/* ============================================================
   Vaks — AI Agents (sidebar > Workspace > AI Agents).
   Liste, pour l'utilisateur courant, les agents IA qui lui sont
   liés : ceux dont il est owner + ceux des équipes qu'il mène
   (team lead). Paginée à 10. Même listing COMPACT que la liste
   des utilisateurs (dir-card / dir-row). Lecture seule.
   ============================================================ */
import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon, Avatar } from './primitives';
import { api } from '../api/client';
import { hueFromId } from './AdminPanel';
import { useEscapeKey } from './projects/shared';
import { UserSkillsDialog } from './TeamView';
import { KNOWN_AGENT_MODELS } from '@vaks-pm/shared';
import type { WorkspaceAgentDto, WorkspaceAgentDetailDto } from '@vaks-pm/shared';

const PAGE_SIZE = 10;

const TRUST_HUE: Record<string, number> = { DRAFT_ONLY: 25, SUPERVISED: 250, AUTONOMOUS: 155 };

export function AgentsWorkspaceView() {
  const { t } = useTranslation('teams');
  const [items, setItems] = useState<WorkspaceAgentDto[]>([]);
  const [total, setTotal] = useState(0);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(async (p: number) => {
    setLoading(true);
    try {
      const res = await api.getMyAgents(p, PAGE_SIZE);
      setItems(res.items);
      setTotal(res.total);
      setPage(res.page);
    } catch {
      setItems([]);
      setTotal(0);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(1);
  }, [load]);

  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const initials = (name: string) =>
    name.split(' ').map((w) => w[0]).join('').slice(0, 2).toUpperCase();

  return (
    <div style={{ height: '100%', overflowY: 'auto', padding: 16 }}>
      <div style={{ maxWidth: 1100, margin: '0 auto' }}>
        <header style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <Icon name="zap" size={18} />
            <h2 style={{ margin: 0, fontSize: 18 }}>{t('agentsWs.title', { defaultValue: 'AI Agents' })}</h2>
          </div>
          {!loading && total > 0 && (
            <span
              className="pill"
              style={{ background: 'var(--surface-2)', color: 'var(--text-3)', fontSize: 11, padding: '2px 8px', borderRadius: 999 }}
            >
              {t('agentsWs.count', { defaultValue: '{{count}} agents', count: total })}
            </span>
          )}
        </header>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginBottom: 16, lineHeight: 1.5 }}>
          {t('agentsWs.subtitle', {
            defaultValue: 'AI agents linked to you — those you own, plus agents of teams you lead.',
          })}
        </div>

        <div className="dir-card">
          {loading && (
            <div className="set-desc" style={{ padding: 16 }}>{t('agentsWs.loading', { defaultValue: 'Loading…' })}</div>
          )}
          {!loading && items.length === 0 && (
            <div className="set-desc" style={{ padding: 16 }}>
              {t('agentsWs.empty', { defaultValue: 'No AI agent is linked to you yet.' })}
            </div>
          )}
          {!loading &&
            items.map((a) => (
              <div className="dir-row" key={a.id}>
                <Avatar
                  user={{
                    id: a.id,
                    name: a.name,
                    short: a.name.split(' ')[0],
                    initials: initials(a.name),
                    role: '',
                    hue: hueFromId(a.id),
                    online: a.status === 'ACTIVE',
                  }}
                  size={32}
                  title={false}
                />
                <div className="dir-id">
                  <div className="dir-name" style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                    <span>{a.name}</span>
                    <span
                      className="pill"
                      style={{
                        fontSize: 10, padding: '1px 6px', borderRadius: 999,
                        background: `oklch(0.62 0.13 ${TRUST_HUE[a.trustLevel] ?? 250} / 0.18)`,
                        color: `oklch(0.62 0.14 ${TRUST_HUE[a.trustLevel] ?? 250})`,
                      }}
                      title={t('agentsWs.trustLabel', { defaultValue: 'Trust level' })}
                    >
                      {t('agentsWs.trust.' + a.trustLevel, { defaultValue: a.trustLevel })}
                    </span>
                    {a.status === 'SUSPENDED' && (
                      <span className="pill" style={{ fontSize: 10, padding: '1px 6px', color: 'var(--text-faint)' }}>
                        {t('agentsWs.suspended', { defaultValue: 'Suspended' })}
                      </span>
                    )}
                  </div>
                  <div className="dir-email mono">
                    {a.email}
                    {' · '}
                    {a.model ? (a.modelProvider ? `${a.modelProvider}/${a.model}` : a.model) : t('agentsWs.noModel', { defaultValue: 'no model declared' })}
                    {a.ownerName && ` · ${a.ownerName}`}
                  </div>
                </div>
                <div className="dir-title">
                  {a.skills.length > 0 ? (
                    <span style={{ display: 'inline-flex', gap: 4, flexWrap: 'wrap' }}>
                      {a.skills.slice(0, 4).map((s) => (
                        <span key={s.skillId} className="skl-chip" style={{ fontSize: 11 }}>
                          {s.name} <span className="mono" style={{ opacity: 0.7 }}>{s.level}</span>
                        </span>
                      ))}
                      {a.skills.length > 4 && (
                        <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>+{a.skills.length - 4}</span>
                      )}
                    </span>
                  ) : (
                    <span style={{ color: 'var(--text-faint)' }}>{t('agentsWs.noSkill', { defaultValue: 'no skill assigned' })}</span>
                  )}
                </div>
                <div className="row gap2" style={{ flexShrink: 0, alignItems: 'center' }}>
                  {a.linkedAsOwner && (
                    <span className="pill" style={{ fontSize: 10, padding: '1px 8px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-3)' }}>
                      {t('agentsWs.linkOwner', { defaultValue: 'Owner' })}
                    </span>
                  )}
                  {a.linkedTeams.map((tm) => (
                    <span
                      key={tm}
                      className="pill"
                      style={{ fontSize: 10, padding: '1px 8px', borderRadius: 999, background: 'var(--surface-2)', color: 'var(--text-3)' }}
                      title={t('agentsWs.linkTeam', { defaultValue: 'via team' })}
                    >
                      {tm}
                    </span>
                  ))}
                  <button
                    className="btn btn-line btn-sm"
                    style={{ whiteSpace: 'nowrap' }}
                    onClick={() => setOpenId(a.id)}
                  >
                    <Icon name="pencil" size={13} /> {t('agentsWs.edit', { defaultValue: 'Edit' })}
                  </button>
                </div>
              </div>
            ))}
        </div>

        {totalPages > 1 && (
          <div className="row gap2" style={{ justifyContent: 'center', marginTop: 12, alignItems: 'center' }}>
            <button className="btn btn-line btn-sm" disabled={page <= 1 || loading} onClick={() => void load(page - 1)}>
              {t('agentsWs.prev', { defaultValue: 'Previous' })}
            </button>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
              {t('agentsWs.pageOf', { defaultValue: 'Page {{page}} / {{total}}', page, total: totalPages })}
            </span>
            <button className="btn btn-line btn-sm" disabled={page >= totalPages || loading} onClick={() => void load(page + 1)}>
              {t('agentsWs.next', { defaultValue: 'Next' })}
            </button>
          </div>
        )}
      </div>

      {openId && (
        <AgentDetailModal
          agentId={openId}
          onClose={() => setOpenId(null)}
          onChanged={() => void load(page)}
        />
      )}
    </div>
  );
}

