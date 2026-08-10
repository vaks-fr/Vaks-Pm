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
import { ModelPricingPanel } from './AgentsSection';

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
/** Les 4 champs du brief agent, dans l'ordre de rendu du brief composé. */
const BRIEF_FIELDS = ['role', 'outputConventions', 'deliveryTarget', 'outOfScope'] as const;
type BriefField = (typeof BRIEF_FIELDS)[number];

const BRIEF_FIELD_LABEL: Record<BriefField, string> = {
  role: 'Role & mission',
  outputConventions: 'Output conventions',
  deliveryTarget: 'Where deliverables go',
  outOfScope: 'Out of scope',
};

/**
 * Exemples affichés en placeholder. Un champ de brief vide est la première cause
 * de livrable à côté de la plaque : sans modèle sous les yeux, on écrit « fais
 * de la doc » et l'agent invente le reste. Ces exemples montrent le **niveau de
 * précision attendu** — ils ne sont jamais enregistrés, seulement suggérés.
 */
const BRIEF_FIELD_PLACEHOLDER: Record<BriefField, string> = {
  role:
    'Ex. : tu rédiges la documentation technique interne. Tu pars de sources existantes ' +
    '(tickets, notes de réunion, code) et tu ne fais jamais de recherche externe.',
  outputConventions:
    'Ex. : français, markdown, titres en phrase (pas de majuscule à chaque mot). ' +
    'Cite systématiquement tes sources en fin de document. Pas de tableau de plus de 5 colonnes.',
  deliveryTarget:
    "Ex. : dépose le document dans le livrable de la tâche (champ « contenu »). " +
    "Ne crée pas de page SharePoint et n'envoie pas d'e-mail.",
  outOfScope:
    "Ex. : ne touche à aucune configuration de production. N'invente pas de chiffre : " +
    "si une donnée manque, pose la question en commentaire et attends la réponse.",
};

