/* ============================================================
   Email deliveries — section admin (Notifications & Email).
   Journal des envois (EmailDelivery) : statut, template, destinataire,
   sujet, erreur SMTP. Lecture seule (debug).

   Présentation alignée sur le journal d'audit (`AuditLogSection`) : lignes
   denses horodatées + détail dépliable, barre de filtres compacte, pagination
   « Charger plus ». Même vocabulaire visuel pour deux journaux lus de la
   même façon.

   Le journal peut compter des dizaines de milliers de lignes : le filtre par
   statut et la pagination sont SERVEUR (keyset), et la fenêtre est bornée à la
   rétention (30 j). Les compteurs des filtres viennent de `counts` (toute la
   fenêtre) — les compter sur la page affichée les rendrait faux.
   ============================================================ */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { EmailDeliveryDto } from '../api/client';
import { Icon } from './primitives';

interface Flash {
  (msg: string, kind?: 'info' | 'ok' | 'err'): void;
}

const STATUSES = ['ALL', 'QUEUED', 'SENT', 'FAILED', 'SKIPPED'] as const;
type StatusFilter = (typeof STATUSES)[number];

const STATUS_COLOR: Record<string, string> = {
  SENT: '#2f9e44',
  FAILED: '#c92a2a',
  QUEUED: '#e08e0b',
  SKIPPED: 'var(--text-3)',
};

/** Pages courtes : un journal de debug se scanne, il ne se lit pas en entier. */
const PAGE_SIZE = 10;

