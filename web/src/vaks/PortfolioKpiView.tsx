/* ============================================================
   Vaks — Global project KPI (portfolio, org-level).
   Resource conflicts, Schedule Variance, Milestone Hit Rate,
   project cycle time, resource utilization. Filterable by team.
   Gated finance:view (org-wide roles). Read-only.
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './primitives';
import { api } from '../api/client';
import type { PortfolioKpiDto } from '@vaks-pm/shared';
import { fmtMoney } from './projects/money';
import { HBars } from './finance-charts';
import './finances.css';

type Preset = 30 | 90 | 365;

function iso(d: Date) { return d.toISOString().slice(0, 10); }
function windowFor(days: Preset): { from: string; to: string } {
  const to = new Date();
  to.setUTCHours(0, 0, 0, 0);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - days);
  return { from: iso(from), to: iso(to) };
}

export function PortfolioKpiView() {
  const { t } = useTranslation('finances');
  const [teams, setTeams] = useState<Array<{ id: string; name: string }>>([]);
  const [teamId, setTeamId] = useState<string>(''); // '' = all
  const [preset, setPreset] = useState<Preset>(90);
  const [data, setData] = useState<PortfolioKpiDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    api.listTeams()
      .then((ts: Array<{ id: string; name: string }>) => setTeams(ts.map((t) => ({ id: t.id, name: t.name }))))
      .catch(() => {});
  }, []);

  const win = useMemo(() => windowFor(preset), [preset]);

  const reload = useCallback(() => {
    setLoading(true);
    api.getPortfolioKpi({ from: win.from, to: win.to, teamId: teamId || undefined })
      .then((d) => { setData(d); setError(false); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [win.from, win.to, teamId]);

  useEffect(() => { reload(); }, [reload]);

  const cur = data?.currency ?? 'EUR';
  const money = (n: number) => fmtMoney(Math.round(n), cur);

  if (loading && !data) {
    return <div className="fin-wrap"><div style={{ color: 'var(--text-3)' }}>{t('finances:common.loadingShort')}</div></div>;
  }
  if (error || !data) {
    return <div className="fin-wrap"><div className="md-warn"><Icon name="warn" size={14} /> {t('finances:kpiView.loadError')}</div></div>;
  }

  const sv = data.schedule.sv;

  return (
    <div className="fin-wrap">
      {/* Toolbar */}
      <div className="fin-card" style={{ padding: 'var(--s3) var(--s4)' }}>
        <div className="row" style={{ gap: 'var(--s4)', flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>{t('finances:kpiView.teamLabel')}</span>
            <select className="finc-select" style={{ minWidth: 180 }} value={teamId} onChange={(e) => setTeamId(e.target.value)}>
              <option value="">{t('finances:kpiView.allTeams')}</option>
              {teams.map((tm) => <option key={tm.id} value={tm.id}>{tm.name}</option>)}
            </select>
          </label>
          <div className="seg" role="group" aria-label={t('finances:kpiView.periodAria')}>
            {([30, 90, 365] as Preset[]).map((p) => (
              <button key={p} className={'seg-btn' + (preset === p ? ' seg-on' : '')} onClick={() => setPreset(p)}>{t('finances:preset.' + p)}</button>
            ))}
          </div>
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-3)' }}>
            {t('finances:kpiView.windowNote', { from: data.from, to: data.to, count: data.projectCount })}
          </span>
        </div>
      </div>

      {/* KPI cards */}
      <div className="fin-kpis">
        <div className="fin-kpi fin-kpi-budget">
          <div className="fin-kpi-cap"><Icon name="warn" size={14} /> {t('finances:kpiView.card.resourceConflicts')}</div>
          <div className="fin-kpi-val mono">{data.conflict.conflictDays}</div>
          <div className="fin-kpi-sub">{t('finances:kpiView.card.conflictSub', { people: data.conflict.peopleAffected })}</div>
        </div>
        <div className="fin-kpi">
          <div className="fin-kpi-cap"><Icon name="sort" size={14} /> {t('finances:kpiView.card.scheduleVariance')}</div>
          <div className="fin-kpi-val mono" style={{ color: sv < 0 ? 'var(--c-over)' : undefined }}>{money(sv)}</div>
          <div className="fin-kpi-sub">{data.schedule.svPct != null ? t('finances:kpiView.card.scheduleSubPct', { ev: money(data.schedule.ev), pv: money(data.schedule.pv), pct: data.schedule.svPct }) : t('finances:kpiView.card.scheduleSub', { ev: money(data.schedule.ev), pv: money(data.schedule.pv) })}</div>
        </div>
        <div className="fin-kpi">
          <div className="fin-kpi-cap"><Icon name="flag" size={14} /> {t('finances:kpiView.card.milestoneHitRate')}</div>
          <div className="fin-kpi-val mono">{data.milestones.hitRatePct == null ? '—' : data.milestones.hitRatePct + '%'}</div>
          <div className="fin-kpi-sub">{t('finances:kpiView.card.milestoneSub', { onTime: data.milestones.onTime, total: data.milestones.total })}</div>
        </div>
        <div className="fin-kpi">
          <div className="fin-kpi-cap"><Icon name="clock" size={14} /> {t('finances:kpiView.card.avgCycleTime')}</div>
          <div className="fin-kpi-val mono">{data.cycleTime.avgDays == null ? '—' : t('finances:kpiView.card.cycleDays', { days: data.cycleTime.avgDays })}</div>
          <div className="fin-kpi-sub">{t('finances:kpiView.card.cycleSub', { count: data.cycleTime.completedCount })}</div>
        </div>
        <div className="fin-kpi">
          <div className="fin-kpi-cap"><Icon name="zap" size={14} /> {t('finances:kpiView.card.utilization')}</div>
          <div className="fin-kpi-val mono">{data.utilization.billablePct == null ? '—' : data.utilization.billablePct + '%'}</div>
          <div className="fin-kpi-sub">{t('finances:kpiView.card.utilizationSub')}</div>
        </div>
      </div>

      {/* Utilisation détail */}
      <div className="fin-card">
        <div className="fin-card-head">
          <div>
            <div className="fin-card-title">{t('finances:kpiView.utilization.title')}</div>
            <div className="fin-card-sub">{t('finances:kpiView.utilization.sub', { teamSuffix: data.teamId ? t('finances:kpiView.utilization.teamFiltered') : '' })}</div>
          </div>
        </div>
        <div className="fin-chart-body">
          <HBars
            items={[
              { label: t('finances:kpiView.utilization.billablePriority'), value: data.utilization.billableHours, color: 'oklch(0.62 0.13 155)' },
              { label: t('finances:kpiView.utilization.operationalAdmin'), value: data.utilization.operationalHours, color: 'oklch(0.7 0.04 260)' },
            ]}
            fmt={(n) => `${Math.round(n * 10) / 10}h`}
          />
        </div>
      </div>

      {/* Cycle time détail */}
      <div className="fin-card">
        <div className="fin-card-head">
          <div>
            <div className="fin-card-title">{t('finances:kpiView.cycle.title')}</div>
            <div className="fin-card-sub">{t('finances:kpiView.cycle.sub')}</div>
          </div>
        </div>
        <div className="fin-scroll">
          <div className="finp-table" style={{ minWidth: 480 }}>
            <div className="finp-row finp-head" style={{ gridTemplateColumns: '1.6fr 120px' }}>
              <span>{t('finances:kpiView.cycle.project')}</span><span className="ar">{t('finances:kpiView.cycle.duration')}</span>
            </div>
            {data.cycleTime.samples.map((s) => (
              <div key={s.projectId} className="finp-row" style={{ gridTemplateColumns: '1.6fr 120px' }}>
                <div className="finp-proj-name truncate">
                  <span className="finp-proj-key">{s.key}</span>
                  <span className="truncate">{s.name}</span>
                </div>
                <span className="ar mono">{t('finances:kpiView.cycle.days', { days: s.days })}</span>
              </div>
            ))}
            {data.cycleTime.samples.length === 0 && <div className="fin-empty">{t('finances:kpiView.cycle.empty')}</div>}
          </div>
        </div>
      </div>

      <div style={{ fontSize: 11, color: 'var(--text-3)', padding: '0 4px' }}>
        {t('finances:kpiView.footnote')}
      </div>
    </div>
  );
}
