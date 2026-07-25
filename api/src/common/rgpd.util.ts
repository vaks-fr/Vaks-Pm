/**
 * Helpers RGPD — pseudonymisation irréversible (droit à l'effacement, Art. 17).
 *
 * Principe : on ne supprime jamais de ligne ; on écrase les champs porteurs de
 * données personnelles par une valeur dérivée de l'`id` (stable, non
 * réversible). Voir `RGPD_ANONYMIZATION.md`.
 */

/** Domaine réservé RFC 2606 — jamais routable, signale clairement une PII effacée. */
export const ANON_EMAIL_DOMAIN = 'anonymized.invalid';

/** Email pseudonyme déterministe (unique par construction grâce à l'id). */
export function anonEmail(id: string): string {
  return `anon-${id}@${ANON_EMAIL_DOMAIN}`;
}

/** Libellé lisible : `<prefix> <id8>` (ex. "Utilisateur anonymisé 1a2b3c4d"). */
export function anonLabel(prefix: string, id: string): string {
  return `${prefix} ${id.slice(0, 8)}`;
}

/** Détecte un email déjà pseudonymisé → anonymisation idempotente. */
export function isAnonymizedEmail(email: string | null | undefined): boolean {
  return !!email && email.endsWith(`@${ANON_EMAIL_DOMAIN}`);
}

/** Signature minimale d'un exécuteur SQL brut (Prisma `$executeRawUnsafe`). */
export type RawExec = (sql: string, ...params: unknown[]) => Promise<number>;

/**
 * Remplace, dans une colonne `jsonb`, les occurrences de chaque valeur — sous
 * sa forme de token JSON quoté `"valeur"` — par son pseudonyme. Le `replace`
 * SQL est **littéral** (pas regex) et les valeurs sont **paramétrées** (pas
 * d'injection). `table`/`column` sont des littéraux internes (jamais d'entrée
 * utilisateur). Le filtre `LIKE` ne sert qu'à éviter de réécrire les lignes
 * non concernées ; un sur-match éventuel reste inoffensif (replace littéral).
 */
export async function scrubJsonColumn(
  exec: RawExec,
  table: string,
  column: string,
  orgId: string,
  pairs: Array<[string | null | undefined, string]>,
): Promise<void> {
  for (const [oldV, newV] of pairs) {
    if (!oldV) continue;
    const quotedOld = `"${oldV}"`;
    const quotedNew = `"${newV}"`;
    await exec(
      `UPDATE "${table}" SET "${column}" = replace("${column}"::text, $1, $2)::jsonb ` +
        `WHERE "organizationId" = $3 AND "${column}"::text LIKE $4`,
      quotedOld,
      quotedNew,
      orgId,
      `%${quotedOld}%`,
    );
  }
}
