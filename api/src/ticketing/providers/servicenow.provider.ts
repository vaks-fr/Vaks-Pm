import { Injectable } from '@nestjs/common';
import { assertSafeExternalUrl, safeFetch } from '../../common/url-guard';
import {
  ConnectorTestResult,
  ProviderContext,
  ProviderDescriptor,
  TicketCandidate,
  TicketProvider,
  TicketSearchQuery,
} from '../ticket-provider.types';

/** Tables ServiceNow proposées pour la recherche de tickets. */
const SN_TABLES = [
  { value: 'incident', label: 'Incidents (INC)' },
  { value: 'sc_task', label: 'Catalog tasks (SCTASK)' },
  { value: 'change_task', label: 'Change tasks (CTASK)' },
  { value: 'problem', label: 'Problems (PRB)' },
  { value: 'task', label: 'All tasks (base table)' },
];

const FETCH_TIMEOUT_MS = 8000;

/**
 * Provider ServiceNow — première implémentation du seam. Auth = compte de
 * service (Basic), config = URL d'instance + tables + requête de base. Le
 * `testConnection` fait un vrai appel authentifié léger contre la Table API.
 */
@Injectable()
export class ServiceNowProvider implements TicketProvider {
  readonly source = 'servicenow';
  readonly label = 'ServiceNow';

  describe(): ProviderDescriptor {
    return {
      source: this.source,
      label: this.label,
      blurb:
        "Compte de service ServiceNow (Basic auth). La recherche de tickets est scopée par l'e-mail de l'utilisateur courant.",
      accent: '#62d84e',
      short: 'now',
      fields: [
        {
          key: 'instanceUrl',
          label: "URL de l'instance",
          type: 'url',
          required: true,
          secret: false,
          placeholder: 'https://acme.service-now.com',
          help: "URL de base de votre instance ServiceNow (https).",
        },
        {
          key: 'username',
          label: 'Utilisateur (compte de service)',
          type: 'text',
          required: true,
          secret: false,
          placeholder: 'svc_timesheet',
          help: 'Compte de service avec accès lecture aux tables sélectionnées (Table API).',
        },
        {
          key: 'password',
          label: 'Mot de passe',
          type: 'password',
          required: true,
          secret: true,
          help: 'Chiffré at-rest (AES-256-GCM), jamais réaffiché. Laissez vide pour conserver le mot de passe actuel.',
        },
        {
          key: 'tables',
          label: 'Tables à rechercher',
          type: 'multiselect',
          required: true,
          secret: false,
          options: SN_TABLES,
          default: ['incident'],
          help: 'Types de tickets exposés dans le sélecteur de timesheet.',
        },
        {
          key: 'baseQuery',
          label: 'Filtre de base (optionnel)',
          type: 'text',
          required: false,
          secret: false,
          placeholder: 'active=true',
          help: "Requête encodée ServiceNow (sysparm_query) ajoutée à chaque recherche, ex. active=true.",
          helpUrl: 'https://www.servicenow.com/docs/r/platform-user-interface/c_EncodedQueryStrings.html',
        },
      ],
    };
  }

  /** En-tête Authorization Basic depuis le contexte résolu. */
  private basicAuth(ctx: ProviderContext): string {
    const user = String(ctx.config.username ?? '');
    const pass = ctx.secret.password ?? '';
    return 'Basic ' + Buffer.from(`${user}:${pass}`).toString('base64');
  }

  /** Base URL validée (anti-SSRF + https). Jette si invalide. */
  private instanceBase(ctx: ProviderContext): URL {
    const raw = String(ctx.config.instanceUrl ?? '').trim();
    if (!raw) throw new Error("URL d'instance manquante.");
    return assertSafeExternalUrl(raw, { httpsOnly: true });
  }

