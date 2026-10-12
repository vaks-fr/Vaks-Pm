/* ============================================================
   Vaks — Risk register (RAID, MVP=RISK) — project tab.
   Three blocks: a probability×impact heatmap, a risk-exposure panel
   (critical gauge + severity bars + automation-rule summary) and a
   sortable register table. Manual CRUD + risks with source=AUTO fed by
   the automations engine (milestone at risk, budget threshold, forecast
   overrun) — see api/src/risks/risk-auto.service.ts. Editing works the
   same for MANUAL and AUTO risks; the auto-feed never overwrites
   status/mitigation/owner on an AUTO risk a human has touched.
   ============================================================ */
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import type { ProjectMemberDto, RiskCategory, RiskStatus } from '@vaks-pm/shared';
import { RISK_CATEGORIES, RISK_STATUSES } from '@vaks-pm/shared';
import { api } from '../api/client';
import { apiCreateRisk, apiDeleteRisk, apiListRisks, apiResolveRisk, apiUpdateRisk, type RiskDto } from './api';
import { Icon, Avatar } from './primitives';
import { avatarUser } from './projects/shared';
import { useAuth } from '../auth/AuthContext';
import { useConfirm } from './confirm';

interface Props {
  projectId: string;
}

const STATUS_TONE: Record<RiskStatus, string> = {
  OPEN: 'var(--amber)',
  MITIGATING: 'var(--accent)',
  RESOLVED: 'var(--good)',
  ACCEPTED: 'var(--text-3)',
};

/** Segment auquel appartient un statut (contrôle segmenté du registre). */
type StatusGroup = 'open' | 'mitigating' | 'closed';
const STATUS_GROUP: Record<RiskStatus, StatusGroup> = {
  OPEN: 'open',
  MITIGATING: 'mitigating',
  RESOLVED: 'closed',
  ACCEPTED: 'closed',
};

/** Score 1-25 → palier de sévérité (4 paliers, comme la maquette). */
type Sev = 'low' | 'medium' | 'high' | 'critical';
function severityOf(score: number): Sev {
  if (score >= 15) return 'critical';
  if (score >= 10) return 'high';
  if (score >= 5) return 'medium';
  return 'low';
}
const SEV_ORDER: Sev[] = ['critical', 'high', 'medium', 'low'];
const SEV_COLOR: Record<Sev, string> = {
  low: 'var(--good)',
  medium: 'var(--amber)',
  high: 'color-mix(in oklab, var(--danger) 58%, var(--amber))',
  critical: 'var(--danger)',
};
const SEV_BG: Record<Sev, string> = {
  low: 'var(--good-bg)',
  medium: 'var(--amber-bg)',
  high: 'color-mix(in oklab, var(--danger) 20%, var(--surface))',
  critical: 'var(--danger-bg)',
};

/** Règles d'automatisation qui peuvent alimenter le registre (source=AUTO). */
const AUTO_RULES: Array<{ kind: string; icon: string }> = [
  { kind: 'milestone_at_risk', icon: 'flag' },
  { kind: 'budget_threshold', icon: 'coins' },
  { kind: 'forecast_overrun', icon: 'gauge' },
];

type DraftRisk = {
  title: string;
  description: string;
  probability: number;
  impact: number;
  category: RiskCategory;
  mitigation: string;
  ownerId: string | null;
  status: RiskStatus;
};

const EMPTY_DRAFT: DraftRisk = {
  title: '',
  description: '',
  probability: 3,
  impact: 3,
  category: 'RISK',
  mitigation: '',
  ownerId: null,
  status: 'OPEN',
};

