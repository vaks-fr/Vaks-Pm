import { withCallContext, type ApiClient } from './api-client.js';

/**
 * Complétion des arguments de prompts (requête MCP `completion/complete`).
 *
 * Sans ça, un argument de prompt est un champ texte libre : l'utilisateur doit
 * deviner le nom exact d'un projet ou d'une personne. Avec `completable()`, le
 * client IA affiche une liste déroulante alimentée par les **vraies données du
 * tenant**, lues via l'API avec le jeton de l'utilisateur (donc filtrées par son
 * RBAC — le serveur MCP ne filtre jamais lui-même).
 *
 * Trois règles structurantes :
 *
 *  1. **Fail-open.** Un completer ne jette JAMAIS : sur erreur (API lente, 403,
 *     jeton révoqué) il renvoie une liste vide et l'utilisateur retombe sur la
 *     saisie libre. Une complétion cassée ne doit pas empêcher de lancer le
 *     prompt.
 *  2. **Plafond 100 valeurs**, maximum imposé par la spec MCP.
 *  3. **Aucun cache inter-requêtes.** Le serveur est stateless et multi-tenant :
 *     un cache mémoire keyé autrement que par (tenant, utilisateur) fuiterait
 *     des noms de projets d'une org à l'autre. Chaque complétion = un appel API.
 *     Le client, lui, débounce la frappe (recommandation de la spec).
 */

/** Plafond de valeurs par réponse imposé par la spec MCP. */
const MAX_SUGGESTIONS = 100;

/**
 * Signature attendue par `completable()` du SDK. `value` est `string |
 * undefined` parce que les arguments sont optionnels (schéma `ZodOptional`) :
 * le client demande la liste complète tant que rien n'est saisi.
 */
export type Completer = (value: string | undefined) => Promise<string[]>;

/** Une entrée candidate : la valeur insérée + les textes sur lesquels matcher. */
interface Candidate {
  /** Ce qui est effectivement inséré dans le champ. */
  value: string;
  /** Textes comparés à la saisie (nom, clé, email…). */
  haystack: string[];
}

/** Minuscules sans accents — comparaison tolérante (« Réseau » ⇢ « reseau »). */
function fold(s: string): string {
  return (
    s
      .normalize('NFD')
      // `Mn` = marques non-espaçantes, exactement ce que produit la
      // décomposition NFD d'un accent. Écrit en propriété Unicode plutôt qu'en
      // plage littérale : des caractères combinants dans une source sont
      // invisibles à la relecture.
      .replace(/\p{Mn}/gu, '')
      .toLowerCase()
      .trim()
  );
}

/**
 * Pertinence d'un candidat : 2 = commence par la saisie, 1 = la contient,
 * 0 = pas de correspondance. Une saisie vide matche tout (le client demande la
 * liste complète à l'ouverture du champ).
 */
function rank(haystack: string[], q: string): number {
  if (!q) return 1;
  let best = 0;
  for (const h of haystack) {
    const f = fold(h);
    if (f.startsWith(q)) return 2;
    if (f.includes(q)) best = 1;
  }
  return best;
}

/**
 * Fabrique un completer à partir d'un chargeur de candidats : filtre sur la
 * saisie, classe les préfixes avant les sous-chaînes, déduplique et plafonne.
 */
function makeCompleter(load: () => Promise<Candidate[]>): Completer {
  return async (value: string | undefined) =>
    // Contexte d'audit explicite : sinon les appels de chargement héritent de
    // l'en-tête `x-vaks-mcp-tool` laissé par le dernier tool exécuté, et une
    // simple frappe au clavier apparaît dans l'audit sous le nom de ce tool.
    withCallContext({ tool: 'completion/complete' }, async () => {
    try {
      const q = fold(value ?? '');
      const scored = (await load())
        .map((c) => ({ c, r: rank(c.haystack, q) }))
        .filter((x) => x.r > 0)
        .sort((a, b) => b.r - a.r || a.c.value.localeCompare(b.c.value));

      const seen = new Set<string>();
      const out: string[] = [];
      for (const { c } of scored) {
        if (!c.value || seen.has(c.value)) continue;
        seen.add(c.value);
        out.push(c.value);
        if (out.length >= MAX_SUGGESTIONS) break;
      }
      return out;
    } catch {
      // Fail-open : la saisie libre reste possible, on ne casse pas le prompt.
      return [];
    }
    });
}

/** Normalise une réponse API en tableau (une erreur silencieuse ⇒ liste vide). */
function asArray(v: unknown): Record<string, unknown>[] {
  return Array.isArray(v) ? (v as Record<string, unknown>[]) : [];
}

/** Lit un champ string d'une ligne API, ou `''` si absent/mal typé. */
function str(row: Record<string, unknown>, field: string): string {
  const v = row[field];
  return typeof v === 'string' ? v : '';
}

/**
 * Projets visibles par l'utilisateur (`scope=mine` — son périmètre, pas tout le
 * portefeuille). On matche sur le **nom ET la clé** : un PM tape souvent « MKT »
 * plutôt que le nom long. La valeur insérée est le nom, le plus lisible ; les
 * prompts résolvent ensuite l'id via `vaks_list_projects`.
 */
export function projectCompleter(api: ApiClient): Completer {
  return makeCompleter(async () => {
    const rows = asArray(await api.get('projects', { scope: 'mine' }));
    return rows.map((p) => {
      const name = str(p, 'name');
      const key = str(p, 'key');
      return { value: name || key, haystack: [name, key].filter(Boolean) };
    });
  });
}

/**
 * Annuaire des personnes. On lit `users` (route `@PublicApi`) et **jamais**
 * `users/directory`, délibérément app-privée (réservée au panneau admin).
 *
 * La route renvoie les humains uniquement par défaut — les agents IA vivent
 * dans Admin > Agents et n'ont rien à faire dans un picker « personne ». On
 * écarte en plus les comptes suspendus : les proposer n'aurait aucun sens pour
 * du staffing ou de l'onboarding.
 */
export function personCompleter(api: ApiClient): Completer {
  return makeCompleter(async () => {
    const rows = asArray(await api.get('users'));
    return rows
      .filter((u) => str(u, 'status') !== 'SUSPENDED')
      .map((u) => {
        const name = str(u, 'name');
        const email = str(u, 'email');
        // L'email reste dans le haystack (chercher par adresse est naturel)
        // mais n'est inséré que si la personne n'a pas de nom renseigné.
        return { value: name || email, haystack: [name, email].filter(Boolean) };
      });
  });
}
