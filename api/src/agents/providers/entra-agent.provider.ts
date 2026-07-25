import { Injectable } from '@nestjs/common';
import {
  AgentDirectoryProvider,
  AgentProviderDescriptor,
  ConnectorTestResult,
  ProviderContext,
  RemoteAgent,
} from '../agent-directory.types';
import { applyCredentialToForm, entraTokenEndpoint } from '../../common/entra/client-assertion';

const FETCH_TIMEOUT_MS = 10_000;
/** Borne dure d'énumération (anti-boucle sur @odata.nextLink). */
const MAX_AGENTS = 500;

/**
 * Provider **Entra Agent ID** (Microsoft Graph v1.0, GA 2026). Auth = app
 * registration client-credentials (permission application `AgentIdentity.Read.All`).
 * Énumère `GET /v1.0/agentIdentities` — les hôtes Microsoft sont fixes (pas de
 * config d'URL → pas de surface SSRF).
 *
 * NB : le registre Entra est annoncé remplacé par « Microsoft Agent 365 »
 * (mai 2026) — le seam AgentDirectoryProvider isole ce changement dans cette
 * seule classe.
 */
@Injectable()
export class EntraAgentProvider implements AgentDirectoryProvider {
  readonly provider = 'entra-agent';
  readonly label = 'Microsoft Entra Agent ID';

  describe(): AgentProviderDescriptor {
    return {
      provider: this.provider,
      label: this.label,
      blurb:
        "Importe les identités d'agents IA du tenant Entra (Agent ID). App registration " +
        "client-credentials avec la permission application AgentIdentity.Read.All.",
      accent: '#0078d4',
      short: 'Ent',
      fields: [
        {
          key: 'tenantId',
          label: 'Tenant ID (Entra)',
          type: 'text',
          required: true,
          secret: false,
          placeholder: 'f1e2d3c4-…',
          help: "GUID du tenant Microsoft Entra (annuaire).",
        },
        {
          key: 'clientId',
          label: 'Client ID (app registration)',
          type: 'text',
          required: true,
          secret: false,
          help: "Application (client) ID de l'app registration dédiée à la sync.",
        },
        {
          key: 'clientSecret',
          label: 'Client secret',
          type: 'password',
          required: false,
          secret: true,
          help: 'Auth par secret partagé. Chiffré at-rest, jamais réaffiché. Laissez vide pour conserver l’actuel — ou utilisez plutôt un certificat ci-dessous (secretless).',
        },
        {
          key: 'certThumbprint',
          label: 'Empreinte du certificat (x5t)',
          type: 'text',
          required: false,
          secret: false,
          placeholder: 'A1B2C3D4…',
          help: 'Auth par certificat (private_key_jwt) : empreinte du certificat uploadé dans Entra > Certificates. À renseigner avec la clé privée.',
        },
        {
          key: 'privateKey',
          label: 'Clé privée (PEM PKCS#8)',
          type: 'textarea',
          required: false,
          secret: true,
          placeholder: '-----BEGIN PRIVATE KEY-----',
          help: 'Clé privée correspondant au certificat. Chiffrée at-rest, ne quitte jamais l’API. Si renseignée, le mode certificat prime sur le client secret.',
        },
      ],
    };
  }

  /** Jeton app-only Graph (client credentials). Jette avec un message actionnable. */
  private async acquireToken(ctx: ProviderContext): Promise<string> {
    const tenantId = String(ctx.config.tenantId ?? '').trim();
    const clientId = String(ctx.config.clientId ?? '').trim();
    if (!tenantId || !clientId) {
      throw new Error('Configuration incomplète (tenantId / clientId).');
    }
    // Mode certificat (private_key_jwt) si une clé privée est fournie, sinon secret.
    const privateKeyPem = ctx.secret.privateKey ?? '';
    const clientSecret = ctx.secret.clientSecret ?? '';
    const body = new URLSearchParams({
      grant_type: 'client_credentials',
      scope: 'https://graph.microsoft.com/.default',
    });
    if (privateKeyPem) {
      const thumbprint = String(ctx.config.certThumbprint ?? '').trim();
      if (!thumbprint) {
        throw new Error("Empreinte du certificat (x5t) requise avec la clé privée.");
      }
      await applyCredentialToForm(body, { tenantId, clientId, authMethod: 'client_assertion', privateKeyPem, thumbprint });
    } else if (clientSecret) {
      await applyCredentialToForm(body, { tenantId, clientId, authMethod: 'client_secret', clientSecret });
    } else {
      throw new Error('Configuration incomplète (client secret ou certificat requis).');
    }
    const res = await this.fetchWithTimeout(entraTokenEndpoint(tenantId), {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    const json = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !json.access_token) {
      const why = json.error_description?.split('\n')[0] ?? json.error ?? `HTTP ${res.status}`;
      throw new Error(`Authentification Entra refusée : ${why}`);
    }
    return json.access_token;
  }

  private async fetchWithTimeout(url: string, init: RequestInit): Promise<Response> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
    try {
      return await fetch(url, { ...init, signal: ctrl.signal });
    } catch (e) {
      if ((e as Error).name === 'AbortError') throw new Error('Délai dépassé en joignant Microsoft.');
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  async testConnection(ctx: ProviderContext): Promise<ConnectorTestResult> {
    try {
      const token = await this.acquireToken(ctx);
      const res = await this.fetchWithTimeout(
        'https://graph.microsoft.com/v1.0/agentIdentities?$top=1&$select=id,displayName',
        { method: 'GET', headers: { authorization: `Bearer ${token}`, accept: 'application/json' } },
      );
      if (res.status === 403) {
        return {
          ok: false,
          error: "Accès refusé (403) — la permission application AgentIdentity.Read.All manque (consentement admin requis).",
        };
      }
      if (!res.ok) return { ok: false, error: `Réponse Graph inattendue (HTTP ${res.status}).` };
      return { ok: true, detail: 'Connecté à Microsoft Graph (agentIdentities lisibles).' };
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
  }

  async listAgents(ctx: ProviderContext): Promise<RemoteAgent[]> {
    const token = await this.acquireToken(ctx);
    const out: RemoteAgent[] = [];
    let url: string | null =
      'https://graph.microsoft.com/v1.0/agentIdentities?$top=100&$select=id,displayName,accountEnabled';
    while (url && out.length < MAX_AGENTS) {
      const res: Response = await this.fetchWithTimeout(url, {
        method: 'GET',
        headers: { authorization: `Bearer ${token}`, accept: 'application/json' },
      });
      if (!res.ok) throw new Error(`Énumération Graph échouée (HTTP ${res.status}).`);
      const page = (await res.json()) as {
        value?: { id?: string; displayName?: string; accountEnabled?: boolean }[];
        '@odata.nextLink'?: string;
      };
      for (const a of page.value ?? []) {
        if (!a.id) continue;
        out.push({
          externalId: a.id,
          displayName: a.displayName || a.id,
          enabled: a.accountEnabled !== false,
        });
      }
      const next = page['@odata.nextLink'];
      // Ne suivre que des liens Graph (jamais une URL arbitraire de la réponse).
      url = next && next.startsWith('https://graph.microsoft.com/') ? next : null;
    }
    return out.slice(0, MAX_AGENTS);
  }
}
