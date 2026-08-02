/**
 * Garde-fou anti-XSS pour tout `href` alimenté par une URL d'origine NON FIABLE
 * (URL de livrable soumise par un agent via `vaks_submit_deliverable`, `externalUrl`
 * d'un ticket posé par une machine, `webUrl` d'un fichier de contexte…).
 *
 * Renvoie l'URL uniquement si elle est **http(s) absolue** ou **relative** (sans
 * schéma) ; tout schéma dangereux (`javascript:`, `data:`, `vbscript:`, `file:`…)
 * renvoie `undefined` → le `href` n'est pas posé et rien ne s'exécute au clic.
 * React ne bloque PAS un href `javascript:` (avertissement dev seulement, exécuté
 * quand même) — d'où ce filtre côté rendu (audit sécu frontend 2026-08-02).
 */
export function safeUrl(u: string | null | undefined): string | undefined {
  if (!u) return undefined;
  const s = u.trim();
  if (!s) return undefined;
  // Un schéma explicite (`mot:`) au tout début ⇒ n'autoriser QUE http/https.
  // Sinon (URL relative ou protocol-relative `//host`), c'est sûr.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) {
    return /^https?:/i.test(s) ? s : undefined;
  }
  return s;
}
