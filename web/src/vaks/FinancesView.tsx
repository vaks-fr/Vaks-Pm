/* ============================================================
   Vaks — Finances / Cost control (per project)
   Ported from the Claude Design mock (FinancesView.jsx), wired to the
   real budget-summary API. Excludes the "Cost parameters" panel.
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, Avatar } from './primitives';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import type {
  ProjectBudgetSummaryDto,
  ProjectExpenseCategory,
  ProjectEvmDto,
  ProjectAgentRatesDto,
  AgentRateRowDto,
} from '@vaks-pm/shared';
import { PvAcLine } from './report-charts';
import { fmtMoney, fmtMoneyWhole, fmtMoneyCompact, parseMoney } from './projects/money';
import { avatarUser } from './projects/shared';
import { ExpensesSection } from './projects/ExpensesSection';
import { useChartTooltip } from './chart-tooltip';
import './finances.css';

const LABOR_HUE = 285;
const AGENT_HUE = 150;
const CAT_HUE: Record<ProjectExpenseCategory, number> = {
  LICENSE: 215,
  HARDWARE: 25,
  CLOUD: 195,
  SUBCONTRACTOR: 330,
  OTHER: 60,
};
interface Props {
  projectId: string;
  pushToast: (text: string, warn?: boolean) => void;
}

export function FinancesView({ projectId, pushToast }: Props) {
  const { t } = useTranslation('finances');
  const { can } = useAuth();
  const canManage = can('finance:manage');
  const { bind: tipBind, tipNode } = useChartTooltip();
  const [budget, setBudget] = useState<ProjectBudgetSummaryDto | null>(null);
  const [evm, setEvm] = useState<ProjectEvmDto | null>(null);
  const [agentRates, setAgentRates] = useState<ProjectAgentRatesDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(false);

  const reload = useCallback(() => {
    setLoading(true);
    api
      .getProjectBudgetSummary(projectId)
      .then((b) => {
        setBudget(b);
        setLoadError(false);
      })
      .catch(() => setLoadError(true))
      .finally(() => setLoading(false));
    api.getProjectEvm(projectId).then(setEvm).catch(() => setEvm(null));
    api.getAgentRates(projectId).then(setAgentRates).catch(() => setAgentRates(null));
  }, [projectId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const cur = budget?.currency ?? 'EUR';
  const money = (n: number | null | undefined) =>
    fmtMoney(n == null ? n : Math.round(n), cur);
  const signed = (n: number) => (n < 0 ? '−' : '+') + money(Math.abs(n)).replace(/^[−-]/, '');
  // Valeur KPI : euros entiers exacts (déborde jamais quand ça tient), et bascule
  // en compact « k/M » via container-query quand la carte est trop étroite
  // (cf. finances.css) ; montant exact au survol.
  const moneyWhole = (n: number | null | undefined) => fmtMoneyWhole(n == null ? n : Math.round(n), cur);
  const moneyK = (n: number | null | undefined) => fmtMoneyCompact(n == null ? n : Math.round(n), cur);
  const kpiMoney = (n: number | null | undefined) => (
    <div className="fin-kpi-val mono" title={n == null ? undefined : moneyWhole(n)}>
      <span className="fin-val-full">{moneyWhole(n)}</span>
      <span className="fin-val-compact">{moneyK(n)}</span>
    </div>
  );

  /* ---- derived figures (mirror the design) ---- */
  const d = useMemo(() => {
    const b = budget;
    if (!b) return null;
    const budgetAmt = b.budgetAmount ?? 0;
    const spent = b.actualCost ?? 0;
    const laborToDate = b.laborActualCost ?? Math.max(0, spent - (b.nonLaborActualCost ?? 0));
    const expIncurred = b.nonLaborActualCost ?? 0;
    // Prévision = coût d'allocation (Σ heures effectives planifiées × taux) + dépenses
    // planifiées. Source unique = forecastCost serveur (fini la divergence estimés/allocs).
    const forecast = b.forecastCost ?? (spent + (b.remainingLaborCost ?? 0) + (b.nonLaborForecastCost ?? 0));
    const committed = Math.max(0, forecast - spent);
    const variance = budgetAmt - forecast;
    const overBudget = variance < 0;
    const spentPct = budgetAmt ? (spent / budgetAmt) * 100 : 0;
    // Marge = définition unique « MO + dépenses » : CA total − coût total (champs serveur).
    const billableValue = b.billableRevenue ?? 0;
    const marginToDate = b.margin ?? (billableValue - spent);
    // Prévisionnel à terminaison (allocations + dépenses planifiées facturables).
    const forecastRevenue = b.forecastRevenue ?? 0;
    const forecastMargin = b.forecastMargin ?? (forecastRevenue - forecast);
    // burn geometry
    const denom = Math.max(budgetAmt, forecast, 1);
    const spentW = (spent / denom) * 100;
    const commW = (committed / denom) * 100;
    const budgetMark = (budgetAmt / denom) * 100;
    // breakdown = composition du coût prévu (M.O. prévisionnelle + dépenses + agents IA).
    const segs = [{ key: t('finances:common.labor'), hue: LABOR_HUE, amount: b.laborForecastCost ?? laborToDate }];
    const agentEac = Math.max(b.agentCostReal ?? 0, b.agentCostForecast ?? 0);
    if (agentEac > 0) segs.push({ key: t('finances:common.aiAgents'), hue: AGENT_HUE, amount: agentEac });
    (b.expensesByCategory ?? []).forEach((c) =>
      segs.push({
        key: (['LICENSE', 'HARDWARE', 'CLOUD', 'SUBCONTRACTOR', 'OTHER'] as ProjectExpenseCategory[]).includes(c.category as ProjectExpenseCategory)
          ? t('finances:expenseCategory.' + c.category)
          : c.category,
        hue: CAT_HUE[c.category as ProjectExpenseCategory] ?? 60,
        amount: c.actualCost + c.plannedCost,
      }),
    );
    const breakdown = segs.filter((s) => s.amount > 0).sort((a, b2) => b2.amount - a.amount);
    const bdTotal = breakdown.reduce((s, x) => s + x.amount, 0) || 1;
    return {
      budgetAmt, spent, laborToDate, expIncurred,
      committed, forecast, variance, overBudget, spentPct, billableValue, marginToDate,
      forecastRevenue, forecastMargin,
      spentW, commW, budgetMark, breakdown, bdTotal,
    };
  }, [budget, t]);

  if (loading && !budget) {
    return <div className="fin-wrap"><div style={{ color: 'var(--text-3)' }}>{t('finances:common.loadingShort')}</div></div>;
  }
  if (!budget || !d) {
    return (
      <div className="fin-wrap">
        <div className="md-warn">
          <Icon name="warn" size={14} /> {loadError ? t('finances:project.loadError') : t('finances:project.unavailable')}
          <button className="btn btn-sm btn-ghost" onClick={reload} style={{ marginLeft: 8 }}>{t('finances:common.retry')}</button>
        </div>
      </div>
    );
  }
  const b = budget;

  return (
    <div className="fin-wrap">
      {tipNode}
      {/* ===================== KPI band ===================== */}
      <div className={'fin-kpis ' + (b.billable ? 'k5' : 'k3')}>
        <div className="fin-kpi fin-kpi-budget">
          <div className="fin-kpi-cap"><Icon name="flag" size={14} /> {t('finances:project.kpi.budget')}</div>
          {kpiMoney(d.budgetAmt)}
          <div className="fin-kpi-sub">{t('finances:project.kpi.budgetSub', { billability: b.billable ? t('finances:project.kpi.billable') : t('finances:project.kpi.nonBillable') })}</div>
        </div>

        <div className="fin-kpi">
          <div className="fin-kpi-cap"><Icon name="hourglass" size={14} /> {t('finances:project.kpi.spentToDate')}</div>
          {kpiMoney(d.spent)}
          <div className="fin-kpi-bar"><div className="fin-kpi-bar-fill" style={{ width: Math.min(100, d.spentPct) + '%' }} /></div>
          <div className="fin-kpi-sub">{t('finances:project.kpi.spentSub', { pct: Math.round(d.spentPct), labor: money(d.laborToDate), costs: money(d.expIncurred) })}</div>
        </div>

        <div className="fin-kpi">
          <div className="fin-kpi-cap"><Icon name="arrowRight" size={14} /> {t('finances:project.kpi.forecast')}</div>
          {kpiMoney(d.forecast)}
          <div className={'fin-kpi-sub ' + (d.overBudget ? 'is-over' : 'is-under')}>
            <span className="fin-pill">{d.overBudget ? t('finances:project.kpi.overBudget') : t('finances:project.kpi.underBudget')} {money(Math.abs(d.variance))}</span>
            {d.committed > 0 && <span className="fin-kpi-dim"> · {t('finances:project.kpi.remainingToCommit', { amount: money(d.committed) })}</span>}
          </div>
        </div>

        {b.billable && (
          <div className="fin-kpi">
            <div className="fin-kpi-cap"><Icon name="zap" size={14} /> {t('finances:project.kpi.billableValue')}</div>
            {kpiMoney(d.billableValue)}
            <div className={'fin-kpi-sub ' + (d.marginToDate >= 0 ? 'is-under' : 'is-over')}>
              {t('finances:project.kpi.margin', { amount: signed(d.marginToDate) })} <span className="fin-kpi-dim">{t('finances:project.kpi.marginNote', { pct: d.billableValue ? Math.round((d.marginToDate / d.billableValue) * 100) : 0 })}</span>
            </div>
          </div>
        )}

        {b.billable && (
          <div className="fin-kpi">
            <div className="fin-kpi-cap"><Icon name="arrowRight" size={14} /> {t('finances:project.kpi.forecastRevenue')}</div>
            {kpiMoney(d.forecastRevenue)}
            <div className={'fin-kpi-sub ' + (d.forecastMargin >= 0 ? 'is-under' : 'is-over')}>
              {t('finances:project.kpi.forecastMargin', { amount: signed(d.forecastMargin) })} <span className="fin-kpi-dim">{t('finances:project.kpi.forecastMarginNote', { pct: d.forecastRevenue ? Math.round((d.forecastMargin / d.forecastRevenue) * 100) : 0 })}</span>
            </div>
          </div>
        )}
      </div>

      {/* ===================== Burn bar ===================== */}
      <div className="fin-card">
        <div className="fin-card-head">
          <div className="fin-card-title">{t('finances:project.burn.title')}</div>
          <div className="fin-burn-legend">
            <span><i className="sw sw-spent" /> {t('finances:project.burn.spent', { amount: money(d.spent) })}</span>
            <span><i className="sw sw-comm" /> {t('finances:project.burn.committed', { amount: money(d.committed) })}</span>
            <span><i className="sw sw-free" /> {d.overBudget ? t('finances:project.burn.overBudget') : t('finances:project.burn.marginLeft', { amount: money(Math.max(0, d.variance)) })}</span>
          </div>
        </div>
        <div className="fin-burn">
          <div className="fin-burn-track">
            <div className="fin-burn-seg spent" style={{ width: d.spentW + '%' }} {...tipBind(<><b>{t('finances:project.burn.spentTip')}</b><br /><span className="ct-k">{money(d.spent)}</span></>)} />
            <div className={'fin-burn-seg comm' + (d.overBudget ? ' over' : '')} style={{ width: d.commW + '%' }} {...tipBind(<><b>{t('finances:project.burn.committedTip')}</b><br /><span className="ct-k">{money(d.committed)}</span></>)} />
            {d.budgetAmt > 0 && (
              <div className="fin-burn-mark" style={{ left: d.budgetMark + '%' }}>
                <span className="fin-burn-mark-lbl mono">{money(d.budgetAmt)}</span>
              </div>
            )}
          </div>
          <div className="fin-burn-foot">
            <span>{money(0)}</span>
            <span className="fin-burn-eac">{t('finances:project.burn.forecast')} <b className="mono">{money(d.forecast)}</b>{d.budgetAmt > 0 && ` · ${t('finances:project.burn.forecastPct', { pct: Math.round((d.forecast / d.budgetAmt) * 100) })}`}</span>
          </div>
        </div>
      </div>

      {/* ===================== EVM (valeur acquise) ===================== */}
      {evm && (
        <div className="fin-card">
          <div className="fin-card-head">
            <div>
              <div className="fin-card-title">{t('finances:project.evm.title')}</div>
              <div className="fin-card-sub">{t('finances:project.evm.sub', { pct: evm.percentComplete })}</div>
            </div>
          </div>
          <div className="fin-chart-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s4)' }}>
            <div className="fin-kpis" style={{ gridTemplateColumns: 'repeat(4, 1fr)' }}>
              <div className="fin-kpi">
                <div className="fin-kpi-cap">{t('finances:project.evm.budgetVariance')}</div>
                {kpiMoney(evm.budgetVariance)}
                <div className={'fin-kpi-sub ' + ((evm.budgetVariance ?? 0) >= 0 ? 'is-under' : 'is-over')}>
                  {evm.budgetVariance == null ? t('finances:project.evm.missingDates') : (evm.budgetVariance >= 0 ? t('finances:project.evm.underPlanned') : t('finances:project.evm.overPlanned'))}
                </div>
              </div>
              <div className="fin-kpi">
                <div className="fin-kpi-cap">{t('finances:project.evm.cpi')}</div>
                <div className="fin-kpi-val mono" style={{ color: evm.cpi != null && evm.cpi < 1 ? 'var(--c-over)' : undefined }}>{evm.cpi == null ? '—' : evm.cpi.toFixed(2)}</div>
                <div className={'fin-kpi-sub ' + ((evm.cpi ?? 1) >= 1 ? 'is-under' : 'is-over')}>{evm.cpi == null ? t('finances:project.evm.noActualCost') : evm.cpi < 1 ? t('finances:project.evm.costOverrun') : t('finances:project.evm.efficient')}</div>
              </div>
              <div className="fin-kpi">
                <div className="fin-kpi-cap">{t('finances:project.evm.ev')}</div>
                {kpiMoney(evm.ev)}
                <div className="fin-kpi-sub">{t('finances:project.evm.evFormula', { pct: evm.percentComplete })}</div>
              </div>
              <div className="fin-kpi">
                <div className="fin-kpi-cap">{t('finances:project.evm.spi')}</div>
                <div className="fin-kpi-val mono">{evm.spi == null ? '—' : evm.spi.toFixed(2)}</div>
                <div className="fin-kpi-sub">{t('finances:project.evm.spiSub')}</div>
              </div>
            </div>
            <PvAcLine data={evm.monthly} fmt={money} />
            {!evm.hasDates && (
              <div className="md-hint"><span className="ct-k">ℹ</span> {t('finances:project.evm.noDatesHint')}</div>
            )}
          </div>
        </div>
      )}

      {/* ===================== Coût agents IA ===================== */}
      {((b.agentCostReal ?? 0) > 0 || b.agentCostBudget != null || b.agentCostForecast != null || (b.agentBilledReal ?? 0) > 0) && (() => {
        const real = b.agentCostReal ?? 0;
        const billed = b.agentBilledReal ?? 0;         // CA facturé (déjà dans le CA projet)
        const forecast = b.agentCostForecast;          // null = pas d'estimation
        const budget = b.agentCostBudget;              // null = pas d'enveloppe
        const projected = forecast ?? real;            // total prévisionnel (réel si pas de forecast)
        const hasBudget = budget != null && budget > 0;
        const remaining = hasBudget ? budget! - projected : null;
        const over = hasBudget && projected > budget!;
        // Barre : échelle = max(budget, prévisionnel). Réel = « dépensé »,
        // (prévisionnel − réel) = « engagé/à venir », repère au budget.
        const scale = Math.max(budget ?? 0, projected, real, 1);
        const realW = Math.min(100, (real / scale) * 100);
        const commW = Math.min(100 - realW, (Math.max(0, projected - real) / scale) * 100);
        const budgetMark = hasBudget ? Math.min(100, (budget! / scale) * 100) : 0;
        return (
        <div className="fin-card">
          <div className="fin-card-head">
            <div>
              <div className="fin-card-title">{t('finances:project.agents.title')}</div>
              <div className="fin-card-sub">
                {hasBudget
                  ? t('finances:project.agents.subBudget', { defaultValue: 'Declared runs vs forecast, against the project AI budget.' })
                  : t('finances:project.agents.subNoBudget', { defaultValue: 'Declared runs vs forecast (no AI budget set on this project).' })}
              </div>
            </div>
          </div>
          <div className="fin-chart-body" style={{ display: 'flex', flexDirection: 'column', gap: 'var(--s4)' }}>
            <div className="fin-kpis" style={{ gridTemplateColumns: `repeat(${b.billable && billed > 0 ? 4 : 3}, 1fr)` }}>
              <div className="fin-kpi">
                <div className="fin-kpi-cap">{t('finances:project.agents.real')}</div>
                {kpiMoney(real)}
                <div className="fin-kpi-sub">
                  {hasBudget
                    ? t('finances:project.agents.usedPct', { pct: Math.round((real / budget!) * 100) })
                    : t('finances:project.agents.realSub', { defaultValue: 'declared by agents' })}
                </div>
              </div>
              {b.billable && billed > 0 && (
                <div className="fin-kpi">
                  <div className="fin-kpi-cap">{t('finances:project.agents.billed')}</div>
                  {kpiMoney(billed)}
                  <div className={'fin-kpi-sub ' + (billed >= real ? 'is-under' : 'is-over')}>
                    {t('finances:project.agents.billedSub')}
                  </div>
                </div>
              )}
              <div className="fin-kpi">
                <div className="fin-kpi-cap">{t('finances:project.agents.forecast')}</div>
                {kpiMoney(forecast)}
                <div className="fin-kpi-sub">{t('finances:project.agents.forecastSub', { defaultValue: 'remaining tasks × avg cost/task' })}</div>
              </div>
              <div className="fin-kpi">
                <div className="fin-kpi-cap">{t('finances:project.agents.budget')}</div>
                {kpiMoney(budget)}
                <div className={'fin-kpi-sub ' + (!hasBudget ? '' : over ? 'is-over' : 'is-under')}>
                  {!hasBudget
                    ? t('finances:project.agents.noBudget', { defaultValue: 'no budget set' })
                    : over
                      ? t('finances:project.agents.overBy', { defaultValue: 'over by {{amount}}', amount: money(-remaining!) })
                      : t('finances:project.agents.leftAmount', { defaultValue: '{{amount}} left', amount: money(remaining!) })}
                </div>
              </div>
            </div>
            {hasBudget && (
              <div className="fin-burn">
                <div className="fin-burn-track">
                  <div className="fin-burn-seg spent" style={{ width: realW + '%' }} />
                  <div className={'fin-burn-seg comm' + (over ? ' over' : '')} style={{ width: commW + '%' }} />
                  <div className="fin-burn-mark" style={{ left: budgetMark + '%' }}>
                    <span className="fin-burn-mark-lbl mono">{money(budget)}</span>
                  </div>
                </div>
                <div className="fin-burn-foot">
                  <span>{money(0)}</span>
                  <span className="fin-burn-eac">
                    {t('finances:project.agents.forecast')} <b className="mono">{money(projected)}</b>
                    {` · ${t('finances:project.agents.usedPct', { pct: Math.round((projected / budget!) * 100) })}`}
                  </span>
                </div>
              </div>
            )}
            <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
              {t('finances:project.agents.includedNote')}
            </div>
          </div>
        </div>
        );
      })()}

      {/* ===================== Taux agents IA (€ / 1K tokens) =====================
          Miroir des taux membres, unité kToken. Visible seulement si le projet
          autorise les agents (`agentsEnabled`) ET qu'il y a des agents à lister. */}
      {agentRates?.enabled && agentRates.agents.length > 0 && (
        <div className="fin-card">
          <div className="fin-card-head">
            <div>
              <div className="fin-card-title">{t('finances:project.agentRates.title')}</div>
              <div className="fin-card-sub">{t('finances:project.agentRates.sub')}</div>
            </div>
          </div>
          <div className="fin-scroll">
            <div className="fin-table fin-rates fin-agent-rates">
              <div className="fin-tr fin-th">
                <span>{t('finances:project.agentRates.agent')}</span>
                <span className="ar">{t('finances:project.agentRates.billPerKTokens')}</span>
                <span className="ar">{t('finances:project.agentRates.kUnits')}</span>
                <span className="ar">{t('finances:project.agentRates.runs')}</span>
                <span className="ar">{t('finances:project.agentRates.cost')}</span>
                <span className="ar">{t('finances:project.agentRates.billed')}</span>
              </div>
              {agentRates.agents.map((a) => (
                <AgentRateRow
                  key={a.agentId}
                  row={a}
                  cur={cur}
                  canManage={canManage}
                  onSave={async (rate) => {
                    try {
                      const next =
                        rate == null
                          ? await api.deleteAgentRate(projectId, a.agentId)
                          : await api.setAgentRate(projectId, a.agentId, { billRatePerKTokens: rate });
                      setAgentRates(next);
                      pushToast(t('finances:project.rates.saved'));
                    } catch (e) {
                      pushToast(t('finances:project.rates.saveFailed', { message: (e as Error).message }), true);
                    }
                  }}
                />
              ))}
              <div className="fin-tr fin-tfoot">
                <span>{t('finances:project.agentRates.footAgents', { count: agentRates.agents.length })}</span>
                <span className="ar" />
                <span className="ar mono">{agentRates.totalKTokens}</span>
                <span className="ar" />
                <span className="ar mono">{fmtMoney(agentRates.totalCost, cur)}</span>
                <span className="ar mono fin-bill">{fmtMoney(agentRates.totalBilled, cur)}</span>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===================== Rate card ===================== */}
      <div className="fin-card">
        <div className="fin-card-head">
          <div>
            <div className="fin-card-title">{t('finances:project.rates.title')}</div>
            <div className="fin-card-sub">{t('finances:project.rates.sub')}</div>
          </div>
        </div>
        <div className="fin-scroll">
          <div className="fin-table fin-rates">
            <div className="fin-tr fin-th">
              <span>{t('finances:project.rates.member')}</span>
              <span className="ar">{t('finances:project.rates.costPerHour')}</span>
              <span className="ar">{t('finances:project.rates.billPerHour')}</span>
              <span className="ar">{t('finances:project.rates.logged')}</span>
              <span className="ar">{t('finances:project.rates.laborCost')}</span>
              <span className="ar">{t('finances:project.rates.billableShort')}</span>
            </div>
            {b.members.length === 0 && (
              <div className="fin-empty">{t('finances:project.rates.empty')}</div>
            )}
            {b.members.map((m) => (
              <RateRow
                key={m.userId}
                member={m}
                cur={cur}
                canManage={canManage}
                onSave={async (cost, bill) => {
                  try {
                    await api.setProjectRate(projectId, m.userId, { costRate: cost, billRate: bill });
                    await reload();
                    pushToast(t('finances:project.rates.saved'));
                  } catch (e) {
                    pushToast(t('finances:project.rates.saveFailed', { message: (e as Error).message }), true);
                  }
                }}
              />
            ))}
            {b.members.length > 0 && (
              <div className="fin-tr fin-tfoot">
                <span>{t('finances:project.rates.footPeople', { count: b.members.length, hours: Math.round(b.members.reduce((s, m) => s + m.actualHours, 0)) })}</span>
                <span className="ar fin-dim">{(() => {
                  const r = b.members.map((m) => m.costRate).filter((c): c is number => c != null);
                  return r.length ? t('finances:project.rates.avgRate', { amount: money(r.reduce((a, x) => a + x, 0) / r.length) }) : '';
                })()}</span>
                <span className="ar" />
                <span className="ar mono">{t('finances:project.rates.footHours', { hours: Math.round(b.members.reduce((s, m) => s + m.actualHours, 0)) })}</span>
                <span className="ar mono">{money(d.laborToDate)}</span>
                <span className="ar mono fin-bill">{money(d.billableValue)}</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ===================== Expenses (reuse existing editor) ===================== */}
      <div className="fin-card">
        <div className="fin-card-head">
          <div>
            <div className="fin-card-title">{t('finances:project.expenses.title')}</div>
            <div className="fin-card-sub">{t('finances:project.expenses.sub')}</div>
          </div>
        </div>
        <div style={{ padding: 'var(--s4) var(--s5) var(--s5)' }}>
          <ExpensesSection
            projectId={projectId}
            currency={cur}
            billable={b.billable}
            canManage={canManage}
            pushToast={(t, warn) => { pushToast(t, warn); reload(); }}
          />
        </div>
      </div>

      {/* ===================== Cost breakdown ===================== */}
      <div className="fin-card">
        <div className="fin-card-head">
          <div className="fin-card-title">{t('finances:project.breakdown.title')}</div>
          <div className="fin-card-sub2 mono">{t('finances:project.breakdown.forecast', { amount: money(d.bdTotal) })}</div>
        </div>
        <div className="fin-bd">
          <div className="fin-bd-bar">
            {d.breakdown.map((s) => (
              <div key={s.key} className="fin-bd-seg"
                style={{ width: (s.amount / d.bdTotal * 100) + '%', background: `oklch(0.62 0.16 ${s.hue})` }}
                {...tipBind(<><b>{s.key}</b><br /><span className="ct-k">{money(s.amount)} · {Math.round(s.amount / d.bdTotal * 100)}%</span></>)} />
            ))}
          </div>
          <div className="fin-bd-legend">
            {d.breakdown.map((s) => (
              <div key={s.key} className="fin-bd-row">
                <span className="fin-bd-dot" style={{ background: `oklch(0.62 0.16 ${s.hue})` }} />
                <span className="fin-bd-key">{s.key}</span>
                <span className="fin-bd-pct mono fin-dim">{Math.round(s.amount / d.bdTotal * 100)}%</span>
                <span className="fin-bd-amt mono">{money(s.amount)}</span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

/* ---- editable rate row ---- */
function RateRow({
  member, cur, canManage, onSave,
}: {
  member: ProjectBudgetSummaryDto['members'][number];
  cur: string;
  canManage: boolean;
  onSave: (cost: number, bill: number | null) => void;
}) {
  const { t } = useTranslation('finances');
  const initCost = member.costRate != null ? String(member.costRate) : '';
  const initBill = member.billRate != null ? String(member.billRate) : '';
  const [cost, setCost] = useState(initCost);
  const [bill, setBill] = useState(initBill);
  useEffect(() => { setCost(initCost); setBill(initBill); /* eslint-disable-next-line */ }, [initCost, initBill]);
  const money = (n: number | null | undefined) => fmtMoney(n == null ? n : Math.round(n), cur);
  const dirty = cost !== initCost || bill !== initBill;
  const commit = () => {
    if (!dirty) return;
    const c = parseMoney(cost);
    if (c === null) return;
    onSave(c, parseMoney(bill));
  };

  return (
    <div className="fin-tr">
      <div className="fin-member">
        <Avatar user={avatarUser({ id: member.userId, name: member.name })} size={30} title={false} />
        <div style={{ minWidth: 0 }}>
          <div className="fin-member-name truncate">{member.name}{!member.hasRate && <span className="fin-member-role">{t('finances:project.rates.defaultRate')}</span>}</div>
        </div>
      </div>
      <div className="ar">
        {canManage ? (
          <span className="fin-num"><span className="fin-num-pre">{cur}</span>
            <input type="number" min={0} step={5} value={cost} style={{ width: 48 }}
              onChange={(e) => setCost(e.target.value)} onBlur={commit}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          </span>
        ) : <span className="mono">{money(member.costRate)}</span>}
      </div>
      <div className="ar">
        {canManage ? (
          <span className="fin-num"><span className="fin-num-pre">{cur}</span>
            <input type="number" min={0} step={5} value={bill} style={{ width: 48 }}
              onChange={(e) => setBill(e.target.value)} onBlur={commit}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          </span>
        ) : <span className="mono">{money(member.billRate)}</span>}
      </div>
      <div className="ar mono fin-dim">{member.actualHours ? member.actualHours + 'h' : '—'}</div>
      <div className="ar mono">{member.actualHours ? money(member.actualCost) : '—'}</div>
      <div className="ar mono fin-bill">{member.billableRevenue ? money(member.billableRevenue) : '—'}</div>
    </div>
  );
}

/* ---- editable agent rate row (€ / 1K tokens) ---- */
function AgentRateRow({
  row, cur, canManage, onSave,
}: {
  row: AgentRateRowDto;
  cur: string;
  canManage: boolean;
  /** null = efface l'override projet (retour au défaut agent). */
  onSave: (rate: number | null) => void;
}) {
  const { t } = useTranslation('finances');
  // L'input ne montre QUE l'override projet ; le défaut agent hérité passe en
  // placeholder (comme un champ « hérité » classique).
  const init = row.hasProjectRate && row.billRatePerKTokens != null ? String(row.billRatePerKTokens) : '';
  const [rate, setRate] = useState(init);
  useEffect(() => { setRate(init); /* eslint-disable-next-line */ }, [init]);
  const money = (n: number | null | undefined) => fmtMoney(n == null ? n : Math.round(n), cur);
  const dirty = rate !== init;
  const commit = () => {
    if (!dirty) return;
    if (rate.trim() === '') {
      if (row.hasProjectRate) onSave(null);
      return;
    }
    // Pas de parseMoney (arrondi 2 déc.) : un taux kToken se joue à 4 décimales.
    const v = Number(rate.trim().replace(',', '.'));
    if (!Number.isFinite(v) || v < 0) return;
    onSave(Math.round(v * 10000) / 10000);
  };
  const inherited = !row.hasProjectRate && row.source === 'agent_default';

  return (
    <div className="fin-tr">
      <div className="fin-member">
        <Avatar user={avatarUser({ id: row.agentId, name: row.name })} size={30} title={false} />
        <div style={{ minWidth: 0 }}>
          <div className="fin-member-name truncate">
            {row.name}
            {inherited && <span className="fin-member-role">{t('finances:project.agentRates.defaultRate')}</span>}
            {row.billRatePerKTokens == null && <span className="fin-member-role">{t('finances:project.agentRates.noRate')}</span>}
          </div>
          {(row.model || row.billingUnit === 'credits') && (
            <div className="fin-member-role truncate">
              {row.model}
              {row.billingUnit === 'credits' && `${row.model ? ' · ' : ''}${t('finances:project.agentRates.unitCredits')}`}
            </div>
          )}
        </div>
      </div>
      <div className="ar">
        {canManage ? (
          <span className="fin-num"><span className="fin-num-pre">{cur}</span>
            <input
              type="number" min={0} step={0.01} value={rate} style={{ width: 64 }}
              placeholder={inherited && row.billRatePerKTokens != null ? String(row.billRatePerKTokens) : ''}
              onChange={(e) => setRate(e.target.value)} onBlur={commit}
              onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
          </span>
        ) : (
          <span className="mono">{row.billRatePerKTokens != null ? `${cur} ${row.billRatePerKTokens}` : '—'}</span>
        )}
      </div>
      <div className="ar mono fin-dim">{row.kTokens > 0 ? row.kTokens : '—'}</div>
      <div className="ar mono fin-dim">{row.runs || '—'}</div>
      {/* Coûts agents en CENTIMES : `money` arrondit à l'euro (budgets projet),
          ce qui écrase un coût d'agent < 1 € en « €0.00 ». `fmtMoney` garde 2 déc. */}
      <div className="ar mono">{row.cost ? fmtMoney(row.cost, cur) : '—'}</div>
      <div className="ar mono fin-bill">{row.billed != null && row.billed > 0 ? fmtMoney(row.billed, cur) : '—'}</div>
    </div>
  );
}
