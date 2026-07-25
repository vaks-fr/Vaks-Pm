import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type {
  ActorKind,
  AgentPolicyAction,
  AgentPolicyRule,
  AgentTaskStakes,
  AgentTrustLevel,
} from '@vaks-pm/shared';
import { AGENT_POLICY_ACTIONS, AGENT_TASK_STAKES, AGENT_TRUST_LEVELS } from '@vaks-pm/shared';
import { api } from '../api/client';
import { Icon } from './primitives';

type Flash = (msg: string) => void;

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 12,
  padding: 20,
  background: 'var(--surface)',
  color: 'var(--text)',
};

const inputStyle: React.CSSProperties = {
  display: 'block',
  width: '100%',
  marginTop: 4,
  padding: '7px 10px',
  borderRadius: 8,
  border: '1px solid var(--border)',
  background: 'var(--surface-2)',
  color: 'var(--text)',
  fontSize: 13,
};

const labelStyle: React.CSSProperties = { fontSize: 12, color: 'var(--text-3)', display: 'block' };

/** Transitions connues proposées dans le sélecteur (la matrice serveur reste
 *  seule juge — c'est juste une aide de saisie). */
const TRANSITIONS = [
  'TODO->CLAIMED',
  'CLAIMED->IN_PROGRESS',
  'IN_PROGRESS->IN_REVIEW',
  'IN_REVIEW->APPROVED',
  'IN_REVIEW->CHANGES_REQUESTED',
  'CHANGES_REQUESTED->IN_PROGRESS',
  'APPROVED->DONE',
];

const ACTION_COLORS: Record<AgentPolicyAction, string> = {
  deny: 'var(--c-over, #e5484d)',
  require_review: 'var(--accent)',
  notify: 'oklch(0.62 0.15 150)',
};

/**
 * Admin → Users & Identity → Agent policies (chantier 3.1b).
 *
 * Éditeur **structuré** des règles de gouvernance des agents (jamais de JSON
 * libre). Chaque règle = une condition (labels, type d'acteur, niveau de
 * confiance, enjeu, estimation, transition) → une action (exiger une revue,
 * refuser, notifier) dans un mode (bloquant / observation). Réglage de la
 * backpressure (plafond de la file de revue). Persisté dans
 * `OrgSetting agents.policies` / `agents.backpressure.maxPendingReviews`.
 */
