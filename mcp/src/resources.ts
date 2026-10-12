import { McpServer, ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import { withCallContext, type ApiClient } from './api-client.js';
import type { Lang } from './i18n.js';
import { msg } from './i18n-messages.js';

/**
 * Resources MCP — la 3ᵉ primitive du protocole, jusqu'ici inutilisée.
 *
 * Une *resource* est une donnée **passive** que l'utilisateur attache lui-même
 * au contexte de sa conversation (le « @ » des clients IA), par opposition à un
 * *tool* que le modèle décide d'appeler. On expose ici le contexte de travail
 * d'une tâche et les documents rattachés.
 *
 * Deux principes de conception :
 *
 *  1. **Ne rien imposer dans l'interface.** Aucun des deux templates n'est
 *     listable. On avait d'abord énuméré les tâches de l'utilisateur pour rendre
 *     la resource « découvrable » : à l'usage, le sélecteur de contexte du
 *     client se retrouve noyé sous une entrée par tâche, toutes identiques à
 *     l'œil — du bruit, pas de la valeur. Les resources restent donc
 *     disponibles pour qui veut les référencer par URI, et le tool
 *     `vaks_get_work_context` couvre le cas où c'est le modèle qui va chercher
 *     le contexte de lui-même.
 *  2. **Le RBAC reste côté API.** Le serveur MCP relaie le bearer et ne filtre
 *     rien : une tâche hors périmètre renvoie 403, c'est le comportement voulu.
 *
 * ⚠️ Le stockage est un **proxy live** (`api/src/filesources/`) vers SharePoint
 * ou Google Drive, pas une copie locale : le contenu est extrait côté serveur et
 * **plafonné (~64 Ko)**. Le drapeau `truncated` doit toujours être remonté à
 * l'utilisateur — un document tronqué lu comme complet produit des réponses
 * fausses avec aplomb.
 */

/** Plafond de suggestions (maximum imposé par la spec MCP). */
const MAX_SUGGESTIONS = 100;

/** Lit un champ string d'un objet API, ou `''`. */
function str(row: Record<string, unknown>, field: string): string {
  const v = row[field];
  return typeof v === 'string' ? v : '';
}

/**
 * Normalise la réponse de `me/tasks`, qui n'est PAS un tableau : l'endpoint sert
 * un tableau de bord (`{ projects, columns, tasks }`).
 */
function asTasks(v: unknown): Record<string, unknown>[] {
  if (Array.isArray(v)) return v as Record<string, unknown>[];
  if (v && typeof v === 'object') {
    const inner = (v as { tasks?: unknown }).tasks;
    if (Array.isArray(inner)) return inner as Record<string, unknown>[];
  }
  return [];
}

/** Encode un segment d'URI (les `itemId` SharePoint contiennent des `!`, `:`…). */
const seg = (v: string) => encodeURIComponent(v);

export function registerResources(server: McpServer, api: ApiClient, lang: Lang = 'en'): void {
  // ── Contexte de travail d'une tâche (listable) ────────────────────────────
  server.registerResource(
    'task-context',
    new ResourceTemplate('vaks://task/{taskId}/context', {
      /**
       * **Volontairement non listable.** On avait d'abord énuméré les tâches de
       * l'utilisateur pour rendre la resource « découvrable » ; à l'usage, le
       * sélecteur de contexte du client se retrouve noyé sous une entrée par
       * tâche — du bruit, pas de la valeur. Une resource ne doit pas s'imposer
       * dans l'interface : elle reste disponible pour qui veut la référencer
       * explicitement par son URI, et le tool `vaks_get_work_context` couvre
       * déjà le besoin quand c'est le modèle qui va chercher le contexte.
       */
      list: undefined,
      complete: {
        taskId: async (value) =>
          withCallContext({ tool: 'completion/complete:task-context' }, async () => {
            try {
              const tasks = asTasks(await api.get('me/tasks'));
              const q = (value ?? '').toLowerCase();
              return tasks
                .map((t) => str(t, 'id'))
                .filter((id) => id && id.toLowerCase().startsWith(q))
                .slice(0, MAX_SUGGESTIONS);
            } catch {
              return [];
            }
          }),
      },
    }),
    {
      title: msg(lang, 'resTaskContextTitle'),
      description: msg(lang, 'resTaskContextDesc'),
      mimeType: 'application/json',
    },
    async (uri, { taskId }) =>
      // Contexte d'audit explicite : sans lui, ces appels sortants héritaient de
      // l'en-tête `x-vaks-mcp-tool` laissé par le dernier tool exécuté, et le
      // journal d'audit attribuait la lecture à un tool qui n'y était pour rien.
      withCallContext({ tool: 'resources/read:task-context' }, async () => {
        const id = Array.isArray(taskId) ? taskId[0] : taskId;
        const context = await api.get(`tasks/${encodeURIComponent(id)}/work-context`);
        // Les documents sont best-effort : une source non configurée ou un grant
        // en attente ne doit pas priver l'utilisateur du contexte lui-même.
        let files: unknown = null;
        try {
          files = await api.get(`tasks/${encodeURIComponent(id)}/context-files`);
        } catch (e) {
          files = { error: e instanceof Error ? e.message : 'indisponible' };
        }
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ context, files }, null, 2),
            },
          ],
        };
      }),
  );

  // ── Un document précis d'une source externe (non listable) ────────────────
  server.registerResource(
    'task-file',
    new ResourceTemplate('vaks://task/{taskId}/file/{source}/{itemId}', {
      // Non listable à dessein : impossible d'énumérer tous les fichiers de
      // toutes les sources de toutes les tâches. On les découvre via la
      // resource « contexte » ci-dessus, qui liste les documents de la tâche.
      list: undefined,
    }),
    {
      title: msg(lang, 'resTaskFileTitle'),
      description: msg(lang, 'resTaskFileDesc'),
    },
    async (uri, { taskId, source, itemId }) =>
      withCallContext({ tool: 'resources/read:task-file' }, async () => {
        const one = (v: string | string[]) => (Array.isArray(v) ? v[0] : v);
        const doc = (await api.get(
          `tasks/${encodeURIComponent(one(taskId))}/context-files/${seg(one(source))}/${seg(one(itemId))}`,
        )) as {
          document?: { name?: string; mimeType?: string };
          content?: string;
          truncated?: boolean;
        };
        // `truncated` est remonté DANS le texte : le client n'a aucun champ
        // standard pour l'exprimer, et le lecteur doit savoir qu'il lit un extrait.
        const header = doc?.truncated
          ? '⚠️ Document tronqué par la limite d\'extraction (~64 Ko) — ceci est un EXTRAIT.\n\n'
          : '';
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: doc?.document?.mimeType ?? 'text/plain',
              text: header + (doc?.content ?? ''),
            },
          ],
        };
      }),
  );
}
