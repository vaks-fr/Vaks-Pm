export default () => ({
  nodeEnv: process.env.NODE_ENV ?? 'development',
  // Rôle de service (control plane mutualisé vs data plane).
  //   non-défini = legacy (login activé, aucune contrainte de tenant) — défaut
  //     historique : un `api` qui fait auth + données comme avant.
  //   `control-plane` = front door auth mutualisée (émet le JWT{tenant}).
  //   `data-plane`    = cellule data-only : login coupé (404), le JWT est émis
  //     par le control-plane et son claim `tenant` doit matcher le Host résolu.
  // Une seule image `vaks-pm/api` ; seul ce flag change le comportement.
  serviceRole: process.env.SERVICE_ROLE ?? null,
  port: parseInt(process.env.API_PORT ?? '3000', 10),
  corsOrigin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
  databaseUrl: process.env.DATABASE_URL,
  redisUrl: process.env.REDIS_URL ?? 'redis://redis:6379',
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET ?? 'dev-access-secret',
    refreshSecret: process.env.JWT_REFRESH_SECRET ?? 'dev-refresh-secret',
    accessTtl: parseInt(process.env.JWT_ACCESS_TTL ?? '900', 10),
    refreshTtl: parseInt(process.env.JWT_REFRESH_TTL ?? '2592000', 10),
  },
  // Clé maître pour le chiffrement at-rest (secrets TOTP, plus tard secrets
  // OIDC clients, etc.). 32 bytes en Base64. En prod : docker secret
  // `mfa_encryption_key` monté en /run/secrets et lu par l'init du container.
  encryptionKey: process.env.MFA_ENCRYPTION_KEY ?? '',
  // Envelope encryption (DORA / HSM-ready). KEK active = trousseau de fichiers
  // `kek_v*` montés dans `keysDir` (Docker secret / Secret K8s / ESO/CSI), sinon
  // fallback sur `MFA_ENCRYPTION_KEY` (ref `env`) → zéro changement pour l'existant.
  //   CRYPTO_KEYS_DIR    répertoire des KEK versionnées (défaut /etc/vaks/keys)
  //   CRYPTO_ACTIVE_KEK  réf de la KEK active ('' = auto : plus haute vN, sinon env)
  crypto: {
    keysDir: process.env.CRYPTO_KEYS_DIR ?? '/etc/vaks/keys',
    activeKek: process.env.CRYPTO_ACTIVE_KEK ?? '',
    // Provider de KEK ACTIF (workstream G — HSM/KMS) : `local` (keyring fichier,
    // défaut), plus tard `kms` / `hsm` une fois le provider externe enregistré.
    // Les DEK existantes restent déchiffrables quel que soit l'actif (routage par
    // schéma de `kekRef`) ; seules les NOUVELLES DEK sont wrappées sous l'actif.
    keyProvider: process.env.CRYPTO_KEY_PROVIDER ?? 'local',
    // KMS externe (AWS KMS ou endpoint compatible : LocalStack, certains KMS
    // on-prem). Actif seulement si `keyId` est défini → s'enregistre alors sous
    // le schéma `kms`. La KEK ne quitte jamais le KMS (wrap=Encrypt, unwrap=Decrypt).
    //   CRYPTO_KMS_KEY_ID    id/alias/arn de la KEK dans le KMS (requis pour activer)
    //   CRYPTO_KMS_REGION    région (défaut us-east-1 ou AWS_REGION)
    //   CRYPTO_KMS_ENDPOINT  endpoint custom ('' = AWS natif ; ex. LocalStack)
    //   CRYPTO_KMS_ACCESS_KEY / _SECRET_KEY  creds explicites (sinon chaîne SDK/IAM)
    kms: {
      keyId: process.env.CRYPTO_KMS_KEY_ID ?? '',
      region: process.env.CRYPTO_KMS_REGION ?? process.env.AWS_REGION ?? 'us-east-1',
      endpoint: process.env.CRYPTO_KMS_ENDPOINT ?? '',
    },
    // HSM on-prem via le **key-broker sidecar** (PKCS#11/KMIP isolés dans le
    // sidecar ; l'app ne parle qu'HTTP interne). Actif si brokerUrl + keyLabel
    // définis → s'enregistre sous le schéma `hsm`. La KEK ne quitte jamais le HSM.
    //   CRYPTO_HSM_BROKER_URL    URL interne du sidecar (ex. http://hsm-broker:8081)
    //   CRYPTO_HSM_KEY_LABEL     label de la KEK dans le HSM (CKA_LABEL)
    //   CRYPTO_HSM_BROKER_TOKEN  secret partagé (header Authorization) app↔sidecar
    hsm: {
      brokerUrl: process.env.CRYPTO_HSM_BROKER_URL ?? '',
      keyLabel: process.env.CRYPTO_HSM_KEY_LABEL ?? '',
      token: process.env.CRYPTO_HSM_BROKER_TOKEN ?? '',
    },
  },
  // Origine publique de l'app (sans slash final). Sert à construire les liens
  // dans les emails ET la redirection finale du callback SSO vers le front.
  // En pooled, le Host de la requête prime (par sous-domaine) ; APP_URL n'est
  // qu'un fallback (mode dedicated / on-premise mono-domaine).
  appUrl: (process.env.APP_URL ?? 'http://localhost:5173').replace(/\/+$/, ''),
  // SSO (phase 10). Config non sensible des providers en DB (IdentityProvider) ;
  // ici uniquement le(s) secret(s) montés en Swarm secret. Pour le 1er tenant
  // Entra de test : un client secret partagé suffit (cf. SSO.md §5).
  sso: {
    oidcClientSecret: process.env.SSO_OIDC_CLIENT_SECRET ?? '',
  },
  // Modèle de déploiement (multi-tenant).
  //   `dedicated` (défaut) = 1 tenant par instance (on-premise, cellule) :
  //      login global par email, aucun routing par Host, connexion DB unique.
  //   `pooled` = N tenants par instance (SaaS) : l'org est résolue depuis le
  //      Host (`<slug>.<baseDomain>` ou domaine custom) et l'app se connecte à
  //      la base du tenant.
  // Back-compat : TENANCY_MODE=multi → pooled, =single → dedicated.
  deployment: {
    mode:
      (process.env.DEPLOYMENT_MODE ??
        (process.env.TENANCY_MODE === 'multi'
          ? 'pooled'
          : process.env.TENANCY_MODE === 'single'
            ? 'dedicated'
            : undefined)) === 'pooled'
        ? 'pooled'
        : 'dedicated',
    baseDomain: (process.env.TENANCY_BASE_DOMAIN ?? '').toLowerCase(),
    // Domaines custom (hors `<slug>.<baseDomain>`) mappés explicitement vers un
    // slug tenant. Pas d'annuaire partagé → mapping statique par config.
    //   TENANCY_CUSTOM_DOMAINS="vaks-pm.vaks.fr=vaks,pm.acme.com=acme"
    customDomains: parseCustomDomains(process.env.TENANCY_CUSTOM_DOMAINS),
  },
});

/** Parse `host=slug,host2=slug2` → { host: slug } (hosts en minuscule). */
function parseCustomDomains(raw?: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    const [host, slug] = pair.split('=').map((s) => s.trim().toLowerCase());
    if (host && slug && /^[a-z0-9-]+$/.test(slug)) map[host] = slug;
  }
  return map;
}