export function RisksView({ projectId }: Props) {
  const { t } = useTranslation('risks');
  const { can } = useAuth();
  const canManage = can('risk:manage');
  const confirm = useConfirm();

  const [risks, setRisks] = useState<RiskDto[]>([]);
  const [members, setMembers] = useState<ProjectMemberDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState<string | null>(null);
  const [cellFilter, setCellFilter] = useState<{ probability: number; impact: number } | null>(null);
  const [statusFilter, setStatusFilter] = useState<'all' | StatusGroup>('all');

  const [modal, setModal] = useState<{ mode: 'create' } | { mode: 'edit'; risk: RiskDto } | null>(null);
  const [draft, setDraft] = useState<DraftRisk>(EMPTY_DRAFT);
  const [saving, setSaving] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    apiListRisks(projectId)
      .then(setRisks)
      .catch(() => setRisks([]))
      .finally(() => setLoading(false));
    api.listProjectMembers(projectId).then(setMembers).catch(() => setMembers([]));
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  useEffect(() => {
    if (!toast) return;
    const id = setTimeout(() => setToast(null), 2600);
    return () => clearTimeout(id);
  }, [toast]);

  // Radar : les risques « vivants » (non résolus) pèsent sur la heatmap et
  // l'exposition ; un risque résolu ne compte plus.
  const live = useMemo(() => risks.filter((r) => r.status !== 'RESOLVED'), [risks]);

  const matrix = useMemo(() => {
    const grid: number[][] = Array.from({ length: 5 }, () => [0, 0, 0, 0, 0]);
    for (const r of live) {
      const p = Math.min(5, Math.max(1, r.probability));
      const i = Math.min(5, Math.max(1, r.impact));
      grid[p - 1][i - 1]++;
    }
    return grid;
  }, [live]);

  // Exposition : comptes par palier de sévérité + part de critiques (jauge).
  const sevCounts = useMemo(() => {
    const c: Record<Sev, number> = { low: 0, medium: 0, high: 0, critical: 0 };
    for (const r of live) c[severityOf(r.score)]++;
    return c;
  }, [live]);
  const liveTotal = live.length;
  const maxSev = Math.max(1, ...SEV_ORDER.map((s) => sevCounts[s]));
  const criticalShare = liveTotal ? sevCounts.critical / liveTotal : 0;

  // Résumé des règles d'automatisation (lecture seule — l'activation vit dans
  // l'admin Automatisations, pas ici) : combien de risques AUTO chaque règle a levé.
  const ruleCounts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const r of risks) if (r.source === 'AUTO' && r.autoRuleKind) c[r.autoRuleKind] = (c[r.autoRuleKind] ?? 0) + 1;
    return c;
  }, [risks]);

  // Compteurs du contrôle segmenté (sur les risques déjà filtrés par cellule).
  const cellScoped = useMemo(() => {
    if (!cellFilter) return risks;
    return risks.filter((r) => r.probability === cellFilter.probability && r.impact === cellFilter.impact);
  }, [risks, cellFilter]);
  const groupCounts = useMemo(() => {
    const g = { all: cellScoped.length, open: 0, mitigating: 0, closed: 0 };
    for (const r of cellScoped) g[STATUS_GROUP[r.status]]++;
    return g;
  }, [cellScoped]);

  const visibleRisks = useMemo(() => {
    const list =
      statusFilter === 'all' ? cellScoped : cellScoped.filter((r) => STATUS_GROUP[r.status] === statusFilter);
    return [...list].sort((a, b) => b.score - a.score);
  }, [cellScoped, statusFilter]);

  function openCreate() {
    setDraft(EMPTY_DRAFT);
    setModal({ mode: 'create' });
  }

  function openEdit(r: RiskDto) {
    setDraft({
      title: r.title,
      description: r.description ?? '',
      probability: r.probability,
      impact: r.impact,
      category: r.category,
      mitigation: r.mitigation ?? '',
      ownerId: r.ownerId,
      status: r.status,
    });
    setModal({ mode: 'edit', risk: r });
  }

  async function save() {
    const title = draft.title.trim();
    if (!title) {
      setToast(t('titleRequired'));
      return;
    }
    setSaving(true);
    try {
      if (modal?.mode === 'edit') {
        const updated = await apiUpdateRisk(projectId, modal.risk.id, {
          title,
          description: draft.description || null,
          probability: draft.probability,
          impact: draft.impact,
          category: draft.category,
          mitigation: draft.mitigation || null,
          ownerId: draft.ownerId,
          status: draft.status,
        });
        setRisks((prev) => prev.map((r) => (r.id === updated.id ? updated : r)));
        setToast(t('saved'));
      } else {
        const created = await apiCreateRisk(projectId, {
          title,
          description: draft.description || null,
          probability: draft.probability,
          impact: draft.impact,
          category: draft.category,
          mitigation: draft.mitigation || null,
          ownerId: draft.ownerId,
          status: draft.status,
        });
        setRisks((prev) => [created, ...prev]);
        setToast(t('created'));
      }
      setModal(null);
    } catch (e) {
      setToast((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  async function resolve(r: RiskDto) {
    try {
      const updated = await apiResolveRisk(projectId, r.id);
      setRisks((prev) => prev.map((x) => (x.id === updated.id ? updated : x)));
      setToast(t('resolved'));
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  async function remove(r: RiskDto) {
    if (!(await confirm({ title: t('confirmDeleteTitle'), message: t('confirmDelete'), danger: true }))) return;
    try {
      await apiDeleteRisk(projectId, r.id);
      setRisks((prev) => prev.filter((x) => x.id !== r.id));
      setToast(t('deleted'));
    } catch (e) {
      setToast((e as Error).message);
    }
  }

  const ownerOptions = members.map((m) => m.user);

  // Géométrie de la jauge (donut) — part de critiques.
  const GAUGE_R = 54;
  const GAUGE_C = 2 * Math.PI * GAUGE_R;
  const SEG: Array<{ key: 'all' | StatusGroup; count: number }> = [
    { key: 'all', count: groupCounts.all },
    { key: 'open', count: groupCounts.open },
    { key: 'mitigating', count: groupCounts.mitigating },
    { key: 'closed', count: groupCounts.closed },
  ];

  return (
    <div className="rk-view">
      {toast && (
        <div
          style={{
            position: 'fixed', top: 16, right: 16, zIndex: 9000,
            background: 'var(--surface)', border: '1px solid var(--border-2)', borderRadius: 'var(--r-sm)',
            padding: '9px 14px', fontSize: 13, fontWeight: 600, boxShadow: 'var(--ghost-shadow, 0 8px 24px rgba(0,0,0,.18))',
          }}
        >
          {toast}
        </div>
      )}

      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start', flexWrap: 'wrap', gap: 10 }}>
        <div style={{ fontSize: 12.5, color: 'var(--text-3)', maxWidth: 560 }}>
          {canManage ? t('emptyHint') : t('readOnlyHint')}
        </div>
        {canManage && (
          <button className="btn btn-accent btn-sm" onClick={openCreate}>
            <Icon name="plus" size={14} /> {t('newRisk')}
          </button>
        )}
      </div>

      {/* ==== Top: heatmap + exposure ==== */}
      <div className="rk-grid">
        {/* ---- Block A · probability × impact matrix ---- */}
        <div className="card rk-block">
          <div className="rk-block-head">
            <div className="rk-block-title">{t('matrix.title')}</div>
            <div className="rk-block-sub">
              {cellFilter ? (
                <button className="rk-clear" onClick={() => setCellFilter(null)}>
                  P{cellFilter.probability} × I{cellFilter.impact} · <span>{t('matrix.clear')}</span>
                </button>
              ) : (
                t('matrix.activeCount', { count: liveTotal })
              )}
            </div>
          </div>

          <div className="rk-matrix">
            <div className="rk-axis-y">{t('matrix.probability')}</div>
            <div className="rk-yscale">
              {[5, 4, 3, 2, 1].map((p) => (
                <span key={p}>{t(`matrix.probScale.${p}`)}</span>
              ))}
            </div>
            <div className="rk-mgrid">
              {[5, 4, 3, 2, 1].map((p) =>
                [1, 2, 3, 4, 5].map((i) => {
                  const count = matrix[p - 1][i - 1];
                  const score = p * i;
                  const sev = severityOf(score);
                  const active = cellFilter?.probability === p && cellFilter?.impact === i;
                  return (
                    <button
                      key={`${p}-${i}`}
                      type="button"
                      className={'rk-cell' + (active ? ' active' : '')}
                      style={{
                        ['--sc' as string]: SEV_COLOR[sev],
                        background: `color-mix(in oklab, ${SEV_COLOR[sev]} 13%, var(--surface))`,
                        borderColor: `color-mix(in oklab, ${SEV_COLOR[sev]} 32%, transparent)`,
                      } as CSSProperties}
                      title={`${t(`matrix.probScale.${p}`)} × ${t(`matrix.impactScale.${i}`)} · ${t('matrix.cellCount', { count })}`}
                      onClick={() => setCellFilter(active ? null : { probability: p, impact: i })}
                    >
                      <span className="rk-cell-score mono">{score}</span>
                      {count > 0 && (
                        <span
                          className="rk-cell-count mono"
                          style={{
                            background: `color-mix(in oklab, ${SEV_COLOR[sev]} 80%, var(--surface))`,
                            borderColor: SEV_COLOR[sev],
                          }}
                        >
                          {count}
                        </span>
                      )}
                    </button>
                  );
                }),
              )}
            </div>
            <div className="rk-xscale">
              {[1, 2, 3, 4, 5].map((i) => (
                <span key={i}>{t(`matrix.impactScale.${i}`)}</span>
              ))}
            </div>
            <div className="rk-axis-x">{t('matrix.impact')}</div>
          </div>

          <div className="rk-legend">
            {SEV_ORDER.slice()
              .reverse()
              .map((s) => (
                <span className="rk-legend-item" key={s}>
                  <i className="rk-legend-dot" style={{ background: SEV_COLOR[s] }} /> {t(`sev.${s}`)} · {t(`matrix.range.${s}`)}
                </span>
              ))}
          </div>
        </div>

        {/* ---- Block B · risk exposure ---- */}
        <div className="card rk-block">
          <div className="rk-block-head">
            <div className="rk-block-title">{t('exposure.title')}</div>
            <div className="rk-block-sub">{t('matrix.activeCount', { count: liveTotal })}</div>
          </div>

          <div className="rk-expo-top">
            <div className="rk-gauge">
              <svg width="120" height="120" viewBox="0 0 120 120" aria-hidden="true">
                <circle cx="60" cy="60" r={GAUGE_R} fill="none" stroke="var(--surface-3)" strokeWidth="12" />
                <circle
                  cx="60" cy="60" r={GAUGE_R} fill="none" stroke={SEV_COLOR.critical} strokeWidth="12"
                  strokeLinecap="round" transform="rotate(-90 60 60)"
                  strokeDasharray={`${criticalShare * GAUGE_C} ${GAUGE_C}`}
                  style={{ transition: 'stroke-dasharray .5s var(--ease, ease)' }}
                />
              </svg>
              <div className="rk-gauge-mid">
                <b className="mono">{sevCounts.critical}</b>
                <span>{t('sev.critical')}</span>
              </div>
            </div>

            <div className="rk-sevbars">
              {SEV_ORDER.map((s) => (
                <div className="rk-sevbar" key={s}>
                  <i className="rk-legend-dot" style={{ background: SEV_COLOR[s] }} />
                  <span className="rk-sevbar-lbl">{t(`sev.${s}`)}</span>
                  <span className="rk-sevbar-track">
                    <span className="rk-sevbar-fill" style={{ width: `${(sevCounts[s] / maxSev) * 100}%`, background: SEV_COLOR[s] }} />
                  </span>
                  <span className="rk-sevbar-n mono">{sevCounts[s]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="rk-auto">
            <div className="rk-auto-head">
              <Icon name="zap" size={13} /> {t('automation.header')}
            </div>
            {AUTO_RULES.map((rule) => {
              const n = ruleCounts[rule.kind] ?? 0;
              const on = n > 0;
              return (
                <div className={'rk-rule' + (on ? '' : ' idle')} key={rule.kind}>
                  <div className="rk-rule-ico">
                    <Icon name={rule.icon} size={15} />
                  </div>
                  <div className="rk-rule-txt">
                    <b>{t(`automation.rule.${rule.kind}`)}</b>
                    <span>{on ? t('automation.raised', { count: n }) : t('automation.idle')}</span>
                  </div>
                  <span className={'rk-rule-state' + (on ? ' on' : '')}>{on ? t('automation.active') : t('automation.off')}</span>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ==== Block C · register ==== */}
      <div className="card rk-block" style={{ padding: 0 }}>
        <div className="rk-reg-head">
          <div className="rk-block-title" style={{ flex: 1 }}>{t('title')}</div>
          <div className="seg">
            {SEG.map((s) => (
              <button
                key={s.key}
                type="button"
                className={'seg-btn' + (statusFilter === s.key ? ' seg-on' : '')}
                onClick={() => setStatusFilter(s.key)}
              >
                {t(`seg.${s.key}`)} {s.count}
              </button>
            ))}
          </div>
        </div>

        {loading ? (
          <div style={{ padding: 20, fontSize: 13, color: 'var(--text-3)' }}>{t('loading')}</div>
        ) : visibleRisks.length === 0 ? (
          <div style={{ padding: 20, fontSize: 13, color: 'var(--text-3)' }}>{t('empty')}</div>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table className="rk-table">
              <thead>
                <tr>
                  <th>{t('col.risk')}</th>
                  <th>{t('col.owner')}</th>
                  <th className="ac">{t('col.probImpact')}</th>
                  <th className="ac">{t('col.score')}</th>
                  <th>{t('col.status')}</th>
                  {canManage && <th />}
                </tr>
              </thead>
              <tbody>
                {visibleRisks.map((r) => {
                  const sev = severityOf(r.score);
                  return (
                    <tr key={r.id}>
                      <td>
                        <div className="rk-risk-title">{r.title}</div>
                        <div className="rk-risk-meta">
                          {t(`category.${r.category}`)}
                          <span className="rk-meta-sep">·</span>
                          {r.source === 'AUTO' ? (
                            <span
                              className="rk-source auto"
                              title={r.autoRuleKind ? t('autoBadgeHint', { rule: r.autoRuleKind }) : undefined}
                            >
                              <Icon name="zap" size={10} />
                              {r.autoRuleKind ? t(`automation.rule.${r.autoRuleKind}`) : t('source.AUTO')}
                            </span>
                          ) : (
                            <span className="rk-source">{t('source.MANUAL')}</span>
                          )}
                        </div>
                      </td>
                      <td>
                        {r.owner ? (
                          <span className="row" style={{ gap: 8 }}>
                            <Avatar user={avatarUser(r.owner)} size={26} />
                            <span style={{ fontSize: 12.5 }}>{r.owner.name}</span>
                          </span>
                        ) : (
                          <span style={{ fontSize: 12.5, color: 'var(--text-faint)' }}>{t('noOwner')}</span>
                        )}
                      </td>
                      <td className="ac">
                        <span className="rk-pi mono">P{r.probability} × I{r.impact}</span>
                      </td>
                      <td className="ac">
                        <span
                          className="rk-score"
                          style={{ background: SEV_BG[sev], color: SEV_COLOR[sev], border: `1px solid color-mix(in oklab, ${SEV_COLOR[sev]} 40%, transparent)` }}
                        >
                          {r.score}
                        </span>
                      </td>
                      <td>
                        <span className="rk-status" style={{ color: STATUS_TONE[r.status] }}>
                          <i style={{ background: STATUS_TONE[r.status] }} />
                          {t(`status.${r.status}`)}
                        </span>
                      </td>
                      {canManage && (
                        <td>
                          <div className="row" style={{ gap: 4, justifyContent: 'flex-end' }}>
                            <button className="btn btn-ghost btn-sm" onClick={() => openEdit(r)} title={t('action.edit')}>
                              <Icon name="pencil" size={13} />
                            </button>
                            {r.status !== 'RESOLVED' && (
                              <button className="btn btn-ghost btn-sm" onClick={() => resolve(r)} title={t('action.resolve')}>
                                <Icon name="check" size={13} />
                              </button>
                            )}
                            <button className="btn btn-ghost btn-sm" onClick={() => remove(r)} title={t('action.delete')}>
                              <Icon name="x" size={13} />
                            </button>
                          </div>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {modal && (
        <div className="md-overlay" onMouseDown={() => !saving && setModal(null)}>
          <div className="md-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
            <div className="md-head">
              <div>
                <div className="md-eyebrow">{t('title')}</div>
                <div className="md-title">{modal.mode === 'edit' ? t('editTitle') : t('createTitle')}</div>
              </div>
            </div>
            <div className="md-body">
              <div className="md-field">
                <div className="md-label">{t('field.title')}</div>
                <input
                  className="rk-input"
                  value={draft.title}
                  onChange={(e) => setDraft((d) => ({ ...d, title: e.target.value }))}
                  autoFocus
                />
              </div>

              <div className="md-field">
                <div className="md-label">{t('field.description')}</div>
                <textarea
                  className="rk-textarea"
                  rows={2}
                  value={draft.description}
                  onChange={(e) => setDraft((d) => ({ ...d, description: e.target.value }))}
                />
              </div>

              <div className="row" style={{ gap: 20, flexWrap: 'wrap' }}>
                <div className="md-field">
                  <div className="md-label">{t('field.probability')}</div>
                  <div className="seg">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={'seg-btn' + (draft.probability === n ? ' seg-on' : '')}
                        onClick={() => setDraft((d) => ({ ...d, probability: n }))}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="md-field">
                  <div className="md-label">{t('field.impact')}</div>
                  <div className="seg">
                    {[1, 2, 3, 4, 5].map((n) => (
                      <button
                        key={n}
                        type="button"
                        className={'seg-btn' + (draft.impact === n ? ' seg-on' : '')}
                        onClick={() => setDraft((d) => ({ ...d, impact: n }))}
                      >
                        {n}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="md-field">
                  <div className="md-label">{t('field.score')}</div>
                  <div className="mono" style={{ fontWeight: 800, fontSize: 15, padding: '5px 0' }}>
                    {draft.probability * draft.impact}
                  </div>
                </div>
              </div>

              <div className="md-field">
                <div className="md-label">{t('field.category')}</div>
                <select
                  className="rk-select"
                  value={draft.category}
                  onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value as RiskCategory }))}
                >
                  {RISK_CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`category.${c}`)}
                    </option>
                  ))}
                </select>
              </div>

              <div className="md-field">
                <div className="md-label">{t('field.status')}</div>
                <div className="seg">
                  {RISK_STATUSES.map((s) => (
                    <button
                      key={s}
                      type="button"
                      className={'seg-btn' + (draft.status === s ? ' seg-on' : '')}
                      onClick={() => setDraft((d) => ({ ...d, status: s }))}
                    >
                      {t(`status.${s}`)}
                    </button>
                  ))}
                </div>
              </div>

              <div className="md-field">
                <div className="md-label">{t('field.owner')}</div>
                <select
                  className="rk-select"
                  value={draft.ownerId ?? ''}
                  onChange={(e) => setDraft((d) => ({ ...d, ownerId: e.target.value || null }))}
                >
                  <option value="">{t('noOwner')}</option>
                  {ownerOptions.map((u) => (
                    <option key={u.id} value={u.id}>
                      {u.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="md-field">
                <div className="md-label">{t('field.mitigation')}</div>
                <textarea
                  className="rk-textarea"
                  rows={3}
                  value={draft.mitigation}
                  onChange={(e) => setDraft((d) => ({ ...d, mitigation: e.target.value }))}
                />
              </div>
            </div>
            <div className="md-foot">
              <span className="md-foot-meta" />
              <div className="row" style={{ gap: 8 }}>
                <button className="btn btn-line btn-sm" disabled={saving} onClick={() => setModal(null)}>
                  {t('action.cancel')}
                </button>
                <button className="btn btn-accent btn-sm" disabled={saving} onClick={save}>
                  {t('action.save')}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
