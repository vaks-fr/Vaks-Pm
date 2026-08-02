import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { AgentDto, AgentRunListItemDto, AgentRunsPageDto } from '@vaks-pm/shared';
import { api, downloadFile, saveBlob } from '../api/client';
import { Icon } from './primitives';
import './agent-runs.css';

type Flash = (msg: string) => void;

const PAGE_SIZE = 50;

const money = (n: number | null) => (n == null ? '—' : `${n.toFixed(4).replace(/0+$/, '').replace(/\.$/, '')} €`);
const num = (n: number | null) => (n == null ? '—' : n.toLocaleString());
const compact = (n: number) => new Intl.NumberFormat(undefined, { notation: 'compact', maximumFractionDigits: 2 }).format(n);

function KpiTile({
  icon,
  label,
  value,
  sub,
  subClass,
  warn,
}: {
  icon: string;
  label: string;
  value: React.ReactNode;
  sub?: React.ReactNode;
  subClass?: string;
  warn?: boolean;
}) {
  return (
    <div className={'aruns-kpi' + (warn ? ' aruns-kpi-warn' : '')}>
      <div className="aruns-kpi-cap"><Icon name={icon} size={13} /> {label}</div>
      <div className="aruns-kpi-val">{value}</div>
      {sub != null && <div className={'aruns-kpi-sub' + (subClass ? ` ${subClass}` : '')}>{sub}</div>}
    </div>
  );
}

/**
 * Admin → Users & Identity → AI Agent Management → **Usage & cost ledger**.
 *
 * Le pendant du journal d'audit, côté consommation IA : chaque run déclaré par
 * un agent, avec son coût, ses tokens, son modèle, et le projet/la tâche
 * concernés. La synthèse par agent existait déjà dans la fiche de l'agent, mais
 * rien ne permettait de répondre à « qu'est-ce que l'IA a coûté ce mois-ci, sur
 * quoi, et est-ce que quelque chose cloche ».
 *
 * Deux colonnes de coût côte à côte — **déclaré** (ce que l'agent annonce, base
 * de facturation) et **référence** (recalculé serveur depuis les tokens et les
 * taux du profil). Leur écart est le signal anti-triche ; le filtre « anomalies »
 * ne garde que les lignes que le détecteur juge suspectes. Le bandeau KPI et le
 * compteur de déclarations suspectes portent sur le PÉRIMÈTRE FILTRÉ complet
 * (agent/projet/période), pas seulement la page affichée — cf. `totals`/
 * `anomalyCount` calculés côté serveur.
 */