/** `2026-07-16 21:11:33` — heure locale, secondes incluses (corrélation SMTP). */
function stamp(iso: string): string {
  const d = new Date(iso);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export default function EmailDeliveriesSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('integrations');
  const [items, setItems] = useState<EmailDeliveryDto[]>([]);
  const [counts, setCounts] = useState<Record<string, number>>({});
  const [retentionDays, setRetentionDays] = useState(30);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [filter, setFilter] = useState<StatusFilter>('ALL');
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});

  /** `from` absent = première page (remplace la liste au lieu de l'étendre). */
  const load = useCallback(
    async (status: StatusFilter, from?: string) => {
      const first = !from;
      if (first) setLoading(true);
      else setLoadingMore(true);
      try {
        const page = await api.listEmailDeliveries({ status, cursor: from, pageSize: PAGE_SIZE });
        setItems((prev) => (first ? page.items : [...prev, ...page.items]));
        setCounts(page.counts);
        setRetentionDays(page.retentionDays);
        setCursor(page.nextCursor);
      } catch (e) {
        flash((e as Error).message, 'err');
      } finally {
        setLoading(false);
        setLoadingMore(false);
      }
    },
    [flash],
  );

  useEffect(() => {
    void load(filter);
  }, [load, filter]);

  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <div className="asection-card" style={{ padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h3 style={{ margin: 0, fontSize: 15 }}>{t('emailDeliveries.title')}</h3>
          <p className="muted" style={{ marginTop: 4, marginBottom: 0, maxWidth: 620, lineHeight: 1.5, fontSize: 12 }}>
            {t('emailDeliveries.intro')} {t('emailDeliveries.retention', { days: retentionDays })}
          </p>
        </div>
        <button className="btn btn-line btn-sm" onClick={() => void load(filter)} disabled={loading} style={{ flexShrink: 0 }}>
          <Icon name="refresh" size={14} /> {t('emailDeliveries.refresh')}
        </button>
      </div>

      {/* Barre de filtres — statut serveur + compteurs sur toute la fenêtre */}
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center', marginTop: 12, marginBottom: 8 }}>
        {STATUSES.map((s) => {
          const active = filter === s;
          const n = s === 'ALL' ? total : counts[s] ?? 0;
          const color = s === 'ALL' ? 'var(--text-2)' : STATUS_COLOR[s];
          return (
            <button
              key={s}
              className="btn btn-line btn-sm mono"
              onClick={() => setFilter(s)}
              style={{
                fontSize: 11,
                padding: '2px 8px',
                borderColor: active ? color : 'var(--border)',
                color: active ? color : 'var(--text-3)',
                background: active ? `color-mix(in srgb, ${color} 12%, transparent)` : undefined,
                fontWeight: active ? 700 : 500,
              }}
            >
              {s === 'ALL' ? t('emailDeliveries.all') : s} <span style={{ opacity: 0.7 }}>{n}</span>
            </button>
          );
        })}
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{t('emailDeliveries.loading')}</div>
      ) : items.length === 0 ? (
        <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{t('emailDeliveries.empty')}</div>
      ) : (
        <div style={{ display: 'grid', gap: 0, borderTop: '1px solid var(--border)' }}>
          {items.map((d) => {
            const isOpen = !!expanded[d.id];
            const color = STATUS_COLOR[d.status] ?? 'var(--text-3)';
            return (
              <div key={d.id} style={{ borderBottom: '1px solid var(--border)' }}>
                <div
                  style={{
                    display: 'grid',
                    // minmax(0,1fr) : sans le 0, le contenu long pousse la grille
                    // au lieu d'être tronqué par l'ellipsis.
                    gridTemplateColumns: '150px 70px 90px minmax(0, 1.4fr) minmax(0, 1fr) auto',
                    gap: 10,
                    alignItems: 'center',
                    fontSize: 12,
                    padding: '6px 8px',
                  }}
                >
                  <span className="mono" style={{ color: 'var(--text-3)', whiteSpace: 'nowrap' }}>
                    {stamp(d.queuedAt)}
                  </span>
                  <span className="mono" style={{ color, fontWeight: 700, fontSize: 11 }}>
                    {d.status}
                  </span>
                  <span
                    className="mono"
                    style={{ color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={d.template}
                  >
                    {d.template}
                  </span>
                  <span
                    style={{ fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={d.subject}
                  >
                    {d.subject}
                  </span>
                  <span
                    className="mono"
                    style={{ color: 'var(--text-3)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                    title={d.toAddress}
                  >
                    {d.toAddress}
                  </span>
                  <button
                    className="btn btn-line btn-sm"
                    onClick={() => setExpanded((m) => ({ ...m, [d.id]: !m[d.id] }))}
                  >
                    {isOpen ? t('emailDeliveries.hide') : t('emailDeliveries.details')}
                  </button>
                </div>
                {isOpen && (
                  <div style={{ padding: '0 8px 10px', display: 'grid', gap: 6, fontSize: 12 }}>
                    <div style={{ color: 'var(--text-3)' }}>
                      <code>{d.id}</code> · {t('emailDeliveries.field.template')} <code>{d.template}</code> ·{' '}
                      {t('emailDeliveries.field.to')} <code>{d.toAddress}</code>
                    </div>
                    <div style={{ color: 'var(--text-3)' }}>
                      {t('emailDeliveries.field.queuedAt')} <code>{d.queuedAt}</code>
                      {' · '}
                      {t('emailDeliveries.field.sentAt')} <code>{d.sentAt ?? '—'}</code>
                    </div>
                    <div style={{ wordBreak: 'break-word' }}>{d.subject}</div>
                    {d.error && (
                      <pre
                        className="mono"
                        style={{
                          margin: 0,
                          maxHeight: 260,
                          overflow: 'auto',
                          background: 'var(--surface-2)',
                          border: '1px solid var(--border)',
                          borderRadius: 6,
                          padding: 8,
                          fontSize: 11,
                          color: '#c92a2a',
                          whiteSpace: 'pre-wrap',
                          wordBreak: 'break-word',
                        }}
                      >
                        {d.error}
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
        {cursor && (
          <button className="btn btn-line btn-sm" disabled={loadingMore} onClick={() => void load(filter, cursor)}>
            {loadingMore ? t('emailDeliveries.loading') : t('emailDeliveries.loadMore')}
          </button>
        )}
      </div>
    </div>
  );
}
