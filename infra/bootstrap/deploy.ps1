<#
.SYNOPSIS
    Orchestrateur de deploiement on-premise, 100% PowerShell natif.

.DESCRIPTION
    Equivalent PowerShell de deploy.sh, concu pour un serveur de management
    Windows SANS Git Bash ni WSL. Il n'utilise que des outils fournis par
    Windows :
      - le client OpenSSH natif  : ssh.exe / scp.exe (+ ssh-agent optionnel)
      - PowerShell 5.1+ (integre a Windows) : base64, fichier temporaire, etc.

    Le bash n'est requis QUE sur les VMs Debian (les scripts *.sh distants) :
    aucune dependance bash cote pilotage.

    PREREQUIS sur le serveur de management (a installer AVANT, hors de ce script) :
      - Un client OpenSSH (ssh.exe / scp.exe) accessible dans le PATH.
        Peu importe la provenance : fonctionnalite integree de Windows,
        installeur MSI/exe Win32-OpenSSH, ou tout autre paquet OpenSSH.
        Verifier :  Get-Command ssh.exe
      - .env.local complet a la racine du repo (SSH_KEY, VM_USER, VM_HOST1..3,
        VM_PASS, POSTGRES_*, PATRONI_*, JWT_*).
      - la cle publique correspondante installee sur les 3 VMs (authorized_keys).
    => AUCUN Docker requis en local : les images sont buildees sur host1.

.PARAMETER Action
    check | db | app | all   (defaut : check)
      check : teste SSH + sudo sur les 3 VMs (A FAIRE EN PREMIER)
      db    : tier base de donnees (etcd + Patroni + HAProxy)
      app   : Swarm + build images sur host1 + deploiement du stack
      all   : check + db + app

.PARAMETER FixKeyPerms
    Verrouille les ACL de la cle privee (icacls : proprietaire courant seul).
    A utiliser si OpenSSH refuse la cle ("bad permissions / unprotected key").

.PARAMETER UseBash
    Repli : delegue a deploy.sh via Git Bash (sinon WSL) au lieu de la voie
    native. Utile si un bash est present et prefere.

.EXAMPLE
    .\deploy.ps1 check
.EXAMPLE
    .\deploy.ps1 all
.EXAMPLE
    .\deploy.ps1 app -FixKeyPerms
#>
[CmdletBinding()]
param(
    [ValidateSet('check', 'db', 'app', 'all')]
    [string]$Action = 'check',

    [switch]$FixKeyPerms,
    [switch]$UseBash
)

$ErrorActionPreference = 'Stop'

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$Root = (Resolve-Path (Join-Path $here '..\..')).Path

# ============================================================
# Repli -UseBash : delegue a deploy.sh (Git Bash puis WSL)
# ============================================================
if ($UseBash) {
    $deploySh = Join-Path $here 'deploy.sh'
    if (-not (Test-Path $deploySh)) { throw "deploy.sh introuvable : $deploySh" }
    $bash = (Get-Command bash.exe -ErrorAction SilentlyContinue).Source
    if (-not $bash) {
        foreach ($c in @("$env:ProgramFiles\Git\bin\bash.exe",
                "${env:ProgramFiles(x86)}\Git\bin\bash.exe",
                "$env:LOCALAPPDATA\Programs\Git\bin\bash.exe")) {
            if ($c -and (Test-Path $c)) { $bash = $c; break }
        }
    }
    if ($bash) {
        & $bash '-lc' "bash '$deploySh' $Action"; exit $LASTEXITCODE
    }
    if (Get-Command wsl.exe -ErrorAction SilentlyContinue) {
        $full = (Resolve-Path $deploySh).Path
        $wp = "/mnt/$($full.Substring(0,1).ToLower())$($full.Substring(2) -replace '\\','/')"
        & wsl.exe bash $wp $Action; exit $LASTEXITCODE
    }
    throw "-UseBash demande mais ni Git Bash ni WSL trouves. Retire -UseBash pour la voie native (OpenSSH)."
}

# ============================================================
# Voie native : verifs prerequis
# ============================================================
foreach ($tool in 'ssh.exe', 'scp.exe') {
    if (-not (Get-Command $tool -ErrorAction SilentlyContinue)) {
        throw @"
$tool introuvable dans le PATH.
Un client OpenSSH (ssh.exe / scp.exe) est un PREREQUIS de ce script et doit
etre installe au prealable, par le moyen de ton choix :
  - fonctionnalite integree de Windows (OpenSSH Client), ou
  - un installeur MSI/exe Win32-OpenSSH, ou tout autre paquet OpenSSH.
Verifie ensuite :  Get-Command ssh.exe
Puis relance :     .\deploy.ps1 $Action
"@
    }
}