  async testConnection(ctx: ProviderContext): Promise<ConnectorTestResult> {
    let base: URL;
    try {
      base = this.instanceBase(ctx);
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    if (!ctx.config.username || !ctx.secret.password) {
      return { ok: false, error: 'Utilisateur et mot de passe requis pour tester.' };
    }
    // Appel léger : 1 ligne de sys_user_role (table système toujours présente),
    // valide l'auth + l'accès Table API sans dépendre d'une table métier.
    const url = new URL('/api/now/table/sys_user_role', base);
    url.searchParams.set('sysparm_limit', '1');
    url.searchParams.set('sysparm_fields', 'sys_id');
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      const res = await safeFetch(url.toString(), {
        method: 'GET',
        headers: { Authorization: this.basicAuth(ctx), Accept: 'application/json' },
        signal: ctrl.signal,
        httpsOnly: true,
      });
      if (res.status === 401) {
        return { ok: false, error: 'Authentification refusée (401) — identifiants invalides.' };
      }
      if (res.status === 403) {
        return { ok: false, error: 'Accès refusé (403) — droits Table API insuffisants.' };
      }
      if (!res.ok) {
        return { ok: false, error: `Réponse inattendue (HTTP ${res.status}).` };
      }
      return { ok: true, detail: `Connecté à ${base.host} (HTTP ${res.status}).` };
    } catch (e) {
      const msg = (e as Error).name === 'AbortError' ? 'Délai dépassé.' : (e as Error).message;
      return { ok: false, error: `Connexion impossible : ${msg}` };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Recherche live (incrément suivant — picker timesheet). Implémentée ici en
   * squelette : traduit `q` en sysparm_query sur les tables configurées, mappe
   * `result[]` → TicketCandidate. Branchée plus tard à l'endpoint /ticketing/search.
   */
  async search(ctx: ProviderContext, q: TicketSearchQuery): Promise<TicketCandidate[]> {
    const base = this.instanceBase(ctx);
    const tables = Array.isArray(ctx.config.tables)
      ? (ctx.config.tables as string[])
      : ['incident'];
    const baseQuery = String(ctx.config.baseQuery ?? '').trim();
    // Anti-injection de requête encodée ServiceNow : `^` sépare les clauses et
    // `=` les opérateurs. Un terme utilisateur contenant ces métacaractères
    // injecterait des clauses arbitraires dans `sysparm_query`. On les retire.
    const term = q.q.trim().replace(/[\^=]/g, ' ').trim();
    const out: TicketCandidate[] = [];
    for (const table of tables.slice(0, 5)) {
      const parts: string[] = [];
      if (baseQuery) parts.push(baseQuery);
      if (term) parts.push(`numberLIKE${term}^ORshort_descriptionLIKE${term}`);
      const url = new URL(`/api/now/table/${encodeURIComponent(table)}`, base);
      if (parts.length) url.searchParams.set('sysparm_query', parts.join('^'));
      url.searchParams.set('sysparm_fields', 'number,short_description,sys_id,state,company');
      url.searchParams.set('sysparm_limit', String(Math.min(q.limit, 50)));
      url.searchParams.set('sysparm_display_value', 'true');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      try {
        const res = await safeFetch(url.toString(), {
          method: 'GET',
          headers: { Authorization: this.basicAuth(ctx), Accept: 'application/json' },
          signal: ctrl.signal,
          httpsOnly: true,
        });
        if (!res.ok) continue;
        const body = (await res.json()) as { result?: Record<string, string>[] };
        for (const r of body.result ?? []) {
          if (!r.number) continue;
          out.push({
            key: r.number,
            title: r.short_description || r.number,
            url: `${base.origin}/nav_to.do?uri=${encodeURIComponent(`${table}.do?sys_id=${r.sys_id}`)}`,
            status: r.state,
            meta: { table, ...(r.company ? { clientHint: r.company } : {}) },
          });
        }
      } catch {
        /* table en échec : on ignore, les autres tables peuvent répondre */
      } finally {
        clearTimeout(timer);
      }
    }
    return out.slice(0, q.limit);
  }
}
