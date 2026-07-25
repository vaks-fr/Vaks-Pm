import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';

type Flash = (msg: string) => void;

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 20,
  background: 'var(--surface)',
  color: 'var(--text)',
};

const OK_GREEN = 'oklch(0.62 0.15 150)';

/** Tools de lecture exposés par le serveur MCP (cf. mcp/src/tools.ts). Liste
 *  informative — l'admin voit ce que l'IA peut consulter. L'écriture (création /
 *  modification) n'est accordée que si « Allow AI write actions » est activé, et
 *  reste bornée par le RBAC de chaque utilisateur. */
const READ_TOOLS = [
  'vaks_list_projects',
  'vaks_list_project_tasks',
  'vaks_get_task',
  'vaks_get_workload',
  'vaks_get_skill_gap',
  'vaks_suggest_assignees',
  'vaks_get_project_health',
  'vaks_get_tasks_in_window',
];

/**
 * Admin → Intégrations → Connecteur IA (MCP), phase 11.
 *
 * Config tenant **minimale** (par design) : l'admin n'a JAMAIS d'URL d'endpoint
 * à saisir. Trois leviers seulement :
 *   1. Activer le connecteur (opt-in strict, `mcp.enabled`) — par tenant.
 *   2. L'URL publique MCP, **affichée** (dérivée du déploiement), à copier pour
 *      les utilisateurs / à coller dans Claude/ChatGPT/Copilot Studio.
 *   3. Autoriser l'écriture (`mcp.allowWrites`, défaut OFF = lecture seule).
 * L'authentification réutilise le SSO existant (phase 10) — rien à reconfigurer.
 */