# --- Chargement de .env.local (parse natif, pas de 'source') ---
$envFile = Join-Path $Root '.env.local'
if (-not (Test-Path $envFile)) { throw "ERREUR : $envFile manquant" }
$Cfg = @{}
foreach ($line in Get-Content $envFile) {
    $t = $line.Trim()
    if ($t -eq '' -or $t.StartsWith('#')) { continue }
    $eq = $t.IndexOf('=')
    if ($eq -lt 1) { continue }
    $k = $t.Substring(0, $eq).Trim()
    $v = $t.Substring($eq + 1).Trim()
    if ($v.Length -ge 2 -and (($v[0] -eq '"' -and $v[-1] -eq '"') -or ($v[0] -eq "'" -and $v[-1] -eq "'"))) {
        $v = $v.Substring(1, $v.Length - 2)
    }
    $Cfg[$k] = $v
}
function Req([string]$name) {
    if (-not $Cfg.ContainsKey($name) -or [string]::IsNullOrEmpty($Cfg[$name])) {
        throw "ERREUR : variable $name absente ou vide dans .env.local"
    }
    return $Cfg[$name]
}
function Opt([string]$name, [string]$default = '') {
    if ($Cfg.ContainsKey($name) -and -not [string]::IsNullOrEmpty($Cfg[$name])) { return $Cfg[$name] }
    return $default
}

$VmUser = Req 'VM_USER'
$H1 = Req 'VM_HOST1'; $H2 = Req 'VM_HOST2'; $H3 = Req 'VM_HOST3'
$VmPass = Opt 'VM_PASS' ''
$Hosts = @($H1, $H2, $H3)
$Names = @('host1', 'host2', 'host3')

# --- Cle privee SSH ---
$SshKey = Req 'SSH_KEY'
if (-not ([System.IO.Path]::IsPathRooted($SshKey) -or $SshKey -match '^[A-Za-z]:')) {
    $SshKey = Join-Path $Root $SshKey
}
if (-not (Test-Path $SshKey)) {
    throw "ERREUR : cle SSH OpenSSH introuvable : $SshKey`n  (PuTTYgen -> Conversions -> Export OpenSSH key)"
}
if ($FixKeyPerms) {
    Write-Host "[perms] verrouillage ACL de la cle : $SshKey" -ForegroundColor Cyan
    & icacls.exe $SshKey /inheritance:r | Out-Null
    & icacls.exe $SshKey /grant:r "$($env:USERNAME):(R)" | Out-Null
    & icacls.exe $SshKey /remove "BUILTIN\Users" "NT AUTHORITY\Authenticated Users" 2>$null | Out-Null
}

# --- ssh-agent optionnel (charge la passphrase une seule fois) ---
try {
    $svc = Get-Service ssh-agent -ErrorAction SilentlyContinue
    if ($svc) {
        if ($svc.StartType -eq 'Disabled') { Set-Service ssh-agent -StartupType Manual -ErrorAction SilentlyContinue }
        if ($svc.Status -ne 'Running') { Start-Service ssh-agent -ErrorAction SilentlyContinue }
        if ((Get-Command ssh-add.exe -ErrorAction SilentlyContinue)) {
            $loaded = (& ssh-add.exe -l 2>$null) -join "`n"
            $fp = (& ssh-keygen.exe -lf $SshKey 2>$null)
            if ($fp -and ($loaded -notmatch [regex]::Escape(($fp -split '\s+')[1]))) {
                Write-Host "[ssh-agent] chargement de la cle (passphrase si necessaire, une seule fois)" -ForegroundColor Cyan
                & ssh-add.exe $SshKey
            }
        }
    }
}
catch {
    Write-Host "[ssh-agent] indisponible - si la cle a une passphrase, elle sera demandee a chaque connexion." -ForegroundColor Yellow
}

# ============================================================
# Helpers de transport (ssh.exe / scp.exe natifs)
# ============================================================
$SshOpts = @('-o', 'StrictHostKeyChecking=accept-new', '-o', 'BatchMode=no', '-i', $SshKey)

# Echappement bash pour valeurs a inserer dans une commande distante.
function ShEsc([string]$s) { "'" + ($s -replace "'", "'\''") + "'" }

# Enveloppe sudo : la commande distante est encodee en base64 (charset sur pour
# le shell) puis decodee + executee cote VM. Uniquement des quotes simples cote
# argument ssh => zero probleme de quoting PowerShell (bug PS 5.1 sur les ").
function SudoArg([string]$cmd) {
    $b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($cmd))
    "echo $(ShEsc $VmPass) | sudo -S -p '' bash -c 'echo $b64 | base64 -d | bash'"
}

