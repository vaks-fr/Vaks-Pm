/* ============================================================
   Vaks — Team report (team-lead). Utilisation des ressources,
   matrice d'allocation multi-projet, répartition des statuts,
   tableau par membre. Filtrable par semaine / mois.
   ============================================================ */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './primitives';
import { api } from '../api/client';
import type { TeamReportDto, TeamKpiDto } from '@vaks-pm/shared';
import { ShareBars, LoadBullets, StatusRings, TASK_STATUS_META, STATUS_ORDER, foldedStatusCount } from './report-charts';
import { HBars, palette } from './finance-charts';
import './finances.css';

type Gran = 'week' | 'month';

function startOfWeekUTC(d: Date): Date {
  const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dow = (x.getUTCDay() + 6) % 7; // lundi = 0
  x.setUTCDate(x.getUTCDate() - dow);
  return x;
}
function iso(d: Date) { return d.toISOString().slice(0, 10); }

const MONTH_KEYS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

function resolvePeriod(
  gran: Gran,
  offset: number,
  t: (key: string, opts?: Record<string, unknown>) => string,
): { from: string; to: string; label: string } {
  const now = new Date();
  if (gran === 'week') {
    const start = startOfWeekUTC(now);
    start.setUTCDate(start.getUTCDate() + offset * 7);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
    return { from: iso(start), to: iso(end), label: t('reports:team.weekOf', { date: iso(start) }) };
  }
  const base = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + offset, 1));
  const end = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + 1, 0));
  const m = t('reports:charts.months.' + MONTH_KEYS[base.getUTCMonth()]);
  return { from: iso(base), to: iso(end), label: `${m} ${base.getUTCFullYear()}` };
}

