{{/* ---------------------------------------------------------------------- */}}
{{/* Names                                                                   */}}
{{/* ---------------------------------------------------------------------- */}}
{{- define "vakspm.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "vakspm.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "vakspm.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/* ---------------------------------------------------------------------- */}}
{{/* Labels                                                                  */}}
{{/* ---------------------------------------------------------------------- */}}
{{- define "vakspm.labels" -}}
helm.sh/chart: {{ include "vakspm.chart" . }}
app.kubernetes.io/name: {{ include "vakspm.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/part-of: vaks-pm
{{- end -}}

{{/* selectorLabels expects a dict: {root: ., component: "api"} */}}
{{- define "vakspm.selectorLabels" -}}
app.kubernetes.io/name: {{ include "vakspm.name" .root }}
app.kubernetes.io/instance: {{ .root.Release.Name }}
app.kubernetes.io/component: {{ .component }}
{{- end -}}

{{/* ---------------------------------------------------------------------- */}}
{{/* Service account                                                         */}}
{{/* ---------------------------------------------------------------------- */}}
{{- define "vakspm.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "vakspm.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}

{{/* ---------------------------------------------------------------------- */}}
{{/* Images                                                                  */}}
{{/* ---------------------------------------------------------------------- */}}
{{/* repoImage expects dict {root: ., repo: "vaks-pm/api"} */}}
{{- define "vakspm.image" -}}
{{- $tag := default .root.Chart.AppVersion .root.Values.image.tag -}}
{{- if .root.Values.image.registry -}}
{{- printf "%s/%s:%s" .root.Values.image.registry .repo $tag -}}
{{- else -}}
{{- printf "%s:%s" .repo $tag -}}
{{- end -}}
{{- end -}}

{{/* ---------------------------------------------------------------------- */}}
{{/* Names of dependent in-cluster services                                  */}}
{{/* ---------------------------------------------------------------------- */}}
{{- define "vakspm.postgresql.fullname" -}}{{ include "vakspm.fullname" . }}-postgresql{{- end -}}
{{- define "vakspm.redis.fullname" -}}{{ include "vakspm.fullname" . }}-redis{{- end -}}
{{- define "vakspm.minio.fullname" -}}{{ include "vakspm.fullname" . }}-minio{{- end -}}
{{- define "vakspm.secretName" -}}
{{- default (printf "%s-secret" (include "vakspm.fullname" .)) .Values.secrets.existingSecret -}}
{{- end -}}

{{/* Crypto keyring (KEK rotation). Enabled when an existingSecret is named or    */}}
{{/* inline keks are provided; otherwise the app uses MFA_ENCRYPTION_KEY (env).   */}}
{{- define "vakspm.cryptoKeyringEnabled" -}}
{{- if or .Values.crypto.existingSecret (gt (len (keys (default (dict) .Values.crypto.keks))) 0) -}}true{{- end -}}
{{- end -}}
{{- define "vakspm.cryptoSecretName" -}}
{{- default (printf "%s-keyring" (include "vakspm.fullname" .)) .Values.crypto.existingSecret -}}
{{- end -}}

{{/* Active external KEK provider: local (default) | kms | hsm. Non-secret        */}}
{{/* provider vars live in the ConfigMap; secret values are injected by           */}}
{{/* cryptoProviderEnv below. */}}
{{- define "vakspm.cryptoProvider" -}}
{{- default "local" .Values.crypto.provider -}}
{{- end -}}

{{/* env entries (secretKeyRef) for external KEK providers' SECRET values. Emitted   */}}
{{/* for every CONFIGURED provider (Secret named), independent of which is active —  */}}
{{/* so a migration (e.g. kms -> hsm) keeps the source provider's creds available    */}}
{{/* to UNWRAP existing DEKs. Renders nothing for local / IRSA (no Secret).          */}}
{{- define "vakspm.cryptoProviderEnv" -}}
{{- if .Values.crypto.kms.existingSecret }}
- name: CRYPTO_KMS_ACCESS_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.crypto.kms.existingSecret }}
      key: accessKey
- name: CRYPTO_KMS_SECRET_KEY
  valueFrom:
    secretKeyRef:
      name: {{ .Values.crypto.kms.existingSecret }}
      key: secretKey
{{- end }}
{{- if .Values.crypto.hsm.existingSecret }}
- name: CRYPTO_HSM_BROKER_TOKEN
  valueFrom:
    secretKeyRef:
      name: {{ .Values.crypto.hsm.existingSecret }}
      key: brokerToken
{{- end }}
{{- end -}}

{{/* Postgres CA verification (anti-MITM): enabled when TLS is on and a CA Secret  */}}
{{/* is named. The Secret must hold the CA PEM under key `ca.crt`.                  */}}
{{- define "vakspm.pgCaEnabled" -}}
{{- if and .Values.tls.postgres .Values.tls.postgresCaSecret -}}true{{- end -}}
{{- end -}}

{{/* ---------------------------------------------------------------------- */}}
{{/* Stable generated passwords (regenerate-safe: read back via lookup on     */}}
{{/* upgrade so the value survives). Call each helper ONCE per render and     */}}
{{/* reuse the result in a variable — every call re-rolls the random.         */}}
{{/* ---------------------------------------------------------------------- */}}
{{- define "vakspm.postgresPassword" -}}
{{- if .Values.postgresql.auth.password -}}
{{- .Values.postgresql.auth.password -}}
{{- else -}}
{{- $secretName := printf "%s-secret" (include "vakspm.fullname" .) -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace $secretName -}}
{{- if and $existing $existing.data (hasKey $existing.data "POSTGRES_PASSWORD") -}}
{{- index $existing.data "POSTGRES_PASSWORD" | b64dec -}}
{{- else -}}
{{- randAlphaNum 24 -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "vakspm.minioPassword" -}}
{{- if .Values.minio.rootPassword -}}
{{- .Values.minio.rootPassword -}}
{{- else -}}
{{- $secretName := printf "%s-secret" (include "vakspm.fullname" .) -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace $secretName -}}
{{- if and $existing $existing.data (hasKey $existing.data "S3_SECRET_KEY") -}}
{{- index $existing.data "S3_SECRET_KEY" | b64dec -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{/* ---------------------------------------------------------------------- */}}
{{/* Connection strings                                                      */}}
{{/* ---------------------------------------------------------------------- */}}
{{- define "vakspm.databaseUrl" -}}
{{- if .Values.postgresql.enabled -}}
{{- $pw := include "vakspm.postgresPassword" . -}}
{{- printf "postgresql://%s:%s@%s:5432/%s?schema=public" .Values.postgresql.auth.username $pw (include "vakspm.postgresql.fullname" .) .Values.postgresql.auth.database -}}
{{- else if .Values.externalDatabase.url -}}
{{- .Values.externalDatabase.url -}}
{{- else -}}
{{- printf "postgresql://%s:%s@%s:%v/%s?schema=public" .Values.externalDatabase.username .Values.externalDatabase.password .Values.externalDatabase.host .Values.externalDatabase.port .Values.externalDatabase.database -}}
{{- end -}}
{{- end -}}

{{- /*
  In-cluster Redis password (requirepass). Explicit value, else read back from
  the chart Secret (stable across upgrades), else a fresh random. Alphanumeric
  only: it is embedded as-is in REDIS_URL. Like the other generators it re-rolls
  on every call — compute it ONCE (secret.yaml) and reuse.
*/ -}}
{{- define "vakspm.redisPassword" -}}
{{- if .Values.redis.auth.password -}}
{{- .Values.redis.auth.password -}}
{{- else -}}
{{- $secretName := printf "%s-secret" (include "vakspm.fullname" .) -}}
{{- $existing := lookup "v1" "Secret" .Release.Namespace $secretName -}}
{{- if and $existing $existing.data (hasKey $existing.data "REDIS_PASSWORD") -}}
{{- index $existing.data "REDIS_PASSWORD" | b64dec -}}
{{- else -}}
{{- randAlphaNum 32 -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- /* Deterministic checksum of the values that shape the Secret / Redis auth. */ -}}
{{- define "vakspm.secretInputsChecksum" -}}
{{- list .Values.secrets .Values.redis.enabled .Values.redis.auth .Values.externalRedis | toJson | sha256sum -}}
{{- end -}}

{{- /*
  With secrets.existingSecret + in-cluster Redis auth, the user's Secret MUST
  carry REDIS_PASSWORD (and a REDIS_URL embedding it). Checked at render time
  when the cluster is reachable (helm install/upgrade): fail with a clear
  message instead of a Redis pod stuck in CreateContainerConfigError after the
  old one was already recreated away.
*/ -}}
{{- define "vakspm.assertRedisAuthSecret" -}}
{{- if and .Values.redis.enabled .Values.redis.auth.enabled .Values.secrets.existingSecret -}}
{{- $s := lookup "v1" "Secret" .Release.Namespace .Values.secrets.existingSecret -}}
{{- if and $s (not (hasKey (default (dict) $s.data) "REDIS_PASSWORD")) -}}
{{- fail (printf "redis.auth.enabled=true but Secret %q has no REDIS_PASSWORD key. Add REDIS_PASSWORD (alphanumeric) and embed it in REDIS_URL (redis://:<pw>@<host>:6379), or set redis.auth.enabled=false." .Values.secrets.existingSecret) -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- /* REDIS_URL. Call with (dict "root" . "password" $pw) — $pw computed once. */ -}}
{{- define "vakspm.redisUrl" -}}
{{- $root := .root -}}
{{- if $root.Values.redis.enabled -}}
{{- if and $root.Values.redis.auth.enabled .password -}}
{{- printf "redis://:%s@%s:6379" .password (include "vakspm.redis.fullname" $root) -}}
{{- else -}}
{{- printf "redis://%s:6379" (include "vakspm.redis.fullname" $root) -}}
{{- end -}}
{{- else -}}
{{- $root.Values.externalRedis.url -}}
{{- end -}}
{{- end -}}

{{/* ---------------------------------------------------------------------- */}}
{{/* Ingress host (explicit, else derived from publicBaseUrl)                */}}
{{/* ---------------------------------------------------------------------- */}}
{{- define "vakspm.ingressHost" -}}
{{- if .Values.ingress.host -}}
{{- .Values.ingress.host -}}
{{- else if .Values.publicBaseUrl -}}
{{- .Values.publicBaseUrl | trimPrefix "https://" | trimPrefix "http://" | trimSuffix "/" -}}
{{- end -}}
{{- end -}}