export default function AgentPoliciesSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('admin');
  const [rules, setRules] = useState<AgentPolicyRule[]>([]);
  const [backpressure, setBackpressure] = useState(5);
  const [requireRun, setRequireRun] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const s = (await api.getAgentPolicies()) as Record<string, unknown>;
        const raw = s['agents.policies'];
        setRules(Array.isArray(raw) ? (raw as AgentPolicyRule[]) : []);
        const bp = Number(s['agents.backpressure.maxPendingReviews']);
        setBackpressure(Number.isInteger(bp) && bp >= 0 ? bp : 5);
        setRequireRun(s['agents.requireRunDeclaration'] === true);
      } catch (e) {
        flash(t('agentPolicies.loadError', { defaultValue: 'Unable to load policies: {{message}}', message: (e as Error).message }));
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const mutate = (fn: (r: AgentPolicyRule[]) => AgentPolicyRule[]) => {
    setRules((prev) => fn(prev));
    setDirty(true);
  };
  const patchRule = (i: number, patch: Partial<AgentPolicyRule>) =>
    mutate((r) => r.map((rule, idx) => (idx === i ? { ...rule, ...patch } : rule)));
  const patchCond = (i: number, patch: Partial<AgentPolicyRule['if']>) =>
    mutate((r) => r.map((rule, idx) => (idx === i ? { ...rule, if: { ...rule.if, ...patch } } : rule)));

  const addRule = () =>
    mutate((r) => [
      ...r,
      { if: { actorKind: 'AGENT' as ActorKind }, then: 'require_review' as AgentPolicyAction, mode: 'enforce' },
    ]);
  const removeRule = (i: number) => mutate((r) => r.filter((_, idx) => idx !== i));

  const save = async () => {
    setSaving(true);
    try {
      // Nettoie les conditions vides (une règle doit garder ≥1 prédicat — la
      // validation serveur rejetterait sinon). On envoie tel quel ; le backend
      // normalise et renvoie la version canonique.
      const s = (await api.putAgentPolicies({
        'agents.policies': rules,
        'agents.backpressure.maxPendingReviews': backpressure,
        'agents.requireRunDeclaration': requireRun,
      } as Record<string, unknown>));
      const raw = s['agents.policies'];
      setRules(Array.isArray(raw) ? (raw as AgentPolicyRule[]) : []);
      setDirty(false);
      flash(t('agentPolicies.saved', { defaultValue: 'Policies saved.' }));
    } catch (e) {
      flash(t('agentPolicies.saveError', { defaultValue: 'Save failed: {{message}}', message: (e as Error).message }));
    } finally {
      setSaving(false);
    }
  };

  const actionLabel = (a: AgentPolicyAction) =>
    ({
      deny: t('agentPolicies.actionDeny', { defaultValue: 'Deny' }),
      require_review: t('agentPolicies.actionReview', { defaultValue: 'Require review' }),
      notify: t('agentPolicies.actionNotify', { defaultValue: 'Notify' }),
    })[a];

  if (loading) return <div style={{ color: 'var(--text-3)', padding: 12 }}>{t('agentPolicies.loading', { defaultValue: 'Loading…' })}</div>;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
      {/* Backpressure */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>{t('agentPolicies.backpressureTitle', { defaultValue: 'Review backpressure' })}</div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5, maxWidth: 620 }}>
          {t('agentPolicies.backpressureDesc', {
            defaultValue:
              'Agents are throttled by the human review throughput. When a project already has this many tasks waiting in review, an agent is refused from pushing more into the queue and retries later. 0 = unlimited.',
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <input
            type="number"
            min={0}
            max={1000}
            value={backpressure}
            onChange={(e) => {
              setBackpressure(Math.max(0, Math.min(1000, Math.floor(Number(e.target.value) || 0))));
              setDirty(true);
            }}
            style={{ ...inputStyle, width: 100, marginTop: 0 }}
          />
          <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
            {t('agentPolicies.backpressureUnit', { defaultValue: 'tasks in review per project' })}
          </span>
        </div>
      </div>

      {/* Déclaration de consommation obligatoire */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {t('agentPolicies.requireRunTitle', { defaultValue: 'Require cost declaration' })}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5, maxWidth: 620 }}>
          {t('agentPolicies.requireRunDesc', {
            defaultValue:
              'When enabled, an agent must declare its consumption (tokens / cost via report_run) on a task before it can submit it for review. Guarantees the budget spent per task is always tracked. Only affects agents.',
          })}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={requireRun}
            onChange={(e) => {
              setRequireRun(e.target.checked);
              setDirty(true);
            }}
          />
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
            {t('agentPolicies.requireRunToggle', {
              defaultValue: 'Block review submission until a run is declared',
            })}
          </span>
        </label>
      </div>

      {/* Règles */}
      <div style={cardStyle}>
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 10 }}>
          <div>
            <div style={{ fontWeight: 600, fontSize: 14 }}>{t('agentPolicies.rulesTitle', { defaultValue: 'Governance rules' })}</div>
            <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5, maxWidth: 640 }}>
              {t('agentPolicies.rulesDesc', {
                defaultValue:
                  'Each rule matches a task context and applies an action. All predicates set must match (AND); an empty predicate is ignored. Evaluated at claim time and at auto-close. In observe mode a match is only logged.',
              })}
            </div>
          </div>
        </div>

        {rules.length === 0 && (
          <div style={{ fontSize: 13, color: 'var(--text-faint)', marginTop: 14, padding: '14px 0' }}>
            {t('agentPolicies.empty', { defaultValue: 'No rules — agents follow the default governance only. Add a rule to constrain them.' })}
          </div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14, marginTop: 14 }}>
          {rules.map((rule, i) => (
            <RuleEditor
              key={i}
              rule={rule}
              onPatch={(p) => patchRule(i, p)}
              onPatchCond={(p) => patchCond(i, p)}
              onRemove={() => removeRule(i)}
              actionLabel={actionLabel}
              t={t}
            />
          ))}
        </div>

        <div style={{ display: 'flex', gap: 10, marginTop: 16, alignItems: 'center' }}>
          <button type="button" className="btn btn-ghost" style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }} onClick={addRule}>
            <Icon name="plus" size={14} />
            {t('agentPolicies.addRule', { defaultValue: 'Add rule' })}
          </button>
          <div style={{ flex: 1 }} />
          {dirty && <span style={{ fontSize: 12, color: 'var(--c-warn, #d9822b)' }}>{t('agentPolicies.unsaved', { defaultValue: 'Unsaved changes' })}</span>}
          <button type="button" className="btn btn-accent" style={{ padding: '8px 16px' }} disabled={saving || !dirty} onClick={() => void save()}>
            {saving ? t('common:saving', { defaultValue: 'Saving…' }) : t('agentPolicies.save', { defaultValue: 'Save policies' })}
          </button>
        </div>
      </div>
    </div>
  );
}

