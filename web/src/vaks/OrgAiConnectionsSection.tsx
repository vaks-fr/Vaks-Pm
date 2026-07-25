import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';

type Flash = (msg: string) => void;

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 20,
  background: 'var(--surface)',
  color: 'var(--text)',
};

interface OrgAiConnection {
  connId: string;
  clientName: string;
  userId: string;
  userName: string | null;
  userEmail: string | null;
  createdAt: number;
  lastUsedAt: number;
}

/**
 * Connexions IA actives de toute l'org (vue admin org-wide). Extrait de
 * `McpSection` : la liste a déménagé dans Sécurité & conformité → Connexions
 * actives. Qui est branché, dernière activité, révocation admin immédiate.
 */
export default function OrgAiConnectionsSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('admin');
  const [conns, setConns] = useState<OrgAiConnection[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    api
      .listAllAiConnections()
      .then((c) => setConns(Array.isArray(c) ? (c as OrgAiConnection[]) : []))
      .catch((e) =>
        flash(t('mcp.loadError', { defaultValue: 'Unable to load: {{message}}', message: (e as Error).message })),
      )
      .finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const revoke = async (connId: string) => {
    try {
      await api.adminRevokeAiConnection(connId);
      setConns((cs) => cs.filter((c) => c.connId !== connId));
      flash(t('mcp.connsRevoked', { defaultValue: 'AI connection revoked.' }));
    } catch (e) {
      flash(t('mcp.clientError', { defaultValue: 'Failed: {{message}}', message: (e as Error).message }));
    }
  };

  if (loading)
    return <div style={{ color: 'var(--text-3)', padding: 12 }}>{t('mcp.loading', { defaultValue: 'Loading…' })}</div>;

  return (
    <div style={cardStyle}>
      <div style={{ fontSize: 13, color: 'var(--text-3)', lineHeight: 1.5 }}>
        {t('mcp.connsDesc', {
          defaultValue:
            'Every user’s AI client currently connected to this organization. Disconnect to cut access immediately — the user will have to reconnect. Suspending or deleting a user also cuts their connections automatically.',
        })}
      </div>
      {conns.length === 0 ? (
        <div style={{ marginTop: 12, fontSize: 13, color: 'var(--text-3)' }}>
          {t('mcp.connsNone', { defaultValue: 'No active AI connection.' })}
        </div>
      ) : (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 8 }}>
          {conns.map((c) => (
            <div
              key={c.connId}
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
                <div style={{ fontSize: 13, fontWeight: 600 }}>
                  {c.userName || c.userEmail || c.userId}{' '}
                  <span style={{ color: 'var(--text-3)', fontWeight: 400 }}>· {c.clientName}</span>
                </div>
                <div style={{ fontSize: 11.5, color: 'var(--text-3)' }}>
                  {c.userName && c.userEmail ? `${c.userEmail} · ` : ''}
                  {t('mcp.connsLastUsed', { defaultValue: 'Last used' })}: {new Date(c.lastUsedAt).toLocaleString()}
                </div>
              </div>
              <button
                type="button"
                className="btn btn-ghost"
                style={{ fontSize: 12, color: 'var(--c-over, #e5484d)' }}
                onClick={() => void revoke(c.connId)}
              >
                {t('mcp.connsRevoke', { defaultValue: 'Disconnect' })}
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
