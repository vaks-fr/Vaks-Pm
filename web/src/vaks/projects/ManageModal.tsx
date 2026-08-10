/* ============================================================
   Vaks — Projects panel : modal "Manage this project" (onglets)
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Icon, Avatar } from '../primitives';
import { api } from '../../api/client';
import {
  AGENT_VERIFICATION_CAPABILITY_METHODS,
  ProjectStatus,
  type AgentBriefDto,
  type AgentContextPreviewDto,
  type ProjectDto,
  type SkillDto,
  type UpdateProjectDto,
} from '@vaks-pm/shared';
import { refreshProjectAssignees, apiGetProjectCustomFields } from '../api';
import SkillPicker from '../SkillPicker';
import WebhooksSection from '../WebhooksSection';
import { CollabProvisionTiles } from './CollabProvisionTiles';
import { CollabSpacesList } from './CollabSpacesList';
import { useAuth } from '../../auth/AuthContext';
import {
  ALL_STATUSES,
  ConfirmDialog,
  DAY_MS,
  avatarUser,
  colorFromKey,
  daysLeft,
  shortDate,
  statusLabel,
  useEscapeKey,
} from './shared';
import { CharterEditor } from './CharterEditor';
import { OfferSection } from './OfferSection';
import { ProjectBudgetField } from './ProjectBudgetField';
import { CustomFieldValuesSection } from '../CustomFieldValuesSection';

/* ============================ Member row ============================ */

interface MemberRowProps {
  member: {
    userId: string;
    user: { id: string; name: string; email: string };
    role: { key: string; name: string };
    isSponsor?: boolean;
  };
  options: { key: string; name: string }[];
  onRoleChange: (roleKey: string) => void;
  onRemove: () => void;
  onToggleSponsor?: () => void;
}

function MemberRow({ member, options, onRoleChange, onRemove, onToggleSponsor }: MemberRowProps) {
  const { t } = useTranslation('projects');
  return (
    <div className="md-member">
      <Avatar user={avatarUser(member.user)} size={32} title={false} />
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="md-member-name truncate">{member.user.name}</div>
        <div className="md-member-role truncate">{member.user.email}</div>
      </div>
      {onToggleSponsor && (
        <button
          onClick={onToggleSponsor}
          title={member.isSponsor ? t('manage.sponsor.badgeTitleOn') : t('manage.sponsor.badgeTitleOff')}
          style={{
            fontFamily: 'inherit',
            fontSize: 11,
            fontWeight: 700,
            padding: '3px 8px',
            borderRadius: 999,
            cursor: 'pointer',
            border: '1px solid',
            borderColor: member.isSponsor ? 'var(--accent)' : 'var(--border)',
            background: member.isSponsor
              ? 'color-mix(in oklch, var(--accent) 16%, var(--surface))'
              : 'transparent',
            color: member.isSponsor ? 'var(--accent)' : 'var(--text-3)',
            flexShrink: 0,
          }}
        >
          {t('manage.sponsor.badge')}
        </button>
      )}
      <select
        value={member.role.key}
        onChange={(e) => onRoleChange(e.target.value)}
        style={{
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text)',
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-sm)',
          padding: '4px 8px',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.name}
          </option>
        ))}
      </select>
      <button className="md-remove" onClick={onRemove} aria-label={t('manage.removeMember', { name: member.user.name })}>
        <Icon name="x" size={15} />
      </button>
    </div>
  );
}

/* ========================= Team access row ========================= */

interface TeamAccessRowProps {
  pt: {
    teamId: string;
    role: { key: string } | null;
    team: { id: string; name: string; color: string | null; members: Array<{ userId: string }> };
  };
  options: { key: string; name: string }[];
  onRoleChange: (roleKey: string) => void;
  onRemove: () => void;
}

/**
 * Une ligne « accès d'équipe » dans la section People : montre l'équipe (et son
 * effectif) avec UN sélecteur de niveau d'accès appliqué à tous ses membres —
 * sans dérouler chaque personne. `role: null` = lien legacy (visibilité seule).
 */