function RuleEditor({
  rule,
  onPatch,
  onPatchCond,
  onRemove,
  actionLabel,
  t,
}: {
  rule: AgentPolicyRule;
  onPatch: (p: Partial<AgentPolicyRule>) => void;
  onPatchCond: (p: Partial<AgentPolicyRule['if']>) => void;
  onRemove: () => void;
  actionLabel: (a: AgentPolicyAction) => string;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const cond = rule.if ?? {};
  const labelsText = useMemo(() => (cond.labelIn ?? []).join(', '), [cond.labelIn]);
  const toggleIn = <T,>(arr: T[] | undefined, val: T): T[] => {
    const set = new Set(arr ?? []);
    if (set.has(val)) set.delete(val);
    else set.add(val);
    return [...set];
  };

  return (
    <div
      style={{
        border: '1px solid var(--border)',
        borderLeft: `3px solid ${ACTION_COLORS[rule.then]}`,
        borderRadius: 10,
        padding: 14,
        background: 'var(--surface-2)',
      }}
    >
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
        <input
          value={rule.description ?? ''}
          onChange={(e) => onPatch({ description: e.target.value })}
          placeholder={t('agentPolicies.descPlaceholder', { defaultValue: 'What this rule enforces' })}
          style={{ ...inputStyle, marginTop: 0, fontWeight: 600 }}
        />
        <button
          type="button"
          className="btn btn-ghost"
          style={{ flexShrink: 0, padding: '6px 8px', color: 'var(--c-over, #e5484d)' }}
          title={t('agentPolicies.removeRule', { defaultValue: 'Remove rule' })}
          onClick={onRemove}
        >
          <Icon name="x" size={14} />
        </button>
      </div>

      {/* Conditions */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
          gap: 12,
          marginTop: 12,
        }}
      >
        {/* Actor kind */}
        <label style={labelStyle}>
          {t('agentPolicies.condActor', { defaultValue: 'Actor' })}
          <select
            value={cond.actorKind ?? ''}
            onChange={(e) => onPatchCond({ actorKind: (e.target.value || undefined) as ActorKind | undefined })}
            style={inputStyle}
          >
            <option value="">{t('agentPolicies.any', { defaultValue: 'Any' })}</option>
            <option value="AGENT">{t('agentPolicies.agents', { defaultValue: 'Agents' })}</option>
            <option value="HUMAN">{t('agentPolicies.humans', { defaultValue: 'Humans' })}</option>
          </select>
        </label>

        {/* Labels */}
        <label style={labelStyle}>
          {t('agentPolicies.condLabels', { defaultValue: 'Labels (comma-sep)' })}
          <input
            defaultValue={labelsText}
            key={labelsText}
            placeholder="production, client"
            onBlur={(e) => {
              const arr = e.target.value.split(',').map((s) => s.trim()).filter(Boolean);
              onPatchCond({ labelIn: arr.length ? arr : undefined });
            }}
            style={inputStyle}
          />
        </label>

        {/* Estimate > */}
        <label style={labelStyle}>
          {t('agentPolicies.condEstimate', { defaultValue: 'Estimate > (hours)' })}
          <input
            type="number"
            min={0}
            value={cond.estimateHoursGt ?? ''}
            onChange={(e) => {
              const v = e.target.value === '' ? undefined : Math.max(0, Number(e.target.value));
              onPatchCond({ estimateHoursGt: v });
            }}
            placeholder="—"
            style={inputStyle}
          />
        </label>

        {/* Transition */}
        <label style={labelStyle}>
          {t('agentPolicies.condTransition', { defaultValue: 'Transition' })}
          <select
            value={cond.transition ?? ''}
            onChange={(e) => onPatchCond({ transition: e.target.value || undefined })}
            style={inputStyle}
          >
            <option value="">{t('agentPolicies.any', { defaultValue: 'Any' })}</option>
            {TRANSITIONS.map((tr) => (
              <option key={tr} value={tr}>
                {tr}
              </option>
            ))}
          </select>
        </label>
      </div>

      {/* Trust levels + stakes */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, marginTop: 12 }}>
        <div>
          <div style={{ ...labelStyle, marginBottom: 4 }}>{t('agentPolicies.condTrust', { defaultValue: 'Trust level (agents)' })}</div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {AGENT_TRUST_LEVELS.map((tl) => (
              <Chip
                key={tl}
                active={(cond.trustLevelIn ?? []).includes(tl)}
                onClick={() => {
                  const next = toggleIn(cond.trustLevelIn as AgentTrustLevel[] | undefined, tl);
                  onPatchCond({ trustLevelIn: next.length ? next : undefined });
                }}
              >
                {tl}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <div style={{ ...labelStyle, marginBottom: 4 }}>
            {t('agentPolicies.condStakes', { defaultValue: 'Stakes' })}
            <span style={{ color: 'var(--text-faint)', fontStyle: 'italic', marginLeft: 6 }}>
              {t('agentPolicies.stakesHint', { defaultValue: '(inert until verification phase B)' })}
            </span>
          </div>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {AGENT_TASK_STAKES.map((sk) => (
              <Chip
                key={sk}
                active={(cond.scopeIn ?? []).includes(sk)}
                onClick={() => {
                  const next = toggleIn(cond.scopeIn as AgentTaskStakes[] | undefined, sk);
                  onPatchCond({ scopeIn: next.length ? next : undefined });
                }}
              >
                {sk}
              </Chip>
            ))}
          </div>
        </div>
      </div>

      {/* Action + mode */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 20, marginTop: 14, alignItems: 'flex-end' }}>
        <div>
          <div style={{ ...labelStyle, marginBottom: 4 }}>{t('agentPolicies.thenLabel', { defaultValue: 'Then' })}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            {AGENT_POLICY_ACTIONS.map((a) => (
              <Chip key={a} active={rule.then === a} onClick={() => onPatch({ then: a })} color={ACTION_COLORS[a]}>
                {actionLabel(a)}
              </Chip>
            ))}
          </div>
        </div>
        <div>
          <div style={{ ...labelStyle, marginBottom: 4 }}>{t('agentPolicies.modeLabel', { defaultValue: 'Mode' })}</div>
          <div style={{ display: 'flex', gap: 6 }}>
            <Chip active={(rule.mode ?? 'enforce') === 'enforce'} onClick={() => onPatch({ mode: 'enforce' })}>
              {t('agentPolicies.modeEnforce', { defaultValue: 'Enforce' })}
            </Chip>
            <Chip active={rule.mode === 'report_only'} onClick={() => onPatch({ mode: 'report_only' })}>
              {t('agentPolicies.modeReport', { defaultValue: 'Observe' })}
            </Chip>
          </div>
        </div>
      </div>
    </div>
  );
}

function Chip({
  active,
  onClick,
  children,
  color,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  color?: string;
}) {
  const c = color ?? 'var(--accent)';
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontSize: 12,
        padding: '5px 11px',
        borderRadius: 999,
        cursor: 'pointer',
        border: `1px solid ${active ? c : 'var(--border)'}`,
        background: active ? `color-mix(in oklch, ${c} 16%, var(--surface))` : 'var(--surface)',
        color: active ? c : 'var(--text-2)',
        fontWeight: active ? 600 : 400,
        transition: 'all 100ms',
      }}
    >
      {children}
    </button>
  );
}