export default function AgentRunsSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('admin');
  const [data, setData] = useState<AgentRunsPageDto | null>(null);
  const [agents, setAgents] = useState<AgentDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [agentId, setAgentId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [anomaliesOnly, setAnomaliesOnly] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(
        await api.listAgentRuns({ page, pageSize: PAGE_SIZE, agentId, from, to, anomaliesOnly }),
      );
    } catch (e) {
      flash(
        t('agentRuns.loadError', {
          defaultValue: 'Unable to load agent runs: {{message}}',
          message: (e as Error).message,
        }),
      );
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, agentId, from, to, anomaliesOnly]);

  useEffect(() => {
    void load();
  }, [load]);

  // Le filtre agent est une commodité : s'il échoue (droits partiels), la vue
  // reste utilisable sans lui.
  useEffect(() => {
    api.listAgents?.().then(setAgents).catch(() => undefined);
  }, []);

  /** Export CSV du MÊME périmètre que la vue (mêmes filtres, sans pagination). */
  const exportCsv = async () => {
    const p = new URLSearchParams();
    if (agentId) p.set('agentId', agentId);
    if (from) p.set('from', from);
    if (to) p.set('to', to);
    if (anomaliesOnly) p.set('anomaliesOnly', 'true');
    const qs = p.toString();
    try {
      const { blob, filename } = await downloadFile(
        `/admin/agent-runs.csv${qs ? `?${qs}` : ''}`,
        'agent-runs.csv',
      );
      saveBlob(blob, filename);
    } catch (e) {
      flash(
        t('agentRuns.exportError', {
          defaultValue: 'Export failed: {{message}}',
          message: (e as Error).message,
        }),
      );
    }
  };

  const anomalyLabel = (a: AgentRunListItemDto['anomaly']) =>
    a === 'no_tokens'
      ? t('agentRuns.anomaly.noTokens', { defaultValue: 'deliverable without tokens' })
      : a === 'zero_cost'
        ? t('agentRuns.anomaly.zeroCost', { defaultValue: 'zero cost despite a rate' })
        : a === 'below_reference'
          ? t('agentRuns.anomaly.belowReference', { defaultValue: 'far below reference cost' })
          : '';

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  const declaredTotal = data?.totals.cost ?? 0;
  const referenceTotal = data?.totals.derivedCost ?? 0;
  const delta = declaredTotal - referenceTotal;

  return (
    <div className="aruns">
      <p className="aruns-desc">
        {t('agentRuns.desc', {
          defaultValue:
            'Every run declared by an AI agent, newest first. The declared cost is what is billed; the reference cost is recomputed server-side from the tokens and the agent profile rates — a large gap is what the anomaly filter catches.',
        })}
      </p>

      {data && (
        <div className="aruns-kpis">
          <KpiTile
            icon="zap"
            label={t('agentRuns.kpi.runs', { defaultValue: 'Runs' })}
            value={num(data.total)}
            sub={
              from || to
                ? t('agentRuns.kpi.runsSubRange', { defaultValue: '{{from}} → {{to}}', from: from || '…', to: to || '…' })
                : t('agentRuns.kpi.runsSubAllTime', { defaultValue: 'All time · {{count}} agents', count: agents.length })
            }
          />
          <KpiTile
            icon="coins"
            label={t('agentRuns.kpi.cost', { defaultValue: 'Declared cost' })}
            value={money(declaredTotal)}
            sub={t('agentRuns.kpi.costSub', {
              defaultValue: 'reference {{reference}} · gap {{delta}}',
              reference: money(referenceTotal),
              delta: (delta >= 0 ? '+' : '') + money(delta),
            })}
            subClass={delta < 0 ? 'is-warn' : undefined}
          />
          <KpiTile
            icon="arrowRight"
            label={t('agentRuns.kpi.tokens', { defaultValue: 'Tokens (in / out)' })}
            value={
              <>
                <span className="aruns-val-full">{num(data.totals.tokensIn)} / {num(data.totals.tokensOut)}</span>
                <span className="aruns-val-compact">{compact(data.totals.tokensIn)} / {compact(data.totals.tokensOut)}</span>
              </>
            }
            sub={t('agentRuns.kpi.tokensSub', {
              defaultValue: 'in {{in}} · out {{out}}',
              in: compact(data.totals.tokensIn),
              out: compact(data.totals.tokensOut),
            })}
          />
          <KpiTile
            icon="warn"
            label={t('agentRuns.kpi.anomalies', { defaultValue: 'Suspicious declarations' })}
            value={num(data.anomalyCount)}
            sub={t('agentRuns.kpi.anomaliesSub', { defaultValue: 'declared/reference gap over threshold' })}
            warn={data.anomalyCount > 0}
          />
        </div>
      )}

      <div className="aruns-toolbar">
        <div className="aruns-field">
          <span className="aruns-field-label">{t('agentRuns.col.agent', { defaultValue: 'Agent' })}</span>
          <select
            value={agentId}
            onChange={(e) => { setPage(1); setAgentId(e.target.value); }}
            className="aruns-input"
            style={{ minWidth: 180 }}
          >
            <option value="">{t('agentRuns.allAgents', { defaultValue: 'All agents' })}</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        <div className="aruns-field">
          <span className="aruns-field-label">{t('agentRuns.from', { defaultValue: 'From' })}</span>
          <input type="date" value={from} onChange={(e) => { setPage(1); setFrom(e.target.value); }} className="aruns-input" />
        </div>
        <div className="aruns-field">
          <span className="aruns-field-label">{t('agentRuns.to', { defaultValue: 'To' })}</span>
          <input type="date" value={to} onChange={(e) => { setPage(1); setTo(e.target.value); }} className="aruns-input" />
        </div>
        <label className="aruns-toggle">
          <button
            type="button"
            role="switch"
            aria-checked={anomaliesOnly}
            className={'tgl' + (anomaliesOnly ? ' tgl-on' : '')}
            onClick={() => { setPage(1); setAnomaliesOnly((v) => !v); }}
          />
          {t('agentRuns.anomaliesOnly', { defaultValue: 'Suspicious declarations only' })}
        </label>
        <div className="aruns-spacer" />
        <div className="aruns-actions">
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>
            <Icon name="refresh" size={13} /> {t('agentRuns.refresh', { defaultValue: 'Refresh' })}
          </button>
          <button type="button" className="btn btn-accent btn-sm" onClick={() => void exportCsv()}>
            <Icon name="download" size={13} /> {t('agentRuns.exportCsv', { defaultValue: 'Export CSV' })}
          </button>
        </div>
      </div>

      <div className="aruns-table-card">
        {loading && !data ? (
          <div className="aruns-loading">{t('agentRuns.loading', { defaultValue: 'Loading…' })}</div>
        ) : !data || data.items.length === 0 ? (
          <div className="aruns-empty">{t('agentRuns.empty', { defaultValue: 'No run matches these filters.' })}</div>
        ) : (
          <table className="aruns-table">
            <colgroup>
              <col className="aruns-col-date" />
              <col className="aruns-col-agent" />
              <col className="aruns-col-model" />
              <col className="aruns-col-scope" />
              <col className="aruns-col-tokens" />
              <col className="aruns-col-cost" />
              <col className="aruns-col-status" />
            </colgroup>
            <thead>
              <tr>
                <th>{t('agentRuns.col.date', { defaultValue: 'Date' })}</th>
                <th>{t('agentRuns.col.agent', { defaultValue: 'Agent' })}</th>
                <th>{t('agentRuns.col.model', { defaultValue: 'Model' })}</th>
                <th>{t('agentRuns.col.scope', { defaultValue: 'Project / task' })}</th>
                <th>{t('agentRuns.col.tokens', { defaultValue: 'Tokens (in / out)' })}</th>
                <th>{t('agentRuns.col.cost', { defaultValue: 'Cost' })}</th>
                <th>{t('agentRuns.col.status', { defaultValue: 'Status' })}</th>
              </tr>
            </thead>
            <tbody>
              {data.items.map((r) => {
                const tokensTotal = (r.tokensIn ?? 0) + (r.tokensOut ?? 0);
                const inShare = tokensTotal > 0 ? ((r.tokensIn ?? 0) / tokensTotal) * 100 : 0;
                const dateLabel = new Date(r.createdAt).toLocaleString();
                const scopeLabel = r.taskNumber != null ? `#${r.taskNumber} ${r.taskTitle ?? ''}` : '';
                return (
                  <tr key={r.id} className={r.anomaly ? 'aruns-row-anomaly' : undefined}>
                    <td className="aruns-cell-dim" title={dateLabel}>
                      <span className="aruns-ellipsis">{dateLabel}</span>
                    </td>
                    <td title={r.agentName ?? undefined}>
                      <span className="aruns-ellipsis">{r.agentName ?? '—'}</span>
                    </td>
                    <td>
                      {r.model ? (
                        <span className="aruns-pill aruns-pill-model" title={r.model}>{r.model}</span>
                      ) : (
                        <span className="aruns-pill aruns-pill-model-missing">
                          {t('agentRuns.modelUndeclared', { defaultValue: 'not declared' })}
                        </span>
                      )}
                    </td>
                    <td>
                      <span className="aruns-ellipsis" title={r.projectName ?? undefined}>{r.projectName ?? '—'}</span>
                      {scopeLabel && (
                        <span className="aruns-task-sub" title={scopeLabel}>{scopeLabel}</span>
                      )}
                    </td>
                    <td className="aruns-cell-nowrap">
                      <span className="aruns-cell-dim">{num(r.tokensIn)} / {num(r.tokensOut)}</span>
                      {tokensTotal > 0 && (
                        <div className="aruns-tokenbar">
                          <div className="aruns-tokenbar-in" style={{ width: `${inShare}%` }} />
                          <div className="aruns-tokenbar-out" style={{ width: `${100 - inShare}%` }} />
                        </div>
                      )}
                    </td>
                    <td>
                      <span className="aruns-cost-declared" title={money(r.cost)}>{money(r.cost)}</span>
                      <span className="aruns-cost-reference" title={money(r.derivedCost)}>
                        {t('agentRuns.referencePrefix', { defaultValue: 'ref.' })} {money(r.derivedCost)}
                      </span>
                    </td>
                    <td>
                      {r.anomaly ? (
                        <>
                          <span className="aruns-pill aruns-pill-review">
                            <Icon name="warn" size={11} /> {t('agentRuns.status.review', { defaultValue: 'Needs review' })}
                          </span>
                          <span className="aruns-status-reason" title={anomalyLabel(r.anomaly)}>{anomalyLabel(r.anomaly)}</span>
                        </>
                      ) : (
                        <span className="aruns-pill aruns-pill-ok">
                          <Icon name="check" size={11} /> {t('agentRuns.status.ok', { defaultValue: 'OK' })}
                        </span>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>

      {data && totalPages > 1 && (
        <div className="aruns-pager">
          <button type="button" className="btn btn-ghost btn-sm" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
            ←
          </button>
          <span className="aruns-pager-info">
            {t('agentRuns.pageOf', { defaultValue: 'Page {{page}} / {{total}}', page, total: totalPages })}
          </span>
          <button
            type="button"
            className="btn btn-ghost btn-sm"
            disabled={page >= totalPages}
            onClick={() => setPage((p) => p + 1)}
          >
            →
          </button>
        </div>
      )}
    </div>
  );
}