function TeamAccessRow({ pt, options, onRoleChange, onRemove }: TeamAccessRowProps) {
  const { t } = useTranslation('projects');
  const count = pt.team.members.length;
  return (
    <div className="md-member">
      <span
        aria-hidden
        style={{
          width: 32,
          height: 32,
          borderRadius: 8,
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          background: pt.team.color ?? `oklch(0.6 0.15 ${colorFromKey(pt.teamId)})`,
          color: '#fff',
        }}
      >
        <Icon name="users" size={16} />
      </span>
      <div className="grow" style={{ minWidth: 0 }}>
        <div className="md-member-name truncate">{pt.team.name}</div>
        <div className="md-member-role truncate">{t('manage.teamMembersTitle', { count })}</div>
      </div>
      <select
        value={pt.role?.key ?? ''}
        onChange={(e) => onRoleChange(e.target.value)}
        style={{
          fontFamily: 'inherit',
          fontSize: 12,
          fontWeight: 600,
          color: 'var(--text)',
          background: 'var(--surface-2)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-sm)',
          padding: '4px 8px',
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        {pt.role === null && (
          <option value="" disabled>
            {t('manage.teamRoleVisibilityOnly')}
          </option>
        )}
        {options.map((o) => (
          <option key={o.key} value={o.key}>
            {o.name}
          </option>
        ))}
      </select>
      <button className="md-remove" onClick={onRemove} aria-label={t('manage.unassignTeam')}>
        <Icon name="x" size={15} />
      </button>
    </div>
  );
}

/* ============================ Manage modal ============================ */

interface ManageDraft {
  status: ProjectStatus;
  /** Santé projet (RAG) pour le point de statut client. '' = non renseignée. */
  statusHealth: '' | 'ON_TRACK' | 'AT_RISK' | 'OFF_TRACK';
  statusSummary: string;
  startDate: string;
  dueDate: string;
  name: string;
  description: string;
  clientId: string | null;
  agentsEnabled: boolean;
  spContextEnabled: boolean;
  agentContext: string;
  /** Brief structuré — 4 champs courts qui remplacent le pavé libre. */
  agentBrief: { role: string; outputConventions: string; deliveryTarget: string; outOfScope: string };
  agentGuardrails: string;
  agentCostBudget: string;
  verificationCapabilities: string[];
  stakes: string;
  verificationMode: string;
  /** Dépôt(s) CI autorisé(s), un par ligne (édition) — sérialisé en tableau au save. */
  ciReposText: string;
  sponsorNotify: { milestoneReached: boolean; projectStatus: boolean; milestoneAtRisk: boolean; budgetThresholds: boolean };
}

/** Les 4 champs du brief structuré, dans l'ordre de saisie ET de rendu. */
const BRIEF_FIELDS = ['role', 'outputConventions', 'deliveryTarget', 'outOfScope'] as const;

/** Libellés de repli (anglais), si la clé i18n n'est pas encore traduite. */
const BRIEF_FIELD_FALLBACK: Record<
  (typeof BRIEF_FIELDS)[number],
  { label: string; placeholder: string }
> = {
  // Les placeholders sont des EXEMPLES, pas des définitions : un champ vide est
  // la première cause de livrable à côté de la plaque, et « qui est l'agent sur
  // ce projet » ne dit pas quel niveau de précision on attend. On montre.
  role: {
    label: 'Role & mission',
    placeholder:
      'e.g. you write the SCCM to Intune migration sheets from tickets and workshop notes, one sheet per application batch.',
  },
  outputConventions: {
    label: 'Output conventions',
    placeholder:
      'e.g. markdown, English, 2 pages max per sheet, a before/after table and a risks section. Always cite your sources.',
  },
  deliveryTarget: {
    label: 'Where deliverables go',
    placeholder:
      'e.g. put the document in the task deliverable (content field). Do not create a SharePoint page, do not send email.',
  },
  outOfScope: {
    label: 'Out of scope',
    placeholder:
      'e.g. do not change any SCCM collection, do not contact end users, never invent a figure — ask in a comment instead.',
  },
};
type BriefField = (typeof BRIEF_FIELDS)[number];
type BriefDraft = Record<BriefField, string>;

/** Colonne `agentBrief` (Json) → brouillon éditable (chaînes, jamais null). */
function readBriefDraft(raw: AgentBriefDto | null | undefined): BriefDraft {
  return {
    role: raw?.role ?? '',
    outputConventions: raw?.outputConventions ?? '',
    deliveryTarget: raw?.deliveryTarget ?? '',
    outOfScope: raw?.outOfScope ?? '',
  };
}

/**
 * Brouillon → payload : champs trimés, vides à `null`, et brief entièrement
 * vide → `null` (effacer). Le serveur re-normalise de toute façon ; on
 * s'aligne ici pour que le diff « a-t-il changé ? » soit fiable.
 */
function normalizeBriefDraft(d: BriefDraft): AgentBriefDto | null {
  const out: AgentBriefDto = {};
  let has = false;
  for (const f of BRIEF_FIELDS) {
    const v = d[f].trim();
    out[f] = v || null;
    if (v) has = true;
  }
  return has ? out : null;
}

/**
 * Rendu de l'aperçu « ce que voient les agents ».
 *
 * Purement présentationnel : tout vient du serveur, RIEN n'est recomposé ici.
 * Si ce composant se mettait à reconstruire le brief, l'écran divergerait de ce
 * que l'agent reçoit — exactement le problème qu'on cherche à supprimer.
 */
function AgentContextPreviewPanel({
  preview,
  t,
}: {
  preview: AgentContextPreviewDto;
  t: (k: string, o?: Record<string, unknown>) => string;
}) {
  const { brief, facts, documents, contextSources, charter, guardrails } = preview;
  // Rubriques du charter réellement transmises, dans l'ordre du pack agent.
  const charterRows: [string, string][] = charter
    ? (
        [
          ['projectPurpose', 'Purpose'],
          ['objectives', 'Objectives'],
          ['scopeIn', 'In scope'],
          ['scopeOut', 'Out of scope'],
          ['deliverables', 'Deliverables'],
          ['constraints', 'Constraints'],
          ['successCriteria', 'Success criteria'],
        ] as const
      )
        .map(([key, fallback]) => {
          const value = charter[key as keyof typeof charter];
          return value
            ? ([t(`manage.agents.charter.${key}`, { defaultValue: fallback }), value] as [
                string,
                string,
              ])
            : null;
        })
        .filter((r): r is [string, string] => r !== null)
    : [];
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      <pre
        style={{
          whiteSpace: 'pre-wrap',
          background: 'var(--bg-subtle, rgba(127,127,127,.08))',
          padding: 10,
          borderRadius: 6,
          fontSize: 12.5,
          margin: 0,
          maxHeight: 320,
          overflow: 'auto',
        }}
      >
        {brief.composed || t('manage.agents.previewEmpty', { defaultValue: '(empty brief)' })}
      </pre>

      {brief.orgDefaultApplied.length > 0 && (
        <div className="md-hint">
          {t('manage.agents.previewInherited', { defaultValue: 'Inherited from org default:' })}{' '}
          {brief.orgDefaultApplied.join(', ')}
        </div>
      )}

      <div className="md-hint">
        {t('manage.agents.previewDocs', { defaultValue: 'Context documents:' })}{' '}
        {documents.returned}/{documents.total}
        {documents.truncated && (
          <strong>
            {' '}
            — {t('manage.agents.previewTruncated', {
              defaultValue: 'truncated, some documents are NOT sent to agents',
            })}
          </strong>
        )}
      </div>
      {documents.items.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12.5 }}>
          {documents.items.slice(0, 12).map((d) => (
            <li key={d.id}>
              {d.filename}
              {d.source === 'folder' && (
                <span className="md-hint">
                  {' '}
                  ({t('documents.aiInherited', { defaultValue: 'inherited' })})
                </span>
              )}
            </li>
          ))}
        </ul>
      )}

      <div className="md-hint">
        {t('manage.agents.previewSources', { defaultValue: 'External sources:' })}{' '}
        {contextSources.length === 0
          ? t('manage.agents.previewNoSource', { defaultValue: 'none' })
          : contextSources
              .map((s) => `${s.label} — ${s.available ? 'OK' : (s.reason ?? 'unavailable')}`)
              .join(' · ')}
      </div>

      {/* Garde-fous projet : l'agent les reçoit, donc l'écran doit les montrer.
          Les résumer d'une ligne reviendrait à demander au PM de deviner. */}
      {guardrails.project && (
        <div>
          <div className="md-hint" style={{ fontWeight: 600, marginBottom: 4 }}>
            {t('manage.agents.previewGuardrails', { defaultValue: 'Guardrails sent to agents:' })}
          </div>
          <pre
            style={{
              whiteSpace: 'pre-wrap',
              background: 'var(--bg-subtle, rgba(127,127,127,.08))',
              padding: 8,
              borderRadius: 6,
              fontSize: 12.5,
              margin: 0,
            }}
          >
            {guardrails.project}
          </pre>
        </div>
      )}

      {/* Charter : on rend les rubriques RÉELLEMENT transmises. Une ligne
          « inclus » obligerait à ouvrir un autre onglet pour savoir quoi. */}
      <div>
        <div className="md-hint" style={{ fontWeight: 600, marginBottom: 4 }}>
          {t('manage.agents.previewCharter', { defaultValue: 'Project charter:' })}{' '}
          {charterRows.length === 0 && (
            <span style={{ fontWeight: 400 }}>
              {t('manage.agents.previewCharterOff', { defaultValue: 'not filled in' })}
            </span>
          )}
        </div>
        {charterRows.length > 0 && (
          <dl style={{ margin: 0, fontSize: 12.5 }}>
            {charterRows.map(([label, value]) => (
              <div key={label} style={{ marginBottom: 4 }}>
                <dt style={{ fontWeight: 600, color: 'var(--text-3)' }}>{label}</dt>
                <dd style={{ margin: '0 0 0 10px', whiteSpace: 'pre-wrap' }}>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="md-hint" style={{ marginTop: 4 }}>
          {t('manage.agents.previewCharterFiltered', {
            defaultValue:
              'Budget, stakeholders and risks are never sent to agents — they stay out of this pack.',
          })}
        </div>
      </div>

      <div className="md-hint">
        {t('manage.agents.previewReviewers', { defaultValue: 'Reviewers:' })}{' '}
        {facts.reviewers.length
          ? facts.reviewers.map((r) => r.name).join(', ')
          : t('manage.agents.previewNoReviewer', { defaultValue: 'none' })}
      </div>
    </div>
  );
}

/** Défauts serveur de `Project.sponsorNotify` (voir sponsor-notify.ts côté API). */
const SPONSOR_NOTIFY_DEFAULTS = {
  milestoneReached: true,
  projectStatus: true,
  milestoneAtRisk: false,
  budgetThresholds: false,
} as const;

function readSponsorNotifyDraft(raw: unknown): ManageDraft['sponsorNotify'] {
  const out = { ...SPONSOR_NOTIFY_DEFAULTS } as ManageDraft['sponsorNotify'];
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const o = raw as Record<string, unknown>;
    for (const k of Object.keys(out) as (keyof ManageDraft['sponsorNotify'])[]) {
      if (typeof o[k] === 'boolean') out[k] = o[k] as boolean;
    }
  }
  return out;
}

/* Onglets du panel de gestion projet (remplacent le scroll unique). */
type ManageTab = 'general' | 'fields' | 'charter' | 'access' | 'ia' | 'integrations' | 'export';
const MANAGE_TAB_META: Record<ManageTab, { labelKey: string; icon: string }> = {
  general: { labelKey: 'general', icon: 'board' },
  fields: { labelKey: 'fields', icon: 'pencil' },
  charter: { labelKey: 'charter', icon: 'flag' },
  access: { labelKey: 'access', icon: 'users' },
  ia: { labelKey: 'ia', icon: 'zap' },
  integrations: { labelKey: 'integrations', icon: 'link' },
  export: { labelKey: 'export', icon: 'download' },
};

interface ManageModalProps {
  project: ProjectDto;
  onClose: () => void;
  onSaved: (p: ProjectDto) => void;
  onDeleted: (projectId: string) => void;
  pushToast: (text: string, warn?: boolean) => void;
}

export function ManageModal({ project, onClose, onSaved, onDeleted, pushToast }: ManageModalProps) {
  const { t } = useTranslation('projects');
  const { t: tc } = useTranslation('common');
  const { can } = useAuth();
  const canDeleteThis =
    can('project:delete') &&
    (project.status === ProjectStatus.DRAFT || project.status === ProjectStatus.CHARTER_REVIEW);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  // Onglet actif du panel (remplace le long scroll par des sous-menus).
  const [tab, setTab] = useState<ManageTab>('general');
  // Champs personnalisés : compte pour n'afficher l'onglet « Champs » que s'il
  // y en a (le contenu est rendu par CustomFieldValuesSection, qui recharge
  // sa propre donnée à l'ouverture de l'onglet).
  const [cfCount, setCfCount] = useState<number>(0);
  useEffect(() => {
    let alive = true;
    apiGetProjectCustomFields(project.id)
      .then((rows) => { if (alive) setCfCount(rows.length); })
      .catch(() => { if (alive) setCfCount(0); });
    return () => { alive = false; };
  }, [project.id]);
  const [draft, setDraft] = useState<ManageDraft>(() => ({
    status: project.status,
    statusHealth: project.statusHealth ?? '',
    statusSummary: project.statusSummary ?? '',
    startDate: project.startDate ? project.startDate.slice(0, 10) : '',
    dueDate: project.dueDate ? project.dueDate.slice(0, 10) : '',
    name: project.name,
    description: project.description ?? '',
    clientId: project.clientId ?? null,
    agentsEnabled: project.agentsEnabled ?? false,
    spContextEnabled: project.spContextEnabled ?? true,
    agentContext: project.agentContext ?? '',
    agentBrief: {
      role: project.agentBrief?.role ?? '',
      outputConventions: project.agentBrief?.outputConventions ?? '',
      deliveryTarget: project.agentBrief?.deliveryTarget ?? '',
      outOfScope: project.agentBrief?.outOfScope ?? '',
    },
    agentGuardrails: project.agentGuardrails ?? '',
    agentCostBudget: project.agentCostBudget != null ? String(project.agentCostBudget) : '',
    verificationCapabilities: Array.isArray(project.verificationCapabilities)
      ? project.verificationCapabilities
      : [],
    stakes: project.stakes ?? '',
    verificationMode: project.verificationMode ?? '',
    ciReposText: (project.ciRepos ?? []).join('\n'),
    sponsorNotify: readSponsorNotifyDraft(project.sponsorNotify),
  }));
  const [clients, setClients] = useState<Array<{ id: string; name: string; company: string | null }>>([]);
  const [canManageClients, setCanManageClients] = useState(false);
  const [saving, setSaving] = useState(false);
  // Contexte documentaire SharePoint (agents) : état du grant + action « Vérifier ».
  const [spGrant, setSpGrant] = useState<'NONE' | 'PENDING' | 'GRANTED' | 'FAILED'>(
    project.msSpGrantStatus ?? 'NONE',
  );
  const [spVerifying, setSpVerifying] = useState(false);
  // Aperçu « ce que voient les agents » : chargé à l'ouverture du panneau (pas
  // au montage — le pack coûte plus cher qu'un GET simple), jamais lié au draft.
  const [preview, setPreview] = useState<AgentContextPreviewDto | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [members, setMembers] = useState<
    Array<{
      userId: string;
      user: { id: string; name: string; email: string };
      role: { key: string; name: string };
      isSponsor?: boolean;
    }>
  >([]);
  const [candidates, setCandidates] = useState<Array<{ id: string; name: string; email: string; kind?: string }>>([]);
  // True quand le chargement membres/candidats a ÉCHOUÉ (réseau, droits…) —
  // distinct de « liste vide », pour ne pas afficher de faux états vides.
  const [accessLoadFailed, setAccessLoadFailed] = useState(false);
  const [allOrgTeams, setAllOrgTeams] = useState<Array<{ id: string; name: string; color: string | null }>>([]);
  const [projectTeams, setProjectTeams] = useState<
    Array<{
      teamId: string;
      role: { id: string; key: string; name: string } | null;
      team: { id: string; name: string; color: string | null; members: Array<{ userId: string }> };
    }>
  >([]);
  const [addingMember, setAddingMember] = useState(false);
  const [addingTeam, setAddingTeam] = useState(false);
  // Webhooks projet (self-service) : visible seulement si l'utilisateur peut gérer.
  const [whCanManage, setWhCanManage] = useState(false);
  const [addingSkill, setAddingSkill] = useState(false);
  const [skillsCatalog, setSkillsCatalog] = useState<SkillDto[]>([]);
  const [projectSkillIds, setProjectSkillIds] = useState<string[]>([]);
  // Périmètre des skills assignables au projet : null = pas d'équipe affectée
  // ⇒ catalogue complet (fallback) ; Set = union des compétences des équipes.
  const [availableSkillIds, setAvailableSkillIds] = useState<Set<string> | null>(null);
  const [memberSearch, setMemberSearch] = useState('');
  // Confirmation modal pour "remove team" quand des membres directs vont être
  // retirés en cascade. null = aucune confirmation en attente.
  const [confirmRemoveTeam, setConfirmRemoveTeam] = useState<
    | {
        teamId: string;
        teamName: string;
        affected: Array<{
          userId: string;
          user: { id: string; name: string; email: string };
          role: { key: string; name: string };
        }>;
      }
    | null
  >(null);
  const [confirmBusy, setConfirmBusy] = useState(false);

  // Escape ferme le modal — sauf si un sous-dialogue est ouvert (il gère le
  // sien, cf. pile dans useEscapeKey) ou pendant un save.
  useEscapeKey(onClose, !confirmDelete && !confirmRemoveTeam && !saving && !deleting);

  const set = (patch: Partial<ManageDraft>) => setDraft((d) => ({ ...d, ...patch }));

  // Resync le statut du brouillon quand le projet change de statut hors de ce
  // sélecteur (actions offre accept/refus/envoi, activation depuis le charter) —
  // sinon le brouillon resterait sur l'ancien statut et « Save » tenterait une
  // transition invalide.
  useEffect(() => {
    setDraft((d) => (d.status === project.status ? d : { ...d, status: project.status }));
  }, [project.status]);

  // Recalcule le périmètre des skills assignables dès que les équipes du
  // projet changent (l'ajout/retrait d'une équipe élargit/réduit la liste).
  useEffect(() => {
    let cancelled = false;
    api
      .availableProjectSkills(project.id)
      .then((r) => {
        if (cancelled) return;
        setAvailableSkillIds(r.scoped ? new Set(r.skills.map((s) => s.id)) : null);
      })
      .catch(() => {
        if (!cancelled) setAvailableSkillIds(null);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [project.id, projectTeams]);

  useEffect(() => {
    let alive = true;
    api
      .projectWebhooksCanManage(project.id)
      .then((r) => alive && setWhCanManage(r.canManage))
      .catch(() => { /* pas de droit / pas dispo → section masquée */ });
    return () => {
      alive = false;
    };
  }, [project.id]);

  const refreshMembersAndCandidates = useCallback(async () => {
    const [m, c] = await Promise.all([
      api.listProjectMembers(project.id).catch(() => null),
      api.listProjectCandidates(project.id).catch(() => null),
    ]);
    setAccessLoadFailed(m === null || c === null);
    if (m !== null) setMembers(m as typeof members);
    if (c !== null) setCandidates(c);
    // Patch le store global pour que TaskDetail recalcule sa liste blanche
    // d'assignees immédiatement, sans attendre un changement de projet ou
    // un F5 (bug rapporté : updater les équipes du projet ne propageait pas).
    refreshProjectAssignees(project.id).catch(() => { /* best-effort */ });
  }, [project.id]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.listProjectMembers(project.id).catch(() => null),
      api.listProjectCandidates(project.id).catch(() => null),
      api.listProjectTeams(project.id).catch(() => []),
      api.listTeams().catch(() => []),
      api
        .listClients({ pageSize: 200 })
        .then((r) => r.items)
        .catch(() => null as null | Awaited<ReturnType<typeof api.listClients>>['items']),
      api.listSkills().catch(() => []),
      api.listProjectSkills(project.id).catch(() => []),
    ]).then(([m, c, pt, all, cls, skills, ps]) => {
      if (cancelled) return;
      setAccessLoadFailed(m === null || c === null);
      setMembers((m ?? []) as typeof members);
      setCandidates(c ?? []);
      setProjectTeams(pt as typeof projectTeams);
      setAllOrgTeams(all.map((t) => ({ id: t.id, name: t.name, color: t.color })));
      setSkillsCatalog(skills);
      setProjectSkillIds(ps.map((x) => x.skillId));
      if (cls) {
        setCanManageClients(true);
        setClients(cls.map((x) => ({ id: x.id, name: x.name, company: x.company })));
      } else {
        setCanManageClients(false);
      }
    });
    return () => {
      cancelled = true;
    };
  }, [project.id]);

  const startDate = draft.startDate ? new Date(draft.startDate) : null;
  const dueDate = draft.dueDate ? new Date(draft.dueDate) : null;
  const invalidDates = !!(startDate && dueDate && dueDate < startDate);
  const span =
    startDate && dueDate
      ? Math.round((dueDate.getTime() - startDate.getTime()) / DAY_MS)
      : null;

  /** Patch minimal draft → projet. `undefined` = champ inchangé. */
  const patch = useMemo<UpdateProjectDto>(
    () => ({
      name: draft.name !== project.name ? draft.name : undefined,
      description:
        draft.description !== (project.description ?? '') ? draft.description || null : undefined,
      status: draft.status !== project.status ? draft.status : undefined,
      statusHealth:
        draft.statusHealth !== (project.statusHealth ?? '')
          ? (draft.statusHealth || null)
          : undefined,
      statusSummary:
        draft.statusSummary !== (project.statusSummary ?? '')
          ? (draft.statusSummary.trim() || null)
          : undefined,
      startDate:
        draft.startDate !== (project.startDate?.slice(0, 10) ?? '')
          ? draft.startDate || null
          : undefined,
      dueDate:
        draft.dueDate !== (project.dueDate?.slice(0, 10) ?? '') ? draft.dueDate || null : undefined,
      clientId:
        (draft.clientId ?? null) !== (project.clientId ?? null) ? draft.clientId : undefined,
      agentsEnabled:
        draft.agentsEnabled !== (project.agentsEnabled ?? false) ? draft.agentsEnabled : undefined,
      spContextEnabled:
        draft.spContextEnabled !== (project.spContextEnabled ?? true) ? draft.spContextEnabled : undefined,
      agentContext:
        draft.agentContext !== (project.agentContext ?? '')
          ? draft.agentContext.trim() || null
          : undefined,
      agentBrief:
        JSON.stringify(normalizeBriefDraft(draft.agentBrief)) !==
        JSON.stringify(normalizeBriefDraft(readBriefDraft(project.agentBrief)))
          ? normalizeBriefDraft(draft.agentBrief)
          : undefined,
      agentGuardrails:
        draft.agentGuardrails !== (project.agentGuardrails ?? '')
          ? draft.agentGuardrails.trim() || null
          : undefined,
      verificationCapabilities:
        JSON.stringify(draft.verificationCapabilities) !==
        JSON.stringify(Array.isArray(project.verificationCapabilities) ? project.verificationCapabilities : [])
          ? draft.verificationCapabilities
          : undefined,
      stakes: draft.stakes !== (project.stakes ?? '') ? (draft.stakes || null) : undefined,
      verificationMode:
        draft.verificationMode !== (project.verificationMode ?? '')
          ? (draft.verificationMode || null)
          : undefined,
      ciRepos:
        draft.ciReposText !== (project.ciRepos ?? []).join('\n')
          ? draft.ciReposText.split(/[\n,]/).map((r) => r.trim()).filter(Boolean)
          : undefined,
      agentCostBudget:
        draft.agentCostBudget !== (project.agentCostBudget != null ? String(project.agentCostBudget) : '')
          ? (draft.agentCostBudget.trim() === '' ? null : Number(draft.agentCostBudget))
          : undefined,
      sponsorNotify:
        JSON.stringify(draft.sponsorNotify) !==
        JSON.stringify(readSponsorNotifyDraft(project.sponsorNotify))
          ? draft.sponsorNotify
          : undefined,
    }),
    [draft, project],
  );
  const hasChange = Object.values(patch).some((v) => v !== undefined);
  const nameInvalid = draft.name.trim().length === 0;
  // Un projet ouvert aux agents doit porter un brief : le formulaire structuré
  // OU les notes libres. L'un des deux suffit (les projets d'avant la refonte
  // n'ont que les notes libres, on ne les invalide pas).
  const agentInvalid =
    draft.agentsEnabled &&
    draft.agentContext.trim().length === 0 &&
    normalizeBriefDraft(draft.agentBrief) === null;

  const filteredCandidates = useMemo(() => {
    const q = memberSearch.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(
      (u) => u.name.toLowerCase().includes(q) || u.email.toLowerCase().includes(q),
    );
  }, [candidates, memberSearch]);

  const teamCandidates = useMemo(
    () => allOrgTeams.filter((t) => !projectTeams.some((pt) => pt.teamId === t.id)),
    [allOrgTeams, projectTeams],
  );

  async function save() {
    if (!hasChange || nameInvalid || invalidDates || agentInvalid) return;
    setSaving(true);
    try {
      const next = await api.updateProject(project.id, patch);
      onSaved(next);
      pushToast(t('manage.saved', { key: project.key }));
      onClose();
    } catch (e) {
      pushToast(t('manage.saveFailed', { message: (e as Error).message }), true);
    } finally {
      setSaving(false);
    }
  }

  async function addMember(userId: string, roleKey: string) {
    setAddingMember(false);
    setMemberSearch('');
    try {
      await api.addProjectMember(project.id, userId, roleKey);
      await refreshMembersAndCandidates();
      pushToast(roleKey === 'PROJECT_MANAGER' ? t('manage.managerAdded') : t('manage.memberAdded'));
    } catch (e) {
      pushToast(t('manage.addFailed', { message: (e as Error).message }), true);
    }
  }
  async function changeMemberRole(userId: string, roleKey: string) {
    try {
      await api.addProjectMember(project.id, userId, roleKey);
      await refreshMembersAndCandidates();
      pushToast(t('manage.roleUpdated'));
    } catch (e) {
      pushToast(t('manage.roleChangeFailed', { message: (e as Error).message }), true);
    }
  }
  async function removeMember(userId: string) {
    try {
      await api.removeProjectMember(project.id, userId);
      await refreshMembersAndCandidates();
      pushToast(t('manage.removed'));
    } catch (e) {
      pushToast(t('manage.removeFailed', { message: (e as Error).message }), true);
    }
  }
  /** Bascule le tag sponsor d'un membre (optimiste, rollback si échec). */
  async function toggleSponsor(userId: string) {
    const current = members.find((m) => m.userId === userId)?.isSponsor ?? false;
    setMembers((ms) => ms.map((m) => (m.userId === userId ? { ...m, isSponsor: !current } : m)));
    try {
      await api.updateProjectMember(project.id, userId, { isSponsor: !current });
      pushToast(!current ? t('manage.sponsor.added') : t('manage.sponsor.removed'));
    } catch (e) {
      setMembers((ms) => ms.map((m) => (m.userId === userId ? { ...m, isSponsor: current } : m)));
      pushToast(t('manage.sponsor.toggleFailed', { message: (e as Error).message }), true);
    }
  }

  async function addTeam(teamId: string) {
    setAddingTeam(false);
    try {
      await api.addProjectTeam(project.id, teamId);
      const [pt] = await Promise.all([
        api.listProjectTeams(project.id),
        refreshMembersAndCandidates(),
      ]);
      setProjectTeams(pt as typeof projectTeams);
      pushToast(t('manage.teamAssigned'));
    } catch (e) {
      pushToast(t('manage.teamAddFailed', { message: (e as Error).message }), true);
    }
  }

  async function changeTeamRole(teamId: string, roleKey: string) {
    try {
      await api.setProjectTeamRole(project.id, teamId, roleKey);
      const pt = await api.listProjectTeams(project.id);
      setProjectTeams(pt as typeof projectTeams);
      pushToast(t('manage.roleUpdated'));
    } catch (e) {
      pushToast(t('manage.roleChangeFailed', { message: (e as Error).message }), true);
    }
  }

  /**
   * Détache une équipe + retire ses membres directs hérités en UNE requête
   * atomique (`?removeMembers=1`, transaction côté serveur — pas d'état
   * intermédiaire si ça échoue à mi-parcours).
   */
  async function commitRemoveTeam(teamId: string) {
    try {
      const res = await api.removeProjectTeam(project.id, teamId, { removeMembers: true });
      const [next] = await Promise.all([
        api.listProjectTeams(project.id),
        refreshMembersAndCandidates(),
      ]);
      setProjectTeams(next as typeof projectTeams);
      pushToast(
        res.membersRemoved > 0
          ? t('manage.teamUnassignedWithMembers', { count: res.membersRemoved })
          : t('manage.teamUnassigned'),
      );
    } catch (e) {
      pushToast(t('manage.teamRemoveFailed', { message: (e as Error).message }), true);
    }
  }

  function removeTeam(teamId: string) {
    const pt = projectTeams.find((p) => p.teamId === teamId);
    if (!pt) return;
    // Cross-check direct project members vs this team's roster: any direct
    // member who belongs to the team will lose their role when the team is
    // unassigned (they were on the project because of this team).
    const teamUserIds = new Set(pt.team.members.map((m) => m.userId));
    const affected = members.filter((m) => teamUserIds.has(m.userId));
    if (affected.length === 0) {
      void commitRemoveTeam(teamId);
      return;
    }
    setConfirmRemoveTeam({ teamId, teamName: pt.team.name, affected });
  }

  const hue = colorFromKey(project.key);
  const managers = members.filter((m) => m.role.key === 'PROJECT_MANAGER');
  const otherMembers = members.filter((m) => m.role.key !== 'PROJECT_MANAGER');
  const PROJECT_ROLE_OPTIONS = [
    { key: 'PROJECT_MANAGER', name: t('manage.memberRole.projectManager') },
    { key: 'CONTRIBUTOR', name: t('manage.memberRole.contributor') },
    { key: 'VIEWER', name: t('manage.memberRole.viewer') },
    { key: 'GUEST', name: t('manage.memberRole.guest') },
  ];
  const [addRoleKey, setAddRoleKey] = React.useState<string>('CONTRIBUTOR');

  // Transitions de statut légales depuis l'état ACTUEL du projet (machine à
  // états serveur, exposée dans le DTO). Le statut courant reste toujours
  // sélectionnable ; les autres sont grisés au lieu d'échouer au save.
  // Fallback permissif si le champ est absent (vieille API en cache).
  const allowedStatuses = useMemo(() => {
    if (!project.allowedTransitions) return new Set(ALL_STATUSES);
    return new Set<ProjectStatus>([...project.allowedTransitions, project.status]);
  }, [project.allowedTransitions, project.status]);

  // Onglets visibles selon le contexte : Charter TOUJOURS visible (édition en
  // DRAFT/CHARTER_REVIEW, sinon vue gelée + téléchargement des fichiers signés),
  // Intégrations seulement si l'utilisateur peut gérer les webhooks projet.
  // (La finance projet vit désormais dans la vue « Finances » dédiée.)
  const canViewReports = can('report:view');
  const visibleTabs = (Object.keys(MANAGE_TAB_META) as ManageTab[]).filter((tabKey) => {
    if (tabKey === 'integrations') return whCanManage;
    if (tabKey === 'fields') return cfCount > 0;
    return true;
  });
  // Si l'onglet actif disparaît (ex. on quitte DRAFT), on retombe sur Général.
  const activeTab: ManageTab = visibleTabs.includes(tab) ? tab : 'general';

  // Fenêtre par défaut des exports datés (burndown, tasks-in-window) :
  // [start du projet | J-30 ; due | aujourd'hui].
  const isoDay = (d: Date) => d.toISOString().slice(0, 10);
  const exportFrom =
    project.startDate?.slice(0, 10) ?? isoDay(new Date(Date.now() - 30 * DAY_MS));
  const exportTo = project.dueDate?.slice(0, 10) ?? isoDay(new Date());
  const exportCsv = (path: string, name: string) =>
    api.downloadCsv(path, name).catch((e) => pushToast(t('manage.exportFailed', { message: (e as Error).message }), true));

  return (
    <div className="md-overlay" onMouseDown={onClose}>
      <div className="md-card md-card-wide" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="md-head">
          <div
            className="pj-key mono"
            style={{ background: `oklch(0.55 0.15 ${hue})`, width: 38, height: 38 }}
          >
            {project.key}
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{t('manage.eyebrow')}</div>
            <div className="md-title truncate">{project.name}</div>
          </div>
          <button className="icon-btn" onClick={onClose} aria-label={tc('close')}>
            <Icon name="x" size={18} />
          </button>
        </div>

        {/* Barre d'onglets — remplace le long scroll par des sous-menus */}
        <div className="md-tabs" role="tablist">
          {visibleTabs.map((tabKey) => (
            <button
              key={tabKey}
              role="tab"
              aria-selected={activeTab === tabKey}
              className={'md-tab' + (activeTab === tabKey ? ' md-tab-on' : '')}
              onClick={() => setTab(tabKey)}
            >
              <Icon name={MANAGE_TAB_META[tabKey].icon} size={14} />
              <span>{t('manage.tab.' + MANAGE_TAB_META[tabKey].labelKey)}</span>
            </button>
          ))}
        </div>

        <div className="md-body">
          {/* Charter (initiation phase + frozen view post-activation) */}
          {activeTab === 'charter' && (
            <CharterEditor project={project} onProjectChanged={onSaved} pushToast={pushToast} />
          )}

          {/* ---- Onglet Général : Name, Status, Timeline, Description, Client ---- */}
          {activeTab === 'general' && (<>
          {/* Name */}
          <div className="md-field">
            <div className="md-label">{t('manage.name')}</div>
            <input
              className="atext"
              value={draft.name}
              onChange={(e) => set({ name: e.target.value })}
              style={{ width: '100%' }}
            />
            {nameInvalid && (
              <div className="md-warn">
                <Icon name="warn" size={13} /> {t('manage.nameEmpty')}
              </div>
            )}
          </div>

          {/* Status */}
          <div className="md-field">
            <div className="md-label">{t('manage.status')}</div>
            <div className="seg">
              {ALL_STATUSES.map((k) => {
                // Les arêtes pilotées par l'étape « offre » (envoi depuis DRAFT,
                // accept/refus depuis OFFER_SENT) passent par la section Offre,
                // pas par ce sélecteur de statut — on les désactive ici.
                const offerControlled =
                  project.billable &&
                  ((project.status === ProjectStatus.DRAFT && k === ProjectStatus.OFFER_SENT) ||
                    (project.status === ProjectStatus.OFFER_SENT &&
                      (k === ProjectStatus.DRAFT || k === ProjectStatus.CHARTER_REVIEW)));
                const allowed = allowedStatuses.has(k) && !offerControlled;
                return (
                  <button
                    key={k}
                    className={'seg-btn' + (draft.status === k ? ' seg-on' : '')}
                    disabled={!allowed}
                    style={!allowed ? { opacity: 0.4, cursor: 'not-allowed' } : undefined}
                    title={
                      offerControlled
                        ? t('manage.useOfferSection')
                        : allowed
                        ? ''
                        : t('manage.transitionNotAllowed', {
                            from: statusLabel(t, project.status),
                            to: statusLabel(t, k),
                          })
                    }
                    onClick={() => allowed && set({ status: k })}
                  >
                    {statusLabel(t, k)}
                  </button>
                );
              })}
            </div>
          </div>

          {/* Étape commerciale « offre » — projets facturables en DRAFT / OFFER_SENT */}
          {project.billable &&
            (project.status === ProjectStatus.DRAFT ||
              project.status === ProjectStatus.OFFER_SENT) && (
              <OfferSection
                project={project}
                onProjectChanged={onSaved}
                pushToast={pushToast}
              />
            )}

          {/* Dates */}
          <div className="md-field">
            <div className="md-label">{t('manage.timeline')}</div>
            <div className="md-dates">
              <label className="md-date">
                <span className="md-date-cap">{t('manage.startDate')}</span>
                <input
                  type="date"
                  value={draft.startDate}
                  max={draft.dueDate || undefined}
                  onChange={(e) => set({ startDate: e.target.value })}
                />
              </label>
              <div className="md-date-arrow">
                <Icon name="arrowR" size={16} />
              </div>
              <label className="md-date">
                <span className="md-date-cap">{t('manage.dueDate')}</span>
                <input
                  type="date"
                  value={draft.dueDate}
                  min={draft.startDate || undefined}
                  onChange={(e) => set({ dueDate: e.target.value })}
                />
              </label>
            </div>
            {invalidDates ? (
              <div className="md-warn">
                <Icon name="warn" size={13} /> {t('manage.dueBeforeStart')}
              </div>
            ) : span !== null ? (
              <div className="md-span">
                <Trans
                  t={t}
                  i18nKey="manage.span"
                  values={{
                    from: shortDate(draft.startDate),
                    to: shortDate(draft.dueDate),
                    days: span,
                    weeks: Math.max(0, Math.round(span / 7)),
                  }}
                  components={[<b />]}
                />
              </div>
            ) : null}
          </div>

          {/* Description */}
          <div className="md-field">
            <div className="md-label">{t('manage.description')}</div>
            <textarea
              className="atext"
              value={draft.description}
              onChange={(e) => set({ description: e.target.value })}
              rows={3}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
            />
          </div>

          {/* Point de statut client — santé (RAG) + résumé rendus dans le deck PPTX */}
          <div className="md-field">
            <div className="md-label">{t('manage.clientStatus')}</div>
            <div className="seg">
              {(
                [
                  ['ON_TRACK', 'onTrack'],
                  ['AT_RISK', 'atRisk'],
                  ['OFF_TRACK', 'offTrack'],
                ] as const
              ).map(([k, key]) => (
                <button
                  key={k}
                  className={'seg-btn' + (draft.statusHealth === k ? ' seg-on' : '')}
                  onClick={() => set({ statusHealth: draft.statusHealth === k ? '' : k })}
                >
                  {t('manage.health.' + key)}
                </button>
              ))}
            </div>
            <textarea
              className="atext"
              value={draft.statusSummary}
              onChange={(e) => set({ statusSummary: e.target.value })}
              rows={4}
              maxLength={4000}
              placeholder={t('manage.statusSummaryPlaceholder')}
              style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit', marginTop: 8 }}
            />
            <div className="md-hint" style={{ marginTop: 4, fontSize: 12, color: 'var(--text-2)' }}>
              {t('manage.clientStatusHint')}
            </div>
          </div>

          {/* Client (portefeuille) — reste dans l'onglet Général */}
          {canManageClients && (
            <div className="md-field">
              <div className="md-label">{t('manage.client')}</div>
              <select
                value={draft.clientId ?? ''}
                onChange={(e) => set({ clientId: e.target.value || null })}
                style={{
                  fontFamily: 'inherit',
                  fontSize: 13,
                  color: 'var(--text)',
                  background: 'var(--surface-2)',
                  border: '1px solid var(--border)',
                  borderRadius: 'var(--r-sm)',
                  padding: '8px 10px',
                  cursor: 'pointer',
                  outline: 'none',
                  width: '100%',
                }}
              >
                <option value="">{t('manage.noClient')}</option>
                {clients.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name}
                    {c.company ? ` (${c.company})` : ''}
                  </option>
                ))}
              </select>
            </div>
          )}

          {/* Budget projet — édité ici (réglages), lecture seule dans la finance projet */}
          {can('finance:view') && (
            <ProjectBudgetField
              projectId={project.id}
              canManage={can('finance:manage')}
              pushToast={pushToast}
            />
          )}

          </>)}

          {/* ---- Onglet Champs (champs personnalisés du projet) ---- */}
          {activeTab === 'fields' && (
            <CustomFieldValuesSection
              kind="project"
              entityId={project.id}
              pushError={(msg) => pushToast(msg, true)}
            />
          )}

          {/* ---- Onglet IA (agents) ---- */}
          {activeTab === 'ia' && (
          <div className="md-field">
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={draft.agentsEnabled}
                onChange={(e) => set({ agentsEnabled: e.target.checked })}
              />
              <span className="md-label" style={{ margin: 0 }}>{t('manage.agents.enable')}</span>
            </label>
            <div className="md-hint" style={{ marginTop: 4 }}>{t('manage.agents.enableHint')}</div>

            {draft.agentsEnabled && (
              <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 12 }}>
                {/* Brief STRUCTURÉ : 4 champs courts. Le serveur y ajoute tout
                    seul ce qu'il sait déjà (reviewer, mode de vérification,
                    enjeu, langue) — inutile de le retaper ici. */}
                <div>
                  <div className="md-label">
                    {t('manage.agents.brief', { defaultValue: 'Agent brief' })}
                    <span style={{ color: 'var(--danger, #f85149)' }}> *</span>
                  </div>
                  <div className="md-hint" style={{ marginBottom: 8 }}>
                    {t('manage.agents.briefHint', {
                      defaultValue:
                        'Fill in only what the app cannot know. Reviewer, verification mode, stakes and language are added automatically.',
                    })}
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                    {BRIEF_FIELDS.map((field) => (
                      <div key={field}>
                        <div className="md-hint" style={{ marginBottom: 4, fontWeight: 600 }}>
                          {t(`manage.agents.brief.${field}`, {
                            defaultValue: BRIEF_FIELD_FALLBACK[field].label,
                          })}
                        </div>
                        <textarea
                          className="atext"
                          value={draft.agentBrief[field]}
                          onChange={(e) =>
                            set({ agentBrief: { ...draft.agentBrief, [field]: e.target.value } })
                          }
                          rows={field === 'role' ? 3 : 2}
                          placeholder={t(`manage.agents.brief.${field}Placeholder`, {
                            defaultValue: BRIEF_FIELD_FALLBACK[field].placeholder,
                          })}
                          style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                        />
                      </div>
                    ))}
                  </div>
                  {agentInvalid && (
                    <div className="md-warn" style={{ marginTop: 6 }}>
                      <Icon name="warn" size={13} /> {t('manage.agents.contextRequired')}
                    </div>
                  )}
                </div>

                {/* Notes libres : l'ancien pavé, conservé et replié. Rendu EN
                    DERNIER dans le brief composé, pour qu'il n'y ait jamais
                    d'ambiguïté de préséance avec les champs structurés. */}
                <details>
                  <summary style={{ cursor: 'pointer' }} className="md-label">
                    {t('manage.agents.freeNotes', { defaultValue: 'Free notes (optional)' })}
                  </summary>
                  <div className="md-hint" style={{ margin: '6px 0' }}>
                    {t('manage.agents.freeNotesHint', {
                      defaultValue:
                        'Anything that does not fit the fields above. Rendered last in the composed brief.',
                    })}
                  </div>
                  <textarea
                    className="atext"
                    value={draft.agentContext}
                    onChange={(e) => set({ agentContext: e.target.value })}
                    rows={5}
                    placeholder={t('manage.agents.contextPlaceholder')}
                    style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                  />
                </details>
                <div>
                  <div className="md-label">{t('manage.agents.guardrails')}</div>
                  <div className="md-hint" style={{ marginBottom: 6 }}>{t('manage.agents.guardrailsHint')}</div>
                  <textarea
                    className="atext"
                    value={draft.agentGuardrails}
                    onChange={(e) => set({ agentGuardrails: e.target.value })}
                    rows={3}
                    placeholder={t('manage.agents.guardrailsPlaceholder')}
                    style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
                  />
                </div>
                <div>
                  <div className="md-label">{t('manage.agents.stakes', { defaultValue: 'Project stakes' })}</div>
                  <div className="md-hint" style={{ marginBottom: 6 }}>
                    {t('manage.agents.stakesHint', {
                      defaultValue:
                        'How much is at risk if an agent gets it wrong. Inherited by every task of the project; drives the required proof level (stakes × agent trust).',
                    })}
                  </div>
                  <select
                    className="atext"
                    value={draft.stakes}
                    onChange={(e) => set({ stakes: e.target.value })}
                    style={{ width: 220 }}
                  >
                    <option value="">{t('manage.agents.stakesLow', { defaultValue: 'low — internal / draft' })}</option>
                    <option value="medium">{t('manage.agents.stakesMedium', { defaultValue: 'medium — project deliverable' })}</option>
                    <option value="high">{t('manage.agents.stakesHigh', { defaultValue: 'high — client-facing / prod' })}</option>
                    <option value="critical">{t('manage.agents.stakesCritical', { defaultValue: 'critical — regulatory / irreversible' })}</option>
                  </select>
                </div>
                <div>
                  <div className="md-label">{t('manage.agents.costBudget')}</div>
                  <div className="md-hint" style={{ marginBottom: 6 }}>{t('manage.agents.costBudgetHint')}</div>
                  <input
                    className="atext"
                    type="number"
                    min={0}
                    step="0.01"
                    value={draft.agentCostBudget}
                    onChange={(e) => set({ agentCostBudget: e.target.value })}
                    placeholder="€"
                    style={{ width: 180 }}
                  />
                </div>
                <div>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={draft.spContextEnabled}
                      onChange={(e) => set({ spContextEnabled: e.target.checked })}
                    />
                    <span className="md-label" style={{ margin: 0 }}>
                      {t('manage.agents.spContext', { defaultValue: 'SharePoint document context' })}
                    </span>
                  </label>
                  <div className="md-hint" style={{ marginTop: 4 }}>
                    {t('manage.agents.spContextHint', {
                      defaultValue:
                        'Let agents read the documents of this project’s provisioned Teams SharePoint (live, read-only). Requires SharePoint context enabled org-wide.',
                    })}
                  </div>
                  {draft.spContextEnabled && (
                    <div style={{ marginTop: 8, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
                      <span
                        className="pill"
                        style={{
                          background: 'var(--surface-2)',
                          color:
                            spGrant === 'GRANTED'
                              ? 'var(--ok, #3fb950)'
                              : spGrant === 'PENDING'
                                ? 'var(--warn, #d29922)'
                                : 'var(--text-3)',
                        }}
                      >
                        {t(`manage.agents.spStatus.${spGrant}`, {
                          defaultValue:
                            spGrant === 'GRANTED'
                              ? 'Access granted'
                              : spGrant === 'PENDING'
                                ? 'Grant pending'
                                : spGrant === 'FAILED'
                                  ? 'Resolution failed'
                                  : 'Not resolved yet',
                        })}
                      </span>
                      {spGrant !== 'GRANTED' && (
                        <button
                          type="button"
                          className="btn btn-ghost"
                          disabled={spVerifying}
                          onClick={async () => {
                            setSpVerifying(true);
                            try {
                              const r = await api.verifyProjectSharePoint(project.id);
                              setSpGrant(r.status);
                            } catch {
                              /* le pill garde l'état précédent */
                            } finally {
                              setSpVerifying(false);
                            }
                          }}
                          style={{ fontSize: 12 }}
                        >
                          {spVerifying
                            ? t('common:loading')
                            : t('manage.agents.spVerify', { defaultValue: 'Verify access' })}
                        </button>
                      )}
                    </div>
                  )}
                </div>
                <div>
                  <div className="md-label">
                    {t('manage.agents.verifCaps', { defaultValue: 'Verification capabilities' })}
                  </div>
                  <div className="md-hint" style={{ marginBottom: 6 }}>
                    {t('manage.agents.verifCapsHint', {
                      defaultValue:
                        'Mechanical proof methods available on this project. Self-attestation and human review are always available; a required method not listed here escalates to human review.',
                    })}
                  </div>
                  <div className="row" style={{ gap: 14, flexWrap: 'wrap' }}>
                    {AGENT_VERIFICATION_CAPABILITY_METHODS.map((m) => (
                      <label key={m} className="row" style={{ gap: 6, cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={draft.verificationCapabilities.includes(m)}
                          onChange={(e) =>
                            set({
                              verificationCapabilities: e.target.checked
                                ? [...draft.verificationCapabilities, m]
                                : draft.verificationCapabilities.filter((x) => x !== m),
                            })
                          }
                        />
                        <code style={{ fontSize: 12.5 }}>{m}</code>
                      </label>
                    ))}
                  </div>
                </div>
                <div>
                  <div className="md-label">
                    {t('manage.agents.verifMode', { defaultValue: 'Verification mode' })}
                  </div>
                  <div className="md-hint" style={{ marginBottom: 6 }}>
                    {t('manage.agents.verifModeHint', {
                      defaultValue:
                        'report_only: the gate only logs proof gaps (calibration). enforce: the gate blocks below the required floor, and an agent-validator approve auto-approves (sampled to human). Inherits the org default when unset.',
                    })}
                  </div>
                  <select
                    className="atext"
                    value={draft.verificationMode}
                    onChange={(e) => set({ verificationMode: e.target.value })}
                    style={{ width: 260 }}
                  >
                    <option value="">{t('manage.agents.verifModeInherit', { defaultValue: 'Inherit org default' })}</option>
                    <option value="report_only">{t('manage.agents.verifModeReport', { defaultValue: 'report_only — log only (calibration)' })}</option>
                    <option value="enforce">{t('manage.agents.verifModeEnforce', { defaultValue: 'enforce — block + agent-validator auto-approve' })}</option>
                  </select>
                </div>

                <div>
                  <div className="md-label">
                    {t('manage.agents.ciRepos', { defaultValue: 'Allowed CI repositories' })}
                  </div>
                  <div className="md-hint" style={{ marginBottom: 6 }}>
                    {t('manage.agents.ciReposHint', {
                      defaultValue:
                        "One repository per line (e.g. owner/repo). A ci_signed proof is only accepted when its signed CI build comes from one of these repositories — a green build from an unrelated repository can no longer pass a deliverable. Leave empty to keep the historical org-wide matching.",
                    })}
                  </div>
                  <textarea
                    className="atext"
                    value={draft.ciReposText}
                    onChange={(e) => set({ ciReposText: e.target.value })}
                    rows={2}
                    placeholder="owner/repo"
                    style={{ width: '100%', fontFamily: 'monospace', fontSize: 12.5 }}
                  />
                </div>

                {/* « Ce que voient les agents » — rendu par le SERVEUR, avec le
                    même code que le work-context. Chargé à l'ouverture, jamais
                    couplé au draft (sinon on afficherait du non-enregistré). */}
                <details
                  onToggle={(e) => {
                    const open = (e.currentTarget as HTMLDetailsElement).open;
                    setPreviewOpen(open);
                    if (!open || preview || previewLoading) return;
                    setPreviewLoading(true);
                    setPreviewError(null);
                    api
                      .getAgentContextPreview(project.id)
                      .then(setPreview)
                      .catch((err: Error) => setPreviewError(err.message))
                      .finally(() => setPreviewLoading(false));
                  }}
                >
                  <summary style={{ cursor: 'pointer' }} className="md-label">
                    <Icon name="eye" size={13} />{' '}
                    {t('manage.agents.preview', { defaultValue: 'What agents actually see' })}
                  </summary>
                  <div className="md-hint" style={{ margin: '6px 0' }}>
                    {t('manage.agents.previewHint', {
                      defaultValue:
                        'The exact context pack served to agents on this project — composed by the server.',
                    })}
                  </div>
                  {previewOpen && hasChange && (
                    <div className="md-warn" style={{ marginBottom: 8 }}>
                      <Icon name="warn" size={13} />{' '}
                      {t('manage.agents.previewStale', {
                        defaultValue:
                          'Showing the SAVED state — your unsaved edits are not reflected here.',
                      })}
                    </div>
                  )}
                  {previewLoading && (
                    <div className="md-hint">{t('common.loading', { defaultValue: 'Loading…' })}</div>
                  )}
                  {previewError && <div className="md-warn">{previewError}</div>}
                  {preview && !previewLoading && (
                    <AgentContextPreviewPanel preview={preview} t={t} />
                  )}
                </details>
              </div>
            )}
          </div>
          )}

          {/* ---- Onglet Export ---- */}
          {activeTab === 'export' && (
            <div className="md-field">
              <div className="md-label">{t('manage.exportLabel')}</div>
              <div className="md-hint" style={{ marginBottom: 8 }}>
                {t('manage.exportHint')}
              </div>
              <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn btn-line btn-sm"
                  onClick={() =>
                    exportCsv(`/projects/${project.id}/tasks.csv`, `tasks-${project.key}.csv`)
                  }
                >
                  <Icon name="download" size={13} /> {t('manage.exportTasks')}
                </button>
                {canViewReports && (
                  <>
                    <button
                      className="btn btn-line btn-sm"
                      onClick={() =>
                        exportCsv(`/projects/${project.id}/stats.csv`, `stats-${project.key}.csv`)
                      }
                    >
                      <Icon name="download" size={13} /> {t('manage.exportStats')}
                    </button>
                    <button
                      className="btn btn-line btn-sm"
                      title={t('manage.exportBurndownPeriod', { from: exportFrom, to: exportTo })}
                      onClick={() =>
                        exportCsv(
                          `/projects/${project.id}/burndown.csv?from=${exportFrom}&to=${exportTo}`,
                          `burndown-${project.key}.csv`,
                        )
                      }
                    >
                      <Icon name="download" size={13} /> {t('manage.exportBurndown')}
                    </button>
                    <button
                      className="btn btn-line btn-sm"
                      onClick={() =>
                        exportCsv(
                          `/projects/${project.id}/due-adherence.csv`,
                          `due-adherence-${project.key}.csv`,
                        )
                      }
                    >
                      <Icon name="download" size={13} /> {t('manage.exportDueAdherence')}
                    </button>
                    <button
                      className="btn btn-line btn-sm"
                      title={t('manage.exportTimeByUserTitle')}
                      onClick={() =>
                        exportCsv(
                          `/reports/time-breakdown.csv?projectId=${project.id}&by=user`,
                          `time-by-user-${project.key}.csv`,
                        )
                      }
                    >
                      <Icon name="download" size={13} /> {t('manage.exportTimeByUser')}
                    </button>
                  </>
                )}
              </div>
              {canViewReports && (
                <div className="md-span" style={{ marginTop: 8, color: 'var(--text-3)' }}>
                  {t('manage.exportDatedNote', { from: exportFrom, to: exportTo })}
                </div>
              )}
            </div>
          )}

          {/* ---- Onglet Équipe & accès : Teams, Skills, People/rôles ---- */}
          {activeTab === 'access' && (<>
          {accessLoadFailed && (
            <div className="md-warn" style={{ marginBottom: 8 }}>
              <Icon name="warn" size={13} /> {t('manage.accessLoadFailed')}{' '}
              <button className="btn btn-ghost btn-sm" onClick={() => void refreshMembersAndCandidates()}>
                {t('common.retry')}
              </button>
            </div>
          )}
          {/* Teams assigned (gate visibility) */}
          <div className="md-field">
            <div className="md-label row" style={{ justifyContent: 'space-between' }}>
              <span>
                {t('manage.teams')} <span className="md-count">{projectTeams.length}</span>
              </span>
              <div style={{ position: 'relative' }}>
                <button
                  className="md-add"
                  onClick={() => setAddingTeam((v) => !v)}
                  disabled={teamCandidates.length === 0}
                >
                  <Icon name="plus" size={14} /> {t('manage.assignTeam')}
                </button>
                {addingTeam && (
                  <div
                    className="dd-menu"
                    style={{ right: 0, top: 'calc(100% + 4px)', width: 240, maxHeight: 280, overflowY: 'auto' }}
                  >
                    {teamCandidates.map((tm) => (
                      <button key={tm.id} className="dd-item" onClick={() => addTeam(tm.id)}>
                        <span
                          style={{
                            width: 12,
                            height: 12,
                            borderRadius: 3,
                            background: tm.color ?? `oklch(0.6 0.15 ${colorFromKey(tm.id)})`,
                            flexShrink: 0,
                          }}
                        />
                        <span className="grow truncate">{tm.name}</span>
                      </button>
                    ))}
                    {teamCandidates.length === 0 && (
                      <div className="md-empty" style={{ padding: 8 }}>
                        {t('manage.allTeamsAssigned')}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {projectTeams.length === 0 && (
                <div className="md-span" style={{ color: 'var(--text-3)' }}>
                  {t('manage.noTeamAssigned')}
                </div>
              )}
              {projectTeams.map((pt) => (
                <span
                  key={pt.teamId}
                  className="skl-chip"
                  title={t('manage.teamMembersTitle', { count: pt.team.members.length })}
                >
                  <span
                    style={{
                      width: 8,
                      height: 8,
                      borderRadius: 2,
                      background: pt.team.color ?? `oklch(0.6 0.15 ${colorFromKey(pt.teamId)})`,
                    }}
                  />
                  {pt.team.name}
                  <span className="skl-count">{pt.team.members.length}</span>
                  <button
                    className="skl-del"
                    title={t('manage.unassignTeam')}
                    onClick={() => removeTeam(pt.teamId)}
                  >
                    <Icon name="x" size={13} />
                  </button>
                </span>
              ))}
            </div>
          </div>

          {/* Skills */}
          <div className="md-field">
            <div className="md-label row" style={{ justifyContent: 'space-between' }}>
              <span>
                {t('manage.skills')} <span className="md-count">{projectSkillIds.length}</span>
              </span>
              <div style={{ position: 'relative' }}>
                <button
                  className="md-add"
                  onClick={() => setAddingSkill((v) => !v)}
                  disabled={skillsCatalog.length === 0}
                >
                  <Icon name="plus" size={14} /> {t('manage.addSkill')}
                </button>
                {addingSkill && (
                  <div
                    style={{
                      position: 'absolute',
                      right: 0,
                      top: 'calc(100% + 4px)',
                      width: 320,
                      background: 'var(--surface)',
                      border: '1px solid var(--border)',
                      borderRadius: 10,
                      padding: 10,
                      boxShadow: '0 10px 30px rgba(0,0,0,0.25)',
                      zIndex: 50,
                    }}
                    onClick={(e) => e.stopPropagation()}
                  >
                    {availableSkillIds !== null && (
                      <div style={{ fontSize: 11, color: 'var(--text-3)', marginBottom: 6 }}>
                        {t('manage.skillScopeHint')}
                      </div>
                    )}
                    <SkillPicker
                      skills={skillsCatalog.filter(
                        (s) => availableSkillIds === null || availableSkillIds.has(s.id),
                      )}
                      selected={projectSkillIds}
                      onChange={async (nextIds) => {
                        const prev = projectSkillIds;
                        setProjectSkillIds(nextIds);
                        try {
                          await api.setProjectSkills(project.id, nextIds);
                        } catch (e) {
                          setProjectSkillIds(prev);
                          pushToast(t('manage.updateSkillsFailed', { message: (e as Error).message }), true);
                        }
                      }}
                      multiple
                      placeholder={t('manage.skillSearchPlaceholder')}
                      emptyHint={
                        availableSkillIds !== null
                          ? t('manage.skillEmptyScoped')
                          : t('manage.skillEmptyAll')
                      }
                      maxHeight={300}
                    />
                    <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 8 }}>
                      <button className="btn btn-sm" onClick={() => setAddingSkill(false)}>
                        {tc('close')}
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {projectSkillIds.length === 0 && (
                <div className="md-span" style={{ color: 'var(--text-3)' }}>
                  {t('manage.noSkillAssociated')}
                </div>
              )}
              {projectSkillIds.map((sid) => {
                const s = skillsCatalog.find((x) => x.id === sid);
                if (!s) return null;
                return (
                  <span key={sid} className="skl-chip">
                    <span
                      style={{
                        width: 8,
                        height: 8,
                        borderRadius: 2,
                        background: s.color ?? '#6d5efc',
                      }}
                    />
                    {s.name}
                    <button
                      className="skl-del"
                      title={t('manage.removeSkill')}
                      onClick={async () => {
                        const next = projectSkillIds.filter((x) => x !== sid);
                        try {
                          await api.setProjectSkills(project.id, next);
                          setProjectSkillIds(next);
                        } catch (e) {
                          pushToast(t('manage.removeSkillFailed', { message: (e as Error).message }), true);
                        }
                      }}
                    >
                      <Icon name="x" size={13} />
                    </button>
                  </span>
                );
              })}
            </div>
          </div>

          {/* People */}
          <div className="md-field">
            <div className="md-label row" style={{ justifyContent: 'space-between' }}>
              <span>
                {t('manage.people')} <span className="md-count">{members.length}</span>
              </span>
              <div style={{ position: 'relative', display: 'flex', gap: 6, alignItems: 'center' }}>
                <select
                  value={addRoleKey}
                  onChange={(e) => setAddRoleKey(e.target.value)}
                  style={{
                    fontFamily: 'inherit',
                    fontSize: 12,
                    fontWeight: 600,
                    color: 'var(--text)',
                    background: 'var(--surface-2)',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r-sm)',
                    padding: '4px 8px',
                    cursor: 'pointer',
                    outline: 'none',
                  }}
                >
                  {PROJECT_ROLE_OPTIONS.map((r) => (
                    <option key={r.key} value={r.key}>
                      {r.name}
                    </option>
                  ))}
                </select>
                <button
                  className="md-add"
                  onClick={() => {
                    setMemberSearch('');
                    setAddingMember((v) => !v);
                  }}
                  disabled={candidates.length === 0 && !addingMember}
                >
                  <Icon name="plus" size={14} /> {tc('add')}
                </button>
                {addingMember && (
                  <div
                    className="dd-menu"
                    style={{
                      right: 0,
                      top: 'calc(100% + 4px)',
                      width: 280,
                      maxHeight: 320,
                      overflowY: 'auto',
                      padding: 4,
                    }}
                  >
                    <div
                      style={{
                        display: 'flex',
                        alignItems: 'center',
                        gap: 6,
                        padding: '6px 8px',
                        borderBottom: '1px solid var(--border)',
                        marginBottom: 4,
                        background: 'var(--surface-2)',
                        borderRadius: 'var(--r-sm)',
                      }}
                    >
                      <Icon name="search" size={13} style={{ color: 'var(--text-3)' }} />
                      <input
                        autoFocus
                        value={memberSearch}
                        onChange={(e) => setMemberSearch(e.target.value)}
                        placeholder={
                          projectTeams.length > 0 ? t('manage.searchTeamMembers') : t('manage.searchUsers')
                        }
                        style={{
                          border: 0,
                          background: 'transparent',
                          outline: 'none',
                          width: '100%',
                          fontSize: 13,
                          color: 'var(--text)',
                          fontFamily: 'inherit',
                        }}
                      />
                    </div>
                    {filteredCandidates.map((u) => (
                      <button key={u.id} className="dd-item" onClick={() => addMember(u.id, addRoleKey)}>
                        <Avatar user={avatarUser(u)} size={24} title={false} />
                        <span className="grow truncate">{u.name}</span>
                        {u.kind === 'AGENT' && (
                          <span
                            className="pill"
                            style={{
                              background: 'color-mix(in oklch, var(--accent) 16%, var(--surface))',
                              color: 'var(--accent)',
                              fontSize: 10.5,
                              flexShrink: 0,
                            }}
                          >
                            {t('manage.agentBadge')}
                          </span>
                        )}
                        <span className="md-role-mini truncate">{u.email}</span>
                      </button>
                    ))}
                    {filteredCandidates.length === 0 && (
                      <div className="md-empty" style={{ padding: 8 }}>
                        {accessLoadFailed
                          ? t('manage.listUnavailable')
                          : candidates.length === 0
                            ? projectTeams.length > 0
                              ? t('manage.noTeamMemberLeft')
                              : t('manage.everyoneOnProject')
                            : t('manage.noOneMatches', { query: memberSearch })}
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>

            {/* Team access sub-block — niveau d'accès par équipe (une ligne par
                équipe, sans dérouler chaque membre). */}
            {projectTeams.length > 0 && (
              <>
                <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-faint)', margin: '6px 0 4px' }}>
                  {t('manage.teamAccessCount', { count: projectTeams.length })}
                </div>
                <div className="md-team">
                  {projectTeams.map((pt) => (
                    <TeamAccessRow
                      key={pt.teamId}
                      pt={pt}
                      onRoleChange={(rk) => changeTeamRole(pt.teamId, rk)}
                      onRemove={() => removeTeam(pt.teamId)}
                      options={PROJECT_ROLE_OPTIONS}
                    />
                  ))}
                </div>
              </>
            )}

            {/* Managers sub-block */}
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-faint)', margin: '12px 0 4px' }}>
              {t('manage.projectManagersCount', { count: managers.length })}
            </div>
            <div className="md-team">
              {managers.map((m) => (
                <MemberRow
                  key={m.userId}
                  member={m}
                  onRoleChange={(rk) => changeMemberRole(m.userId, rk)}
                  onRemove={() => removeMember(m.userId)}
                  onToggleSponsor={() => toggleSponsor(m.userId)}
                  options={PROJECT_ROLE_OPTIONS}
                />
              ))}
              {managers.length === 0 && (
                <div className="md-empty">
                  {accessLoadFailed ? t('manage.membersNotLoaded') : t('manage.noManagerYet')}
                </div>
              )}
            </div>

            {/* Other members sub-block */}
            <div style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase', color: 'var(--text-faint)', margin: '12px 0 4px' }}>
              {t('manage.membersCount', { count: otherMembers.length })}
            </div>
            <div className="md-team">
              {otherMembers.map((m) => (
                <MemberRow
                  key={m.userId}
                  member={m}
                  onRoleChange={(rk) => changeMemberRole(m.userId, rk)}
                  onRemove={() => removeMember(m.userId)}
                  onToggleSponsor={() => toggleSponsor(m.userId)}
                  options={PROJECT_ROLE_OPTIONS}
                />
              ))}
              {otherMembers.length === 0 && (
                <div className="md-empty">
                  {accessLoadFailed ? t('manage.membersNotLoaded') : t('manage.noContributorsYet')}
                </div>
              )}
            </div>
          </div>

          {/* Sponsors — matrice d'événements notifiés (tag isSponsor par membre
              ci-dessus ; les changements passent par Save comme le reste). */}
          <div className="md-field">
            <div className="md-label">
              {t('manage.sponsor.eventsLabel')}{' '}
              <span className="md-count">{members.filter((m) => m.isSponsor).length}</span>
            </div>
            <div className="md-hint" style={{ marginBottom: 8 }}>
              {t('manage.sponsor.eventsHint')}
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              {(
                [
                  ['milestoneReached', 'manage.sponsor.evMilestoneReached'],
                  ['projectStatus', 'manage.sponsor.evProjectStatus'],
                  ['milestoneAtRisk', 'manage.sponsor.evMilestoneAtRisk'],
                  ['budgetThresholds', 'manage.sponsor.evBudgetThresholds'],
                ] as Array<[keyof ManageDraft['sponsorNotify'], string]>
              ).map(([key, labelKey]) => (
                <label key={key} className="row" style={{ gap: 8, cursor: 'pointer', fontSize: 13 }}>
                  <input
                    type="checkbox"
                    checked={draft.sponsorNotify[key]}
                    onChange={(e) =>
                      set({ sponsorNotify: { ...draft.sponsorNotify, [key]: e.target.checked } })
                    }
                  />
                  <span>{t(labelKey)}</span>
                </label>
              ))}
            </div>
            <div className="md-span" style={{ marginTop: 6, color: 'var(--text-3)' }}>
              {t('manage.sponsor.budgetNote')}
            </div>
          </div>
          </>)}

          {/* ---- Onglet Intégrations : webhooks projet ---- */}
          {activeTab === 'integrations' && whCanManage && (
            <div className="md-field">
              <div className="md-label">{t('manage.webhooksLabel')}</div>
              <div className="md-hint" style={{ marginBottom: 8 }}>
                {t('manage.webhooksHint')}
              </div>
              <WebhooksSection
                flash={(msg, kind) => pushToast(msg, kind === 'err')}
                projectId={project.id}
              />
              {/* Espaces de collaboration : une tuile par fournisseur (logo +
                  statut + bouton). Remplace l'ancien bloc Teams en texte brut et
                  expose aussi Slack / Google Chat au niveau projet. */}
              <CollabProvisionTiles
                projectId={project.id}
                canProvision={can('project:update')}
                flash={(msg, kind) => pushToast(msg, kind === 'err')}
              />
              {/* Espaces déclarés par un outil externe : visibles même sans la
                  licence `teams-provisioning` (l'endpoint n'est pas gaté). */}
              <CollabSpacesList
                projectId={project.id}
                canManage={can('project:update')}
                flash={(msg, kind) => pushToast(msg, kind === 'err')}
              />
            </div>
          )}
        </div>

        <div className="md-foot">
          <div className="md-foot-meta" style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span>
              {(() => {
                const left = daysLeft(draft.dueDate || project.dueDate);
                if (left === null) return t('manage.noDueDate');
                return left < 0 ? t('manage.overdue', { count: -left }) : t('manage.remaining', { count: left });
              })()}
            </span>
            {canDeleteThis && (
              <button
                className="btn btn-danger btn-sm"
                onClick={() => setConfirmDelete(true)}
                disabled={saving || deleting}
                title={t('manage.deleteProjectTitle')}
              >
                {t('manage.deleteProject')}
              </button>
            )}
          </div>
          <div className="row gap2">
            <button className="btn btn-ghost" onClick={onClose} disabled={saving}>
              {tc('cancel')}
            </button>
            <button
              className="btn btn-accent"
              disabled={invalidDates || saving || !hasChange || nameInvalid || agentInvalid}
              title={
                !hasChange
                  ? t('manage.noChange')
                  : nameInvalid
                    ? t('manage.nameRequired')
                    : agentInvalid
                      ? t('manage.agents.contextRequired')
                      : ''
              }
              onClick={save}
            >
              {saving ? tc('saving') : t('manage.saveChanges')}
            </button>
          </div>
        </div>
      </div>

      {/* Confirm: permanent project deletion (DRAFT / CHARTER_REVIEW only) */}
      {confirmDelete && (
        <ConfirmDialog
          eyebrow={t('manage.confirmDeleteEyebrow')}
          title={t('manage.confirmDeleteTitle', { name: project.name })}
          confirmLabel={t('manage.confirmDeleteConfirm')}
          busyLabel={t('manage.confirmDeleteBusy')}
          busy={deleting}
          onCancel={() => !deleting && setConfirmDelete(false)}
          onConfirm={async () => {
            setDeleting(true);
            try {
              await api.deleteProject(project.id);
              pushToast(t('manage.deleted', { key: project.key }));
              onDeleted(project.id);
            } catch (e) {
              pushToast((e as Error).message, true);
              setDeleting(false);
            }
          }}
        >
          <div className="md-span">
            <Trans
              t={t}
              i18nKey="manage.confirmDeleteBody"
              values={{ status: statusLabel(t, project.status).toLowerCase() }}
              components={[<b />, <b />]}
            />
          </div>
        </ConfirmDialog>
      )}

      {/* Confirm: remove team will also remove direct members */}
      {confirmRemoveTeam && (
        <ConfirmDialog
          eyebrow={t('manage.confirmRemoveTeamEyebrow')}
          title={t('manage.confirmRemoveTeamTitle', { name: confirmRemoveTeam.teamName })}
          confirmLabel={t('manage.confirmRemoveTeamConfirm')}
          busyLabel={t('manage.confirmRemoveTeamBusy')}
          busy={confirmBusy}
          footMeta={t('manage.confirmRemoveTeamFoot', { count: confirmRemoveTeam.affected.length })}
          onCancel={() => !confirmBusy && setConfirmRemoveTeam(null)}
          onConfirm={async () => {
            const ctx = confirmRemoveTeam;
            setConfirmBusy(true);
            try {
              await commitRemoveTeam(ctx.teamId);
            } finally {
              setConfirmBusy(false);
              setConfirmRemoveTeam(null);
            }
          }}
        >
          <div className="md-span">
            <Trans
              t={t}
              i18nKey="manage.confirmRemoveTeamBody"
              count={confirmRemoveTeam.affected.length}
              values={{ count: confirmRemoveTeam.affected.length }}
              components={[<b />]}
            />
          </div>
          <div className="md-team">
            {confirmRemoveTeam.affected.map((a) => (
              <div key={a.userId} className="md-member">
                <Avatar user={avatarUser(a.user)} size={30} title={false} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="md-member-name truncate">{a.user.name}</div>
                  <div className="md-member-role truncate">{a.user.email}</div>
                </div>
                <span className="pill pill-role" style={{ flexShrink: 0 }}>
                  {a.role.name}
                </span>
              </div>
            ))}
          </div>
          <div className="md-warn">
            <Icon name="warn" size={13} /> {t('manage.cannotBeUndone')}
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
