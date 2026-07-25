/* ============================================================
   Support & diagnostics — section admin (Sécurité & Conformité).
   Instantané in-app : santé DB/Redis/stockage, profondeurs de
   files de jobs, réglages redactés, dernières erreurs. Bouton de
   téléchargement (.json) à nous envoyer en cas d'incident + la
   procédure exacte des logs d'infrastructure à collecter côté hôtes.
   ============================================================ */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, saveBlob } from '../api/client';
import { Icon } from './primitives';

interface Flash {
  (msg: string, kind?: 'info' | 'ok' | 'err'): void;
}

type Probe = { status?: string; latencyMs?: number; detail?: string };

const STATUS_COLOR: Record<string, string> = {
  up: '#2f9e44',
  down: '#c92a2a',
  unknown: 'var(--text-3)',
};

function StatusDot({ status }: { status?: string }) {
  const color = STATUS_COLOR[status ?? 'unknown'] ?? STATUS_COLOR.unknown;
  return (
    <span
      style={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        background: color,
        marginRight: 6,
      }}
    />
  );
}

export default function DiagnosticsSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('security');
  const [bundle, setBundle] = useState<Record<string, any> | null>(null);
  const [loading, setLoading] = useState(true);
  const [showErrors, setShowErrors] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getDiagnostics();
      setBundle(data as Record<string, any>);
    } catch (e) {
      flash((e as Error).message || t('diag.loadError'), 'err');
    } finally {
      setLoading(false);
    }
  }, [flash, t]);

  useEffect(() => {
    void load();
  }, [load]);

  const download = useCallback(async () => {
    if (!bundle) return;
    try {
      // Récupère via la route /export (auditée) — c'est le SEUL appel qui
      // génère une entrée d'audit ; l'affichage/refresh ne logge rien.
      const fresh = await api.exportDiagnostics();
      const slug = (fresh?.tenant as any)?.slug ?? (bundle?.tenant as any)?.slug ?? 'org';
      const date = new Date().toISOString().slice(0, 10);
      const blob = new Blob([JSON.stringify(fresh, null, 2)], { type: 'application/json' });
      saveBlob(blob, `vaks-diagnostics-${slug}-${date}.json`);
      flash(t('diag.downloaded'), 'ok');
    } catch (e) {
      flash((e as Error).message, 'err');
    }
  }, [bundle, flash, t]);

  const copy = useCallback(
    (text: string) => {
      void navigator.clipboard?.writeText(text).then(
        () => flash(t('diag.copied'), 'ok'),
        () => flash(t('diag.copyError'), 'err'),
      );
    },
    [flash, t],
  );

  const health = bundle?.health ?? {};
  const app = bundle?.app ?? {};
  const queues = bundle?.queues ?? {};
  const email = bundle?.email ?? {};
  const emailFailures: any[] = email?.lastFailures ?? [];
  const errors: any[] = bundle?.recentErrors ?? [];
  const hostGuide = bundle?.hostLogsToCollect;

  const appStats: Array<[string, string]> = [
    ['version', String(app.version ?? '—')],
    ['node', String(app.nodeVersion ?? '—')],
    ['mode', String(app.tenancyMode ?? '—')],
    ['uptime', `${Math.round((app.uptimeSeconds ?? 0) / 60)} min`],
    ['rss', `${String(app.memoryMB ?? '—')} MB`],
    ['tenant', String(bundle?.tenant?.slug ?? '—')],
  ];

  return (
    <div className="asection-card" style={{ padding: 24 }}>
      {/* ---- En-tête ---- */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'flex-start',
          gap: 16,
          paddingBottom: 20,
          borderBottom: '1px solid var(--border)',
        }}
      >
        <div>
          <h3 style={{ margin: 0 }}>{t('diag.title')}</h3>
          <p className="muted" style={{ marginTop: 6, marginBottom: 0, maxWidth: 620, lineHeight: 1.55 }}>{t('diag.intro')}</p>
        </div>
        <div style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          <button className="btn" onClick={() => void load()} disabled={loading}>
            <Icon name="refresh" /> {t('diag.refresh')}
          </button>
          <button className="btn btn-primary" onClick={download} disabled={!bundle}>
            <Icon name="download" /> {t('diag.download')}
          </button>
        </div>
      </div>

      {loading && !bundle ? (
        <p className="muted" style={{ marginTop: 24 }}>{t('diag.loading')}</p>
      ) : bundle ? (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 32, marginTop: 28 }}>
          {/* ---- Santé des dépendances ---- */}
          <section>
            <SectionHead>{t('diag.healthTitle')}</SectionHead>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
              {(['db', 'redis', 's3'] as const).map((k) => {
                const p: Probe = health[k] ?? {};
                return (
                  <div key={k} className="md-card" style={{ padding: 14 }}>
                    <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{t(`diag.dep.${k}`)}</div>
                    <div style={{ marginTop: 8, fontWeight: 600 }}>
                      <StatusDot status={p.status} />
                      {p.status ?? 'unknown'}
                      {typeof p.latencyMs === 'number' && (
                        <span className="muted" style={{ fontWeight: 400 }}> · {p.latencyMs} ms</span>
                      )}
                    </div>
                    {p.detail && <div className="muted" style={{ fontSize: 11, marginTop: 6, wordBreak: 'break-word' }}>{p.detail}</div>}
                  </div>
                );
              })}
              {/* SMTP (configuré ?) */}
              <div className="md-card" style={{ padding: 14 }}>
                <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{t('diag.dep.smtp')}</div>
                <div style={{ marginTop: 8, fontWeight: 600 }}>
                  <StatusDot status={health.smtp?.configured ? 'up' : 'unknown'} />
                  {health.smtp?.configured ? t('diag.configured') : t('diag.notConfigured')}
                </div>
                {health.smtp?.host && <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>{String(health.smtp.host)}</div>}
              </div>
            </div>
          </section>

          {/* ---- Files de jobs ---- */}
          <section>
            <SectionHead>{t('diag.queuesTitle')}</SectionHead>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
              {Object.entries(queues).map(([name, q]: [string, any]) => (
                <div key={name} className="md-card" style={{ padding: 14 }}>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{name}</div>
                  {q && typeof q === 'object' && 'waiting' in q ? (
                    <div style={{ display: 'flex', gap: 14, marginTop: 8, fontSize: 13 }}>
                      <QueueStat label={t('diag.queueWaiting')} value={q.waiting} />
                      <QueueStat label={t('diag.queueActive')} value={q.active} />
                      <QueueStat label={t('diag.queueFailed')} value={q.failed} danger={q.failed > 0} />
                    </div>
                  ) : (
                    <div className="muted" style={{ marginTop: 8, fontSize: 13 }}>{t('diag.unknown')}</div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* ---- Email / SMTP ---- */}
          <section>
            <SectionHead>{t('diag.emailTitle')}</SectionHead>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: emailFailures.length ? 12 : 0 }}>
              {Object.entries(email?.counts ?? {}).length === 0 ? (
                <span className="muted" style={{ fontSize: 13 }}>{t('diag.emailNoData')}</span>
              ) : (
                Object.entries(email?.counts ?? {}).map(([status, n]: [string, any]) => (
                  <span
                    key={status}
                    className="mono"
                    style={{
                      fontSize: 12,
                      padding: '4px 10px',
                      borderRadius: 6,
                      border: '1px solid var(--border)',
                      background: 'var(--bg-2)',
                      color: status === 'FAILED' ? '#c92a2a' : status === 'SENT' ? '#2f9e44' : 'var(--text-3)',
                    }}
                  >
                    {status}: <b>{n}</b>
                  </span>
                ))
              )}
            </div>
            {emailFailures.length === 0 ? (
              Object.entries(email?.counts ?? {}).length > 0 && (
                <p className="muted" style={{ fontSize: 13, margin: 0 }}>{t('diag.emailNoFailures')}</p>
              )
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                {emailFailures.map((f, i) => (
                  <div key={i} className="md-card" style={{ padding: '8px 12px' }}>
                    <div style={{ display: 'flex', gap: 10, fontSize: 12, alignItems: 'baseline', flexWrap: 'wrap' }}>
                      <span className="mono" style={{ color: 'var(--text-3)' }}>{String(f.at).slice(0, 19).replace('T', ' ')}</span>
                      <span className="mono">{f.template}</span>
                      <span className="muted">→ {f.to}</span>
                    </div>
                    {f.error && <div className="mono" style={{ fontSize: 11, color: '#c92a2a', marginTop: 4, wordBreak: 'break-word' }}>{f.error}</div>}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ---- App ---- */}
          <section>
            <SectionHead>{t('diag.appTitle')}</SectionHead>
            <div
              className="md-card"
              style={{ padding: 14, display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(150px, 1fr))', gap: 14 }}
            >
              {appStats.map(([label, value]) => (
                <div key={label}>
                  <div className="mono" style={{ fontSize: 11, color: 'var(--text-3)', textTransform: 'uppercase', letterSpacing: '.04em' }}>{label}</div>
                  <div className="mono" style={{ fontSize: 13, marginTop: 4 }}>{value}</div>
                </div>
              ))}
            </div>
          </section>

          {/* ---- Dernières erreurs ---- */}
          <section>
            <SectionHead
              action={
                errors.length > 0 ? (
                  <button className="btn btn-sm" onClick={() => setShowErrors((s) => !s)}>
                    {showErrors ? t('diag.hide') : t('diag.show')}
                  </button>
                ) : undefined
              }
            >
              {t('diag.errorsTitle')} <span className="muted" style={{ fontWeight: 400 }}>({errors.length})</span>
            </SectionHead>
            {errors.length === 0 ? (
              <p className="muted" style={{ fontSize: 13, margin: 0 }}>{t('diag.noErrors')}</p>
            ) : showErrors ? (
              <div style={{ maxHeight: 260, overflow: 'auto', background: 'var(--bg-2)', border: '1px solid var(--border)', borderRadius: 8, padding: 12 }}>
                {errors.slice().reverse().map((e, i) => (
                  <div key={i} className="mono" style={{ fontSize: 11, marginBottom: 6, color: e.level === 'error' ? '#c92a2a' : '#e08e0b', lineHeight: 1.5 }}>
                    [{e.time?.slice(11, 19)}] {e.level?.toUpperCase()} {e.context ? `(${e.context}) ` : ''}{e.message}
                  </div>
                ))}
              </div>
            ) : null}
          </section>

          {/* ---- Procédure logs hôtes (niveau 2, séparé visuellement) ---- */}
          <section style={{ paddingTop: 28, borderTop: '1px solid var(--border)' }}>
            <SectionHead>{t('diag.hostTitle')}</SectionHead>
            <p className="muted" style={{ fontSize: 13, marginTop: -4, marginBottom: 16, maxWidth: 720, lineHeight: 1.55 }}>{hostGuide?.note ?? t('diag.hostNote')}</p>
            <div style={{ display: 'grid', gap: 14 }}>
              {(hostGuide?.categories ?? []).map((cat: any, i: number) => (
                <div key={i} className="md-card" style={{ padding: 14 }}>
                  <div style={{ fontWeight: 600 }}>{cat.area}</div>
                  <div className="muted" style={{ fontSize: 12, marginTop: 2, marginBottom: 10 }}>{cat.why}</div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(cat.commands ?? []).map((cmd: string, j: number) => (
                      <div key={j} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <code style={{ flex: 1, fontSize: 12, background: 'var(--bg-2)', border: '1px solid var(--border)', padding: '5px 8px', borderRadius: 5, wordBreak: 'break-all' }}>{cmd}</code>
                        <button className="btn btn-sm" style={{ flexShrink: 0 }} onClick={() => copy(cmd)}>
                          {t('diag.copy')}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

/** En-tête de bloc homogène : titre + action optionnelle, espacement constant. */
function SectionHead({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, marginBottom: 12 }}>
      <h4 style={{ margin: 0, fontSize: 13, textTransform: 'uppercase', letterSpacing: '.05em', color: 'var(--text-3)' }}>{children}</h4>
      {action}
    </div>
  );
}

function QueueStat({ label, value, danger }: { label: string; value: number; danger?: boolean }) {
  return (
    <div>
      <span className="muted" style={{ fontSize: 11 }}>{label}</span>
      <div style={{ fontWeight: 700, color: danger ? '#c92a2a' : undefined }}>{value}</div>
    </div>
  );
}