function Invoke-Ssh([string]$h, [string]$cmd) {
    & ssh.exe @SshOpts "$VmUser@$h" $cmd
    return $LASTEXITCODE
}
function Invoke-Sudo([string]$h, [string]$cmd) {
    & ssh.exe @SshOpts "$VmUser@$h" (SudoArg $cmd)
    return $LASTEXITCODE
}
function Get-SudoOutput([string]$h, [string]$cmd) {
    $out = & ssh.exe @SshOpts "$VmUser@$h" (SudoArg $cmd)
    if ($LASTEXITCODE -ne 0) { throw "sudo (capture) sur $h a echoue ($LASTEXITCODE)" }
    return $out
}
# Variantes "fail-fast" pour les chemins de deploiement.
function Ssh([string]$h, [string]$cmd) { if ((Invoke-Ssh $h $cmd) -ne 0) { throw "ssh sur $h a echoue : $cmd" } }
function Sudo([string]$h, [string]$cmd) { if ((Invoke-Sudo $h $cmd) -ne 0) { throw "sudo sur $h a echoue" } }
function Rsy([string]$h, [string]$src, [string]$dest) {
    & scp.exe @SshOpts -r $src "$VmUser@${h}:$dest"
    if ($LASTEXITCODE -ne 0) { throw "scp vers $h a echoue : $src -> $dest" }
}

# ============================================================
# Etapes (miroir de deploy.sh)
# ============================================================
function Invoke-Check {
    Write-Host "=== Test d'acces aux 3 VMs ===" -ForegroundColor Green
    foreach ($h in $Hosts) {
        Write-Host ("- {0,-15} : " -f $h) -NoNewline
        if ((Invoke-Ssh $h 'true') -ne 0) { Write-Host "SSH KO (cle absente sur la VM ou refusee)" -ForegroundColor Red; exit 1 }
        if ((Invoke-Sudo $h 'true') -eq 0) { Write-Host "SSH ok, sudo ok" -ForegroundColor Green }
        else { Write-Host "SSH ok mais SUDO KO" -ForegroundColor Red; exit 1 }
    }
    Write-Host "Acces valide sur les 3 VMs." -ForegroundColor Green
}

function Push-Infra([string]$h) {
    Ssh $h "mkdir -p ~/vakspm"
    Rsy $h $here "~/vakspm/"                                   # -> ~/vakspm/bootstrap/*
    Rsy $h (Join-Path $Root 'infra\patroni.yml') "~/vakspm/bootstrap/patroni.yml"
    Rsy $h (Join-Path $Root 'infra\haproxy.cfg') "~/vakspm/bootstrap/haproxy.cfg"
}

function Invoke-DeployDb {
    Write-Host "=== Tier base de donnees ===" -ForegroundColor Green
    $replUser = Opt 'PATRONI_REPLICATION_USER' 'replicator'
    $replPass = Req 'PATRONI_REPLICATION_PASSWORD'
    $superPass = Req 'PATRONI_SUPERUSER_PASSWORD'
    for ($i = 0; $i -lt 3; $i++) {
        $h = $Hosts[$i]; $name = $Names[$i]; $ip = $h
        Write-Host "--- $name ($h) ---" -ForegroundColor Cyan
        Push-Infra $h
        Sudo $h "cd ~$VmUser/vakspm/bootstrap && bash 00-common.sh"
        Sudo $h "cd ~$VmUser/vakspm/bootstrap && NODE_NAME=$name NODE_IP=$ip HOST1_IP=$H1 HOST2_IP=$H2 HOST3_IP=$H3 bash 10-etcd.sh"
        Sudo $h "cd ~$VmUser/vakspm/bootstrap && NODE_NAME=$name NODE_IP=$ip HOST1_IP=$H1 HOST2_IP=$H2 HOST3_IP=$H3 REPL_USER=$(ShEsc $replUser) REPL_PASSWORD=$(ShEsc $replPass) SUPERUSER_PASSWORD=$(ShEsc $superPass) bash 20-patroni.sh"
        Sudo $h "cd ~$VmUser/vakspm/bootstrap && HOST1_IP=$H1 HOST2_IP=$H2 HOST3_IP=$H3 bash 30-haproxy.sh"
    }
    Write-Host "--- bootstrap role + base (sur le leader) ---" -ForegroundColor Cyan
    $pgUser = Req 'POSTGRES_USER'; $pgPass = Req 'POSTGRES_PASSWORD'; $pgDb = Req 'POSTGRES_DB'
    Sudo $H1 "cd ~$VmUser/vakspm/bootstrap && POSTGRES_USER=$(ShEsc $pgUser) POSTGRES_PASSWORD=$(ShEsc $pgPass) POSTGRES_DB=$(ShEsc $pgDb) bash 25-bootstrap-db.sh"
    Write-Host "DB OK. Verifier: ssh -i $SshKey $VmUser@$H1 'sudo patronictl -c /etc/patroni.yml list'" -ForegroundColor Green
}

