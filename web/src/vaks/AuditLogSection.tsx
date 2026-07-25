/* ============================================================
   Journal d'audit (Phase 8) — section admin.
   Listing filtrable (action, sévérité, outcome, acteur, période,
   recherche libre) en pagination keyset « Charger plus », détail
   JSON dépliable par ligne, exports JSON Lines / CEF.
   Style aligné sur le reste du panel (asection-card, btn, …).
   ============================================================ */
import React, { useCallback, useEffect, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { api } from '../api/client';
import { Icon } from './primitives';
import type { AuditLogDto, AuditLogListQuery, AuditSeverity, AuditOutcome, AuditActorType } from '@vaks-pm/shared';

interface Flash {
  (msg: string, kind?: 'info' | 'ok' | 'err'): void;
}

const SEVERITY_COLOR: Record<string, string> = {
  INFO: 'var(--text-3)',
  WARNING: '#e08e0b',
  CRITICAL: '#c92a2a',
};

const ACTOR_KEYS = new Set(['USER', 'API_TOKEN', 'AGENT', 'SYSTEM', 'ANONYMOUS']);
const actorLabel = (tk: TFunction, type: string): string =>
  ACTOR_KEYS.has(type) ? tk(`audit.actorLabel.${type}`) : type;

/* Actions exactes cataloguées (libellés dans i18n `audit.phrase.*`). La phrase
   se lit « {acteur} {phrase} “{ressource}” ». Le code technique reste visible
   dans le détail déplié. */
const KNOWN_ACTIONS = new Set<string>([
  'auth.login.success', 'auth.login.failure', 'auth.logout',
  'auth.mfa.success', 'auth.mfa.failure', 'auth.mfa.enrolled', 'auth.mfa.disabled',
  'auth.password.changed', 'auth.token.refreshed',
  'user.created', 'user.deleted', 'user.suspended', 'user.reactivated',
  'user.role.changed', 'user.admin.toggled', 'users.update', 'settings.updated',
  'apiToken.created', 'apiToken.revoked',
  'webhook.created', 'webhook.updated', 'webhook.deleted',
  'task.created', 'task.updated', 'task.moved', 'task.deleted',
  'attachment.downloaded', 'attachments.create', 'attachments.delete',
  'comments.create', 'comments.update', 'comments.delete',
  'projects.create', 'projects.update', 'projects.delete', 'projects.copy',
  'skills.create', 'skills.update', 'skills.delete',
  'teams.create', 'teams.update', 'teams.delete',
  'clients.create', 'clients.update', 'clients.delete',
  'labels.create', 'labels.delete',
  'time-entries.create', 'time-entries.update', 'time-entries.delete',
  'allocations.create', 'allocations.delete', 'workload.autoplan',
  'security.forceLogoutAll', 'security.session.revoked',
  'security.password.resetLink', 'security.breakGlass.toggled',
  'audit.alert', 'audit.test', 'audit.anchor', 'backup.failed',
  'automation.alert', 'automation.mutation',
]);

/* Verbes reconnus en fallback (action dérivée de la route `<famille>.<verbe>`).
   CRUD historiques + verbes admin non-CRUD (test connexion, rotation clé, …).
   Tout verbe absent de cette table → on rend le code brut (pas de phrase). */
const VERB_KEYS: Record<string, string> = {
  create: 'verbCreate', update: 'verbUpdate', delete: 'verbDelete',
  test: 'verb.test', send: 'verb.send', rotate: 'verb.rotate', preview: 'verb.preview',
  enable: 'verb.enable', disable: 'verb.disable', revoke: 'verb.revoke', reset: 'verb.reset',
  export: 'verb.export', apply: 'verb.apply', sync: 'verb.sync', run: 'verb.run',
  toggle: 'verb.toggle', copy: 'verb.copy', move: 'verb.move', retry: 'verb.retry',
};

/* Fallback par famille quand l'action exacte n'est pas cataloguée. La famille
   peut être multi-segment (`identity-providers`, `notifications.deliveries`),
   le verbe est le dernier segment. */
function actionPhrase(tk: TFunction, action: string): string | null {
  if (KNOWN_ACTIONS.has(action)) return tk(`audit.phrase.${action}`);
  const m = action.match(/^(?:admin\.)?([a-zA-Z][a-zA-Z.-]*)\.([a-zA-Z]+)$/);
  if (m) {
    const verbKey = VERB_KEYS[m[2]];
    if (!verbKey) return null;
    return tk('audit.phraseFamily', { verb: tk(`audit.${verbKey}`), family: m[1] });
  }
  return null;
}

interface Filters {
  action: string;
  severity: '' | AuditSeverity;
  outcome: '' | AuditOutcome;
  actorType: '' | AuditActorType;
  q: string;
  from: string;
  to: string;
}

const BLANK_FILTERS: Filters = { action: '', severity: '', outcome: '', actorType: '', q: '', from: '', to: '' };

function toQuery(f: Filters): AuditLogListQuery {
  return {
    action: f.action.trim() || undefined,
    severity: f.severity || undefined,
    outcome: f.outcome || undefined,
    actorType: f.actorType || undefined,
    q: f.q.trim() || undefined,
    // <input type="date"> rend YYYY-MM-DD ; `to` couvre la journée entière.
    from: f.from ? new Date(f.from + 'T00:00:00').toISOString() : undefined,
    to: f.to ? new Date(f.to + 'T23:59:59.999').toISOString() : undefined,
  };
}

export default function AuditLogSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('security');
  const [items, setItems] = useState<AuditLogDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [filters, setFilters] = useState<Filters>(BLANK_FILTERS);
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [exporting, setExporting] = useState(false);
  const [syslogFailures, setSyslogFailures] = useState<{
    date?: string;
    batches?: number;
    entries?: number;
    lastError?: string;
  } | null>(null);

  // Badge dead-letter : lots syslog définitivement perdus aujourd'hui.
  useEffect(() => {
    void api
      .getAdminSettings()
      .then((all) => {
        const f = all['audit.syslog.failures'] as typeof syslogFailures;
        if (f?.date === new Date().toISOString().slice(0, 10) && (f.batches ?? 0) > 0) {
          setSyslogFailures(f);
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const load = useCallback(
    async (f: Filters, cursor?: string) => {
      setLoading(true);
      try {
        const r = await api.listAuditLogs({ ...toQuery(f), cursor, pageSize: 50 });
        setItems((prev) => (cursor ? [...prev, ...r.items] : r.items));
        setNextCursor(r.nextCursor);
      } catch (e) {
        flash(t('audit.loadFailed', { message: (e as Error).message }), 'err');
      } finally {
        setLoading(false);
      }
    },
    [flash, t],
  );

  // Charge au montage puis à chaque changement de filtre (debounce léger —
  // utile pour les champs texte, anodin pour les selects/dates).
  useEffect(() => {
    const t = setTimeout(() => void load(filters), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters]);

  const doExport = async (format: 'jsonl' | 'cef') => {
    setExporting(true);
    try {
      await api.exportAuditLogs(format, toQuery(filters));
    } catch (e) {
      flash(t('audit.exportFailed', { message: (e as Error).message }), 'err');
    } finally {
      setExporting(false);
    }
  };

  // Vérification d'intégrité contre l'ancre quotidienne (défaut : hier UTC).
  const [verifyDate, setVerifyDate] = useState('');
  const doVerify = async () => {
    try {
      const r = await api.verifyAuditDay(verifyDate || undefined);
      if (!r.anchored) {
        flash(r.message ?? t('audit.verify.noAnchor', { date: r.date }));
      } else if (r.ok) {
        flash(t('audit.verify.ok', { date: r.date, count: r.currentCount }), 'ok');
      } else {
        flash(
          t('audit.verify.tampered', { date: r.date, sealed: r.sealedCount, current: r.currentCount }),
          'err',
        );
      }
    } catch (e) {
      flash(t('audit.verify.failed', { message: (e as Error).message }), 'err');
    }
  };

  const inputStyle: React.CSSProperties = {
    padding: '4px 8px',
    borderRadius: 6,
    border: '1px solid var(--border)',
    background: 'var(--surface-2)',
    color: 'var(--text)',
    fontSize: 12,
  };

  return (
    <div className="asection-card" style={{ padding: 14 }}>
      {/* Avertissement dead-letter syslog */}
      {syslogFailures && (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            marginBottom: 10,
            padding: '8px 10px',
            borderRadius: 8,
            border: '1px solid #e08e0b55',
            background: '#e08e0b14',
            color: '#e08e0b',
            fontSize: 12,
          }}
        >
          <span>⚠</span>
          <span>
            <Trans
              t={t}
              i18nKey="audit.deadLetter.summary"
              values={{ batches: syslogFailures.batches, entries: syslogFailures.entries }}
              components={{ 1: <b /> }}
            />
            {syslogFailures.lastError && (
              <>{t('audit.deadLetter.lastError')}<code>{syslogFailures.lastError}</code></>
            )}
          </span>
        </div>
      )}
      {/* Barre de filtres */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
        <input
          style={{ ...inputStyle, width: 160 }}
          placeholder={t('audit.filters.actionPlaceholder')}
          value={filters.action}
          onChange={(e) => setFilters((f) => ({ ...f, action: e.target.value }))}
        />
        <select
          className="select-sm"
          style={inputStyle}
          value={filters.severity}
          onChange={(e) => setFilters((f) => ({ ...f, severity: e.target.value as Filters['severity'] }))}
        >
          <option value="">{t('audit.filters.allSeverities')}</option>
          <option value="INFO">INFO</option>
          <option value="WARNING">WARNING</option>
          <option value="CRITICAL">CRITICAL</option>
        </select>
        <select
          className="select-sm"
          style={inputStyle}
          value={filters.outcome}
          onChange={(e) => setFilters((f) => ({ ...f, outcome: e.target.value as Filters['outcome'] }))}
        >
          <option value="">{t('audit.filters.allOutcomes')}</option>
          <option value="SUCCESS">{t('audit.filters.outcomeSuccess')}</option>
          <option value="FAILURE">{t('audit.filters.outcomeFailure')}</option>
        </select>
        <select
          className="select-sm"
          style={inputStyle}
          value={filters.actorType}
          onChange={(e) => setFilters((f) => ({ ...f, actorType: e.target.value as Filters['actorType'] }))}
        >
          <option value="">{t('audit.filters.allActors')}</option>
          <option value="USER">{actorLabel(t, 'USER')}</option>
          <option value="AGENT">{actorLabel(t, 'AGENT')}</option>
          <option value="API_TOKEN">{actorLabel(t, 'API_TOKEN')}</option>
          <option value="SYSTEM">{actorLabel(t, 'SYSTEM')}</option>
        </select>
        <input
          type="date"
          style={inputStyle}
          value={filters.from}
          onChange={(e) => setFilters((f) => ({ ...f, from: e.target.value }))}
          title={t('audit.filters.fromTitle')}
        />
        <input
          type="date"
          style={inputStyle}
          value={filters.to}
          onChange={(e) => setFilters((f) => ({ ...f, to: e.target.value }))}
          title={t('audit.filters.toTitle')}
        />
        <input
          style={{ ...inputStyle, width: 170 }}
          placeholder={t('audit.filters.searchPlaceholder')}
          value={filters.q}
          onChange={(e) => setFilters((f) => ({ ...f, q: e.target.value }))}
        />
        <div className="grow" />
        <input
          type="date"
          style={inputStyle}
          value={verifyDate}
          onChange={(e) => setVerifyDate(e.target.value)}
          title={t('audit.filters.verifyDateTitle')}
        />
        <button className="btn btn-line btn-sm" onClick={() => void doVerify()} title={t('audit.verifyIntegrityTitle')}>
          <Icon name="check" size={14} /> {t('audit.verifyIntegrity')}
        </button>
        <button className="btn btn-line btn-sm" disabled={exporting} onClick={() => doExport('jsonl')}>
          <Icon name="inbox" size={14} /> {t('audit.exportJsonl')}
        </button>
        <button className="btn btn-line btn-sm" disabled={exporting} onClick={() => doExport('cef')}>
          <Icon name="inbox" size={14} /> {t('audit.exportCef')}
        </button>
        <button className="btn btn-line btn-sm" disabled={loading} onClick={() => void load(filters)}>
          <Icon name="refresh" size={14} /> {t('audit.refresh')}
        </button>
      </div>

      {/* Liste */}
      {items.length === 0 && !loading ? (
        <div style={{ color: 'var(--text-3)' }}>{t('audit.empty')}</div>
      ) : (
        <div style={{ display: 'grid', gap: 0 }}>
          {items.map((e) => {
            const isOpen = !!expanded[e.id];
            const sevColor = SEVERITY_COLOR[e.severity] ?? 'var(--text-3)';
            const failed = e.outcome === 'FAILURE';
            const detailStr = (() => {
              if (e.detail == null) return null;
              try {
                return JSON.stringify(e.detail, null, 2);
              } catch {
                return String(e.detail);
              }
            })();
            return (
              <div key={e.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <div
                  style={{
                    display: 'grid',
                    gridTemplateColumns: '140px 80px 1fr 1fr auto auto',
                    gap: 10,
                    alignItems: 'center',
                    fontSize: 12,
                    padding: '6px 8px',
                  }}
                >
                  <span style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                    {new Date(e.createdAt).toLocaleString()}
                  </span>
                  <span style={{ color: sevColor, fontWeight: 600 }}>{e.severity}</span>
                  <span style={{ minWidth: 0, overflow: 'hidden' }} title={e.action}>
                    <span style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                      {actionPhrase(t, e.action) ?? e.action}
                      {failed && <span style={{ color: '#c92a2a', marginLeft: 6 }}>{t('audit.failedSuffix')}</span>}
                    </span>
                    {e.resourceLabel && (
                      <span
                        style={{
                          color: 'var(--text-3)',
                          marginLeft: 8,
                          overflow: 'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace: 'nowrap',
                        }}
                        title={e.resourceLabel}
                      >
                        « {e.resourceLabel} »
                      </span>
                    )}
                  </span>
                  <span
                    style={{ color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={e.actorId ?? undefined}
                  >
                    {e.actorLabel || (e.actorType !== 'USER' ? actorLabel(t, e.actorType) : e.actorId?.slice(0, 8)) || t('audit.neverUsedDash')}
                  </span>
                  <span style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                    {e.statusCode ?? ''}
                  </span>
                  <button
                    className="btn btn-line btn-sm"
                    onClick={() => setExpanded((m) => ({ ...m, [e.id]: !m[e.id] }))}
                  >
                    {isOpen ? t('audit.hide') : t('audit.details')}
                  </button>
                </div>
                {isOpen && (
                  <div style={{ padding: '0 8px 10px', display: 'grid', gap: 6, fontSize: 12 }}>
                    <div style={{ color: 'var(--text-3)' }}>
                      <code>{e.id}</code>
                      {t('audit.actionDetail')}
                      <code>{e.action}</code>
                      {e.method && e.route && (
                        <>
                          {' · '}
                          <code>
                            {e.method} {e.route}
                          </code>
                        </>
                      )}
                      {e.ip && <> · IP <code>{e.ip}</code></>}
                      {e.resourceType && (
                        <>
                          {' · '}
                          {e.resourceType}
                          {e.resourceLabel ? <> « {e.resourceLabel} »</> : null}
                          {e.resourceId ? <> <code>{e.resourceId.slice(0, 8)}</code></> : null}
                        </>
                      )}
                      {t('audit.actorDetail')}
                      {actorLabel(t, e.actorType)}
                    </div>
                    {detailStr && (
                      <pre
                        style={{
                          margin: 0,
                          maxHeight: 260,
                          overflow: 'auto',
                          background: 'var(--surface-2)',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          padding: 8,
                          fontSize: 11,
                        }}
                      >
                        {detailStr}
                      </pre>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Pagination keyset */}
      <div style={{ display: 'flex', justifyContent: 'center', marginTop: 10 }}>
        {nextCursor && (
          <button
            className="btn btn-line btn-sm"
            disabled={loading}
            onClick={() => void load(filters, nextCursor)}
          >
            {loading ? t('common:loading') : t('audit.loadMore')}
          </button>
        )}
      </div>
    </div>
  );
}
