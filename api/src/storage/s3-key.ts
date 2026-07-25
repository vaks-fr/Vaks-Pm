/**
 * Résolution PURE des clés S3 pour l'isolation par tenant (préfixe `<slug>/`).
 * Extrait de `S3Service` pour être testable sans backend S3. Les décisions I/O
 * (existence de l'objet) sont injectées via un callback.
 */

/**
 * Clé d'ÉCRITURE. Isolation off → clé brute. Isolation on → `<slug>/<clé>`.
 * **Throw si on sans slug** : un blob écrit sans préfixe serait invisible (donc
 * irrécupérable) après la bascule stricte — on refuse plutôt que d'orpheliner.
 */
export function tenantWriteKey(enabled: boolean, slug: string | null, key: string): string {
  if (!enabled) return key;
  if (!slug) throw new Error(`S3 write without tenant context (isolation on) for key "${key}"`);
  return `${slug}/${key}`;
}

/**
 * Clé de LECTURE effective. Isolation off ou hors contexte tenant → clé brute.
 * Strict → toujours `<slug>/<clé>`. Sinon (fallback migration) → `<slug>/<clé>`
 * si l'objet préfixé existe, sinon la clé legacy.
 */
export async function tenantReadKey(
  enabled: boolean,
  strict: boolean,
  slug: string | null,
  key: string,
  scopedExists: (scopedKey: string) => Promise<boolean>,
): Promise<string> {
  if (!enabled || !slug) return key;
  const scoped = `${slug}/${key}`;
  if (strict) return scoped;
  if (await scopedExists(scoped)) return scoped;
  return key;
}

/**
 * Clés à supprimer pour un `removeObject` : la préfixée ET la legacy (best-effort)
 * pendant la fenêtre de fallback, pour qu'un objet « supprimé » ne réapparaisse
 * pas via le fallback de lecture. En strict, seule la préfixée (si slug).
 */
export function tenantDeleteKeys(
  enabled: boolean,
  strict: boolean,
  slug: string | null,
  key: string,
): string[] {
  if (!enabled) return [key];
  const out = new Set<string>();
  if (slug) out.add(`${slug}/${key}`);
  if (!strict || !slug) out.add(key); // legacy
  return [...out];
}