export default function AgentPoliciesSection({ flash }: { flash: Flash }) {
  const { t } = useTranslation('admin');
  const [rules, setRules] = useState<AgentPolicyRule[]>([]);
  const [backpressure, setBackpressure] = useState(5);
  const [requireRun, setRequireRun] = useState(false);
  const [preauthorize, setPreauthorize] = useState(false);
  const [leaseMinutes, setLeaseMinutes] = useState(30);
  const [budgetBreaker, setBudgetBreaker] = useState(false);
  // Mesure du coût : secret partagé passerelle (existence seule côté serveur) +
  // nouvelle valeur à écrire (vide = conserver).
  const [gatewaySecretSet, setGatewaySecretSet] = useState(false);
  const [gatewaySecretInput, setGatewaySecretInput] = useState('');
  // Estimation coût Copilot (agents crédits non mesurables).
  const [copilotEnabled, setCopilotEnabled] = useState(false);
  const [copilotBaseline, setCopilotBaseline] = useState(7);
  const [copilotCreditPrice, setCopilotCreditPrice] = useState(0);
  /**
   * Brief agent par défaut de l'organisation. Hérité CHAMP PAR CHAMP par les
   * projets : les conventions maison (langue, format des livrables) se règlent
   * une fois ici au lieu d'être retapées dans chaque projet.
   */
  const [briefDefault, setBriefDefault] = useState<Record<BriefField, string>>({
    role: '',
    outputConventions: '',
    deliveryTarget: '',
    outOfScope: '',
  });
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
        setPreauthorize(s['agents.preauthorizeBudget'] === true);
        // Clé jamais posée = filet armé au défaut serveur (30 min), pas 0.
        const lease = Number(s['agents.executionLeaseMinutes']);
        setLeaseMinutes(Number.isInteger(lease) && lease >= 0 ? lease : 30);
        setBudgetBreaker(s['agents.budgetBreaker'] === true);
        setGatewaySecretSet(s['agents.gateway.secretSet'] === true);
        setCopilotEnabled(s['agents.copilotEstimate.enabled'] === true);
        const cb = Number(s['agents.copilotEstimate.baselineCreditsPerTask']);
        setCopilotBaseline(Number.isFinite(cb) && cb >= 0 ? cb : 7);
        const cp = Number(s['agents.copilotEstimate.creditPriceEur']);
        setCopilotCreditPrice(Number.isFinite(cp) && cp >= 0 ? cp : 0);
        const bd = (s['agents.briefDefault'] ?? null) as Record<string, unknown> | null;
        setBriefDefault({
          role: typeof bd?.role === 'string' ? bd.role : '',
          outputConventions: typeof bd?.outputConventions === 'string' ? bd.outputConventions : '',
          deliveryTarget: typeof bd?.deliveryTarget === 'string' ? bd.deliveryTarget : '',
          outOfScope: typeof bd?.outOfScope === 'string' ? bd.outOfScope : '',
        });
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
        'agents.preauthorizeBudget': preauthorize,
        'agents.executionLeaseMinutes': leaseMinutes,
        'agents.budgetBreaker': budgetBreaker,
        'agents.copilotEstimate.enabled': copilotEnabled,
        'agents.copilotEstimate.baselineCreditsPerTask': copilotBaseline,
        'agents.copilotEstimate.creditPriceEur': copilotCreditPrice,
        // Secret partagé passerelle : écrit seulement si une nouvelle valeur est
        // saisie (vide = conserver l'existant, jamais réexposé en lecture).
        ...(gatewaySecretInput.trim() ? { 'agents.gateway.sharedSecret': gatewaySecretInput.trim() } : {}),
        // Tout-vide → `null` : pas de défaut org plutôt qu'un objet creux.
        'agents.briefDefault': BRIEF_FIELDS.some((f) => briefDefault[f].trim())
          ? Object.fromEntries(BRIEF_FIELDS.map((f) => [f, briefDefault[f].trim() || null]))
          : null,
      } as Record<string, unknown>));
      const raw = s['agents.policies'];
      setRules(Array.isArray(raw) ? (raw as AgentPolicyRule[]) : []);
      if (gatewaySecretInput.trim()) {
        setGatewaySecretSet(true);
        setGatewaySecretInput('');
      }
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
      {/* Prix catalogue des modèles (AGENT_COST_UNITS) — rangé ici (gouvernance)
          plutôt que dans la liste des agents. */}
      <ModelPricingPanel flash={flash} />

      {/* Mesure du coût — secret partagé passerelle + rappel du contrat */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {t('agentCost.measureTitle', { defaultValue: 'Cost measurement' })}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5, maxWidth: 640 }}>
          {t('agentCost.measureDesc', {
            defaultValue:
              'The exact token usage of an agent can be measured by a producer that reports to POST /api/v1/agent-runs: the Vaks LLM gateway, your own external gateway (e.g. LiteLLM), or the runtime usage-log collector (Claude Code / Agent SDK). The shared secret below proves a report is measured (source=gateway / runtime_log) and exempts it from declaration anomalies.',
          })}
        </div>
        <div style={{ marginTop: 12, maxWidth: 420 }}>
          <label style={labelStyle}>
            {t('agentCost.sharedSecret', { defaultValue: 'Gateway shared secret' })}
            <input
              type="password"
              value={gatewaySecretInput}
              placeholder={
                gatewaySecretSet
                  ? t('agentCost.secretSetPlaceholder', { defaultValue: '•••••••• (set — leave blank to keep)' })
                  : t('agentCost.secretUnsetPlaceholder', { defaultValue: 'Not set — paste a strong secret' })
              }
              onChange={(e) => {
                setGatewaySecretInput(e.target.value);
                setDirty(true);
              }}
              autoComplete="new-password"
              style={inputStyle}
            />
          </label>
          <div style={{ fontSize: 12, color: 'var(--text-faint)', marginTop: 6, lineHeight: 1.5 }}>
            {t('agentCost.secretHint', {
              defaultValue:
                'Set this value as VAKS_GATEWAY_SECRET on the gateway/collector, or X-Vaks-Gateway-Secret in your external adapter. Reporting without it still works but stays source=self (declared).',
            })}
          </div>
        </div>
      </div>

      {/* Estimation coût Copilot (agents crédits non mesurables) */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {t('agentCost.copilotTitle', { defaultValue: 'Copilot cost estimation' })}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5, maxWidth: 640 }}>
          {t('agentCost.copilotDesc', {
            defaultValue:
              'Copilot-style agents run their model inside Microsoft and can never be measured by the gateway. When enabled, completing a task with a credit-billed agent creates an ESTIMATED run from the public Copilot Studio credit rate card × the activity Vaks observed, plus a baseline for the generative part it cannot see. Always shown as “estimated”, never “measured”; skipped if a real (declared/measured) run already exists for the task.',
          })}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={copilotEnabled}
            onChange={(e) => {
              setCopilotEnabled(e.target.checked);
              setDirty(true);
            }}
          />
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
            {t('agentCost.copilotToggle', { defaultValue: 'Estimate credit-agent cost on task completion' })}
          </span>
        </label>
        {copilotEnabled && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 18, marginTop: 14 }}>
            <label style={labelStyle}>
              {t('agentCost.copilotBaseline', { defaultValue: 'Baseline credits per task' })}
              <input
                type="number"
                min={0}
                max={100000}
                value={copilotBaseline}
                onChange={(e) => {
                  setCopilotBaseline(Math.max(0, Math.min(100000, Number(e.target.value) || 0)));
                  setDirty(true);
                }}
                style={{ ...inputStyle, width: 140 }}
              />
            </label>
            <label style={labelStyle}>
              {t('agentCost.copilotCreditPrice', { defaultValue: 'Credit price (€ / 1000 credits)' })}
              <input
                type="number"
                min={0}
                step="0.01"
                value={copilotCreditPrice}
                onChange={(e) => {
                  setCopilotCreditPrice(Math.max(0, Number(e.target.value) || 0));
                  setDirty(true);
                }}
                style={{ ...inputStyle, width: 180 }}
              />
            </label>
          </div>
        )}
      </div>

      {/* Brief agent par défaut de l'organisation */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {t('agentPolicies.briefDefaultTitle', { defaultValue: 'Default agent brief' })}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5, maxWidth: 620 }}>
          {t('agentPolicies.briefDefaultDesc', {
            defaultValue:
              'House conventions inherited by every agent-enabled project, field by field: a project that fills a field wins, the others fall back here. Set your output language and format once instead of retyping them in each project.',
          })}
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 12 }}>
          {BRIEF_FIELDS.map((field) => (
            <div key={field}>
              <div style={{ fontSize: 12.5, fontWeight: 600, marginBottom: 4 }}>
                {t(`agentPolicies.briefDefault.${field}`, {
                  defaultValue: BRIEF_FIELD_LABEL[field],
                })}
              </div>
              <textarea
                value={briefDefault[field]}
                placeholder={t(`agentPolicies.briefPlaceholder.${field}`, {
                  defaultValue: BRIEF_FIELD_PLACEHOLDER[field],
                })}
                onChange={(e) => {
                  setBriefDefault((prev) => ({ ...prev, [field]: e.target.value }));
                  setDirty(true);
                }}
                rows={2}
                style={{ ...inputStyle, marginTop: 0, width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
              />
            </div>
          ))}
        </div>
      </div>

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

      {/* Budget pré-autorisé au claim */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {t('agentPolicies.preauthTitle', { defaultValue: 'Pre-authorize cost at claim' })}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5, maxWidth: 620 }}>
          {t('agentPolicies.preauthDesc', {
            defaultValue:
              "When enabled, an agent is refused a task at claim time if the task's estimated cost (its own historical average cost per task) would push spend over a budget envelope — instead of only blocking after the budget is already exceeded. Fails open until the agent has history (first tasks are never blocked). Only affects agents.",
          })}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={preauthorize}
            onChange={(e) => {
              setPreauthorize(e.target.checked);
              setDirty(true);
            }}
          />
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
            {t('agentPolicies.preauthToggle', {
              defaultValue: 'Refuse claim when the estimated task cost would exceed the remaining budget',
            })}
          </span>
        </label>
      </div>

      {/* Bail d'exécution (lot A) */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {t('agentPolicies.leaseTitle', { defaultValue: 'Execution lease' })}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5, maxWidth: 620 }}>
          {t('agentPolicies.leaseDesc', {
            defaultValue:
              'An agent that claims a task holds it only for this long, and extends the lease with a heartbeat while it works. If it dies (crash, lost connectivity) the lease lapses and the task is returned to the pool (back to TODO, retry count incremented) instead of staying blocked. Humans are never affected. 0 disables the mechanism.',
          })}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12 }}>
          <input
            type="number"
            min={0}
            max={1440}
            step={5}
            value={leaseMinutes}
            onChange={(e) => {
              const n = Math.max(0, Math.min(1440, Math.floor(Number(e.target.value) || 0)));
              // Le serveur refuse 1–4 : on n'offre pas une valeur qui sera rejetée.
              setLeaseMinutes(n > 0 && n < 5 ? 5 : n);
              setDirty(true);
            }}
            style={{ ...inputStyle, width: 100, marginTop: 0 }}
          />
          <span style={{ fontSize: 12.5, color: 'var(--text-3)' }}>
            {t('agentPolicies.leaseUnit', { defaultValue: 'minutes (0 = disabled, otherwise 5–1440)' })}
          </span>
        </div>
      </div>

      {/* Coupe-circuit budgétaire (lot A) */}
      <div style={cardStyle}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>
          {t('agentPolicies.breakerTitle', { defaultValue: 'Budget circuit breaker' })}
        </div>
        <div style={{ fontSize: 13, color: 'var(--text-3)', marginTop: 3, lineHeight: 1.5, maxWidth: 620 }}>
          {t('agentPolicies.breakerDesc', {
            defaultValue:
              'Budget envelopes are checked at claim time, but a runaway agent burns them mid-task. Whenever an agent declares a run that consumes an envelope, its owner is alerted and the agent is told to stop. Enable this to also take the task away from it right there (claim and assignment removed, task waits for a human) — the work already produced stays attached to the task.',
          })}
        </div>
        <label style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, cursor: 'pointer' }}>
          <input
            type="checkbox"
            checked={budgetBreaker}
            onChange={(e) => {
              setBudgetBreaker(e.target.checked);
              setDirty(true);
            }}
          />
          <span style={{ fontSize: 13, color: 'var(--text-2)' }}>
            {t('agentPolicies.breakerToggle', {
              defaultValue: 'Take the task away from the agent when an envelope is exhausted',
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