export function TeamReportView() {
  const { t } = useTranslation('reports');
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [teamId, setTeamId] = useState<string>('');
  const [gran, setGran] = useState<Gran>('week');
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<TeamReportDto | null>(null);
  const [kpi, setKpi] = useState<TeamKpiDto | null>(null);
  const [utilUser, setUtilUser] = useState<string>('all');
  const [loadQ, setLoadQ] = useState('');
  const [statusQ, setStatusQ] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.listTeams()
      .then((ts: Array<{ id: string; name: string }>) => {
        setTeams(ts.map((t) => ({ id: t.id, name: t.name })));
        if (ts.length && !teamId) setTeamId(ts[0].id);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const period = useMemo(() => resolvePeriod(gran, offset, t), [gran, offset, t]);

  const reload = useCallback(() => {
    if (!teamId) return;
    setLoading(true);
    setError(null);
    api.getTeamReport(teamId, period.from, period.to)
      .then((d) => setData(d))
      .catch((e) => { setError((e as Error).message); setData(null); })
      .finally(() => setLoading(false));
    api.getTeamKpi(teamId, period.from, period.to)
      .then((k) => setKpi(k))
      .catch(() => setKpi(null));
  }, [teamId, period.from, period.to]);

  useEffect(() => { reload(); }, [reload]);

  // Couleur stable par projet (matrice d'allocation).
  const projColor = useMemo(() => {
    const map = new Map<string, string>();
    let i = 0;
    (data?.members ?? []).forEach((m) => m.byProject.forEach((p) => {
      if (!map.has(p.projectKey)) map.set(p.projectKey, palette(i++));
    }));
    return map;
  }, [data]);

  // Toutes les dérivations sont mémoïsées pour que la frappe dans l'un des DEUX
  // champs de recherche (loadQ / statusQ) ne recalcule pas l'ensemble : seule la
  // liste filtrée correspondante est refaite. `statusTot` est notamment en
  // O(membres×statuts²) — le sortir du chemin de frappe est le vrai gain.
  const allocCols = useMemo(() => (data?.members ?? []).map((m) => ({
    label: m.name,
    reference: m.capacityHours,
    segments: m.byProject.map((p) => ({ key: p.projectKey, label: p.projectName, color: projColor.get(p.projectKey) ?? 'var(--accent)', value: p.hours })),
  })), [data, projColor]);
  // Stats de charge (refonte bullet trié) : dérivées des mêmes données.
  const { loadStats, loadHas, loadAvg, loadOverSum, loadOverCount } = useMemo(() => {
    const loadStats = allocCols.map((c) => {
      const total = c.segments.reduce((s, x) => s + x.value, 0);
      const ref = c.reference && c.reference > 0 ? c.reference : 0;
      return { pct: ref > 0 ? (total / ref) * 100 : 0, over: ref > 0 ? Math.max(0, total - ref) : 0, total };
    });
    return {
      loadStats,
      loadHas: loadStats.some((r) => r.total > 0),
      loadAvg: loadStats.length ? Math.round(loadStats.reduce((s, r) => s + r.pct, 0) / loadStats.length) : 0,
      loadOverSum: Math.round(loadStats.reduce((s, r) => s + r.over, 0)),
      loadOverCount: loadStats.filter((r) => r.pct > 100).length,
    };
  }, [allocCols]);
  // Recherche par nom (affichée seulement quand l'équipe est nombreuse). Les
  // stats restent calculées sur TOUTE l'équipe ; seul l'affichage est filtré.
  const loadQn = loadQ.trim().toLowerCase();
  const loadShown = useMemo(
    () => (loadQn ? allocCols.filter((c) => c.label.toLowerCase().includes(loadQn)) : allocCols),
    [allocCols, loadQn],
  );
  const statusCols = useMemo(() => (data?.members ?? []).map((m) => ({
    label: m.name,
    segments: STATUS_ORDER.map((s) => ({ key: s, label: t(TASK_STATUS_META[s].labelKey), color: TASK_STATUS_META[s].color, value: foldedStatusCount(m.statusCounts, s) })),
  })), [data, t]);
  // Anneaux small-multiples (refonte KPI) : recherche/filtrage + totaux par statut.
  const statusQn = statusQ.trim().toLowerCase();
  const statusShown = useMemo(
    () => (statusQn ? statusCols.filter((c) => c.label.toLowerCase().includes(statusQn)) : statusCols),
    [statusCols, statusQn],
  );
  const { statusTot, statusGrand, statusHas, statusDonePct } = useMemo(() => {
    const statusTot = STATUS_ORDER.reduce<Record<string, number>>((acc, s) => {
      acc[s] = statusCols.reduce((sum, c) => sum + (c.segments.find((x) => x.key === s)?.value ?? 0), 0);
      return acc;
    }, {});
    const statusGrand = Object.values(statusTot).reduce((a, b) => a + b, 0);
    return {
      statusTot,
      statusGrand,
      statusHas: statusGrand > 0,
      statusDonePct: statusGrand > 0 ? Math.round(((statusTot.DONE ?? 0) / statusGrand) * 100) : 0,
    };
  }, [statusCols]);

  return (
    <div className="fin-wrap">
      {/* Toolbar */}
      <div className="fin-card" style={{ padding: 'var(--s3) var(--s4)' }}>
        <div className="row" style={{ gap: 'var(--s4)', flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>{t('reports:team.team')}</span>
            <select className="finc-select" style={{ minWidth: 180 }} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              {teams.length === 0 && <option value="">{t('reports:team.noTeam')}</option>}
              {teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
            </select>
          </label>
          <div className="seg" role="group">
            {(['week', 'month'] as Gran[]).map((g) => (
              <button key={g} className={'seg-btn' + (gran === g ? ' seg-on' : '')} onClick={() => { setGran(g); setOffset(0); }}>
                {g === 'week' ? t('reports:team.week') : t('reports:team.month')}
              </button>
            ))}
          </div>
          <div className="row" style={{ gap: 4, alignItems: 'center' }}>
            <button className="icon-btn" onClick={() => setOffset((o) => o - 1)}><Icon name="chevL" size={16} /></button>
            <span className="mono" style={{ fontSize: 13, fontWeight: 700, minWidth: 150, textAlign: 'center' }}>{period.label}</span>
            <button className="icon-btn" onClick={() => setOffset((o) => o + 1)}><Icon name="chevR" size={16} /></button>
            {offset !== 0 && <button className="btn btn-line btn-sm" onClick={() => setOffset(0)}>{t('reports:team.today')}</button>}
          </div>
        </div>
      </div>

      {error && <div className="md-warn"><Icon name="warn" size={14} /> {error.includes('403') || error.toLowerCase().includes('réserv') ? t('reports:team.reservedManager') : t('reports:team.loadFailed', { message: error })}</div>}
      {loading && !data && <div style={{ color: 'var(--text-3)' }}>{t('reports:team.loading')}</div>}

      {data && (
        <>
          {/* KPI totals — cartes de métriques : mini-viz + états calmes (refonte) */}
          <div className="fin-kpis">
            {/* Membres : carte NEUTRE (plus de fond coral « alarmant »). */}
            <div className="fin-kpi">
              <div className="fin-kpi-cap"><Icon name="users" size={14} /> {t('reports:team.members')}</div>
              <div className={'fin-kpi-val mono' + (data.totals.memberCount === 0 ? ' fin-kpi-dim' : '')}>{data.totals.memberCount || '—'}</div>
            </div>
            {/* Utilisation moyenne : jauge annulaire. */}
            {(() => {
              const pct = data.totals.avgUtilizationPct;
              const R = 16, TH = 5, sz = (R + TH) * 2, C = 2 * Math.PI * R;
              const frac = pct == null ? 0 : Math.min(1, Math.max(0, pct / 100));
              const gcol = pct == null ? 'var(--surface-3)' : pct > 100 ? 'var(--c-over)' : pct >= 95 ? 'var(--c-warn)' : 'var(--c-ok)';
              return (
                <div className="fin-kpi">
                  <div className="fin-kpi-cap"><Icon name="gauge" size={14} /> {t('reports:team.avgUtilization')}</div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <div className={'fin-kpi-val mono' + (pct == null ? ' fin-kpi-dim' : '')}>{pct == null ? '—' : pct + '%'}</div>
                    <svg width={sz} height={sz} viewBox={`0 0 ${sz} ${sz}`} style={{ flexShrink: 0 }}>
                      <circle cx={sz / 2} cy={sz / 2} r={R} fill="none" stroke="var(--surface-3)" strokeWidth={TH} />
                      {pct != null && <circle cx={sz / 2} cy={sz / 2} r={R} fill="none" stroke={gcol} strokeWidth={TH} strokeLinecap="round" strokeDasharray={`${frac * C} ${C}`} transform={`rotate(-90 ${sz / 2} ${sz / 2})`} />}
                    </svg>
                  </div>
                  <div className="fin-kpi-sub">{t('reports:team.loggedOverCapacity')}</div>
                </div>
              );
            })()}
            {/* Heures loguées : barre loguées / capacité. */}
            {(() => {
              const cap = data.totals.capacityHours || 0;
              const logged = data.totals.loggedHours || 0;
              return (
                <div className="fin-kpi">
                  <div className="fin-kpi-cap"><Icon name="hourglass" size={14} /> {t('reports:team.loggedHours')}</div>
                  <div className={'fin-kpi-val mono' + (logged === 0 ? ' fin-kpi-dim' : '')}>{data.totals.loggedHours}h</div>
                  <div className="fin-kpi-bar" style={{ marginTop: 7 }}><div className="fin-kpi-bar-fill" style={{ width: `${cap > 0 ? Math.min(100, (logged / cap) * 100) : 0}%`, background: 'var(--c-ok)' }} /></div>
                  <div className="fin-kpi-sub">{t('reports:team.capacityHours', { hours: data.totals.capacityHours })}</div>
                </div>
              );
            })()}
            {/* Alloué : barre alloué / capacité (coral en dépassement). */}
            {(() => {
              const cap = data.totals.capacityHours || 0;
              const alloc = data.totals.allocatedHours || 0;
              const over = alloc > cap && cap > 0;
              return (
                <div className="fin-kpi">
                  <div className="fin-kpi-cap"><Icon name="board" size={14} /> {t('reports:team.allocated')}</div>
                  <div className={'fin-kpi-val mono' + (alloc === 0 ? ' fin-kpi-dim' : '')}>{data.totals.allocatedHours}h</div>
                  <div className="fin-kpi-bar" style={{ marginTop: 7 }}><div className="fin-kpi-bar-fill" style={{ width: `${cap > 0 ? Math.min(100, (alloc / cap) * 100) : 0}%`, background: over ? 'var(--c-over)' : 'var(--c-free)' }} /></div>
                  <div className="fin-kpi-sub">{t('reports:team.overPeriod')}</div>
                </div>
              );
            })()}
          </div>

          {/* Charge multi-projet — bullet horizontal trié (refonte KPI) */}
          <div className="fin-card">
            <div className="fin-card-head">
              <div>
                <div className="fin-card-title">{t('reports:team.multiprojectLoad')}</div>
                <div className="fin-card-sub">{t('reports:team.multiprojectSub')}</div>
              </div>
              {loadOverCount > 0 && (
                <span className="chart-pill-over">{t('reports:team.loadOverbooked', { count: loadOverCount })}</span>
              )}
            </div>
            <div className="fin-chart-body">
              {!loadHas ? (
                <div className="chart-empty">
                  <div className="chart-empty-ico">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round"><path d="M3 3v18h18" /><rect x="7" y="12" width="3" height="6" rx="1" /><rect x="13" y="8" width="3" height="10" rx="1" /></svg>
                  </div>
                  <div className="chart-empty-title">{t('reports:team.loadEmptyTitle')}</div>
                  <div className="chart-empty-sub">{t('reports:team.loadEmptySub')}</div>
                  <div className="chart-ghost">
                    {[0, 1, 2, 3].map((i) => (
                      <div className="chart-ghost-row" key={i}><span className="chart-ghost-name" /><span className="chart-ghost-track" /></div>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  {allocCols.length > 8 && (
                    <div className="lb-search-row">
                      {loadQn && (
                        <span className="lb-search-count">{t('reports:team.loadShowing', { shown: loadShown.length, total: allocCols.length })}</span>
                      )}
                      <input
                        className="fin-search"
                        style={{ maxWidth: 220 }}
                        value={loadQ}
                        onChange={(e) => setLoadQ(e.target.value)}
                        placeholder={t('reports:team.loadSearchPlaceholder')}
                      />
                    </div>
                  )}
                  {loadShown.length === 0 ? (
                    <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '6px 2px' }}>{t('reports:team.loadNoMatch')}</div>
                  ) : (
                    <div className={allocCols.length > 12 ? 'load-scroll' : undefined}>
                      <LoadBullets columns={loadShown} fmt={(n) => `${Math.round(n)}h`} />
                    </div>
                  )}
                  <div className="finc-dual-legend" style={{ flexWrap: 'wrap', marginTop: 12 }}>
                    <span><i className="finc-dot" style={{ background: 'var(--c-free)' }} /> {t('reports:team.loadUnder')}</span>
                    <span><i className="finc-dot" style={{ background: 'var(--c-warn)' }} /> {t('reports:team.loadNear')}</span>
                    <span><i className="finc-dot" style={{ background: 'var(--c-over)' }} /> {t('reports:team.loadOver')}</span>
                    <span><i style={{ width: 2, height: 13, borderRadius: 0, background: 'var(--border-2)', display: 'inline-block' }} /> {t('reports:team.loadRef')}</span>
                  </div>
                  <div className="chart-stat-strip">
                    <div className="chart-stat"><b className="mono">{loadAvg}%</b><small>{t('reports:team.avgLoad')}</small></div>
                    <div className="chart-stat"><b className="mono" style={loadOverSum > 0 ? { color: 'var(--c-over)' } : undefined}>{loadOverSum}h</b><small>{t('reports:team.overrunHours')}</small></div>
                    <div className="chart-stat"><b className="mono">{loadStats.length}</b><small>{t('reports:team.members')}</small></div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Répartition des statuts */}
          <div className="fin-card">
            <div className="fin-card-head">
              <div><div className="fin-card-title">{t('reports:team.tasksByStatus')}</div></div>
              {statusHas && <span className="chart-pill-done">{t('reports:team.statusDonePct', { pct: statusDonePct })}</span>}
            </div>
            <div className="fin-chart-body">
              {!statusHas ? (
                <div className="chart-empty">
                  <div className="chart-empty-ico">
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8}><circle cx="12" cy="12" r="8" /></svg>
                  </div>
                  <div className="chart-empty-title">{t('reports:team.statusEmptyTitle')}</div>
                  <div className="chart-empty-sub">{t('reports:team.statusEmptySub')}</div>
                  <div className="status-rings" style={{ opacity: 0.5 }}>
                    {[0, 1, 2, 3].map((i) => (
                      <div className="sr-cell" key={i}>
                        <div className="sr-donut" style={{ width: 82, height: 82 }}>
                          <svg viewBox="0 0 82 82" width={82} height={82}><circle cx={41} cy={41} r={30} fill="none" stroke="var(--surface-3)" strokeWidth={10} /></svg>
                        </div>
                        <span className="chart-ghost-name" style={{ width: 56 }} />
                      </div>
                    ))}
                  </div>
                </div>
              ) : (
                <>
                  <div className="finc-dual-legend" style={{ flexWrap: 'wrap', marginBottom: 4, justifyContent: 'center' }}>
                    {STATUS_ORDER.map((s) => <span key={s}><i className="finc-dot" style={{ background: TASK_STATUS_META[s].color }} /> {t(TASK_STATUS_META[s].labelKey)}</span>)}
                  </div>
                  {statusCols.length > 8 && (
                    <div className="lb-search-row">
                      {statusQn && (
                        <span className="lb-search-count">{t('reports:team.loadShowing', { shown: statusShown.length, total: statusCols.length })}</span>
                      )}
                      <input className="fin-search" style={{ maxWidth: 220 }} value={statusQ} onChange={(e) => setStatusQ(e.target.value)} placeholder={t('reports:team.loadSearchPlaceholder')} />
                    </div>
                  )}
                  {statusShown.length === 0 ? (
                    <div style={{ color: 'var(--text-3)', fontSize: 13, padding: '6px 2px' }}>{t('reports:team.loadNoMatch')}</div>
                  ) : (
                    <div className={statusCols.length > 16 ? 'chart-scroll' : undefined}>
                      <StatusRings columns={statusShown} />
                    </div>
                  )}
                  <div className="chart-stat-strip">
                    <div className="chart-stat"><b className="mono">{statusGrand}</b><small>{t('reports:team.statusTotalTasks')}</small></div>
                    <div className="chart-stat"><b className="mono" style={{ color: TASK_STATUS_META.DONE.color }}>{statusTot.DONE ?? 0}</b><small>{t('reports:charts.status.done')}</small></div>
                    <div className="chart-stat"><b className="mono" style={{ color: TASK_STATUS_META.IN_PROGRESS.color }}>{statusTot.IN_PROGRESS ?? 0}</b><small>{t('reports:charts.status.inProgress')}</small></div>
                    <div className="chart-stat"><b className="mono" style={{ color: TASK_STATUS_META.ON_HOLD.color }}>{statusTot.ON_HOLD ?? 0}</b><small>{t('reports:charts.status.onHold')}</small></div>
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Tableau par membre (scroll horizontal si beaucoup de monde) */}
          <div className="fin-card">
            <div className="fin-card-head"><div className="fin-card-title">{t('reports:team.memberDetail')}</div></div>
            <div className="fin-scroll">
              <div className="finp-table" style={{ minWidth: 720 }}>
                <div className="finp-row finp-head" style={{ gridTemplateColumns: '1.4fr 90px 90px 90px 90px 1fr' }}>
                  <span>{t('reports:team.colMember')}</span>
                  <span className="ar">{t('reports:team.colCapacity')}</span>
                  <span className="ar">{t('reports:team.colLogged')}</span>
                  <span className="ar">{t('reports:team.colUtil')}</span>
                  <span className="ar">{t('reports:team.colAlloc')}</span>
                  <span>{t('reports:team.colStatuses')}</span>
                </div>
                {data.members.map((m) => (
                  <div key={m.userId} className="finp-row" style={{ gridTemplateColumns: '1.4fr 90px 90px 90px 90px 1fr' }}>
                    <span className="finp-client-name truncate">{m.name}</span>
                    <span className="ar mono">{m.capacityHours}h</span>
                    <span className="ar mono">{m.loggedHours}h</span>
                    <span className="ar mono" style={{ color: m.utilizationPct != null && m.utilizationPct > 100 ? 'var(--c-over)' : undefined }}>{m.utilizationPct == null ? '—' : m.utilizationPct + '%'}</span>
                    <span className="ar mono" style={{ color: m.allocationPct != null && m.allocationPct > 100 ? 'var(--c-over)' : undefined }}>{m.allocationPct == null ? '—' : m.allocationPct + '%'}</span>
                    <span className="row" style={{ gap: 8, fontSize: 11.5, flexWrap: 'wrap' }}>
                      {STATUS_ORDER.map((s) => foldedStatusCount(m.statusCounts, s) > 0 ? (
                        <span key={s} className="mono" style={{ color: 'var(--text-3)' }}>
                          <i className="finc-dot" style={{ background: TASK_STATUS_META[s].color, marginRight: 3 }} />{foldedStatusCount(m.statusCounts, s)}
                        </span>
                      ) : null)}
                    </span>
                  </div>
                ))}
                {data.members.length === 0 && <div className="fin-empty">{t('reports:team.noMemberInTeam')}</div>}
              </div>
            </div>
          </div>

          {/* ===== KPI : utilisation, conflits de ressources, marge de capacité ===== */}
          {kpi && (
            <>
              {/* Taux d'utilisation (facturable vs opérationnel), filtrable par user */}
              <div className="fin-card">
                <div className="fin-card-head">
                  <div>
                    <div className="fin-card-title">{t('reports:team.utilizationTitle')}</div>
                    <div className="fin-card-sub">{t('reports:team.utilizationSub', { pct: kpi.utilization.teamBillablePct == null ? '—' : kpi.utilization.teamBillablePct })}</div>
                  </div>
                  <label className="row" style={{ gap: 6, alignItems: 'center' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>{t('reports:team.member')}</span>
                    <select className="finc-select" value={utilUser} onChange={(e) => setUtilUser(e.target.value)}>
                      <option value="all">{t('reports:team.all')}</option>
                      {kpi.utilization.byUser.map((u) => <option key={u.userId} value={u.userId}>{u.name}</option>)}
                    </select>
                  </label>
                </div>
                <div className="fin-chart-body">
                  {(() => {
                    const rows = kpi.utilization.byUser.filter((u) => utilUser === 'all' || u.userId === utilUser);
                    const cols = rows.map((u) => ({
                      label: u.name,
                      reference: u.totalHours || 1,
                      segments: [
                        { key: 'bill', label: t('reports:team.billable'), color: 'oklch(0.62 0.13 155)', value: u.billableHours },
                        { key: 'op', label: t('reports:team.operational'), color: 'oklch(0.7 0.04 260)', value: u.operationalHours },
                      ],
                    }));
                    if (!rows.length || rows.every((u) => u.totalHours === 0)) {
                      return <div style={{ color: 'var(--text-3)' }}>{t('reports:team.noHoursLogged')}</div>;
                    }
                    const billSum = rows.reduce((s, u) => s + u.billableHours, 0);
                    const opSum = rows.reduce((s, u) => s + u.operationalHours, 0);
                    const totSum = billSum + opSum;
                    const avgBillPct = totSum > 0 ? Math.round((billSum / totSum) * 100) : 0;
                    return (
                      <>
                        <div className={rows.length > 14 ? 'load-scroll' : undefined}>
                          <ShareBars columns={cols} fmt={(n) => `${Math.round(n * 10) / 10}h`} sortByKey="bill" />
                        </div>
                        <div className="finc-dual-legend" style={{ marginTop: 12 }}>
                          <span><i className="finc-dot" style={{ background: 'oklch(0.62 0.13 155)' }} /> {t('reports:team.billable')}</span>
                          <span><i className="finc-dot" style={{ background: 'oklch(0.7 0.04 260)' }} /> {t('reports:team.operationalAdmin')}</span>
                        </div>
                        <div className="chart-stat-strip">
                          <div className="chart-stat"><b className="mono">{avgBillPct}%</b><small>{t('reports:team.billable')}</small></div>
                          <div className="chart-stat"><b className="mono" style={{ color: 'oklch(0.62 0.13 155)' }}>{Math.round(billSum * 10) / 10}h</b><small>{t('reports:team.billable')}</small></div>
                          <div className="chart-stat"><b className="mono">{Math.round(opSum * 10) / 10}h</b><small>{t('reports:team.operationalAdmin')}</small></div>
                          <div className="chart-stat"><b className="mono">{rows.length}</b><small>{t('reports:team.members')}</small></div>
                        </div>
                      </>
                    );
                  })()}
                </div>
              </div>

              {/* Conflits de ressources + marge de capacité */}
              <div className="row" style={{ gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
                <div className="fin-card" style={{ flex: '1 1 320px' }}>
                  <div className="fin-card-head">
                    <div>
                      <div className="fin-card-title">{t('reports:team.conflictsTitle')}</div>
                      <div className="fin-card-sub">{t('reports:team.conflictsSub')}</div>
                    </div>
                  </div>
                  <div className="fin-chart-body">
                    {/* fin-kpi est un container inline-size (largeur intrinsèque nulle) → max-content collapse ; largeur fixe requise */}
                    <div className="fin-kpis" style={{ marginBottom: 8, gridTemplateColumns: 'minmax(0, 240px)' }}>
                      <div className="fin-kpi fin-kpi-budget">
                        <div className="fin-kpi-cap"><Icon name="warn" size={14} /> {t('reports:team.conflictDays')}</div>
                        <div className="fin-kpi-val mono">{kpi.conflict.conflictDays}</div>
                        <div className="fin-kpi-sub">{t('reports:team.peopleAffected', { count: kpi.conflict.peopleAffected })}</div>
                      </div>
                    </div>
                    {kpi.conflict.worst.length === 0 ? (
                      <div style={{ color: 'var(--text-3)', fontSize: 12 }}>{t('reports:team.noConflict')}</div>
                    ) : (
                      <div className="finp-table">
                        <div className="finp-row finp-head" style={{ gridTemplateColumns: '1.4fr 100px 90px 90px' }}>
                          <span>{t('reports:team.colMember')}</span><span>{t('reports:team.colDate')}</span><span className="ar">{t('reports:team.colAllocated')}</span><span className="ar">{t('reports:team.colCapacity')}</span>
                        </div>
                        {kpi.conflict.worst.map((w, i) => (
                          <div key={i} className="finp-row" style={{ gridTemplateColumns: '1.4fr 100px 90px 90px' }}>
                            <span className="truncate">{w.name}</span>
                            <span className="mono" style={{ fontSize: 12 }}>{w.date}</span>
                            <span className="ar mono" style={{ color: 'var(--c-over)' }}>{w.allocatedHours}h</span>
                            <span className="ar mono">{w.capacityHours}h</span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                <div className="fin-card" style={{ flex: '1 1 320px' }}>
                  <div className="fin-card-head">
                    <div>
                      <div className="fin-card-title">{t('reports:team.headroomTitle')}</div>
                      <div className="fin-card-sub">{t('reports:team.headroomSub')}</div>
                    </div>
                  </div>
                  <div className="fin-chart-body">
                    <div className="fin-kpis" style={{ marginBottom: 8, gridTemplateColumns: 'minmax(0, 240px)' }}>
                      <div className="fin-kpi fin-kpi-budget">
                        <div className="fin-kpi-cap"><Icon name="gauge" size={14} /> {t('reports:team.totalHeadroom')}</div>
                        <div className="fin-kpi-val mono" style={{ color: kpi.capacity.headroomHours < 0 ? 'var(--c-over)' : undefined }}>{kpi.capacity.headroomHours}h</div>
                        <div className="fin-kpi-sub">{kpi.capacity.allocatedHours}h / {kpi.capacity.availableHours}h</div>
                      </div>
                    </div>
                    <HBars
                      items={kpi.capacity.byUser.map((u) => ({ label: u.name, value: u.headroomHours, color: u.headroomHours < 0 ? 'oklch(0.6 0.16 25)' : 'oklch(0.62 0.13 155)' }))}
                      fmt={(n) => `${Math.round(n * 10) / 10}h`}
                    />
                  </div>
                </div>
              </div>
            </>
          )}
        </>
      )}
    </div>
  );
}
