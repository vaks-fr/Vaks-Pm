/**
 * Contenu de la doc OpenAPI publique (description markdown rendue par Redoc) et
 * page HTML Redoc servie offline (bundle local, pas de CDN — déploiement on-prem).
 */

export const OPENAPI_DESCRIPTION = `
# API Vaks-PM

API REST de gestion de projet **on-premise**. C'est la **même API** que celle consommée par l'application web — tout ce que fait l'UI est faisable par l'API.

## Authentification

Les requêtes sont authentifiées par **jeton Bearer** dans l'en-tête \`Authorization\` :

\`\`\`
Authorization: Bearer <token>
\`\`\`

- **Aujourd'hui** : jeton d'accès **JWT** obtenu via \`POST /api/v1/auth/login\` (court, ~15 min, renouvelable via \`/auth/refresh\`).
- **À venir (Phase 9)** : **jetons d'API personnels (PAT)** à **scopes** (\`tasks:write\`, \`webhooks:write\`, …) + rate-limit par token — destinés aux intégrations tierces (clé longue durée, pas un login utilisateur).

Toutes les routes appliquent le **RBAC côté serveur** : un token n'agit que dans les limites des permissions de son porteur.

> **Multi-tenant** : en déploiement mutualisé, le tenant est résolu depuis le sous-domaine de l'hôte (\`<tenant>.exemple.com\`). Adressez vos appels au sous-domaine de votre organisation.

## Webhooks sortants

Vous pouvez recevoir des **webhooks** (POST HTTP signés) à chaque événement. Gérez-les **par projet** via \`/api/v1/projects/{projectId}/webhooks\` (création, test, rotation du secret, journal des livraisons). _(Les webhooks au niveau organisation sont gérés par un administrateur dans la console d'admin et ne font pas partie de l'API publique.)_

**En-têtes envoyés à chaque livraison :**

| En-tête | Description |
|---|---|
| \`X-Vaks-Event\` | Nom de l'événement (ex. \`task.assigned\`) |
| \`X-Vaks-Delivery\` | UUID de la livraison (idempotence) |
| \`X-Vaks-Signature\` | \`sha256=<hex>\` — HMAC-SHA256 du corps avec le secret du webhook |
| \`X-Vaks-Timestamp\` | Epoch (secondes) |
| \`X-Vaks-Tenant\` | Slug du tenant (mode mutualisé) |

**Vérifier la signature** : \`HMAC_SHA256(secret, body) == partie après "sha256="\`.

**Événements disponibles :**

- \`task.created\`, \`task.updated\`, \`task.deleted\`, \`task.moved\`
- \`task.assigned\`, \`task.unassigned\`, \`task.completed\`
- \`comment.created\`
- \`project.created\`, \`project.updated\`
- \`skill_request.created\`, \`skill_request.acknowledged\`, \`skill_request.resolved\`, \`skill_request.rejected\`, \`skill_request.reminded\`

**Format du payload** : \`raw\` (enveloppe \`{ event, deliveryId, organizationId, at, payload }\`) ou \`teams\` (Adaptive Card prête pour un canal Microsoft Teams / Power Automate).

**Gouvernance** (anti-fuite) : allowlist de domaines, pin de **tenant Entra ID** pour les cibles Teams/Power Automate, protection anti-SSRF, et politique « qui peut créer un webhook ». Une cible non conforme est refusée à la création **et** à l'envoi.
`.trim();

/**
 * Page HTML Redoc (design 3 colonnes). Le CSP de prod est `script-src 'self'`
 * → AUCUN script inline : le bundle ET le script d'init sont des fichiers
 * externes same-origin (`redocInitJs` servi par l'API). `style-src` autorise
 * 'unsafe-inline' → les styles injectés par Redoc passent.
 */
export function redocHtml(opts: { initUrl: string; bundleUrl: string }): string {
  return `<!DOCTYPE html>
<html>
  <head>
    <title>Vaks-PM API — Référence</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <link href="https://fonts.googleapis.com/css?family=Montserrat:300,400,700|Roboto:300,400,700" rel="stylesheet" />
    <style> body { margin: 0; padding: 0; } </style>
  </head>
  <body>
    <div id="redoc"></div>
    <script src="${opts.bundleUrl}"></script>
    <script src="${opts.initUrl}"></script>
  </body>
</html>`;
}

/** Script d'init Redoc, servi comme fichier externe (compat CSP script-src 'self'). */
export function redocInitJs(opts: { specUrl: string; primaryColor?: string }): string {
  const primary = opts.primaryColor ?? '#6d5efc';
  return `Redoc.init(
  ${JSON.stringify(opts.specUrl)},
  {
    scrollYOffset: 0,
    hideDownloadButton: false,
    expandResponses: '200,201',
    theme: {
      colors: { primary: { main: ${JSON.stringify(primary)} } },
      typography: {
        fontFamily: 'Roboto, sans-serif',
        headings: { fontFamily: 'Montserrat, sans-serif' },
      },
      sidebar: { width: '300px' },
    },
  },
  document.getElementById('redoc')
);`;
}
