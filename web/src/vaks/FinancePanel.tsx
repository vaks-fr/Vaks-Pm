/* ============================================================
   Vaks — Global finance panel (org-level), aggregated by client.
   Period filter (fiscal quarter/semester/year) + client filter + charts.
   Gated finance:view (org-wide roles only). Read-only.
   ============================================================ */
import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './primitives';
import { api } from '../api/client';
import type { PortfolioFinanceDto, FiscalGranularity } from '@vaks-pm/shared';
import { fmtMoney } from './projects/money';
import { PieChart, HBars, DualBars, MonthlyChart, palette } from './finance-charts';
import { useChartTooltip } from './chart-tooltip';
import './finances.css';

interface Props {
  onOpenProjectFinance?: (projectId: string) => void;
}

export function FinancePanel({ onOpenProjectFinance }: Props) {
  const { t } = useTranslation('finances');
  const [data, setData] = useState<PortfolioFinanceDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [open, setOpen] = useState<Set<string>>(new Set());
  const [clientList, setClientList] = useState<Array<{ id: string; name: string }>>([]);

  // filters
  const [granularity, setGranularity] = useState<FiscalGranularity>('quarter');
  const [offset, setOffset] = useState(0);
  const [clientId, setClientId] = useState<string>(''); // '' = all

  // Billing export (timesheet → invoicing): own date window + options.
  const monthStart = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); })();
  const monthEnd = (() => { const d = new Date(); return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10); })();
  const [beFrom, setBeFrom] = useState(monthStart);
  const [beTo, setBeTo] = useState(monthEnd);
  const [beBillableOnly, setBeBillableOnly] = useState(false);
  const [beBusy, setBeBusy] = useState<'csv' | 'xlsx' | null>(null);
  const [beError, setBeError] = useState(false);
  // Each list section is a collapsible "dropdown" — all shown by default. A key
  // present in this set = that section is collapsed (hidden).
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // Per-list search filters.
  const [clientSearch, setClientSearch] = useState('');
  const [teamSearch, setTeamSearch] = useState('');
  const [marginSearch, setMarginSearch] = useState('');
  // Offer/budget iterations: search + pagination (10 / page).
  const [offerQuery, setOfferQuery] = useState('');
  const [offerPage, setOfferPage] = useState(1);
  const { bind: tipBind, tipNode } = useChartTooltip();

  // client list for the selector (once)
  useEffect(() => {
    let alive = true;
    api
      .listClients({ pageSize: 200 })
      .then((r) => alive && setClientList(r.items.map((c) => ({ id: c.id, name: c.name }))))
      .catch(() => {});
    return () => { alive = false; };
  }, []);

  const reload = useCallback(() => {
    setLoading(true);
    api
      .getPortfolioFinance({ granularity, offset, clientId: clientId || undefined })
      .then((d) => { setData(d); setError(false); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
  }, [granularity, offset, clientId]);

  useEffect(() => { reload(); }, [reload]);

  const runBillingExport = async (format: 'csv' | 'xlsx') => {
    if (!beFrom || !beTo || beFrom > beTo) { setBeError(true); return; }
    setBeBusy(format);
    setBeError(false);
    try {
      await api.downloadBillingExport(format, {
        from: beFrom, to: beTo, clientId: clientId || undefined, billableOnly: beBillableOnly,
      });
    } catch {
      setBeError(true);
    } finally {
      setBeBusy(null);
    }
  };

  // Reset offer pagination when the search or the period/client scope changes.
  useEffect(() => { setOfferPage(1); }, [offerQuery, granularity, offset, clientId]);

  const cur = data?.currency ?? 'EUR';
  const money = (n: number | null | undefined) => fmtMoney(n == null ? n : Math.round(n), cur);
  // Compact form for donut centers so the value never overflows the ring.
  const moneyShort = (n: number) => {
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: cur, notation: 'compact', maximumFractionDigits: 1 }).format(n);
    } catch {
      return money(n);
    }
  };
  const keyOf = (cid: string | null) => cid ?? '__none__';
  const toggle = (k: string) => setOpen((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const toggleSection = (k: string) => setCollapsed((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  // Localized labels for the backend's null buckets (don't ship hardcoded FR).
  const teamLabel = (name: string, teamId: string | null) => (teamId === null ? t('finances:portfolio.noTeam') : name);
  const clientLabelL = (name: string, clientId: string | null) => (clientId === null ? t('finances:portfolio.internalClients') : name);
  // Good / bad coloring: green when positive (margin/variance), red when negative.
  const signColor = (n: number) => (n > 0 ? 'var(--c-ok)' : n < 0 ? 'var(--c-over)' : undefined);
  // Offer iterations: fewer is better (1 green · 2 amber · 3+ red).
  const iterColor = (n: number) => (n >= 3 ? 'var(--c-over)' : n === 2 ? 'var(--c-warn)' : 'var(--c-ok)');

  if (loading && !data) {
    return <div className="fin-wrap"><div style={{ color: 'var(--text-3)' }}>{t('finances:common.loadingShort')}</div></div>;
  }
  if (error || !data) {
    return <div className="fin-wrap"><div className="md-warn"><Icon name="warn" size={14} /> {t('finances:portfolio.loadError')}</div></div>;
  }

  const tot = data.totals;
  const filtered = !!data.clientId;
  const isOpen = (k: string) => !collapsed.has(k);

  // --- Section search filters ---
  const clientQ = clientSearch.trim().toLowerCase();
  const teamQ = teamSearch.trim().toLowerCase();
  const marginQ = marginSearch.trim().toLowerCase();

  // Finance by client: match on client name/company or any of its projects.
  const clientsShown = data.clients.filter(
    (c) => !clientQ
      || c.clientName.toLowerCase().includes(clientQ)
      || (c.company ?? '').toLowerCase().includes(clientQ)
      || c.projects.some((p) => p.key.toLowerCase().includes(clientQ) || p.name.toLowerCase().includes(clientQ)),
  );
  // Single-client (filtered) view: search filters its project rows.
  const clientProjectsShown = (data.clients[0]?.projects ?? []).filter(
    (p) => !clientQ || p.key.toLowerCase().includes(clientQ) || p.name.toLowerCase().includes(clientQ),
  );

  // PV vs cost by team.
  const pvRowsShown = data.pvVsCost.byTeam.filter((tm) => !teamQ || tm.teamName.toLowerCase().includes(teamQ));

  // Margin by client: hide rows that round to 0 €, then apply the search.
  const marginRows = data.clients
    .filter((c) => Math.round(c.margin) !== 0)
    .filter((c) => !marginQ || c.clientName.toLowerCase().includes(marginQ));
  const maxMargin = Math.max(1, ...marginRows.map((c) => Math.abs(c.margin)));

  // Offer iterations: search → paginate (10 / page), padded so the last page
  // keeps the same height as a full one.
  const OFFERS_PER_PAGE = 10;
  const offerQ = offerQuery.trim().toLowerCase();
  const offerFiltered = data.offerIterations.projects.filter(
    (p) => !offerQ
      || p.name.toLowerCase().includes(offerQ)
      || p.key.toLowerCase().includes(offerQ)
      || p.status.toLowerCase().includes(offerQ),
  );
  const offerPages = Math.max(1, Math.ceil(offerFiltered.length / OFFERS_PER_PAGE));
  const offerSafePage = Math.min(offerPage, offerPages);
  const offerPaged = offerFiltered.slice((offerSafePage - 1) * OFFERS_PER_PAGE, offerSafePage * OFFERS_PER_PAGE);
  const offerFillers = offerPages > 1 ? Math.max(0, OFFERS_PER_PAGE - offerPaged.length) : 0;

  // chart segment builders
  const revByClient = data.revenueByClient.map((c, i) => ({ label: clientLabelL(c.clientName, c.clientId), value: c.revenue, color: palette(i) }));
  const projByClient = data.projectsByClient.map((c, i) => ({ label: clientLabelL(c.clientName, c.clientId), value: c.count, color: palette(i) }));
  const budgetSegs = data.budgetBuckets.filter((b) => b.count > 0).map((b, i) => ({ label: b.label, value: b.count, color: b.key === 'none' ? 'var(--surface-3)' : palette(i) }));
  const teamProjSegs = data.byTeam.map((tm, i) => ({ label: teamLabel(tm.teamName, tm.teamId), value: tm.projectCount, color: palette(i) }));
  const teamDual = data.byTeam.map((tm) => ({ label: teamLabel(tm.teamName, tm.teamId), revenue: tm.revenue, cost: tm.spent }));
  const revByProject = data.revenueByProject.filter((p) => p.revenue > 0).slice(0, 12).map((p, i) => ({ label: p.name, value: p.revenue, color: palette(i) }));

  return (
    <div className="fin-wrap">
      {tipNode}
      {/* ===== Toolbar : client + period ===== */}
      <div className="fin-card" style={{ padding: 'var(--s3) var(--s4)' }}>
        <div className="row" style={{ gap: 'var(--s4)', flexWrap: 'wrap', alignItems: 'center' }}>
          <label className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>{t('finances:portfolio.clientLabel')}</span>
            <select className="finc-select" style={{ minWidth: 180 }} value={clientId}
              onChange={(e) => { setClientId(e.target.value); setOpen(new Set()); }}>
              <option value="">{t('finances:portfolio.allClients')}</option>
              {clientList.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>

          <div className="seg" role="group" aria-label={t('finances:portfolio.granularityAria')}>
            {(['quarter', 'semester', 'year'] as FiscalGranularity[]).map((g) => (
              <button key={g} className={'seg-btn' + (granularity === g ? ' seg-on' : '')}
                onClick={() => { setGranularity(g); setOffset(0); }}>{t('finances:granularity.' + g)}</button>
            ))}
          </div>

          <div className="row" style={{ gap: 4, alignItems: 'center' }}>
            <button className="icon-btn" title={t('finances:portfolio.prevPeriod')} onClick={() => setOffset((o) => o - 1)}><Icon name="chevL" size={16} /></button>
            <span className="mono" style={{ fontSize: 13, fontWeight: 700, minWidth: 120, textAlign: 'center' }}>{data.period.label}</span>
            <button className="icon-btn" title={t('finances:portfolio.nextPeriod')} onClick={() => setOffset((o) => o + 1)}><Icon name="chevR" size={16} /></button>
            {offset !== 0 && <button className="btn btn-line btn-sm" onClick={() => setOffset(0)}>{t('finances:portfolio.today')}</button>}
          </div>
          <span style={{ marginLeft: 'auto', fontSize: 11.5, color: 'var(--text-3)' }}>
            {t('finances:portfolio.periodNote')}
          </span>
        </div>
      </div>

      {/* ===== Billing export (timesheet → invoicing) ===== */}
      <div className="fin-card" style={{ padding: 'var(--s3) var(--s4)' }}>
        <div className="row" style={{ gap: 'var(--s4)', flexWrap: 'wrap', alignItems: 'center' }}>
          <div style={{ minWidth: 0 }}>
            <div className="fin-card-title">{t('finances:billing.title')}</div>
            <div className="fin-card-sub">{t('finances:billing.sub')}</div>
          </div>
          <label className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>{t('finances:billing.from')}</span>
            <input type="date" className="finc-select" value={beFrom} max={beTo || undefined} onChange={(e) => setBeFrom(e.target.value)} />
          </label>
          <label className="row" style={{ gap: 6, alignItems: 'center' }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)', fontWeight: 600 }}>{t('finances:billing.to')}</span>
            <input type="date" className="finc-select" value={beTo} min={beFrom || undefined} onChange={(e) => setBeTo(e.target.value)} />
          </label>
          <label className="row" style={{ gap: 6, alignItems: 'center', fontSize: 12, color: 'var(--text-2)' }}>
            <input type="checkbox" checked={beBillableOnly} onChange={(e) => setBeBillableOnly(e.target.checked)} />
            {t('finances:billing.billableOnly')}
          </label>
          <div className="row" style={{ gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
            <button className="btn btn-line btn-sm" disabled={!!beBusy} onClick={() => runBillingExport('csv')}>
              {beBusy === 'csv' ? t('finances:billing.exporting') : t('finances:billing.csv')}
            </button>
            <button className="btn btn-line btn-sm" disabled={!!beBusy} onClick={() => runBillingExport('xlsx')}>
              {beBusy === 'xlsx' ? t('finances:billing.exporting') : t('finances:billing.xlsx')}
            </button>
          </div>
        </div>
        {beError && (
          <div className="md-warn" style={{ marginTop: 8 }}>
            <Icon name="warn" size={14} /> {t('finances:billing.error')}
          </div>
        )}
        <div style={{ fontSize: 11.5, color: 'var(--text-3)', marginTop: 6 }}>{t('finances:billing.note')}</div>
      </div>

      {/* ===== KPI totals ===== */}
      <div className="fin-kpis">
        <div className="fin-kpi fin-kpi-budget">
          <div className="fin-kpi-cap"><Icon name="users" size={14} /> {filtered ? t('finances:portfolio.kpi.projects') : t('finances:portfolio.kpi.clients')}</div>
          <div className="fin-kpi-val mono">{filtered ? tot.projectCount : tot.clientCount}</div>
          <div className="fin-kpi-sub">{filtered ? t('finances:portfolio.kpi.oneClient') : t('finances:portfolio.kpi.projectsCount', { count: tot.projectCount })}</div>
        </div>
        <div className="fin-kpi">
          <div className="fin-kpi-cap"><Icon name="hourglass" size={14} /> {t('finances:portfolio.kpi.spent')}</div>
          <div className="fin-kpi-val mono">{money(tot.spent)}</div>
          <div className="fin-kpi-sub">{t('finances:portfolio.kpi.budgetSub', { amount: money(tot.budget) })}</div>
        </div>
        <div className="fin-kpi">
          <div className="fin-kpi-cap"><Icon name="zap" size={14} /> {t('finances:portfolio.kpi.billableRevenue')}</div>
          <div className="fin-kpi-val mono">{money(tot.revenue)}</div>
        </div>
        <div className="fin-kpi">
          <div className="fin-kpi-cap"><Icon name="sort" size={14} /> {t('finances:portfolio.kpi.margin')}</div>
          <div className="fin-kpi-val mono" style={{ color: signColor(tot.margin) }}>{money(tot.margin)}</div>
          <div className={'fin-kpi-sub ' + (tot.margin >= 0 ? 'is-under' : 'is-over')}>
            {t('finances:portfolio.kpi.marginPctOfRevenue', { pct: tot.revenue ? Math.round((tot.margin / tot.revenue) * 100) : 0 })}
          </div>
        </div>
      </div>

      {/* ===== Charts grid ===== */}
      <div className="fin-chart-grid">
        <ChartCard title={filtered ? t('finances:portfolio.charts.revenueByProject') : t('finances:portfolio.charts.revenueByClient')}>
          <PieChart segments={filtered ? revByProject : revByClient} fmt={money} centerLabel={moneyShort(tot.revenue)} centerSub={t('finances:portfolio.charts.revenueCenterSub')} />
        </ChartCard>

        {!filtered && (
          <ChartCard title={t('finances:portfolio.charts.projectsByClient')}>
            <PieChart segments={projByClient} fmt={(n) => String(n)} centerLabel={String(tot.projectCount)} centerSub={t('finances:portfolio.charts.projectsCenterSub')} />
          </ChartCard>
        )}

        <ChartCard title={t('finances:portfolio.charts.projectsByBudgetBracket')}>
          <PieChart segments={budgetSegs} fmt={(n) => String(n)} centerLabel={String(tot.projectCount)} centerSub={t('finances:portfolio.charts.projectsCenterSub')} />
        </ChartCard>

        <ChartCard title={t('finances:portfolio.charts.projectsByTeam')}>
          <PieChart segments={teamProjSegs} fmt={(n) => String(n)} />
        </ChartCard>

        <ChartCard title={t('finances:portfolio.charts.revenueVsCostByTeam')}>
          <DualBars items={teamDual} fmt={money} />
        </ChartCard>

        <ChartCard title={t('finances:portfolio.charts.costAndRevenueByMonth')} wide>
          <MonthlyChart data={data.monthly} fmt={money} />
        </ChartCard>
      </div>

      {/* ===== Finance by client (collapsible dropdown + search) ===== */}
      <ListCard
        title={filtered ? t('finances:portfolio.table.clientProjects') : t('finances:portfolio.table.financeByClient')}
        sub={t('finances:portfolio.table.sub', { period: data.period.label })}
        collapsed={!isOpen('clients')}
        onToggle={() => toggleSection('clients')}
        search={data.clients.length > 0 ? {
          value: clientSearch, onChange: setClientSearch,
          placeholder: filtered ? t('finances:portfolio.offers.search') : t('finances:portfolio.searchClient'),
        } : undefined}
      >
        <div className="fin-scroll">
          <div className="finp-table" style={{ minWidth: 760 }}>
            <div className="finp-row finp-head">
              <span>{filtered ? t('finances:portfolio.table.project') : t('finances:portfolio.table.client')}</span>
              <span className="ar">{filtered ? '' : t('finances:portfolio.table.projects')}</span>
              <span className="ar">{t('finances:portfolio.table.budget')}</span>
              <span className="ar">{t('finances:portfolio.table.spent')}</span>
              <span className="ar">{t('finances:portfolio.table.revenue')}</span>
              <span className="ar">{t('finances:portfolio.table.margin')}</span>
              <span className="ar">{t('finances:portfolio.table.marginPct')}</span>
            </div>

            {filtered ? (
              clientProjectsShown.map((p) => (
                <div className="finp-row" key={p.id}>
                  <div className="finp-proj-name truncate" onClick={() => onOpenProjectFinance?.(p.id)} style={onOpenProjectFinance ? undefined : { cursor: 'default' }}>
                    <span className="finp-proj-key">{p.key}</span>
                    <span className="truncate">{p.name}</span>
                  </div>
                  <span className="ar" />
                  <span className="ar mono">{money(p.budget)}</span>
                  <span className="ar mono">{money(p.spent)}</span>
                  <span className="ar mono fin-bill">{money(p.revenue)}</span>
                  <span className="ar mono" style={{ color: signColor(p.margin) }}>{money(p.margin)}</span>
                  <span className="ar mono fin-dim">{p.revenue > 0 ? Math.round((p.margin / p.revenue) * 100) + '%' : '—'}</span>
                </div>
              ))
            ) : (
              clientsShown.map((c) => {
                const k = keyOf(c.clientId);
                const rowOpen = open.has(k);
                return (
                  <React.Fragment key={k}>
                    <div className="finp-row">
                      <button className="finp-client" onClick={() => toggle(k)}>
                        <Icon name="chevR" size={14} className={'finp-chev' + (rowOpen ? ' open' : '')} />
                        <span style={{ minWidth: 0 }}>
                          <span className="finp-client-name truncate" style={{ display: 'block' }}>{clientLabelL(c.clientName, c.clientId)}</span>
                          {c.company && <span className="finp-client-co truncate">{c.company}</span>}
                          {((c.agentCost ?? 0) > 0 || (c.agentBilled ?? 0) > 0) && (
                            <span className="finp-client-co truncate" style={{ color: 'var(--text-3)' }}>
                              <Icon name="zap" size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} />
                              {t('finances:portfolio.table.ofWhichAgents', { cost: money(c.agentCost ?? 0), billed: money(c.agentBilled ?? 0) })}
                            </span>
                          )}
                        </span>
                      </button>
                      <span className="ar mono fin-dim">{c.projectCount}</span>
                      <span className="ar mono">{money(c.budget)}</span>
                      <span className="ar mono">{money(c.spent)}</span>
                      <span className="ar mono fin-bill">{money(c.revenue)}</span>
                      <span className="ar mono" style={{ color: signColor(c.margin) }}>{money(c.margin)}</span>
                      <span className="ar mono fin-dim">{c.marginPct != null ? c.marginPct + '%' : '—'}</span>
                    </div>
                    {rowOpen && c.projects.map((p) => (
                      <div className="finp-proj-row" key={p.id}>
                        <div className="finp-proj-name truncate" onClick={() => onOpenProjectFinance?.(p.id)} style={onOpenProjectFinance ? undefined : { cursor: 'default' }}>
                          <span className="finp-proj-key">{p.key}</span>
                          <span className="truncate">{p.name}</span>
                        </div>
                        <span className="ar" />
                        <span className="ar mono">{money(p.budget)}</span>
                        <span className="ar mono">{money(p.spent)}</span>
                        <span className="ar mono fin-bill">{money(p.revenue)}</span>
                        <span className="ar mono" style={{ color: signColor(p.margin) }}>{money(p.margin)}</span>
                        <span className="ar" />
                      </div>
                    ))}
                  </React.Fragment>
                );
              })
            )}
            {data.clients.length === 0 && <div className="fin-empty">{t('finances:portfolio.table.empty')}</div>}
            {data.clients.length > 0 && (filtered ? clientProjectsShown : clientsShown).length === 0 && (
              <div className="fin-empty">{t('finances:portfolio.noMatch')}</div>
            )}
            {!filtered && clientsShown.length > 0 && (
              <div className="finp-row finp-tfoot">
                <span>
                  {t('finances:portfolio.table.totalProjects', { count: tot.projectCount })}
                  {((tot.agentCost ?? 0) > 0 || (tot.agentBilled ?? 0) > 0) && (
                    <span className="finp-client-co truncate" style={{ color: 'var(--text-3)', display: 'block', fontWeight: 400 }}>
                      <Icon name="zap" size={11} style={{ verticalAlign: '-1px', marginRight: 3 }} />
                      {t('finances:portfolio.table.ofWhichAgents', { cost: money(tot.agentCost ?? 0), billed: money(tot.agentBilled ?? 0) })}
                    </span>
                  )}
                </span>
                <span className="ar mono">{tot.projectCount}</span>
                <span className="ar mono">{money(tot.budget)}</span>
                <span className="ar mono">{money(tot.spent)}</span>
                <span className="ar mono fin-bill">{money(tot.revenue)}</span>
                <span className="ar mono" style={{ color: signColor(tot.margin) }}>{money(tot.margin)}</span>
                <span className="ar" />
              </div>
            )}
          </div>
        </div>
      </ListCard>

      {/* ===== Planned value (PV) vs actual cost by team (dropdown + search) ===== */}
      <ListCard
        title={t('finances:portfolio.pvVsCost.title')}
        sub={t('finances:portfolio.pvVsCost.sub')}
        collapsed={!isOpen('pv')}
        onToggle={() => toggleSection('pv')}
        search={data.pvVsCost.byTeam.length > 0 ? {
          value: teamSearch, onChange: setTeamSearch, placeholder: t('finances:portfolio.searchTeam'),
        } : undefined}
      >
        <div className="fin-scroll">
          <div className="finp-table" style={{ minWidth: 600 }}>
            <div className="finp-row finp-head" style={{ gridTemplateColumns: '1.6fr 130px 130px 130px' }}>
              <span>{t('finances:portfolio.pvVsCost.team')}</span><span className="ar">{t('finances:portfolio.pvVsCost.planned')}</span><span className="ar">{t('finances:portfolio.pvVsCost.actualCost')}</span><span className="ar">{t('finances:portfolio.pvVsCost.variance')}</span>
            </div>
            {pvRowsShown.map((tm, i) => {
              const d = tm.pv - tm.cost;
              return (
                <div key={i} className="finp-row" style={{ gridTemplateColumns: '1.6fr 130px 130px 130px' }}>
                  <span className="finp-client-name truncate">{teamLabel(tm.teamName, tm.teamId)}</span>
                  <span className="ar mono">{money(tm.pv)}</span>
                  <span className="ar mono">{money(tm.cost)}</span>
                  <span className="ar mono" style={{ color: signColor(d) }}>{money(d)}</span>
                </div>
              );
            })}
            {data.pvVsCost.byTeam.length === 0 && <div className="fin-empty">{t('finances:portfolio.pvVsCost.empty')}</div>}
            {data.pvVsCost.byTeam.length > 0 && pvRowsShown.length === 0 && <div className="fin-empty">{t('finances:portfolio.noMatch')}</div>}
            {pvRowsShown.length > 0 && (
              <div className="finp-row finp-tfoot" style={{ gridTemplateColumns: '1.6fr 130px 130px 130px' }}>
                <span>{t('finances:portfolio.pvVsCost.total')}</span>
                <span className="ar mono">{money(data.pvVsCost.total.pv)}</span>
                <span className="ar mono">{money(data.pvVsCost.total.cost)}</span>
                <span className="ar mono" style={{ color: signColor(data.pvVsCost.total.pv - data.pvVsCost.total.cost) }}>{money(data.pvVsCost.total.pv - data.pvVsCost.total.cost)}</span>
              </div>
            )}
          </div>
        </div>
      </ListCard>

      {/* ===== Offer / budget iterations (dropdown + search + pagination 10) ===== */}
      {data.offerIterations.projects.length > 0 && (
        <ListCard
          title={t('finances:portfolio.offers.title')}
          sub={t('finances:portfolio.offers.sub', { avg: data.offerIterations.avgIterations ?? '—' })}
          collapsed={!isOpen('offers')}
          onToggle={() => toggleSection('offers')}
          search={{ value: offerQuery, onChange: setOfferQuery, placeholder: t('finances:portfolio.offers.search') }}
        >
          <div className="fin-scroll">
            <div className="finp-table" style={{ minWidth: 520 }}>
              <div className="finp-row finp-head" style={{ gridTemplateColumns: '1.6fr 110px 130px' }}>
                <span>{t('finances:portfolio.offers.project')}</span><span className="ar">{t('finances:portfolio.offers.iterations')}</span><span>{t('finances:portfolio.offers.status')}</span>
              </div>
              {offerPaged.map((p) => (
                <div key={p.id} className="finp-row" style={{ gridTemplateColumns: '1.6fr 110px 130px' }}>
                  <div className="finp-proj-name truncate" onClick={() => onOpenProjectFinance?.(p.id)} style={onOpenProjectFinance ? undefined : { cursor: 'default' }}>
                    <span className="finp-proj-key">{p.key}</span>
                    <span className="truncate">{p.name}</span>
                  </div>
                  <span className="ar mono" style={{ color: iterColor(p.iterations) }}>{p.iterations}</span>
                  <span className="mono fin-dim" style={{ fontSize: 12 }}>{p.status}</span>
                </div>
              ))}
              {/* Keep the last page the same height as a full one. */}
              {Array.from({ length: offerFillers }).map((_, i) => (
                <div key={'filler-' + i} className="finp-row finp-filler" style={{ gridTemplateColumns: '1.6fr 110px 130px' }} aria-hidden="true">
                  <span>&nbsp;</span><span className="ar">·</span><span>·</span>
                </div>
              ))}
              {offerFiltered.length === 0 && <div className="fin-empty">{t('finances:portfolio.offers.noMatch')}</div>}
            </div>
          </div>
          {offerPages > 1 && (
            <div className="row" style={{ gap: 10, alignItems: 'center', justifyContent: 'center', padding: '8px 0 2px' }}>
              <button className="btn btn-ghost btn-sm" disabled={offerSafePage <= 1} onClick={() => setOfferPage((p) => Math.max(1, p - 1))}>
                ‹ {t('finances:common.prev')}
              </button>
              <span style={{ fontSize: 12, color: 'var(--text-2)' }}>
                {t('finances:common.pageOf', { page: offerSafePage, pages: offerPages })}
              </span>
              <button className="btn btn-ghost btn-sm" disabled={offerSafePage >= offerPages} onClick={() => setOfferPage((p) => Math.min(offerPages, p + 1))}>
                {t('finances:common.next')} ›
              </button>
            </div>
          )}
        </ListCard>
      )}

      {/* Margin by client (no client filter only) — dropdown + search; 0 € hidden */}
      {!filtered && data.clients.some((c) => Math.round(c.margin) !== 0) && (
        <ListCard
          title={t('finances:portfolio.marginByClient.title')}
          collapsed={!isOpen('margin')}
          onToggle={() => toggleSection('margin')}
          search={{ value: marginSearch, onChange: setMarginSearch, placeholder: t('finances:portfolio.searchClient') }}
        >
          <div className="fin-bd">
            <div className="fin-bd-legend">
              {marginRows.map((c) => (
                <div key={keyOf(c.clientId)} className="fin-bd-row" style={{ gridTemplateColumns: '1fr 120px auto' }}
                  {...tipBind(<><b>{clientLabelL(c.clientName, c.clientId)}</b><br /><span className="ct-k">{t('finances:portfolio.marginByClient.tip', { amount: money(c.margin) })}{c.marginPct != null ? ' · ' + c.marginPct + '%' : ''}</span></>)}>
                  <span className="fin-bd-key truncate">{clientLabelL(c.clientName, c.clientId)}</span>
                  <span style={{ display: 'flex', alignItems: 'center', height: 12 }}>
                    <span style={{ height: 10, borderRadius: 3, width: (Math.abs(c.margin) / maxMargin * 100) + '%', background: c.margin < 0 ? 'var(--c-over)' : 'oklch(0.62 0.13 155)' }} />
                  </span>
                  <span className="fin-bd-amt mono">{money(c.margin)}</span>
                </div>
              ))}
              {marginRows.length === 0 && <div className="fin-empty">{t('finances:portfolio.noMatch')}</div>}
            </div>
          </div>
        </ListCard>
      )}
    </div>
  );
}

/**
 * A collapsible report card (a "dropdown" you can hide), shown expanded by
 * default, with an optional search field that has a distinct background.
 */
function ListCard({
  title, sub, collapsed, onToggle, search, children,
}: {
  title: React.ReactNode;
  sub?: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  search?: { value: string; onChange: (v: string) => void; placeholder: string };
  children: React.ReactNode;
}) {
  return (
    <div className="fin-card">
      <div
        className="fin-card-head"
        style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', cursor: 'pointer' }}
        onClick={onToggle}
      >
        <div className="row" style={{ gap: 8, alignItems: 'center', minWidth: 0 }}>
          <Icon name="chevR" size={16} className={'finp-chev' + (collapsed ? '' : ' open')} />
          <div style={{ minWidth: 0 }}>
            <div className="fin-card-title">{title}</div>
            {sub != null && <div className="fin-card-sub">{sub}</div>}
          </div>
        </div>
        {search && !collapsed && (
          <input
            className="fin-search"
            style={{ marginLeft: 'auto', minWidth: 200, maxWidth: 280 }}
            placeholder={search.placeholder}
            value={search.value}
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => search.onChange(e.target.value)}
          />
        )}
      </div>
      {!collapsed && children}
    </div>
  );
}

function ChartCard({ title, children, wide }: { title: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={'fin-card' + (wide ? ' fin-chart-wide' : '')}>
      <div className="fin-card-head"><div className="fin-card-title">{title}</div></div>
      <div className="fin-chart-body">{children}</div>
    </div>
  );
}
