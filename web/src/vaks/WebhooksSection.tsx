/* ============================================================
   Webhooks admin section (Phase 7).
   Liste des webhooks org + création/édition + test + journal des
   livraisons récentes. Style aligné sur le reste du panel admin
   (asection-card, btn, etc.).
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { Icon } from './primitives';
import { useConfirm } from './confirm';
import type {
  WebhookDto,
  WebhookDeliveryDto,
  WebhookScopeType,
  WebhookFormat,
  WebhookCreateDto,
  WebhookUpdateDto,
} from '@vaks-pm/shared';

interface Flash {
  (msg: string, kind?: 'info' | 'ok' | 'err'): void;
}

interface NamedRef {
  id: string;
  name: string;
}

interface FormState {
  id: string | null;
  url: string;
  label: string;
  events: Set<string>;
  active: boolean;
  secret: string;
  scopeType: WebhookScopeType;
  /** vide quand scopeType === 'ORG' */
  scopeId: string;
  format: WebhookFormat;
}

const BLANK: FormState = {
  id: null,
  url: '',
  label: '',
  events: new Set<string>(),
  active: true,
  secret: '',
  scopeType: 'ORG',
  scopeId: '',
  format: 'raw',
};

export default function WebhooksSection({
  flash,
  projectId,
}: {
  flash: Flash;
  /** Si fourni : mode self-service projet — scope verrouillé sur ce projet,
   *  appels API projet-scopés, pas de sélecteur de périmètre. */
  projectId?: string;
}) {
  const [hooks, setHooks] = useState<WebhookDto[]>([]);
  const [events, setEvents] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [edit, setEdit] = useState<FormState | null>(null);
  const [showSecret, setShowSecret] = useState<Record<string, boolean>>({});
  const [deliveries, setDeliveries] = useState<WebhookDeliveryDto[]>([]);
  const [deliveryFilter, setDeliveryFilter] = useState<string>('');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [projects, setProjects] = useState<NamedRef[]>([]);
  const [teams, setTeams] = useState<NamedRef[]>([]);
  const { t } = useTranslation('integrations');
  const confirm = useConfirm();

  // Adaptateur : route les opérations vers l'API admin (org) ou projet-scopée.
  const A = useMemo(
    () =>
      projectId
        ? {
            listEvents: () => api.listProjectWebhookEvents(projectId),
            list: () => api.listProjectWebhooks(projectId),
            create: (dto: WebhookCreateDto) => api.createProjectWebhook(projectId, dto),
            update: (id: string, dto: WebhookUpdateDto) =>
              api.updateProjectWebhook(projectId, id, dto),
            remove: (id: string) => api.deleteProjectWebhook(projectId, id),
            rotate: (id: string) => api.rotateProjectWebhookSecret(projectId, id),
            test: (id: string) => api.testProjectWebhook(projectId, id),
            listDeliveries: (q: { webhookId?: string; limit?: number }) =>
              api.listProjectWebhookDeliveries(projectId, { limit: q.limit }),
            retry: (id: string) => api.retryProjectWebhookDelivery(projectId, id),
          }
        : {
            listEvents: () => api.listWebhookEvents(),
            list: () => api.listWebhooks(),
            create: (dto: WebhookCreateDto) => api.createWebhook(dto),
            update: (id: string, dto: WebhookUpdateDto) => api.updateWebhook(id, dto),
            remove: (id: string) => api.deleteWebhook(id),
            rotate: (id: string) => api.rotateWebhookSecret(id),
            test: (id: string) => api.testWebhook(id),
            listDeliveries: (q: { webhookId?: string; limit?: number }) =>
              api.listWebhookDeliveries(q),
            retry: (id: string) => api.retryWebhookDelivery(id),
          },
    [projectId],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [hs, es, ds] = await Promise.all([
        A.list(),
        A.listEvents(),
        A.listDeliveries({ limit: 50 }),
      ]);
      setHooks(hs);
      setEvents(es.events);
      setDeliveries(ds);
      // Listes projet/équipe seulement utiles pour le sélecteur de périmètre (mode org).
      if (!projectId) {
        const [ps, ts] = await Promise.all([
          api.listProjects().catch(() => []),
          api.listTeams().catch(() => []),
        ]);
        setProjects(ps.map((p) => ({ id: p.id, name: p.name })));
        setTeams(ts.map((tm) => ({ id: tm.id, name: tm.name })));
      }
    } catch (e) {
      flash((e as Error).message, 'err');
    } finally {
      setLoading(false);
    }
  }, [flash, A, projectId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const refreshDeliveries = useCallback(async () => {
    try {
      const ds = await A.listDeliveries({
        webhookId: deliveryFilter || undefined,
        limit: 100,
      });
      setDeliveries(ds);
    } catch (e) {
      flash((e as Error).message, 'err');
    }
  }, [deliveryFilter, flash, A]);

  useEffect(() => {
    refreshDeliveries();
  }, [refreshDeliveries]);

  const submit = async () => {
    if (!edit) return;
    const events = Array.from(edit.events);
    if (!edit.url.trim()) return flash(t('webhooks.urlRequired'), 'err');
    if (events.length === 0) return flash(t('webhooks.eventRequired'), 'err');
    if (edit.scopeType !== 'ORG' && !edit.scopeId) {
      return flash(t('webhooks.scopeRequired'), 'err');
    }
    const scopeType = edit.scopeType;
    const scopeId = scopeType === 'ORG' ? null : edit.scopeId;
    try {
      if (edit.id) {
        const updated = await A.update(edit.id, {
          url: edit.url.trim(),
          label: edit.label.trim(),
          events,
          active: edit.active,
          secret: edit.secret.trim() || undefined,
          scopeType,
          scopeId,
          format: edit.format,
        });
        setHooks((prev) => prev.map((h) => (h.id === updated.id ? updated : h)));
        flash(t('webhooks.updated'), 'ok');
      } else {
        const created = await A.create({
          url: edit.url.trim(),
          label: edit.label.trim() || undefined,
          events,
          active: edit.active,
          secret: edit.secret.trim() || undefined,
          scopeType,
          scopeId,
          format: edit.format,
        });
        setHooks((prev) => [created, ...prev]);
        flash(t('webhooks.created'), 'ok');
      }
      setEdit(null);
    } catch (e) {
      flash((e as Error).message, 'err');
    }
  };

  /** Libellé lisible du périmètre d'un webhook pour l'affichage liste. */
  const scopeLabel = useCallback(
    (h: Pick<WebhookDto, 'scopeType' | 'scopeId'>): string => {
      if (h.scopeType === 'PROJECT') {
        return t('webhooks.scopeProject', {
          name: projects.find((p) => p.id === h.scopeId)?.name ?? t('webhooks.scopeProjectDeleted'),
        });
      }
      if (h.scopeType === 'TEAM') {
        return t('webhooks.scopeTeam', {
          name: teams.find((tm) => tm.id === h.scopeId)?.name ?? t('webhooks.scopeTeamDeleted'),
        });
      }
      return t('webhooks.scopeOrg');
    },
    [projects, teams, t],
  );

  const remove = async (id: string) => {
    if (!(await confirm({ title: t('common:delete'), message: t('webhooks.confirmDelete'), confirmLabel: t('common:delete'), danger: true }))) return;
    try {
      await A.remove(id);
      setHooks((prev) => prev.filter((h) => h.id !== id));
      flash(t('webhooks.deleted'), 'ok');
    } catch (e) {
      flash((e as Error).message, 'err');
    }
  };

  const rotate = async (id: string) => {
    if (!(await confirm({ title: t('common:confirm'), message: t('webhooks.confirmRotate'), danger: true }))) return;
    try {
      const updated = await A.rotate(id);
      setHooks((prev) => prev.map((h) => (h.id === updated.id ? updated : h)));
      setShowSecret((m) => ({ ...m, [id]: true }));
      flash(t('webhooks.secretRotated'), 'ok');
    } catch (e) {
      flash((e as Error).message, 'err');
    }
  };

  const sendTest = async (id: string) => {
    try {
      await A.test(id);
      flash(t('webhooks.testSent'), 'ok');
      setTimeout(refreshDeliveries, 1500);
    } catch (e) {
      flash((e as Error).message, 'err');
    }
  };

  const retry = async (id: string) => {
    try {
      await A.retry(id);
      flash(t('webhooks.retryQueued'), 'ok');
      setTimeout(refreshDeliveries, 1500);
    } catch (e) {
      flash((e as Error).message, 'err');
    }
  };

  const hookById = useMemo(() => new Map(hooks.map((h) => [h.id, h])), [hooks]);

  return (
    <div style={{ display: 'grid', gap: 18 }}>
      <div className="asection-card" style={{ padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ fontWeight: 700 }}>
            {t('webhooks.count', { count: hooks.length })}
          </div>
          <div className="grow" />
          <button className="btn btn-line btn-sm" onClick={refresh} disabled={loading}>
            <Icon name="refresh" size={14} /> {t('webhooks.refresh')}
          </button>
          <button
            className="btn btn-accent btn-sm"
            onClick={() =>
              setEdit({
                ...BLANK,
                events: new Set(),
                scopeType: projectId ? 'PROJECT' : 'ORG',
                scopeId: projectId ?? '',
              })
            }
          >
            <Icon name="plus" size={14} /> {t('webhooks.newWebhook')}
          </button>
        </div>
        {loading ? (
          <div style={{ color: 'var(--text-3)' }}>{t('common:loading')}</div>
        ) : hooks.length === 0 ? (
          <div style={{ color: 'var(--text-3)' }}>
            {t('webhooks.empty')}
          </div>
        ) : (
          <div style={{ display: 'grid', gap: 8 }}>
            {hooks.map((h) => (
              <div
                key={h.id}
                style={{
                  border: '1px solid var(--border)',
                  borderRadius: 8,
                  padding: 12,
                  display: 'grid',
                  gap: 6,
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      background: h.active ? '#15a37f' : '#9aa0a6',
                    }}
                  />
                  <div style={{ fontWeight: 600 }}>{h.label || h.url}</div>
                  {!projectId && (
                    <span
                      className="badge-soft"
                      style={{
                        fontSize: 11,
                        background:
                          h.scopeType === 'ORG' ? undefined : 'var(--accent-soft, rgba(80,120,255,.12))',
                      }}
                      title={t('webhooks.routingScopeTitle')}
                    >
                      {scopeLabel(h)}
                    </span>
                  )}
                  {!h.active && h.autoDisabledAt && (
                    <span
                      className="badge-soft"
                      style={{ fontSize: 11, background: 'rgba(201,42,42,.12)', color: '#c92a2a' }}
                      title={t('webhooks.autoDisabledTooltip', { date: new Date(h.autoDisabledAt).toLocaleString() })}
                    >
                      {t('webhooks.autoDisabled')}
                    </span>
                  )}
                  <div className="grow" />
                  <button className="btn btn-line btn-sm" onClick={() => sendTest(h.id)}>
                    {t('webhooks.sendTest')}
                  </button>
                  <button
                    className="btn btn-line btn-sm"
                    onClick={() =>
                      setEdit({
                        id: h.id,
                        url: h.url,
                        label: h.label,
                        events: new Set(h.events),
                        active: h.active,
                        secret: '',
                        scopeType: h.scopeType,
                        scopeId: h.scopeId ?? '',
                        format: h.format ?? 'raw',
                      })
                    }
                  >
                    {t('common:edit')}
                  </button>
                  <button className="btn btn-line btn-sm" onClick={() => remove(h.id)} style={{ color: '#c92a2a' }}>
                    {t('common:delete')}
                  </button>
                </div>
                <div style={{ fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: 12, color: 'var(--text-2)' }}>
                  {h.url}
                </div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                  {h.events.map((e) => (
                    <span key={e} className="badge-soft" style={{ fontSize: 11 }}>
                      {e}
                    </span>
                  ))}
                </div>
                <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
                  <span style={{ color: 'var(--text-3)' }}>{t('webhooks.secret')}</span>
                  <code style={{ fontSize: 11 }}>
                    {showSecret[h.id] ? h.secret : '••••••••••••••••'}
                  </code>
                  <button
                    className="btn btn-line btn-sm"
                    onClick={() => setShowSecret((m) => ({ ...m, [h.id]: !m[h.id] }))}
                  >
                    {showSecret[h.id] ? t('webhooks.hide') : t('webhooks.show')}
                  </button>
                  <button className="btn btn-line btn-sm" onClick={() => rotate(h.id)}>
                    {t('webhooks.rotate')}
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Journal des livraisons */}
      <div className="asection-card" style={{ padding: 14 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
          <div style={{ fontWeight: 700 }}>{t('webhooks.recentDeliveries')}</div>
          <div className="grow" />
          <select
            value={deliveryFilter}
            onChange={(e) => setDeliveryFilter(e.target.value)}
            className="select-sm"
            style={{
              padding: '4px 8px',
              borderRadius: 6,
              border: '1px solid var(--border)',
              background: 'var(--surface-2)',
              color: 'var(--text)',
            }}
          >
            <option value="">{t('webhooks.allWebhooks')}</option>
            {hooks.map((h) => (
              <option key={h.id} value={h.id}>
                {h.label || h.url}
              </option>
            ))}
          </select>
          <button className="btn btn-line btn-sm" onClick={refreshDeliveries}>
            <Icon name="refresh" size={14} /> {t('webhooks.refresh')}
          </button>
        </div>
        {deliveries.length === 0 ? (
          <div style={{ color: 'var(--text-3)' }}>{t('webhooks.noDeliveries')}</div>
        ) : (
          <div style={{ display: 'grid', gap: 6 }}>
            {deliveries.map((d) => {
              const color =
                d.status === 'SUCCESS' ? '#15a37f' : d.status === 'FAILED' ? '#c92a2a' : '#e08e0b';
              const hook = hookById.get(d.webhookId);
              const isOpen = !!expanded[d.id];
              const payloadStr = (() => {
                try {
                  return JSON.stringify(d.payload, null, 2);
                } catch {
                  return String(d.payload);
                }
              })();
              return (
                <div key={d.id} style={{ borderBottom: '1px solid var(--border)' }}>
                  <div
                    style={{
                      display: 'grid',
                      gridTemplateColumns: '90px 1fr 1fr auto auto',
                      gap: 10,
                      alignItems: 'center',
                      fontSize: 12,
                      padding: '6px 8px',
                    }}
                  >
                    <span style={{ color, fontWeight: 600 }}>
                      {d.status}
                      {d.responseStatus ? ` ${d.responseStatus}` : ''}
                    </span>
                    <span>{d.event}</span>
                    <span
                      style={{
                        color: 'var(--text-3)',
                        whiteSpace: 'nowrap',
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                      }}
                      title={hook?.url || ''}
                    >
                      {hook?.label || hook?.url || d.webhookId.slice(0, 8)}
                    </span>
                    <span style={{ color: 'var(--text-3)' }}>
                      {new Date(d.queuedAt).toLocaleString()}
                    </span>
                    <span style={{ display: 'flex', gap: 6 }}>
                      <span style={{ color: 'var(--text-3)' }}>×{d.attemptCount || 0}</span>
                      <button
                        className="btn btn-line btn-sm"
                        onClick={() => setExpanded((m) => ({ ...m, [d.id]: !m[d.id] }))}
                      >
                        {isOpen ? t('webhooks.hideDetails') : t('webhooks.details')}
                      </button>
                      {d.status === 'FAILED' && (
                        <button className="btn btn-line btn-sm" onClick={() => retry(d.id)}>
                          {t('webhooks.retry')}
                        </button>
                      )}
                    </span>
                  </div>
                  {isOpen && (
                    <div style={{ padding: '0 8px 10px', display: 'grid', gap: 8, fontSize: 12 }}>
                      {d.error && (
                        <div style={{ color: '#c92a2a' }}>
                          <b>{t('webhooks.error')}</b> {d.error}
                        </div>
                      )}
                      <div style={{ color: 'var(--text-3)' }}>
                        <Trans
                          t={t}
                          i18nKey="webhooks.deliveryHeaders"
                          values={{ id: d.id, event: d.event }}
                          components={{ 0: <code />, 1: <code />, 2: <code />, 3: <code />, 4: <code /> }}
                        />
                      </div>
                      <div>
                        <div style={{ color: 'var(--text-3)', marginBottom: 2 }}>{t('webhooks.payloadSent')}</div>
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
                          {payloadStr}
                        </pre>
                      </div>
                      {d.responseBody && (
                        <div>
                          <div style={{ color: 'var(--text-3)', marginBottom: 2 }}>
                            {t('webhooks.responseReceived', { status: d.responseStatus ? ` (HTTP ${d.responseStatus})` : '' })}
                          </div>
                          <pre
                            style={{
                              margin: 0,
                              maxHeight: 200,
                              overflow: 'auto',
                              background: 'var(--surface-2)',
                              border: '1px solid var(--border)',
                              borderRadius: 6,
                              padding: 8,
                              fontSize: 11,
                            }}
                          >
                            {d.responseBody}
                          </pre>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Modal édition / création */}
      {edit && (
        <div
          onClick={() => setEdit(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,.4)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--surface)',
              border: '1px solid var(--border)',
              color: 'var(--text)',
              borderRadius: 10,
              padding: 18,
              width: 'min(520px, 92vw)',
              maxHeight: '88vh',
              overflow: 'auto',
              display: 'grid',
              gap: 12,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 16 }}>
              {edit.id ? t('webhooks.editWebhook') : t('webhooks.newWebhook')}
            </div>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('webhooks.label')}</span>
              <input
                value={edit.label}
                onChange={(e) => setEdit({ ...edit, label: e.target.value })}
                placeholder={t('webhooks.labelPlaceholder')}
                style={{
                  padding: '8px 10px',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  background: 'var(--surface-2)',
                  color: 'var(--text)',
                }}
              />
            </label>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('webhooks.url')}</span>
              <input
                value={edit.url}
                onChange={(e) => setEdit({ ...edit, url: e.target.value })}
                placeholder={t('webhooks.urlPlaceholder')}
                style={{
                  padding: '8px 10px',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  background: 'var(--surface-2)',
                  color: 'var(--text)',
                  fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                  fontSize: 12,
                }}
              />
            </label>
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('webhooks.events')}</span>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {events.map((e) => {
                  const on = edit.events.has(e);
                  return (
                    <button
                      key={e}
                      type="button"
                      className={'btn btn-sm ' + (on ? 'btn-accent' : 'btn-line')}
                      onClick={() => {
                        const s = new Set(edit.events);
                        if (on) s.delete(e);
                        else s.add(e);
                        setEdit({ ...edit, events: s });
                      }}
                    >
                      {e}
                    </button>
                  );
                })}
              </div>
            </div>
            {!projectId && (
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {t('webhooks.scope')} <span style={{ opacity: 0.6 }}>{t('webhooks.scopeSubtitle')}</span>
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                {(['ORG', 'PROJECT', 'TEAM'] as WebhookScopeType[]).map((st) => {
                  const labels: Record<WebhookScopeType, string> = {
                    ORG: t('webhooks.scopeAllOrg'),
                    PROJECT: t('webhooks.scopeOneProject'),
                    TEAM: t('webhooks.scopeOneTeam'),
                  };
                  return (
                    <button
                      key={st}
                      type="button"
                      className={'btn btn-sm ' + (edit.scopeType === st ? 'btn-accent' : 'btn-line')}
                      onClick={() => setEdit({ ...edit, scopeType: st, scopeId: '' })}
                    >
                      {labels[st]}
                    </button>
                  );
                })}
              </div>
              {edit.scopeType !== 'ORG' && (
                <select
                  value={edit.scopeId}
                  onChange={(e) => setEdit({ ...edit, scopeId: e.target.value })}
                  style={{
                    padding: '8px 10px',
                    border: '1px solid var(--border)',
                    borderRadius: 6,
                    background: 'var(--surface-2)',
                    color: 'var(--text)',
                  }}
                >
                  <option value="">
                    {edit.scopeType === 'PROJECT' ? t('webhooks.chooseProject') : t('webhooks.chooseTeam')}
                  </option>
                  {(edit.scopeType === 'PROJECT' ? projects : teams).map((o) => (
                    <option key={o.id} value={o.id}>
                      {o.name}
                    </option>
                  ))}
                </select>
              )}
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {edit.scopeType === 'ORG'
                  ? t('webhooks.scopeHintOrg')
                  : edit.scopeType === 'PROJECT'
                    ? t('webhooks.scopeHintProject')
                    : t('webhooks.scopeHintTeam')}
              </span>
            </div>
            )}
            <div style={{ display: 'grid', gap: 6 }}>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {t('webhooks.payloadFormat')}
              </span>
              <div style={{ display: 'flex', gap: 6 }}>
                {([
                  ['raw', t('webhooks.formatRaw')],
                  ['teams', t('webhooks.formatTeams')],
                ] as [WebhookFormat, string][]).map(([f, lbl]) => (
                  <button
                    key={f}
                    type="button"
                    className={'btn btn-sm ' + (edit.format === f ? 'btn-accent' : 'btn-line')}
                    onClick={() => setEdit({ ...edit, format: f })}
                  >
                    {lbl}
                  </button>
                ))}
              </div>
              <span style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {edit.format === 'teams'
                  ? t('webhooks.formatHintTeams')
                  : t('webhooks.formatHintRaw')}
              </span>
            </div>
            <label style={{ display: 'grid', gap: 4 }}>
              <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
                {t('webhooks.secretLabel')} <span style={{ opacity: 0.6 }}>{t('webhooks.secretSubtitle')}</span>
              </span>
              <input
                value={edit.secret}
                onChange={(e) => setEdit({ ...edit, secret: e.target.value })}
                placeholder={edit.id ? t('webhooks.secretUnchanged') : t('webhooks.secretAutoGenerated')}
                style={{
                  padding: '8px 10px',
                  border: '1px solid var(--border)',
                  borderRadius: 6,
                  background: 'var(--surface-2)',
                  color: 'var(--text)',
                  fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace',
                  fontSize: 12,
                }}
              />
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="checkbox"
                checked={edit.active}
                onChange={(e) => setEdit({ ...edit, active: e.target.checked })}
              />
              <span>{t('webhooks.active')}</span>
            </label>
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button className="btn btn-line btn-sm" onClick={() => setEdit(null)}>
                {t('common:cancel')}
              </button>
              <button className="btn btn-accent btn-sm" onClick={submit}>
                {edit.id ? t('common:save') : t('common:create')}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