/* -------------------------- Detail / edit modal --------------------------- */

function AgentDetailModal({
  agentId,
  onClose,
  onChanged,
}: {
  agentId: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { t } = useTranslation('teams');
  const [d, setD] = useState<WorkspaceAgentDetailDto | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);

  useEscapeKey(onClose, !busy && !skillsOpen);

  const reload = useCallback(() => {
    api.getMyAgentDetail(agentId).then(setD, (e) => setErr((e as Error).message));
  }, [agentId]);

  useEffect(() => {
    reload();
  }, [reload]);

  const run = async (p: Promise<WorkspaceAgentDetailDto>) => {
    setBusy(true);
    setErr(null);
    try {
      setD(await p);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const changeModel = (model: string) => void run(api.updateMyAgentModel(agentId, model || null));

  const models = KNOWN_AGENT_MODELS.filter((m) => !d?.modelProvider || m.provider === d.modelProvider);

  return (
    <>
    <div className="md-overlay" onMouseDown={() => !busy && onClose()}>
      <div className="md-card" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true" style={{ width: 'min(680px, 100%)' }}>
        <div className="md-head">
          <div>
            <div className="md-eyebrow mono">{t('agentsWs.title', { defaultValue: 'AI Agent' })}</div>
            <div className="md-title truncate">{d?.name ?? '…'}</div>
            {d?.email && <div className="mono truncate" style={{ fontSize: 12, opacity: 0.6 }}>{d.email}</div>}
          </div>
          <button className="icon-btn" onClick={onClose} aria-label="close">
            <Icon name="x" size={18} />
          </button>
        </div>

        <div className="md-body" style={{ display: 'grid', gap: 16 }}>
          {err && <div className="md-warn"><Icon name="warn" size={13} /> {err}</div>}
          {!d && !err && <div className="set-desc">{t('agentsWs.loading', { defaultValue: 'Loading…' })}</div>}

          {d && (
            <>
              {/* Modèle */}
              <div className="md-field">
                <div className="md-label">{t('agentsWs.model', { defaultValue: 'Model' })}</div>
                <div className="md-hint" style={{ marginBottom: 6 }}>
                  {t('agentsWs.modelHint', { defaultValue: 'The provider is fixed; pick a model from the catalog.' })}
                </div>
                <div className="row gap2" style={{ alignItems: 'center' }}>
                  {d.modelProvider && (
                    <span className="pill mono" style={{ fontSize: 11, padding: '2px 8px', background: 'var(--surface-2)', color: 'var(--text-3)' }}>
                      {d.modelProvider}
                    </span>
                  )}
                  <select
                    className="atext"
                    value={d.model ?? ''}
                    disabled={busy}
                    onChange={(e) => changeModel(e.target.value)}
                    style={{ minWidth: 240 }}
                  >
                    <option value="">{t('agentsWs.noModelOption', { defaultValue: '— none —' })}</option>
                    {models.map((m) => (
                      <option key={m.provider + m.model} value={m.model}>
                        {m.label}
                      </option>
                    ))}
                    {d.model && !models.some((m) => m.model === d.model) && (
                      <option value={d.model}>{d.model}</option>
                    )}
                  </select>
                </div>
              </div>

              {/* Compétences (édition via le même dialogue que les users) */}
              <div className="md-field">
                <div className="md-label row" style={{ justifyContent: 'space-between', alignItems: 'center' }}>
                  <span>{t('agentsWs.skillsLabel', { defaultValue: 'Skills' })}</span>
                  <button className="btn btn-line btn-sm" onClick={() => setSkillsOpen(true)}>
                    <Icon name="pencil" size={13} /> {t('agentsWs.manageSkills', { defaultValue: 'Manage skills' })}
                  </button>
                </div>
                {d.skills.length === 0 ? (
                  <div className="set-desc">{t('agentsWs.noSkill', { defaultValue: 'no skill assigned' })}</div>
                ) : (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 6 }}>
                    {d.skills.map((s) => (
                      <span key={s.skillId} className="skl-chip" style={{ fontSize: 11.5 }}>
                        {s.name} <span className="mono" style={{ opacity: 0.7 }}>{s.level}</span>
                      </span>
                    ))}
                  </div>
                )}
              </div>

              {/* Usage */}
              <div className="md-field">
                <div className="md-label">{t('agentsWs.usage', { defaultValue: 'Usage & cost' })}</div>
                {d.usage ? (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: 10 }}>
                    {[
                      { l: t('agentsWs.usageMonth', { defaultValue: 'This month' }), v: `€${d.usage.monthlyCost.toFixed(2)}` },
                      { l: t('agentsWs.usageCost', { defaultValue: 'Total cost' }), v: `€${d.usage.totalCost.toFixed(2)}` },
                      { l: t('agentsWs.usageRuns', { defaultValue: 'Runs' }), v: String(d.usage.runCount) },
                      { l: t('agentsWs.usageAvg', { defaultValue: 'Avg / task' }), v: d.usage.avgCostPerTask != null ? `€${d.usage.avgCostPerTask.toFixed(2)}` : '—' },
                      { l: t(d.billingUnit === 'credits' ? 'agentsWs.usageCredits' : 'agentsWs.usageTokens', { defaultValue: d.billingUnit === 'credits' ? 'Credits' : 'Tokens' }), v: d.usage.totalTokens.toLocaleString() },
                    ].map((x) => (
                      <div key={x.l}>
                        <div style={{ fontSize: 11, color: 'var(--text-3)' }}>{x.l}</div>
                        <div style={{ fontWeight: 600, fontSize: 15 }}>{x.v}</div>
                      </div>
                    ))}
                  </div>
                ) : (
                  <div className="set-desc">{t('agentsWs.usageEmpty', { defaultValue: 'No run declared yet.' })}</div>
                )}
              </div>

              {/* Projets actifs (chips comme la fiche projet) */}
              <div className="md-field">
                <div className="md-label">
                  {t('agentsWs.projects', { defaultValue: 'Active projects' })}{' '}
                  <span className="md-count">{d.projects.length}</span>
                </div>
                {d.projects.length === 0 ? (
                  <div className="set-desc">{t('agentsWs.projectsEmpty', { defaultValue: 'Not assigned to any active project.' })}</div>
                ) : (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                    {d.projects.map((p) => (
                      <span key={p.id} className="skl-chip" title={p.name} style={{ maxWidth: 260 }}>
                        <span
                          className="mono"
                          style={{
                            fontSize: 10,
                            background: `oklch(0.55 0.15 ${hueFromId(p.key)})`,
                            color: 'white',
                            padding: '1px 5px',
                            borderRadius: 3,
                          }}
                        >
                          {p.key}
                        </span>
                        <span className="truncate">{p.name}</span>
                        {p.activeTasks > 0 && (
                          <span className="mono" style={{ color: 'var(--accent)', fontSize: 11 }}>{p.activeTasks}</span>
                        )}
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </>
          )}
        </div>

        <div className="md-foot">
          <div className="row gap2">
            <button className="btn btn-ghost" onClick={onClose}>{t('agentsWs.close', { defaultValue: 'Close' })}</button>
          </div>
        </div>
      </div>
    </div>

    {skillsOpen && d && (
      <UserSkillsDialog
        user={{ id: d.id, name: d.name, email: '' }}
        adminOrLeadEdit
        isSelf={false}
        onClose={() => {
          setSkillsOpen(false);
          reload();
          onChanged();
        }}
        flash={(m) => setErr(m)}
      />
    )}
    </>
  );
}
