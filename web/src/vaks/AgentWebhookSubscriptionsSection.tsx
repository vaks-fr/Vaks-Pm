import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { request } from '../api/client';
import { Icon } from './primitives';

type Flash = (msg: string) => void;

interface SubscriptionDto {
  id: string;
  agentUserId: string;
  agentName: string | null;
  callbackHost: string;
  events: string[];
  active: boolean;
  consecutiveFailures: number;
  autoDisabledAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface DeliveryDto {
  id: string;
  agentUserId: string;
  agentName: string | null;
  event: string;
  taskId: string | null;
  projectId: string | null;
  status: 'PENDING' | 'SUCCESS' | 'FAILED';
  responseStatus: number | null;
  error: string | null;
  attemptCount: number;
  queuedAt: string;
  deliveredAt: string | null;
}

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 20,
  background: 'var(--surface)',
  color: 'var(--text)',
};

const th: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--text-3)',
  borderBottom: '1px solid var(--border)',
  whiteSpace: 'nowrap',
};
const td: React.CSSProperties = {
  padding: '8px 10px',
  fontSize: 13,
  borderBottom: '1px solid var(--border)',
  verticalAlign: 'top',
};

const STATUS_COLOR: Record<string, string> = {
  SUCCESS: 'oklch(0.62 0.15 150)',
  FAILED: 'var(--c-over, #e5484d)',
  PENDING: 'var(--text-3)',
};

/**
 * Admin → AI Agent Management → Agent nudges.
 *
 * Visibilité (lecture + toggle) des souscriptions webhook self-provisionnées par
 * les agents (réveil sur assignation / boucle de revue) et du journal de
 * livraisons. On n'affiche jamais l'URL complète ni le secret — host seul.
 */
export default function AgentWebhookSubscriptionsSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('admin');
  const [subs, setSubs] = useState<SubscriptionDto[] | null>(null);
  const [deliveries, setDeliveries] = useState<DeliveryDto[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [genKey, setGenKey] = useState<string | null>(null);
  const [genBusy, setGenBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [internalEnabled, setInternalEnabled] = useState<boolean | null>(null);
  const [cidrsText, setCidrsText] = useState('');
  const [savingCidrs, setSavingCidrs] = useState(false);

  const load = useCallback(async () => {
    try {
      const [s, d, ic] = await Promise.all([
        request<SubscriptionDto[]>('/admin/agent-webhook-subscriptions'),
        request<DeliveryDto[]>('/admin/agent-webhook-subscriptions/deliveries?limit=100'),
        request<{ enabled: boolean; cidrs: string[] }>(
          '/admin/agent-webhook-subscriptions/internal-cidrs',
        ),
      ]);
      setSubs(s);
      setDeliveries(d);
      setInternalEnabled(ic.enabled);
      setCidrsText(ic.cidrs.join('\n'));
    } catch (e) {
      flash((e as Error).message);
    }
  }, [flash]);

  const saveCidrs = async () => {
    setSavingCidrs(true);
    try {
      const cidrs = cidrsText
        .split(/[\s,]+/)
        .map((c) => c.trim())
        .filter(Boolean);
      const res = await request<{ cidrs: string[] }>(
        '/admin/agent-webhook-subscriptions/internal-cidrs',
        { method: 'PUT', body: JSON.stringify({ cidrs }) },
      );
      setCidrsText(res.cidrs.join('\n'));
      flash(t('agentNudges.saved', { defaultValue: 'Saved' }));
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setSavingCidrs(false);
    }
  };

  useEffect(() => {
    void load();
  }, [load]);

  const toggle = async (sub: SubscriptionDto) => {
    setBusy(sub.id);
    try {
      await request<SubscriptionDto>(`/admin/agent-webhook-subscriptions/${sub.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ active: !sub.active }),
      });
      await load();
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setBusy(null);
    }
  };

  const generateKey = async () => {
    setGenBusy(true);
    setCopied(false);
    try {
      const res = await request<{ token: string }>(
        '/admin/agent-webhook-subscriptions/connector-key',
        { method: 'POST', body: '{}' },
      );
      setGenKey(res.token);
    } catch (e) {
      flash((e as Error).message);
    } finally {
      setGenBusy(false);
    }
  };

  const copyKey = async () => {
    if (!genKey) return;
    try {
      await navigator.clipboard.writeText(genKey);
      setCopied(true);
    } catch {
      /* clipboard blocked — the value is selectable in the box */
    }
  };

  const eventsLabel = (events: string[]) =>
    events.length === 0 ? t('agentNudges.allEvents', { defaultValue: 'All' }) : events.join(', ');

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={cardStyle}>
        <h3 style={{ margin: '0 0 6px', fontSize: 15 }}>
          {t('agentNudges.subsTitle', { defaultValue: 'Agent subscriptions' })}
        </h3>
        <p style={{ margin: '0 0 14px', fontSize: 13, color: 'var(--text-3)' }}>
          {t('agentNudges.subsBlurb', {
            defaultValue:
              'Callbacks self-registered by agents (Copilot Studio, n8n, custom runners) to be woken when a task is assigned to them or a review asks for changes. A nudge carries no authority — the agent still pulls and claims with its own token.',
          })}
        </p>

        <div style={{ marginBottom: 16 }}>
          <button
            type="button"
            disabled={genBusy}
            onClick={() => void generateKey()}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '7px 12px',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              fontSize: 13,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Icon name="zap" size={14} />
            {t('agentNudges.genKey', { defaultValue: 'Generate connector key' })}
          </button>
          <p style={{ margin: '6px 0 0', fontSize: 12, color: 'var(--text-3)' }}>
            {t('agentNudges.genKeyHint', {
              defaultValue:
                'A dedicated org key (scope: manage nudges only) to paste into the provider’s subscribe header (X-Api-Key). One key routes ALL agents to a single flow.',
            })}
          </p>
          {genKey && (
            <div
              style={{
                marginTop: 10,
                border: '1px solid var(--accent)',
                borderRadius: 8,
                padding: 12,
                background: 'var(--surface-2)',
              }}
            >
              <div style={{ fontSize: 12, color: 'var(--c-over, #e5484d)', marginBottom: 6 }}>
                {t('agentNudges.genKeyWarn', {
                  defaultValue: 'Copy it now — it will not be shown again.',
                })}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <code
                  style={{
                    flex: 1,
                    fontFamily: 'monospace',
                    fontSize: 12,
                    wordBreak: 'break-all',
                    userSelect: 'all',
                    color: 'var(--text)',
                  }}
                >
                  {genKey}
                </code>
                <button
                  type="button"
                  onClick={() => void copyKey()}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                    padding: '5px 10px',
                    background: 'var(--surface)',
                    color: 'var(--text)',
                    fontSize: 12,
                    cursor: 'pointer',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {copied
                    ? t('agentNudges.copied', { defaultValue: 'Copied' })
                    : t('agentNudges.copy', { defaultValue: 'Copy' })}
                </button>
              </div>
            </div>
          )}
        </div>
        {!subs ? (
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            {t('common.loading', { defaultValue: 'Loading…' })}
          </p>
        ) : subs.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            {t('agentNudges.noSubs', { defaultValue: 'No agent has subscribed yet.' })}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>{t('agentNudges.colAgent', { defaultValue: 'Agent' })}</th>
                  <th style={th}>{t('agentNudges.colCallback', { defaultValue: 'Callback host' })}</th>
                  <th style={th}>{t('agentNudges.colEvents', { defaultValue: 'Events' })}</th>
                  <th style={th}>{t('agentNudges.colFailures', { defaultValue: 'Failures' })}</th>
                  <th style={th}>{t('agentNudges.colStatus', { defaultValue: 'Status' })}</th>
                  <th style={th} />
                </tr>
              </thead>
              <tbody>
                {subs.map((s) => (
                  <tr key={s.id}>
                    <td style={td}>{s.agentName ?? s.agentUserId}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{s.callbackHost || '—'}</td>
                    <td style={td}>{eventsLabel(s.events)}</td>
                    <td style={td}>{s.consecutiveFailures}</td>
                    <td style={td}>
                      {s.active ? (
                        <span style={{ color: 'oklch(0.62 0.15 150)' }}>
                          {t('agentNudges.active', { defaultValue: 'Active' })}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--text-3)' }}>
                          {s.autoDisabledAt
                            ? t('agentNudges.autoDisabled', { defaultValue: 'Auto-disabled' })
                            : t('agentNudges.disabled', { defaultValue: 'Disabled' })}
                        </span>
                      )}
                    </td>
                    <td style={{ ...td, textAlign: 'right' }}>
                      <button
                        type="button"
                        disabled={busy === s.id}
                        onClick={() => void toggle(s)}
                        style={{
                          border: '1px solid var(--border)',
                          borderRadius: 8,
                          padding: '5px 10px',
                          background: 'var(--surface-2)',
                          color: 'var(--text)',
                          fontSize: 12,
                          cursor: 'pointer',
                        }}
                      >
                        {s.active
                          ? t('agentNudges.disable', { defaultValue: 'Disable' })
                          : t('agentNudges.enable', { defaultValue: 'Enable' })}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>
            {t('agentNudges.deliveriesTitle', { defaultValue: 'Delivery journal' })}
          </h3>
          <button
            type="button"
            onClick={() => void load()}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '5px 10px',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              fontSize: 12,
              cursor: 'pointer',
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
            }}
          >
            <Icon name="refresh" size={13} />
            {t('common.refresh', { defaultValue: 'Refresh' })}
          </button>
        </div>
        {!deliveries ? (
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            {t('common.loading', { defaultValue: 'Loading…' })}
          </p>
        ) : deliveries.length === 0 ? (
          <p style={{ fontSize: 13, color: 'var(--text-3)' }}>
            {t('agentNudges.noDeliveries', { defaultValue: 'No nudge delivered yet.' })}
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={th}>{t('agentNudges.colWhen', { defaultValue: 'Queued' })}</th>
                  <th style={th}>{t('agentNudges.colAgent', { defaultValue: 'Agent' })}</th>
                  <th style={th}>{t('agentNudges.colEvent', { defaultValue: 'Event' })}</th>
                  <th style={th}>{t('agentNudges.colTask', { defaultValue: 'Task' })}</th>
                  <th style={th}>{t('agentNudges.colStatus', { defaultValue: 'Status' })}</th>
                  <th style={th}>{t('agentNudges.colHttp', { defaultValue: 'HTTP' })}</th>
                  <th style={th}>{t('agentNudges.colAttempts', { defaultValue: 'Attempts' })}</th>
                </tr>
              </thead>
              <tbody>
                {deliveries.map((d) => (
                  <tr key={d.id}>
                    <td style={{ ...td, whiteSpace: 'nowrap' }}>{new Date(d.queuedAt).toLocaleString()}</td>
                    <td style={td}>{d.agentName ?? d.agentUserId}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>{d.event}</td>
                    <td style={{ ...td, fontFamily: 'monospace', fontSize: 12 }}>
                      {d.taskId ? d.taskId.slice(0, 8) : '—'}
                    </td>
                    <td style={{ ...td, color: STATUS_COLOR[d.status] }}>{d.status}</td>
                    <td style={td}>{d.responseStatus ?? (d.error ? '✕' : '—')}</td>
                    <td style={td}>{d.attemptCount}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
          <h3 style={{ margin: 0, fontSize: 15 }}>
            {t('agentNudges.internalTitle', { defaultValue: 'Internal callbacks (on-prem)' })}
          </h3>
          {internalEnabled !== null && (
            <span
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderRadius: 999,
                border: '1px solid var(--border)',
                color: internalEnabled ? 'oklch(0.62 0.15 150)' : 'var(--text-3)',
              }}
            >
              {internalEnabled
                ? t('agentNudges.internalActive', { defaultValue: 'Active' })
                : t('agentNudges.internalInactive', {
                    defaultValue: 'Inactive (requires on-prem/dedicated mode)',
                  })}
            </span>
          )}
        </div>
        <p style={{ margin: '0 0 10px', fontSize: 13, color: 'var(--text-3)' }}>
          {t('agentNudges.internalBlurb', {
            defaultValue:
              'Allow nudges to reach private/LAN callback addresses. Off by default; the pooled SaaS stays strict. Only effective when the deployment is dedicated/on-prem or the operator sets ALLOW_INTERNAL_NUDGE_CALLBACKS=true. Loopback and metadata addresses are always blocked.',
          })}
        </p>
        <div
          style={{
            fontSize: 12,
            color: 'var(--c-over, #e5484d)',
            marginBottom: 8,
            display: 'flex',
            gap: 6,
            alignItems: 'flex-start',
          }}
        >
          <Icon name="shield" size={14} />
          <span>
            {t('agentNudges.internalWarn', {
              defaultValue:
                'Security: only add ranges you fully trust — this relaxes anti-SSRF for matching private IPs.',
            })}
          </span>
        </div>
        <label style={{ fontSize: 12, color: 'var(--text-3)', display: 'block', marginBottom: 4 }}>
          {t('agentNudges.internalCidrsLabel', {
            defaultValue: 'Approved internal CIDRs (one per line, e.g. 192.168.1.0/24)',
          })}
        </label>
        <textarea
          value={cidrsText}
          onChange={(e) => setCidrsText(e.target.value)}
          rows={4}
          placeholder="192.168.1.0/24&#10;10.0.0.0/8"
          style={{
            width: '100%',
            fontFamily: 'monospace',
            fontSize: 13,
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid var(--border)',
            background: 'var(--surface-2)',
            color: 'var(--text)',
            resize: 'vertical',
          }}
        />
        <div style={{ marginTop: 8 }}>
          <button
            type="button"
            disabled={savingCidrs}
            onClick={() => void saveCidrs()}
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: '6px 12px',
              background: 'var(--surface-2)',
              color: 'var(--text)',
              fontSize: 13,
              cursor: 'pointer',
            }}
          >
            {t('agentNudges.save', { defaultValue: 'Save' })}
          </button>
        </div>
      </div>
    </div>
  );
}