export default function McpSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('admin');
  const { hasFeature } = useAuth();
  const licensed = hasFeature('mcp');
  const [enabled, setEnabled] = useState(false);
  const [allowWrites, setAllowWrites] = useState(false);
  const [allowFinance, setAllowFinance] = useState(false);
  const [ssoCount, setSsoCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState<string | null>(null);
  // Clients OAuth pré-enregistrés (Copilot Studio / intégrations).
  const [oauthClients, setOauthClients] = useState<
    Array<{ clientId: string; clientName: string; redirectUris: string[]; createdAt: number }>
  >([]);
  const [newClientName, setNewClientName] = useState('');
  const [newClientUri, setNewClientUri] = useState('');
  const [creatingClient, setCreatingClient] = useState(false);
  const [createdSecret, setCreatedSecret] = useState<{ client_id: string; client_secret: string } | null>(null);

  // URL publique dérivée du déploiement (path-based `https://<tenant>/mcp`).
  const mcpUrl = `${window.location.origin}/mcp`;

  useEffect(() => {
    (async () => {
      try {
        const [settings, sso, clients] = await Promise.all([
          api.getAdminSettings(),
          api.listSsoProviders().catch(() => []),
          api.listOauthClients().catch(() => []),
        ]);
        const s = settings as Record<string, unknown>;
        setEnabled(s['mcp.enabled'] === true);
        setAllowWrites(s['mcp.allowWrites'] === true);
        setAllowFinance(s['mcp.allowFinance'] === true);
        setSsoCount(Array.isArray(sso) ? sso.length : 0);
        setOauthClients(Array.isArray(clients) ? clients : []);
      } catch (e) {
        flash(t('mcp.loadError', { defaultValue: 'Unable to load MCP settings: {{message}}', message: (e as Error).message }));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const save = async (
    key: 'mcp.enabled' | 'mcp.allowWrites' | 'mcp.allowFinance',
    value: boolean,
  ) => {
    setSaving(key);
    // Optimiste, rollback si l'écriture échoue.
    const setters = {
      'mcp.enabled': setEnabled,
      'mcp.allowWrites': setAllowWrites,
      'mcp.allowFinance': setAllowFinance,
    } as const;
    const prev = { 'mcp.enabled': enabled, 'mcp.allowWrites': allowWrites, 'mcp.allowFinance': allowFinance }[key];
    setters[key](value);
    try {
      await api.putAdminSettings({ [key]: value } as Record<string, unknown>);
      flash(t('mcp.saved', { defaultValue: 'Saved.' }));
    } catch (e) {
      setters[key](prev);
      flash(t('mcp.saveError', { defaultValue: 'Save failed: {{message}}', message: (e as Error).message }));
    } finally {
      setSaving(null);
    }
  };

  const copyUrl = () => {
    void navigator.clipboard?.writeText(mcpUrl);
    flash(t('mcp.urlCopied', { defaultValue: 'MCP URL copied to clipboard.' }));
  };
  const copy = (text: string) => {
    void navigator.clipboard?.writeText(text);
    flash(t('mcp.copied', { defaultValue: 'Copied to clipboard.' }));
  };

  const authUrl = `${window.location.origin}/api/v1/auth/oauth/authorize`;
  const tokenUrl = `${window.location.origin}/api/v1/auth/oauth/token`;

  const createClient = async () => {
    if (!newClientUri.trim()) return;
    setCreatingClient(true);
    try {
      const res = await api.createOauthClient(newClientName.trim() || 'Integration', [newClientUri.trim()]);
      setCreatedSecret({ client_id: res.client_id, client_secret: res.client_secret });
      setNewClientName('');
      setNewClientUri('');
      setOauthClients(await api.listOauthClients());
      flash(t('mcp.clientCreated', { defaultValue: 'Client created — copy the secret now, it is shown only once.' }));
    } catch (e) {
      flash(t('mcp.clientError', { defaultValue: 'Failed: {{message}}', message: (e as Error).message }));
    } finally {
      setCreatingClient(false);
    }
  };

  const revokeClient = async (clientId: string) => {
    try {
      await api.revokeOauthClient(clientId);
      setOauthClients(await api.listOauthClients());
      flash(t('mcp.clientRevoked', { defaultValue: 'Client revoked.' }));
    } catch (e) {
      flash(t('mcp.clientError', { defaultValue: 'Failed: {{message}}', message: (e as Error).message }));
    }
  };

  if (loading) return <div style={{ color: 'var(--text-3)', padding: 12 }}>{t('mcp.loading', { defaultValue: 'Loading…' })}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {!licensed && (
        <div
          style={{
            ...cardStyle,
            borderColor: 'color-mix(in oklch, var(--accent) 45%, var(--border))',
            background: 'color-mix(in oklch, var(--accent) 7%, var(--surface))',
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: 4 }}>
            {t('mcp.premiumTitle', { defaultValue: 'Premium feature' })}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-3)' }}>
            {t('mcp.premiumDesc', {
              defaultValue:
                'The AI connector (MCP) requires an active license that grants the “AI connector (MCP)” feature. It stays disabled until a matching license is imported (Security & Compliance → License).',
            })}
          </div>
        </div>
      )}
      {/* 1. Opt-in + URL publique */}
      <div style={cardStyle}>
        <Toggle
          label={t('mcp.enableLabel', { defaultValue: 'Enable the AI connector (MCP)' })}
          desc={t('mcp.enableDesc', {
            defaultValue:
              'Opt-in for this organization only. When OFF, no AI client can obtain an access token — every connection attempt is refused at consent. When ON, your users can connect their own AI client and act with their own permissions.',
          })}
          checked={enabled}
          busy={saving === 'mcp.enabled'}
          disabled={!licensed}
          onChange={(v) => void save('mcp.enabled', v)}
        />

        <div style={{ height: 1, background: 'var(--border)', margin: '18px 0' }} />

        <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', marginBottom: 8, letterSpacing: 0.3 }}>
          {t('mcp.urlHeading', { defaultValue: 'MCP server URL' })}
        </div>
        <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-3)' }}>
          {t('mcp.urlDesc', {
            defaultValue:
              'Share this URL with your users — they paste it into their AI client (Claude, ChatGPT, Copilot Studio) as a custom connector, then sign in.',
          })}
        </p>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <code
            style={{
              fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: 13,
              padding: '7px 10px',
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              color: enabled ? 'var(--text)' : 'var(--text-faint)',
              userSelect: 'all',
            }}
          >
            {mcpUrl}
          </code>
          <button
            type="button"
            onClick={copyUrl}
            style={{
              cursor: 'pointer',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--surface)',
              color: 'var(--text-2)',
              fontSize: 12,
              padding: '6px 12px',
            }}
          >
            {t('mcp.copyUrl', { defaultValue: 'Copy' })}
          </button>
          {!enabled && (
            <span style={{ fontSize: 12, color: 'var(--c-warn, #d9822b)' }}>
              {t('mcp.urlInactive', { defaultValue: 'Inactive until you enable the connector above.' })}
            </span>
          )}
        </div>
      </div>

      {/* 2. Authentification (réutilise le SSO) */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 600, marginBottom: 6 }}>{t('mcp.authHeading', { defaultValue: 'Authentication' })}</div>
        <p style={{ margin: 0, fontSize: 13, color: 'var(--text-3)' }}>
          {t('mcp.authDesc', {
            defaultValue:
              'MCP login reuses your existing sign-in (local accounts and any configured SSO / Entra ID). There is nothing extra to configure here — users authenticate the same way they sign in to the app, and the AI is bound to their account.',
          })}
        </p>
        <div style={{ marginTop: 10, fontSize: 13, color: 'var(--text-2)' }}>
          {ssoCount && ssoCount > 0
            ? t('mcp.authSso', { defaultValue: '{{count}} SSO provider(s) configured — used for MCP sign-in too.', count: ssoCount })
            : t('mcp.authLocal', { defaultValue: 'No SSO provider configured — MCP sign-in uses local accounts. Configure SSO in the Single sign-on section to delegate to Entra ID.' })}
        </div>
      </div>

      {/* 3. Périmètre : lecture seule / écriture + tools */}
      <div style={cardStyle}>
        <Toggle
          label={t('mcp.writesLabel', { defaultValue: 'Allow AI write actions' })}
          desc={t('mcp.writesDesc', {
            defaultValue:
              'OFF (default) = the AI can only READ. ON = connected users can also let the AI create / modify projects, tasks, assignments and time entries — always bounded by each user’s own permissions. The consent screen reflects the granted scope.',
          })}
          checked={allowWrites}
          busy={saving === 'mcp.allowWrites'}
          disabled={!enabled || !licensed}
          onChange={(v) => void save('mcp.allowWrites', v)}
        />

        <div style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
          <Toggle
            label={t('mcp.financeLabel', { defaultValue: 'Expose finance to AI' })}
            desc={t('mcp.financeDesc', {
              defaultValue:
                'OFF (default) = financial data (rates, budgets, EVM, expenses, portfolio margins) is NEVER returned to AI / API tokens — even for finance-privileged users. ON = users with finance permissions can read it via the AI. Browser app users are unaffected either way.',
            })}
            checked={allowFinance}
            busy={saving === 'mcp.allowFinance'}
            disabled={!enabled || !licensed}
            onChange={(v) => void save('mcp.allowFinance', v)}
          />
        </div>

        <div style={{ marginTop: 18 }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text-3)', marginBottom: 8, letterSpacing: 0.3 }}>
            {t('mcp.toolsHeading', { defaultValue: 'Read tools exposed' })}
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {READ_TOOLS.map((name) => (
              <code
                key={name}
                style={{
                  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
                  fontSize: 12,
                  padding: '3px 8px',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--surface-2)',
                  color: 'var(--text-2)',
                }}
              >
                {name}
              </code>
            ))}
          </div>
          <div style={{ marginTop: 10, fontSize: 12.5, color: allowWrites ? OK_GREEN : 'var(--text-3)' }}>
            {allowWrites
              ? t('mcp.writesOn', { defaultValue: 'Write tools are also exposed (create / modify), within each user’s permissions.' })
              : t('mcp.writesOff', { defaultValue: 'Write tools are hidden — the AI observes and suggests only.' })}
          </div>
        </div>
      </div>

      {/* 4. Clients OAuth pré-enregistrés (Copilot Studio / intégrations) */}
      {licensed && (
        <div style={cardStyle}>
          <div style={{ fontSize: 14, fontWeight: 600 }}>
            {t('mcp.clientsTitle', { defaultValue: 'Pre-registered OAuth clients' })}
          </div>
          <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>
            {t('mcp.clientsDesc', {
              defaultValue:
                'For integrations that do not self-register (e.g. Microsoft Copilot Studio / Power Platform): create a client here, paste its ID + secret into the connector. Claude and ChatGPT don’t need this — they self-register.',
            })}
          </div>

          <div style={{ marginTop: 14, fontSize: 12.5, color: 'var(--text-2)' }}>
            <div style={{ marginBottom: 4 }}>
              {t('mcp.clientsUrls', { defaultValue: 'Connector OAuth URLs (read-only):' })}
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              <UrlRow label="Authorization URL" value={authUrl} onCopy={() => copy(authUrl)} />
              <UrlRow label="Token URL" value={tokenUrl} onCopy={() => copy(tokenUrl)} />
              <UrlRow label="Scope" value="mcp:access" onCopy={() => copy('mcp:access')} />
            </div>
          </div>

          {createdSecret && (
            <div
              style={{
                marginTop: 14,
                border: '1px solid color-mix(in oklch, var(--accent) 45%, var(--border))',
                background: 'color-mix(in oklch, var(--accent) 8%, var(--surface))',
                borderRadius: 10,
                padding: 14,
              }}
            >
              <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 8 }}>
                {t('mcp.secretOnce', { defaultValue: 'Copy the secret now — it will not be shown again.' })}
              </div>
              <UrlRow label="Client ID" value={createdSecret.client_id} onCopy={() => copy(createdSecret.client_id)} />
              <UrlRow label="Client secret" value={createdSecret.client_secret} onCopy={() => copy(createdSecret.client_secret)} />
              <button
                type="button"
                className="btn btn-ghost"
                style={{ marginTop: 8, fontSize: 12 }}
                onClick={() => setCreatedSecret(null)}
              >
                {t('mcp.secretDone', { defaultValue: 'I saved it' })}
              </button>
            </div>
          )}

          <div style={{ marginTop: 14, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={{ fontSize: 12, color: 'var(--text-3)', flex: '1 1 150px' }}>
              {t('mcp.clientName', { defaultValue: 'Name' })}
              <input
                value={newClientName}
                onChange={(e) => setNewClientName(e.target.value)}
                placeholder="Copilot Studio"
                style={inputStyle}
              />
            </label>
            <label style={{ fontSize: 12, color: 'var(--text-3)', flex: '2 1 280px' }}>
              {t('mcp.clientCallback', { defaultValue: 'Callback URL (from the connector)' })}
              <input
                value={newClientUri}
                onChange={(e) => setNewClientUri(e.target.value)}
                placeholder="https://global.consent.azure-apim.net/redirect/..."
                style={inputStyle}
              />
            </label>
            <button
              type="button"
              className="btn btn-accent"
              style={{ padding: '8px 14px' }}
              disabled={creatingClient || !newClientUri.trim()}
              onClick={() => void createClient()}
            >
              {creatingClient ? t('mcp.creating', { defaultValue: 'Creating…' }) : t('mcp.createClient', { defaultValue: 'Create client' })}
            </button>
          </div>

          {oauthClients.length > 0 && (
            <div style={{ marginTop: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
              {oauthClients.map((c) => (
                <div
                  key={c.clientId}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 10,
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '8px 12px',
                    background: 'var(--surface-2)',
                  }}
                >
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{c.clientName}</div>
                    <div style={{ fontSize: 11.5, color: 'var(--text-3)', wordBreak: 'break-all' }}>
                      <code>{c.clientId}</code> · {c.redirectUris.join(', ')}
                    </div>
                  </div>
                  <button
                    type="button"
                    className="btn btn-ghost"
                    style={{ fontSize: 12, color: 'var(--c-over, #e5484d)' }}
                    onClick={() => void revokeClient(c.clientId)}
                  >
                    {t('mcp.revoke', { defaultValue: 'Revoke' })}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 4,
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--surface-2)',
  color: 'var(--text)',
  fontSize: 13,
};

function UrlRow({ label, value, onCopy }: { label: string; value: string; onCopy: () => void }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
      <span style={{ fontSize: 11, color: 'var(--text-3)', minWidth: 96 }}>{label}</span>
      <code
        style={{
          flex: 1,
          fontSize: 12,
          padding: '3px 8px',
          borderRadius: 6,
          border: '1px solid var(--border)',
          background: 'var(--surface-2)',
          color: 'var(--text-2)',
          wordBreak: 'break-all',
        }}
      >
        {value}
      </code>
      <button type="button" className="btn btn-ghost" style={{ fontSize: 11, padding: '3px 8px' }} onClick={onCopy}>
        copy
      </button>
    </div>
  );
}

function Toggle({
  label,
  desc,
  checked,
  busy,
  disabled,
  onChange,
}: {
  label: string;
  desc: string;
  checked: boolean;
  busy?: boolean;
  disabled?: boolean;
  onChange: (v: boolean) => void;
}) {
  const off = !!disabled || !!busy;
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 14, opacity: disabled ? 0.55 : 1 }}>
      <div style={{ flex: 1 }}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{label}</div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5 }}>{desc}</div>
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={checked}
        disabled={off}
        onClick={() => !off && onChange(!checked)}
        style={{
          flexShrink: 0,
          marginTop: 2,
          width: 42,
          height: 24,
          borderRadius: 999,
          border: 'none',
          padding: 2,
          cursor: off ? 'default' : 'pointer',
          background: checked ? 'var(--accent)' : 'var(--surface-3)',
          transition: 'background 120ms',
        }}
      >
        <span
          style={{
            display: 'block',
            width: 20,
            height: 20,
            borderRadius: '50%',
            background: '#fff',
            transform: checked ? 'translateX(18px)' : 'translateX(0)',
            transition: 'transform 120ms',
            boxShadow: '0 1px 2px rgba(0,0,0,0.3)',
          }}
        />
      </button>
    </div>
  );
}