function Build-ImagesOnHost1 {
    Write-Host "=== Build des images sur host1 ===" -ForegroundColor Green
    Ssh $H1 "mkdir -p ~/vakspm/src"
    foreach ($d in 'package.json', 'tsconfig.base.json', 'packages', 'api', 'worker', 'web', 'mcp') {
        Rsy $H1 (Join-Path $Root $d) "~/vakspm/src/"
    }
    Sudo $H1 "cd ~$VmUser/vakspm/src && docker build -t vaks-pm-web:latest -f web/Dockerfile . && docker build -t vaks-pm-api:latest -f api/Dockerfile . && docker build -t vaks-pm-worker:latest -f worker/Dockerfile . && docker build -t vaks-pm-mcp:latest -f mcp/Dockerfile ."

    Write-Host "  export des images depuis host1" -ForegroundColor Cyan
    Sudo $H1 "docker save vaks-pm-web:latest vaks-pm-api:latest vaks-pm-worker:latest vaks-pm-mcp:latest -o /tmp/vakspm-images.tar && chown ${VmUser}:${VmUser} /tmp/vakspm-images.tar"
    $tmp = New-TemporaryFile
    try {
        & scp.exe @SshOpts "$VmUser@${H1}:/tmp/vakspm-images.tar" $tmp.FullName
        if ($LASTEXITCODE -ne 0) { throw "telechargement du tar d'images depuis host1 a echoue" }
        foreach ($h in @($H2, $H3)) {
            Write-Host "  -> chargement des images sur $h" -ForegroundColor Cyan
            Rsy $h $tmp.FullName "/tmp/vakspm-images.tar"
            Sudo $h "docker load -i /tmp/vakspm-images.tar"
        }
    }
    finally { Remove-Item $tmp.FullName -ErrorAction SilentlyContinue }
}

function Invoke-DeployApp {
    Write-Host "=== Swarm + stack applicative ===" -ForegroundColor Green
    Sudo $H1 "cd ~$VmUser/vakspm/bootstrap && bash 40-swarm.sh manager $H1"
    $token = (Get-SudoOutput $H1 "docker swarm join-token -q worker" | Where-Object { $_ -and $_.Trim() } | Select-Object -Last 1).Trim()
    if (-not $token) { throw "impossible de recuperer le join-token Swarm depuis host1" }
    Sudo $H2 "cd ~$VmUser/vakspm/bootstrap && bash 40-swarm.sh worker $token $H1"
    Sudo $H3 "cd ~$VmUser/vakspm/bootstrap && bash 40-swarm.sh worker $token $H1"

    Build-ImagesOnHost1

    Rsy $H1 (Join-Path $Root 'docker-stack.yml') "~/vakspm/docker-stack.yml"
    Ssh $H1 "mkdir -p ~/vakspm/infra"
    Rsy $H1 (Join-Path $Root 'infra\traefik-dynamic.yml') "~/vakspm/infra/traefik-dynamic.yml"

    $pgUser = Opt 'POSTGRES_USER' 'vakspm'; $pgPass = Req 'POSTGRES_PASSWORD'; $pgDb = Opt 'POSTGRES_DB' 'vakspm'
    $jwtA = Req 'JWT_ACCESS_SECRET'; $jwtR = Req 'JWT_REFRESH_SECRET'
    $dbUrl = "postgresql://${pgUser}:${pgPass}@${H1}:5000/${pgDb}?schema=public"
    Sudo $H1 "cd ~$VmUser/vakspm/bootstrap && JWT_ACCESS_SECRET=$(ShEsc $jwtA) JWT_REFRESH_SECRET=$(ShEsc $jwtR) DATABASE_URL=$(ShEsc $dbUrl) VAKS_IMAGE_PREFIX=vaks-pm VAKS_TAG=latest bash 50-deploy.sh"
    Write-Host "App deployee. Suivi: ssh -i $SshKey $VmUser@$H1 'sudo docker stack ps vaks-pm'" -ForegroundColor Green
}

# ============================================================
# Dispatch
# ============================================================
switch ($Action) {
    'check' { Invoke-Check }
    'db' { Invoke-DeployDb }
    'app' { Invoke-DeployApp }
    'all' { Invoke-Check; Invoke-DeployDb; Invoke-DeployApp }
}
Write-Host "=== Termine ===" -ForegroundColor Green
