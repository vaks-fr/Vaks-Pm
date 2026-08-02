import type {
  AllocationDto,
  AgentWorkloadDto,
  AutoplanRequestDto,
  AutoplanResultDto,
  AuthTokens,
  LoginResponse,
  MfaEnrollStartResponse,
  SsoProviderPublicDto,
  IdentityProviderDto,
  UpsertIdentityProviderDto,
  IdpTestResultDto,
  ConnectorFieldDescriptorDto,
  ConnectorProviderDescriptorDto,
  TicketingConnectorDto,
  UpsertTicketingConnectorDto,
  CollabSpaceDto,
  UpsertCollabSpaceDto,
  ConnectorTestResultDto,
  AgentDto,
  AgentRunSummaryDto,
  AgentRunsPageDto,
  TaskAgentActivityDto,
  CreateAgentDto,
  UpdateAgentDto,
  WorkspaceAgentsPageDto,
  WorkspaceAgentDetailDto,
  AgentConnectorDto,
  UpsertAgentConnectorDto,
  AgentSyncResultDto,
  AgentTrustIssuerDto,
  AgentCredentialDto,
  ActiveSessionDto,
  PasswordPolicyDto,
  TeamDto,
  TeamWithMembersDto,
  BoardDto,
  CreateAllocationDto,
  CreateColumnDto,
  CreateDependencyDto,
  CreateLabelDto,
  CreateTaskDto,
  CreateTimeOffDto,
  DependencyDto,
  GanttDto,
  LabelDto,
  ListTasksQuery,
  LoginDto,
  MoveTaskDto,
  MyTasksDto,
  DashboardDto,
  ProjectDto,
  DocumentTemplateDto,
  DocumentTemplateKind,
  ProjectCharterDto,
  ProjectDocumentDto,
  ProjectDocumentFolderDto,
  AgentContextPreviewDto,
  ProjectCreationCapabilitiesDto,
  UpsertProjectCharterDto,
  UpdateProjectDto,
  ProjectMemberDto,
  ProjectRatesDto,
  ProjectBudgetSummaryDto,
  SetProjectRateBody,
  UpdateProjectBudgetBody,
  RestampRatesBody,
  RestampRatesResultDto,
  ProjectExpenseDto,
  CreateProjectExpenseBody,
  UpdateProjectExpenseBody,
  PortfolioFinanceDto,
  PortfolioFinanceQuery,
  ProjectEvmDto,
  ProjectCfdDto,
  ProjectQualityDto,
  ProjectAgentReportDto,
  ProjectAgentRatesDto,
  TeamReportDto,
  TeamKpiDto,
  ProjectByTeamDto,
  PortfolioKpiDto,
  ReorderColumnsDto,
  TaskDto,
  TimeOffDto,
  UpdateAllocationDto,
  UpdateColumnDto,
  UpdateDependencyDto,
  UpdateLabelDto,
  UpdateTaskDto,
  UpdateTimeOffDto,
  UpsertWorkScheduleDto,
  UserDto,
  WorkScheduleDto,
  WebhookDto,
  WebhookCreateDto,
  WebhookUpdateDto,
  WebhookDeliveryDto,
  AuditLogListQuery,
  AuditLogListResponse,
  WorkloadGridDto,
  PlanStatusDto,
  OrgSettingsDto,
  CreateUserDto,
  UpdateUserDto,
  UserDirectoryPageDto,
  UserImportResultDto,
  RoleDto,
  ClientDto,
  ClientImportResultDto,
  ClientListDto,
  ContactDto,
  CreateClientDto,
  UpdateClientDto,
  CreateContactDto,
  UpdateContactDto,
  CommentDto,
  SkillDto,
  CreateSkillDto,
  UpdateSkillDto,
  SkillPackSummaryDto,
  ApplySkillPackResultDto,
  RemoveSkillPackResultDto,
  CreateSkillPackDto,
  PackScopeTeamDto,
  TaskRequiredSkillDto,
  SkillGapRowDto,
  BulkImportUserSkillsResult,
  SkillRequestSummaryDto,
  UserSkillDto,
  ProjectSkillDto,
  TeamSkillDto,
  AvailableSkillsDto,
  CreateSkillRequestDto,
  SkillRequestDto,
  SkillRequestStatus,
  AssigneeSuggestionDto,
  CreateCommentDto,
  WatcherDto,
  WatchingEntryDto,
  RecurringTaskDto,
  UpsertRecurrenceDto,
  CustomFieldDefinitionDto,
  CustomFieldValueDto,
  CustomFieldCapabilitiesDto,
  CustomFieldEntity,
  CreateCustomFieldDto,
  UpdateCustomFieldDto,
  UpsertCustomFieldValuesDto,
  CustomStatusDto,
  CustomStatusCapabilitiesDto,
  CreateCustomStatusDto,
  UpdateCustomStatusDto,
  DeliverableDto,
  CreateDeliverableDto,
  ReviewDeliverableDto,
  TimeEntryDto,
  CreateTimeEntryDto,
  UpdateTimeEntryDto,
  AttachmentDto,
  ProjectStatsDto,
  BurndownReportDto,
  DueAdherenceDto,
  TimeBreakdownDto,
  TasksInWindowReportDto,
  ReportWidgetPreferenceDto,
  TimesheetDto,
  ExternalTaskDto,
  ProjectTeamDto,
  LicenseStatusDto,
  LicenseHistoryRowDto,
} from '@vaks-pm/shared';

import { newMutationId, trackPendingMutation } from '../realtime/store';
import i18n from 'i18next';
import { DEMO } from '../demo/config';

export interface EmailDeliveryDto {
  id: string;
  toAddress: string;
  subject: string;
  template: string;
  status: 'QUEUED' | 'SENT' | 'FAILED' | 'SKIPPED';
  error: string | null;
  queuedAt: string;
  sentAt: string | null;
}

export interface EmailDeliveryPage {
  items: EmailDeliveryDto[];
  /** null = plus de page. */
  nextCursor: string | null;
  /** Répartition par statut sur toute la fenêtre de rétention, pas sur la page. */
  counts: Record<string, number>;
  retentionDays: number;
}

export interface ApiTokenDto {
  id: string;
  type: 'USER' | 'ORG';
  name: string;
  prefix: string;
  scopes: string[];
  lastUsedAt: string | null;
  expiresAt: string | null;
  revoked: boolean;
  createdAt: string;
}
export interface ApiTokenCreateBody {
  name: string;
  scopes?: string[];
  expiresAt?: string | null;
}
/** Réponse de création : le secret en clair n'est renvoyé qu'ICI, une seule fois. */
export interface ApiTokenCreated {
  id: string;
  token: string;
  prefix: string;
}

/** Préférences notif par user (#14). `null` = hériter du défaut org. */
export interface UserNotificationPrefsDto {
  assignment: boolean | null;
  mention: boolean | null;
  dueReminder: boolean | null;
  statusChange: boolean | null;
}

export const BASE = '/api/v1';

const ACCESS_KEY = 'accessToken';
const REFRESH_KEY = 'refreshToken';

let accessToken: string | null = null;
let refreshToken: string | null = null;

/** Pose access + refresh ensemble. Persiste en localStorage (best-effort).
 *  Passer `(null, null)` pour purger. */
export const setTokens = (access: string | null, refresh: string | null): void => {
  accessToken = access;
  refreshToken = refresh;
  try {
    if (access) localStorage.setItem(ACCESS_KEY, access);
    else localStorage.removeItem(ACCESS_KEY);
    if (refresh) localStorage.setItem(REFRESH_KEY, refresh);
    else localStorage.removeItem(REFRESH_KEY);
  } catch {
    // ignore (private mode)
  }
};

/** Compat : conservé pour les appels qui ne posent que l'access (boot avec
 *  un seul token connu, ou reset). */
export const setAccessToken = (t: string | null): void => {
  if (t === null) setTokens(null, null);
  else setTokens(t, refreshToken);
};
export const getAccessToken = (): string | null => accessToken;
export const getRefreshToken = (): string | null => refreshToken;

function authHeader(): Record<string, string> {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}

/** Erreur HTTP enrichie du corps JSON et du statut, pour que les appelants
 *  puissent réagir à un payload structuré (ex. `code: 'PREDECESSORS_NOT_DONE'`)
 *  sans re-parser la réponse. */
export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function extractError(res: Response): Promise<Error> {
  const body = await res.json().catch(() => ({}));
  const msg = Array.isArray(body?.message) ? body.message.join(', ') : body?.message;
  return new ApiError(msg ?? `Erreur ${res.status}`, res.status, body);
}

// Refresh single-flight : si plusieurs requêtes prennent 401 en même temps,
// on ne déclenche qu'UN appel /auth/refresh, toutes les autres attendent son
// résultat puis rejouent leur requête initiale.
let refreshInFlight: Promise<boolean> | null = null;

async function tryRefresh(): Promise<boolean> {
  // Démo : jamais de 401 (le faux backend renvoie toujours 200) → pas de refresh.
  if (DEMO) return false;
  if (!refreshToken) return false;
  if (refreshInFlight) return refreshInFlight;
  const current = refreshToken;
  refreshInFlight = (async () => {
    try {
      const res = await fetch(`${BASE}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: current }),
      });
      if (!res.ok) return false;
      const body = (await res.json()) as { accessToken: string; refreshToken: string };
      setTokens(body.accessToken, body.refreshToken);
      return true;
    } catch {
      return false;
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
}

// JWT expirés et refresh KO ⇒ on purge tout et on renvoie vers /login. Sans
// ça, chaque composant masque l'erreur dans son .catch() et l'UI affiche
// silencieusement des listes vides.
function handleUnauthorized(): void {
  if (accessToken === null && !localStorage.getItem(ACCESS_KEY)) return;
  setTokens(null, null);
  if (typeof window !== 'undefined' && window.location.pathname !== '/login') {
    window.location.assign('/login');
  }
}

/** Wrap fetch: on 401 sur une route protégée, tente UN refresh puis rejoue.
 *  `baseHeaders` est pré-calculé (mutation-id figé) ; seul l'Authorization
 *  est recalculé après refresh pour porter le nouvel access token. */
async function fetchWithRefresh(
  path: string,
  init: RequestInit,
  baseHeaders: Record<string, string>,
): Promise<Response> {
  // Démo statique : tout appel réseau est servi par le faux backend en mémoire.
  // Import dynamique → le code démo reste hors du bundle prod (DEMO=false).
  if (DEMO) {
    const { demoHandler } = await import('../demo/handler');
    return demoHandler(path, init);
  }
  const url = `${BASE}${path}`;
  // Carry the current UI language on every request so the server localizes
  // error messages (and exports) accordingly. baseHeaders/authHeader can override.
  const acceptLang = (i18n.language || 'en').slice(0, 2).toLowerCase();
  const go = () =>
    fetch(url, { ...init, headers: { 'Accept-Language': acceptLang, ...baseHeaders, ...authHeader() } });
  let res = await go();
  if (res.status === 401 && refreshToken && path !== '/auth/refresh' && path !== '/auth/login') {
    if (await tryRefresh()) {
      res = await go();
    }
  }
  return res;
}

function mutationHeader(method: string | undefined): Record<string, string> {
  const m = (method ?? 'GET').toUpperCase();
  if (m === 'GET' || m === 'HEAD' || m === 'OPTIONS') return {};
  const id = newMutationId();
  trackPendingMutation(id);
  return { 'X-Client-Mutation-Id': id };
}

export async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const baseHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...mutationHeader(options.method),
    ...((options.headers ?? {}) as Record<string, string>),
  };
  const res = await fetchWithRefresh(path, options, baseHeaders);
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) throw await extractError(res);
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

/** POST a multipart/form-data file. Returns the parsed JSON response. */
export async function multipartUpload<T>(path: string, file: File): Promise<T> {
  const fd = new FormData();
  fd.append('file', file);
  const baseHeaders: Record<string, string> = { ...mutationHeader('POST') };
  const res = await fetchWithRefresh(path, { method: 'POST', body: fd }, baseHeaders);
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) throw await extractError(res);
  return (await res.json()) as T;
}

/** GET a binary file. Returns the blob + filename parsed from Content-Disposition. */
export async function downloadFile(
  path: string,
  fallbackName: string,
): Promise<{ blob: Blob; filename: string }> {
  // Carry the current UI language so server-rendered exports (CSV/XLSX/PDF
  // report labels) come back localized. Sent as a header — NOT a query param —
  // so it never trips the global ValidationPipe (forbidNonWhitelisted) on
  // endpoints whose query is bound to a DTO. Harmless on endpoints that ignore it.
  const lang = (i18n.language || 'en').slice(0, 2).toLowerCase();
  const res = await fetchWithRefresh(path, { method: 'GET' }, { 'Accept-Language': lang });
  if (res.status === 401) handleUnauthorized();
  if (!res.ok) throw await extractError(res);
  const cd = res.headers.get('Content-Disposition') ?? '';
  const m = /filename="([^"]+)"/.exec(cd);
  return { blob: await res.blob(), filename: m?.[1] ?? fallbackName };
}

/** Trigger a browser download for an already-fetched blob. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function qs(params: Record<string, unknown> = {}): string {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null) continue;
    if (Array.isArray(v)) usp.set(k, v.join(','));
    else usp.set(k, String(v));
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/** État des clés de chiffrement (DORA) renvoyé par /admin/crypto/status. */
export interface CryptoStatusDto {
  /** KEK active (ref préfixée par provider : `v1`/`env` = local, `kms:…`, `hsm:…`). */
  activeKek: string;
  deks: { dekRef: string; kekRef: string; status: string; createdAt: string }[];
  /** Nombre de DEK par KEK (clé = kekRef). */
  kekDistribution: Record<string, number>;
}

/** Connecteur CI signataire (vérification des livrables agents — phase C). */
export interface CiConnectorDto {
  id: string;
  provider: string;
  label: string;
  enabled: boolean;
  secretConfigured: boolean;
  lastEventAt: string | null;
  lastEventOk: boolean | null;
  lastEventError: string | null;
  createdAt: string;
  updatedAt: string;
}
export interface UpsertCiConnectorPayload {
  provider?: string;
  label?: string;
  enabled?: boolean;
  secret?: string;
}

// ---- documents externes (sources de fichiers : SharePoint, …) ----
export interface ContextSourceAvailability {
  source: string;
  label: string;
  available: boolean;
  reason?: string;
}
export interface ContextFileEntry {
  id: string;
  name: string;
  isFolder: boolean;
  size?: number;
  mimeType?: string;
  lastModified?: string;
  webUrl?: string;
}
export interface ContextFileList {
  source: string;
  items: ContextFileEntry[];
  nextCursor?: string | null;
}
export interface ContextFileContent {
  source: string;
  document: ContextFileEntry;
  truncated: boolean;
  content: string;
}

/** Champ de config d'une source de fichiers (+ visibilité conditionnelle). */
export interface FileSourceFieldDto extends ConnectorFieldDescriptorDto {
  /** Champ rendu seulement si `config[field] === equals` (fallback sur le défaut). */
  showIf?: { field: string; equals: string };
}
/** Descripteur d'un type de source de fichiers (`.../providers`). */
export interface FileSourceProviderDto extends Omit<ConnectorProviderDescriptorDto, 'fields'> {
  fields: FileSourceFieldDto[];
  /** Source dont les credentials viennent d'ailleurs (SharePoint ← identité Teams). */
  managedElsewhere?: boolean;
}
/** Connecteur de source de fichiers autonome configuré (jamais de secret en clair). */
export interface FileSourceConnectorDto {
  id: string;
  source: string;
  label: string;
  enabled: boolean;
  config: Record<string, unknown>;
  secretsConfigured: string[];
  lastTestAt: string | null;
  lastTestOk: boolean | null;
  createdAt: string;
  updatedAt: string;
}
export interface UpsertFileSourceConnectorDto {
  source?: string;
  label?: string;
  enabled?: boolean;
  config?: Record<string, unknown>;
  secrets?: Record<string, string>;
}

export const api = {
  // ---- auth ----
  login: (dto: LoginDto) =>
    request<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify(dto) }),
  loginMfa: (dto: { challengeToken: string; code: string }) =>
    request<AuthTokens>('/auth/login/mfa', { method: 'POST', body: JSON.stringify(dto) }),
  refresh: (refreshToken: string) =>
    request<AuthTokens>('/auth/refresh', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),
  logout: (refreshToken: string) =>
    request<void>('/auth/logout', {
      method: 'POST',
      body: JSON.stringify({ refreshToken }),
    }),
  me: () => request<UserDto>('/auth/me'),
  changePassword: (currentPassword: string, newPassword: string) =>
    request<void>('/auth/change-password', {
      method: 'POST',
      body: JSON.stringify({ currentPassword, newPassword }),
    }),
  getPasswordPolicy: () => request<PasswordPolicyDto>('/auth/password-policy'),

  // ---- OAuth pour MCP (phase 11) : consentement après login ----
  /** Infos à afficher sur l'écran de consentement (nom du client, accès écriture). */
  oauthConsentInfo: (tx: string) =>
    request<{ clientName: string; write: boolean; finance: boolean; enabled: boolean }>(
      `/auth/oauth/consent-info?tx=${encodeURIComponent(tx)}`,
    ),
  /** Approuve/refuse une demande d'autorisation MCP en cours ; renvoie l'URL de
   *  redirection finale vers le client IA (avec le code, ou une erreur). */
  oauthConsent: (tx: string, approve: boolean) =>
    request<{ redirect: string }>('/auth/oauth/consent', {
      method: 'POST',
      body: JSON.stringify({ tx, approve }),
    }),

  // ---- Connexions IA de l'utilisateur courant (self-service) ----
  listAiConnections: () =>
    request<Array<{ connId: string; clientName: string; createdAt: number; lastUsedAt: number }>>(
      '/me/ai-connections',
    ),
  revokeAiConnection: (connId: string) =>
    request<{ revoked: boolean }>(`/me/ai-connections/${encodeURIComponent(connId)}`, {
      method: 'DELETE',
    }),

  // ---- Connexions IA org-wide (admin) ----
  listAllAiConnections: () =>
    request<
      Array<{
        connId: string;
        clientName: string;
        userId: string;
        userName: string | null;
        userEmail: string | null;
        createdAt: number;
        lastUsedAt: number;
      }>
    >('/admin/ai-connections'),
  adminRevokeAiConnection: (connId: string) =>
    request<{ revoked: boolean }>(`/admin/ai-connections/${encodeURIComponent(connId)}`, {
      method: 'DELETE',
    }),

  // ---- Clients OAuth pré-enregistrés (admin) : intégrations type Copilot Studio ----
  listOauthClients: () =>
    request<Array<{ clientId: string; clientName: string; redirectUris: string[]; createdAt: number }>>(
      '/admin/oauth-clients',
    ),
  createOauthClient: (name: string, redirectUris: string[]) =>
    request<{ client_id: string; client_secret: string; redirect_uris: string[]; client_name: string }>(
      '/admin/oauth-clients',
      { method: 'POST', body: JSON.stringify({ name, redirect_uris: redirectUris }) },
    ),
  revokeOauthClient: (clientId: string) =>
    request<{ revoked: boolean }>(`/admin/oauth-clients/${encodeURIComponent(clientId)}`, {
      method: 'DELETE',
    }),

  // ---- SSO (phase 10) ----
  /** Providers SSO activés pour ce tenant (écran de login). Public. */
  listSsoProviders: () => request<SsoProviderPublicDto[]>('/auth/sso/providers'),
  /** URL de démarrage du flow OIDC (le navigateur navigue dessus → 302 IdP). */
  ssoStartUrl: (slug: string) => `${BASE}/auth/oidc/${encodeURIComponent(slug)}/start`,
  /** URL de démarrage du flow SAML (302 AuthnRequest vers l'IdP). */
  samlLoginUrl: (slug: string) => `${BASE}/auth/saml/${encodeURIComponent(slug)}/login`,
  /** URL des métadonnées SP SAML (à fournir à l'IdP). */
  samlMetadataUrl: (slug: string) => `${BASE}/auth/saml/${encodeURIComponent(slug)}/metadata`,
  /** URL de démarrage SSO selon le type de provider. */
  ssoLoginUrl: (slug: string, type: 'OIDC' | 'SAML') =>
    type === 'SAML'
      ? `${BASE}/auth/saml/${encodeURIComponent(slug)}/login`
      : `${BASE}/auth/oidc/${encodeURIComponent(slug)}/start`,
  // ---- SSO admin (org:manage) ----
  listIdentityProviders: () =>
    request<IdentityProviderDto[]>('/admin/identity-providers'),
  createIdentityProvider: (dto: UpsertIdentityProviderDto) =>
    request<IdentityProviderDto>('/admin/identity-providers', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  updateIdentityProvider: (id: string, dto: UpsertIdentityProviderDto) =>
    request<IdentityProviderDto>(`/admin/identity-providers/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  deleteIdentityProvider: (id: string) =>
    request<void>(`/admin/identity-providers/${id}`, { method: 'DELETE' }),
  testIdentityProvider: (id: string) =>
    request<IdpTestResultDto>(`/admin/identity-providers/${id}/test`, { method: 'POST' }),

  // ---- External ticketing connectors (ServiceNow, …) ----
  listConnectorProviders: () =>
    request<ConnectorProviderDescriptorDto[]>('/admin/ticketing-connectors/providers'),
  listTicketingConnectors: () =>
    request<TicketingConnectorDto[]>('/admin/ticketing-connectors'),
  createTicketingConnector: (dto: UpsertTicketingConnectorDto) =>
    request<TicketingConnectorDto>('/admin/ticketing-connectors', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  updateTicketingConnector: (id: string, dto: UpsertTicketingConnectorDto) =>
    request<TicketingConnectorDto>(`/admin/ticketing-connectors/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  deleteTicketingConnector: (id: string) =>
    request<void>(`/admin/ticketing-connectors/${id}`, { method: 'DELETE' }),
  testTicketingConnector: (id: string) =>
    request<ConnectorTestResultDto>(`/admin/ticketing-connectors/${id}/test`, { method: 'POST' }),

  // ---- Agents IA (chantier 1 — agent:manage) ----
  listAgents: () => request<AgentDto[]>('/admin/agents'),
  /** Vue workspace : mes agents (owner + équipes que je mène), paginé. */
  getMyAgents: (page = 1, pageSize = 10) =>
    request<WorkspaceAgentsPageDto>(`/me/agents?page=${page}&pageSize=${pageSize}`),
  /** Détail d'un de mes agents (profil + compétences + usage + projets). */
  getMyAgentDetail: (id: string) => request<WorkspaceAgentDetailDto>(`/me/agents/${id}`),
  /** Owner/lead : changer le modèle de l'agent. */
  updateMyAgentModel: (id: string, model: string | null) =>
    request<WorkspaceAgentDetailDto>(`/me/agents/${id}`, {
      method: 'PATCH',
      body: JSON.stringify({ model }),
    }),
  /** Owner/lead : poser/mettre à jour une compétence. */
  setMyAgentSkill: (id: string, skillId: string, level: number) =>
    request<WorkspaceAgentDetailDto>(`/me/agents/${id}/skills/${skillId}`, {
      method: 'PUT',
      body: JSON.stringify({ level }),
    }),
  /** Owner/lead : retirer une compétence. */
  removeMyAgentSkill: (id: string, skillId: string) =>
    request<WorkspaceAgentDetailDto>(`/me/agents/${id}/skills/${skillId}`, { method: 'DELETE' }),
  listAgentCapabilities: () => request<{ key: string }[]>('/admin/agents/capabilities'),
  /** Policies de gouvernance agents — endpoint dédié gaté `agent:manage` (utilisable
   *  par l'« AI administrator » sans `org:manage`). Miroir borné de /admin/settings. */
  getAgentPolicies: () => request<Record<string, unknown>>('/admin/agents/policies'),
  putAgentPolicies: (body: Record<string, unknown>) =>
    request<Record<string, unknown>>('/admin/agents/policies', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  createAgent: (dto: CreateAgentDto) =>
    request<AgentDto>('/admin/agents', { method: 'POST', body: JSON.stringify(dto) }),
  updateAgent: (id: string, dto: UpdateAgentDto) =>
    request<AgentDto>(`/admin/agents/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  deleteAgent: (id: string) => request<void>(`/admin/agents/${id}`, { method: 'DELETE' }),
  mintAgentToken: (id: string, dto: { name?: string; expiresAt?: string | null }) =>
    request<{ id: string; token: string; prefix: string }>(`/admin/agents/${id}/tokens`, {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  revokeAgentToken: (id: string, tokenId: string) =>
    request<void>(`/admin/agents/${id}/tokens/${tokenId}`, { method: 'DELETE' }),
  // ---- Identifiants machine (refresh rotatif, agents headless) ----
  listAgentCredentials: (id: string) =>
    request<AgentCredentialDto[]>(`/admin/agents/${id}/credentials`),
  issueAgentCredential: (id: string, body: { label?: string }) =>
    request<{ id: string; chainId: string; secret: string; expiresAt: string }>(
      `/admin/agents/${id}/credentials`,
      { method: 'POST', body: JSON.stringify(body) },
    ),
  revokeAgentCredential: (id: string, credentialId: string) =>
    request<{ id: string; revoked: true }>(`/admin/agents/${id}/credentials/${credentialId}`, {
      method: 'DELETE',
    }),
  getAgentRuns: (id: string) => request<AgentRunSummaryDto>(`/admin/agents/${id}/runs`),
  /** Journal transverse des runs d'agent (Admin > Agents > Runs d'agents). */
  listAgentRuns: (q: Record<string, string | number | boolean | undefined>) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) {
      if (v !== undefined && v !== '' && v !== false) p.set(k, String(v));
    }
    const qs = p.toString();
    return request<AgentRunsPageDto>(`/admin/agent-runs${qs ? `?${qs}` : ''}`);
  },
  getTaskAgentActivity: (taskId: string) =>
    request<TaskAgentActivityDto>(`/tasks/${taskId}/agent-activity`),
  listAgentConnectorProviders: () =>
    request<{ provider: string; label: string; blurb: string; accent?: string; short?: string; fields: ConnectorProviderDescriptorDto['fields'] }[]>(
      '/admin/agent-connectors/providers',
    ),
  listAgentConnectors: () => request<AgentConnectorDto[]>('/admin/agent-connectors'),
  createAgentConnector: (dto: UpsertAgentConnectorDto) =>
    request<AgentConnectorDto>('/admin/agent-connectors', { method: 'POST', body: JSON.stringify(dto) }),
  updateAgentConnector: (id: string, dto: UpsertAgentConnectorDto) =>
    request<AgentConnectorDto>(`/admin/agent-connectors/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  deleteAgentConnector: (id: string) =>
    request<void>(`/admin/agent-connectors/${id}`, { method: 'DELETE' }),
  // ---- Clés d'enregistrement d'agents (carte inbound) : scope agent:manage ----
  // Endpoints dédiés (un « AI administrator » n'a pas org:manage) ; scopes
  // hardcodés côté serveur, révocation bornée au purpose.
  listAgentRegistrationKeys: () =>
    request<ApiTokenDto[]>('/admin/agents/registration-keys'),
  createAgentRegistrationKey: (body: { expiresAt: string; label?: string }) =>
    request<ApiTokenCreated>('/admin/agents/registration-keys', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  revokeAgentRegistrationKey: (id: string) =>
    request<void>(`/admin/agents/registration-keys/${id}`, { method: 'DELETE' }),
  // ---- Espaces de collaboration d'un projet (Teams, Slack…) ----
  listProjectCollabSpaces: (projectId: string) =>
    request<CollabSpaceDto[]>(`/projects/${projectId}/collab-spaces`),
  upsertProjectCollabSpace: (projectId: string, provider: string, dto: UpsertCollabSpaceDto) =>
    request<CollabSpaceDto>(`/projects/${projectId}/collab-spaces/${provider}`, {
      method: 'PUT',
      body: JSON.stringify(dto),
    }),
  deleteProjectCollabSpace: (projectId: string, provider: string) =>
    request<{ deleted: true }>(`/projects/${projectId}/collab-spaces/${provider}`, { method: 'DELETE' }),
  testAgentConnector: (id: string) =>
    request<ConnectorTestResultDto>(`/admin/agent-connectors/${id}/test`, { method: 'POST' }),
  syncAgentConnector: (id: string) =>
    request<AgentSyncResultDto>(`/admin/agent-connectors/${id}/sync`, { method: 'POST' }),

  // ---- Émetteurs de confiance (fédération d'identité agents, RFC 8693) ----
  listAgentTrustIssuers: () =>
    request<AgentTrustIssuerDto[]>('/admin/agent-trust-issuers'),
  createAgentTrustIssuer: (dto: Partial<AgentTrustIssuerDto> & { jwksJson?: unknown }) =>
    request<AgentTrustIssuerDto>('/admin/agent-trust-issuers', { method: 'POST', body: JSON.stringify(dto) }),
  updateAgentTrustIssuer: (id: string, dto: Partial<AgentTrustIssuerDto> & { jwksJson?: unknown }) =>
    request<AgentTrustIssuerDto>(`/admin/agent-trust-issuers/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  deleteAgentTrustIssuer: (id: string) =>
    request<{ id: string; deleted: true }>(`/admin/agent-trust-issuers/${id}`, { method: 'DELETE' }),
  testAgentTrustIssuer: (id: string) =>
    request<{ ok: boolean; keys?: number; error?: string }>(`/admin/agent-trust-issuers/${id}/test`, { method: 'POST' }),
  deriveAgentTrustIssuer: (connectorId: string) =>
    request<Partial<AgentTrustIssuerDto>>(`/admin/agent-trust-issuers/derive/${connectorId}`),

  // ---- CI verification connectors (vérification des livrables agents, phase C) ----
  listCiConnectorProviders: () =>
    request<{ id: string; label: string; signatureHeader: string }[]>('/admin/ci-connectors/providers'),
  listCiConnectors: () => request<CiConnectorDto[]>('/admin/ci-connectors'),
  createCiConnector: (dto: UpsertCiConnectorPayload) =>
    request<CiConnectorDto>('/admin/ci-connectors', { method: 'POST', body: JSON.stringify(dto) }),
  updateCiConnector: (id: string, dto: UpsertCiConnectorPayload) =>
    request<CiConnectorDto>(`/admin/ci-connectors/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  deleteCiConnector: (id: string) =>
    request<void>(`/admin/ci-connectors/${id}`, { method: 'DELETE' }),

  // ---- File source connectors (contexte documentaire des agents) ----
  listFileSourceProviders: () =>
    request<FileSourceProviderDto[]>('/admin/filesource-connectors/providers'),
  /** Connecteurs de sources de fichiers autonomes configurés (Google Drive, …). */
  listFileSourceConnectors: () =>
    request<FileSourceConnectorDto[]>('/admin/filesource-connectors'),
  createFileSourceConnector: (dto: UpsertFileSourceConnectorDto) =>
    request<FileSourceConnectorDto>('/admin/filesource-connectors', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  updateFileSourceConnector: (id: string, dto: UpsertFileSourceConnectorDto) =>
    request<FileSourceConnectorDto>(`/admin/filesource-connectors/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  deleteFileSourceConnector: (id: string) =>
    request<void>(`/admin/filesource-connectors/${id}`, { method: 'DELETE' }),
  testFileSourceConnector: (id: string) =>
    request<{ ok: boolean; detail?: string; error?: string }>(
      `/admin/filesource-connectors/${id}/test`,
      { method: 'POST' },
    ),
  /** Génère la paire de clés WIF d'un connecteur Google Drive → JWKS + issuer à coller côté Google. */
  generateFileSourceWifKey: (id: string) =>
    request<{ keyId: string; issuer: string; jwks: { keys: Record<string, unknown>[] } }>(
      `/admin/filesource-connectors/${id}/wif-key`,
      { method: 'POST' },
    ),
  testSharePointFileSource: (projectId: string) =>
    request<{ ok: boolean; message: string; siteId?: string | null; driveId?: string | null; itemCount?: number }>(
      '/admin/filesource-connectors/test-sharepoint',
      { method: 'POST', body: JSON.stringify({ projectId }) },
    ),
  /** (Re)résout le site SharePoint et pose le grant si nécessaire (bouton projet). */
  verifyProjectSharePoint: (projectId: string) =>
    request<{ status: 'GRANTED' | 'PENDING' | 'FAILED'; siteId?: string | null; driveId?: string | null; detail?: string }>(
      `/projects/${projectId}/ms-team/sharepoint/verify`,
      { method: 'POST' },
    ),

  // ---- MFA enrollment (user) ----
  mfaEnrollStart: () =>
    request<MfaEnrollStartResponse>('/auth/mfa/enroll/start', { method: 'POST' }),
  mfaEnrollVerify: (code: string) =>
    request<void>('/auth/mfa/enroll/verify', {
      method: 'POST',
      body: JSON.stringify({ code }),
    }),
  /** Enrôlement forcé (post-login, policy on, user pas encore enrollé).
   *  Le `enrollToken` vient de la réponse `/auth/login`. */
  mfaForcedEnrollStart: (enrollToken: string) =>
    request<MfaEnrollStartResponse>('/auth/mfa/forced-enroll/start', {
      method: 'POST',
      body: JSON.stringify({ enrollToken }),
    }),
  mfaForcedEnrollVerify: (enrollToken: string, code: string) =>
    request<AuthTokens>('/auth/mfa/forced-enroll/verify', {
      method: 'POST',
      body: JSON.stringify({ enrollToken, code }),
    }),
  mfaDisable: (password: string, code: string) =>
    request<void>('/auth/mfa/disable', {
      method: 'POST',
      body: JSON.stringify({ password, code }),
    }),

  // ---- admin security ----
  listActiveSessions: () =>
    request<ActiveSessionDto[]>('/admin/security/sessions'),
  revokeSession: (id: string) =>
    request<void>(`/admin/security/sessions/${id}`, { method: 'DELETE' }),
  forceLogoutAll: () =>
    request<{ revokedCount: number }>('/admin/security/force-logout-all', {
      method: 'POST',
    }),
  adminResetMfa: (userId: string) =>
    request<void>(`/admin/security/users/${userId}/mfa/reset`, { method: 'POST' }),
  /** Envoie un lien de reset de mot de passe par email à l'utilisateur (#3). */
  sendUserPasswordReset: (userId: string) =>
    request<{ sent: true }>(`/admin/security/users/${userId}/password-reset`, {
      method: 'POST',
    }),
  /** Valide un token de reset (page publique /reset-password). */
  validateResetToken: (token: string) =>
    request<{ valid: boolean; email?: string }>(
      `/auth/password-reset${qs({ token })}`,
    ),
  /** Consomme le token de reset + fixe le nouveau mot de passe (page publique). */
  consumeResetToken: (token: string, newPassword: string) =>
    request<{ ok: true }>('/auth/password-reset', {
      method: 'POST',
      body: JSON.stringify({ token, newPassword }),
    }),
  setUserBreakGlass: (userId: string, enabled: boolean) =>
    request<{ id: string; allowLocalLogin: boolean; setupLinkSent?: boolean; passwordSetupNeeded?: boolean }>(
      `/admin/security/users/${userId}/break-glass`,
      { method: 'POST', body: JSON.stringify({ enabled }) },
    ),

  // ---- users ----
  listUsers: (opts?: { includeAgents?: boolean }) =>
    request<UserDto[]>(`/users${opts?.includeAgents ? '?includeAgents=1' : ''}`),
  /** Annuaire admin paginé : search/status/role + schedules batchés (kill N+1). */
  listUsersDirectory: (q: {
    search?: string;
    status?: 'ACTIVE' | 'SUSPENDED';
    role?: string;
    page?: number;
    pageSize?: number;
    includeSchedule?: boolean;
  } = {}) =>
    request<UserDirectoryPageDto>(
      `/users/directory${qs({
        search: q.search || undefined,
        status: q.status,
        role: q.role,
        page: q.page,
        pageSize: q.pageSize,
        includeSchedule: q.includeSchedule === false ? '0' : undefined,
      })}`,
    ),
  createUser: (dto: CreateUserDto) =>
    request<UserDto>('/users', { method: 'POST', body: JSON.stringify(dto) }),
  updateUser: (id: string, dto: UpdateUserDto) =>
    request<UserDto>(`/users/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  deleteUser: (id: string) => request<UserDto>(`/users/${id}`, { method: 'DELETE' }),
  /** Déverrouille un compte bloqué par le lockout anti-brute-force. */
  unlockUser: (id: string) =>
    request<UserDto & { wasLocked: boolean }>(`/users/${id}/unlock`, {
      method: 'POST',
    }),
  /** RGPD — pseudonymisation irréversible (aucune suppression de ligne). */
  anonymizeUser: (id: string) =>
    request<{ id: string; anonymized: boolean; alreadyAnonymized: boolean }>(
      `/users/${id}/anonymize`,
      { method: 'POST' },
    ),
  /** RGPD — export portabilité des données d'un user (variante admin). */
  exportUserData: (id: string) => request<unknown>(`/users/${id}/export`),
  /** RGPD — export portabilité de MES propres données (self-service). */
  exportMyData: () => request<unknown>('/me/export'),
  /** Import CSV. commit=false (défaut) → dry-run (prévisualisation sans écriture). */
  importUsers: (csv: string, commit = false) =>
    request<UserImportResultDto>('/users/import', {
      method: 'POST',
      body: JSON.stringify({ csv, commit }),
    }),

  // ---- projects ----
  listProjects: (scope?: 'mine' | 'all') =>
    request<ProjectDto[]>('/projects' + (scope ? `?scope=${scope}` : '')),
  getProject: (id: string) => request<ProjectDto>(`/projects/${id}`),
  createProject: (dto: {
    key: string;
    name: string;
    description?: string;
    clientId?: string | null;
    teamIds?: string[];
    billable?: boolean;
  }) => request<ProjectDto>('/projects', { method: 'POST', body: JSON.stringify(dto) }),
  copyProject: (
    sourceId: string,
    dto: {
      key: string;
      name: string;
      description?: string;
      clientId?: string | null;
      teamIds?: string[];
      billable?: boolean;
    },
  ) =>
    request<ProjectDto>(`/projects/${sourceId}/copy`, {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  getProjectCreationCapabilities: () =>
    request<ProjectCreationCapabilitiesDto>('/projects/creation-policy/me'),
  updateProject: (id: string, dto: UpdateProjectDto) =>
    request<ProjectDto>(`/projects/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  deleteProject: (id: string) =>
    request<{ id: string; deleted: true }>(`/projects/${id}`, { method: 'DELETE' }),

  // ---- étape commerciale « offre » (projets facturables) ----
  /** Marque l'offre comme envoyée (DRAFT → OFFER_SENT) sans email. */
  sendOffer: (projectId: string) =>
    request<ProjectDto & { noOfferDocument?: boolean }>(
      `/projects/${projectId}/offer/send`,
      { method: 'POST' },
    ),
  /** Envoie l'offre par email au client (PJ = document OFFER) + passe en OFFER_SENT. */
  emailOffer: (projectId: string, intro?: string) =>
    request<ProjectDto & { sentTo: string; deliveryId: string }>(
      `/projects/${projectId}/offer/email`,
      { method: 'POST', body: JSON.stringify(intro ? { intro } : {}) },
    ),
  /** OFFER_SENT → CHARTER_REVIEW : le client a accepté l'offre. */
  acceptOffer: (projectId: string) =>
    request<ProjectDto>(`/projects/${projectId}/offer/accept`, { method: 'POST' }),
  /** OFFER_SENT → DRAFT : le client a refusé l'offre (compteur++ + raison). */
  refuseOffer: (projectId: string, reason?: string) =>
    request<ProjectDto>(`/projects/${projectId}/offer/refuse`, {
      method: 'POST',
      body: JSON.stringify(reason ? { reason } : {}),
    }),

  // ---- project charter (initiation) ----
  getProjectCharter: (projectId: string) =>
    request<ProjectCharterDto>(`/projects/${projectId}/charter`),
  upsertProjectCharter: (projectId: string, patch: UpsertProjectCharterDto) =>
    request<ProjectCharterDto>(`/projects/${projectId}/charter`, {
      method: 'PUT',
      body: JSON.stringify(patch),
    }),
  // ---- document templates (admin) ----
  listDocumentTemplates: () =>
    request<DocumentTemplateDto[]>('/admin/document-templates'),
  uploadDocumentTemplate: (kind: DocumentTemplateKind, file: File) =>
    multipartUpload<DocumentTemplateDto>(`/admin/document-templates/${kind}`, file),
  downloadDocumentTemplate: (kind: DocumentTemplateKind) =>
    downloadFile(`/admin/document-templates/${kind}/file`, `template-${kind}.docx`),
  resetDocumentTemplate: (kind: DocumentTemplateKind) =>
    request<{ kind: string; removed: boolean }>(
      `/admin/document-templates/${kind}`,
      { method: 'DELETE' },
    ),

  downloadCharterDocx: (projectId: string) =>
    downloadFile(`/projects/${projectId}/charter.docx`, `charter-${projectId}.docx`),
  downloadSignedCharter: (projectId: string) =>
    downloadFile(
      `/projects/${projectId}/charter/signed-document`,
      `signed-charter-${projectId}`,
    ),
  uploadSignedCharter: (projectId: string, file: File) =>
    multipartUpload<ProjectCharterDto>(
      `/projects/${projectId}/charter/signed-document`,
      file,
    ),

  // ---- project documents (offres / propositions) ----
  listProjectDocuments: (projectId: string) =>
    request<ProjectDocumentDto[]>(`/projects/${projectId}/documents`),
  uploadProjectDocument: (
    projectId: string,
    file: File,
    kind: 'OFFER' | 'OTHER' = 'OFFER',
    opts?: { folderId?: string | null; aiContext?: boolean },
  ) => {
    const qs = new URLSearchParams({ kind });
    if (opts?.folderId) qs.set('folderId', opts.folderId);
    if (opts?.aiContext) qs.set('aiContext', '1');
    return multipartUpload<ProjectDocumentDto>(`/projects/${projectId}/documents?${qs}`, file);
  },
  updateProjectDocument: (
    projectId: string,
    docId: string,
    dto: { folderId?: string | null; aiContext?: boolean },
  ) =>
    request<ProjectDocumentDto>(`/projects/${projectId}/documents/${docId}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  downloadProjectDocument: (projectId: string, docId: string, filename: string) =>
    downloadFile(`/projects/${projectId}/documents/${docId}/download`, filename),
  deleteProjectDocument: (projectId: string, docId: string) =>
    request(`/projects/${projectId}/documents/${docId}`, { method: 'DELETE' }),

  // ---- project document folders (espace documents) ----
  listProjectFolders: (projectId: string) =>
    request<ProjectDocumentFolderDto[]>(`/projects/${projectId}/folders`),
  createProjectFolder: (
    projectId: string,
    dto: { name: string; parentId?: string | null; aiContext?: boolean },
  ) =>
    request<ProjectDocumentFolderDto>(`/projects/${projectId}/folders`, {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  updateProjectFolder: (
    projectId: string,
    folderId: string,
    dto: { name?: string; parentId?: string | null; aiContext?: boolean },
  ) =>
    request<ProjectDocumentFolderDto>(`/projects/${projectId}/folders/${folderId}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  deleteProjectFolder: (projectId: string, folderId: string) =>
    request<{ removed: true }>(`/projects/${projectId}/folders/${folderId}`, { method: 'DELETE' }),

  /**
   * « Ce que voient les agents » : le pack de contexte exact, composé par le
   * MÊME code que le work-context servi aux agents. App-privé (jamais un jeton).
   */
  getAgentContextPreview: (projectId: string) =>
    request<AgentContextPreviewDto>(`/projects/${projectId}/agent-context-preview`),

  // ---- documents externes (SharePoint de la team provisionnée) — lecture seule ----
  projectContextSources: (projectId: string) =>
    request<ContextSourceAvailability[]>(`/projects/${projectId}/context-files/availability`),
  listProjectContextFiles: (
    projectId: string,
    opts: { source?: string; folderId?: string; cursor?: string } = {},
  ) => {
    const qs = new URLSearchParams();
    qs.set('source', opts.source ?? 'sharepoint');
    if (opts.folderId) qs.set('folderId', opts.folderId);
    if (opts.cursor) qs.set('cursor', opts.cursor);
    return request<ContextFileList>(`/projects/${projectId}/context-files?${qs}`);
  },
  getProjectContextFile: (projectId: string, source: string, itemId: string) =>
    request<ContextFileContent>(
      `/projects/${projectId}/context-files/${encodeURIComponent(source)}/${encodeURIComponent(itemId)}`,
    ),

  // ---- project teams ----
  listProjectTeams: (projectId: string) =>
    request<ProjectTeamDto[]>(`/projects/${projectId}/teams`),

  // ---- finance : taux & budget projet (gardé finance:view / finance:manage) ----
  getProjectRates: (projectId: string) =>
    request<ProjectRatesDto>(`/projects/${projectId}/rates`),
  getProjectBudgetSummary: (projectId: string) =>
    request<ProjectBudgetSummaryDto>(`/projects/${projectId}/budget-summary`),
  getProjectEvm: (projectId: string) =>
    request<ProjectEvmDto>(`/projects/${projectId}/evm`),
  getProjectCfd: (projectId: string, opts: { from?: string; to?: string; granularity?: 'day' | 'week' } = {}) => {
    const qs = new URLSearchParams();
    if (opts.from) qs.set('from', opts.from);
    if (opts.to) qs.set('to', opts.to);
    if (opts.granularity) qs.set('granularity', opts.granularity);
    const q = qs.toString();
    return request<ProjectCfdDto>(`/projects/${projectId}/cfd` + (q ? '?' + q : ''));
  },
  getProjectQuality: (projectId: string) =>
    request<ProjectQualityDto>(`/projects/${projectId}/quality`),
  getProjectAgentReport: (projectId: string, from: string, to: string) =>
    request<ProjectAgentReportDto>(`/projects/${projectId}/agents-report?from=${from}&to=${to}`),
  getAgentRates: (projectId: string) =>
    request<ProjectAgentRatesDto>(`/projects/${projectId}/agent-rates`),
  setAgentRate: (projectId: string, agentId: string, body: { billRatePerKTokens: number }) =>
    request<ProjectAgentRatesDto>(`/projects/${projectId}/agent-rates/${agentId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteAgentRate: (projectId: string, agentId: string) =>
    request<ProjectAgentRatesDto>(`/projects/${projectId}/agent-rates/${agentId}`, {
      method: 'DELETE',
    }),
  getTeamReport: (teamId: string, from: string, to: string) =>
    request<TeamReportDto>(`/teams/${teamId}/report?from=${from}&to=${to}`),
  getTeamKpi: (teamId: string, from: string, to: string) =>
    request<TeamKpiDto>(`/teams/${teamId}/kpi?from=${from}&to=${to}`),
  setProjectRate: (projectId: string, userId: string, body: SetProjectRateBody) =>
    request<ProjectRatesDto>(`/projects/${projectId}/rates/${userId}`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  deleteProjectRate: (projectId: string, userId: string) =>
    request<ProjectRatesDto>(`/projects/${projectId}/rates/${userId}`, {
      method: 'DELETE',
    }),
  updateProjectBudget: (projectId: string, body: UpdateProjectBudgetBody) =>
    request<ProjectRatesDto>(`/projects/${projectId}/budget`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  restampProjectRates: (projectId: string, body: RestampRatesBody = {}) =>
    request<RestampRatesResultDto>(`/projects/${projectId}/rates/restamp`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),

  // ---- finance : coûts hors main-d'œuvre (licence, matériel, cloud, sous-traitance) ----
  listProjectExpenses: (projectId: string) =>
    request<ProjectExpenseDto[]>(`/projects/${projectId}/expenses`),
  createProjectExpense: (projectId: string, body: CreateProjectExpenseBody) =>
    request<ProjectExpenseDto>(`/projects/${projectId}/expenses`, {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  updateProjectExpense: (projectId: string, expenseId: string, body: UpdateProjectExpenseBody) =>
    request<ProjectExpenseDto>(`/projects/${projectId}/expenses/${expenseId}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteProjectExpense: (projectId: string, expenseId: string) =>
    request<{ id: string; deleted: true }>(`/projects/${projectId}/expenses/${expenseId}`, {
      method: 'DELETE',
    }),

  // ---- finance portefeuille (agrégée par client, gardé finance:view) ----
  getPortfolioFinance: (opts: PortfolioFinanceQuery = {}) => {
    const qs = new URLSearchParams();
    if (opts.granularity) qs.set('granularity', opts.granularity);
    if (opts.offset != null) qs.set('offset', String(opts.offset));
    if (opts.clientId) qs.set('clientId', opts.clientId);
    const q = qs.toString();
    return request<PortfolioFinanceDto>('/finance/portfolio' + (q ? '?' + q : ''));
  },
  getPortfolioKpi: (opts: { from?: string; to?: string; teamId?: string } = {}) =>
    request<PortfolioKpiDto>(`/reports/portfolio-kpi${qs(opts)}`),

  /**
   * Export facturation (timesheet ligne à ligne, tickets externes inclus) —
   * gardé `finance:view`, app-privé. Télécharge CSV ou XLSX.
   */
  downloadBillingExport: async (
    format: 'csv' | 'xlsx',
    opts: { from: string; to: string; clientId?: string; projectId?: string; billableOnly?: boolean },
  ) => {
    const p = new URLSearchParams();
    p.set('from', opts.from);
    p.set('to', opts.to);
    if (opts.clientId) p.set('clientId', opts.clientId);
    if (opts.projectId) p.set('projectId', opts.projectId);
    if (opts.billableOnly) p.set('billableOnly', 'true');
    const { blob, filename } = await downloadFile(
      `/finance/billing-export.${format}?${p.toString()}`,
      `billing-${opts.from}_${opts.to}.${format}`,
    );
    saveBlob(blob, filename);
  },

  // ---- project managers (admin) ----
  listProjectMembers: (projectId: string) =>
    request<ProjectMemberDto[]>(`/projects/${projectId}/members`),
  addProjectManager: (projectId: string, userId: string) =>
    request<ProjectMemberDto>(`/projects/${projectId}/managers`, {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  removeProjectManager: (projectId: string, userId: string) =>
    request(`/projects/${projectId}/managers/${userId}`, { method: 'DELETE' }),
  addProjectMember: (projectId: string, userId: string, roleKey: string) =>
    request<ProjectMemberDto>(`/projects/${projectId}/members`, {
      method: 'POST',
      body: JSON.stringify({ userId, roleKey }),
    }),
  removeProjectMember: (projectId: string, userId: string) =>
    request(`/projects/${projectId}/members/${userId}`, { method: 'DELETE' }),
  updateProjectMember: (projectId: string, userId: string, dto: { isSponsor?: boolean }) =>
    request<ProjectMemberDto>(`/projects/${projectId}/members/${userId}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  globalSearch: (q: string) =>
    request<GlobalSearchResults>(`/search?q=${encodeURIComponent(q)}`),
  addProjectTeam: (projectId: string, teamId: string, roleKey = 'CONTRIBUTOR') =>
    request(`/projects/${projectId}/teams`, {
      method: 'POST',
      body: JSON.stringify({ teamId, roleKey }),
    }),
  setProjectTeamRole: (projectId: string, teamId: string, roleKey: string) =>
    request(`/projects/${projectId}/teams/${teamId}`, {
      method: 'PATCH',
      body: JSON.stringify({ roleKey }),
    }),
  removeProjectTeam: (projectId: string, teamId: string, opts?: { removeMembers?: boolean }) =>
    request<{ projectId: string; teamId: string; removed: true; membersRemoved: number }>(
      `/projects/${projectId}/teams/${teamId}${opts?.removeMembers ? '?removeMembers=1' : ''}`,
      { method: 'DELETE' },
    ),
  listProjectCandidates: (projectId: string) =>
    request<Array<{ id: string; name: string; email: string }>>(`/projects/${projectId}/candidates`),

  // ---- board / columns ----
  getBoard: (projectId: string) => request<BoardDto>(`/projects/${projectId}/board`),
  createColumn: (projectId: string, dto: CreateColumnDto) =>
    request(`/projects/${projectId}/board/columns`, {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  updateColumn: (projectId: string, columnId: string, dto: UpdateColumnDto) =>
    request(`/projects/${projectId}/board/columns/${columnId}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  deleteColumn: (projectId: string, columnId: string) =>
    request(`/projects/${projectId}/board/columns/${columnId}`, { method: 'DELETE' }),
  reorderColumns: (projectId: string, dto: ReorderColumnsDto) =>
    request<BoardDto>(`/projects/${projectId}/board/columns/reorder`, {
      method: 'POST',
      body: JSON.stringify(dto),
    }),

  // ---- tasks ----
  listTasks: (projectId: string, query: Omit<ListTasksQuery, 'projectId'> = {}) =>
    request<TaskDto[]>(`/projects/${projectId}/tasks${qs(query)}`),
  getTask: (taskId: string) => request<TaskDto>(`/tasks/${taskId}`),
  /** Board inter-projet « Mes tâches » (toutes mes tâches sur projets ACTIVE). */
  myTasks: () => request<MyTasksDto>('/me/tasks'),
  /** Dashboard personnel (agrégat d'accueil : tâches, stats, activité équipe). */
  dashboard: () => request<DashboardDto>('/me/dashboard'),
  createTask: (projectId: string, dto: CreateTaskDto) =>
    request<TaskDto>(`/projects/${projectId}/tasks`, {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  updateTask: (taskId: string, dto: UpdateTaskDto) =>
    request<TaskDto>(`/tasks/${taskId}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  moveTask: (taskId: string, dto: MoveTaskDto) =>
    request<TaskDto>(`/tasks/${taskId}/move`, { method: 'POST', body: JSON.stringify(dto) }),
  deleteTask: (taskId: string) => request(`/tasks/${taskId}`, { method: 'DELETE' }),

  // ---- watchers (abonnement passif : suivre sans être assigné) ----
  watchTask: (taskId: string) =>
    request<{ watching: boolean }>(`/tasks/${taskId}/watch`, { method: 'POST' }),
  unwatchTask: (taskId: string) =>
    request<{ watching: boolean }>(`/tasks/${taskId}/watch`, { method: 'DELETE' }),
  listTaskWatchers: (taskId: string) =>
    request<WatcherDto[]>(`/tasks/${taskId}/watchers`),
  watchProject: (projectId: string) =>
    request<{ watching: boolean }>(`/projects/${projectId}/watch`, { method: 'POST' }),
  unwatchProject: (projectId: string) =>
    request<{ watching: boolean }>(`/projects/${projectId}/watch`, { method: 'DELETE' }),
  listProjectWatchers: (projectId: string) =>
    request<WatcherDto[]>(`/projects/${projectId}/watchers`),
  listMyWatching: () => request<WatchingEntryDto[]>('/me/watching'),

  // ---- récurrence de tâche ----
  getRecurrence: (taskId: string) =>
    request<RecurringTaskDto | null>(`/tasks/${taskId}/recurrence`),
  upsertRecurrence: (taskId: string, dto: UpsertRecurrenceDto) =>
    request<RecurringTaskDto>(`/tasks/${taskId}/recurrence`, {
      method: 'PUT',
      body: JSON.stringify(dto),
    }),
  deleteRecurrence: (taskId: string) =>
    request<{ removed: boolean }>(`/tasks/${taskId}/recurrence`, { method: 'DELETE' }),

  // ---- champs personnalisés (définitions org) ----
  listCustomFields: (entityType?: CustomFieldEntity) =>
    request<CustomFieldDefinitionDto[]>(
      `/custom-fields${entityType ? `?entityType=${entityType}` : ''}`,
    ),
  customFieldCapabilities: () =>
    request<CustomFieldCapabilitiesDto>('/custom-fields/capabilities'),
  createCustomField: (dto: CreateCustomFieldDto) =>
    request<CustomFieldDefinitionDto>('/custom-fields', { method: 'POST', body: JSON.stringify(dto) }),
  updateCustomField: (fieldId: string, dto: UpdateCustomFieldDto) =>
    request<CustomFieldDefinitionDto>(`/custom-fields/${fieldId}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  deleteCustomField: (fieldId: string) =>
    request<{ removed: true }>(`/custom-fields/${fieldId}`, { method: 'DELETE' }),

  // ---- sous-statuts (Custom Status) ----
  listCustomStatuses: (projectId?: string) =>
    request<CustomStatusDto[]>(
      `/custom-statuses${projectId ? `?projectId=${encodeURIComponent(projectId)}` : ''}`,
    ),
  customStatusCapabilities: () =>
    request<CustomStatusCapabilitiesDto>('/custom-statuses/capabilities'),
  createCustomStatus: (dto: CreateCustomStatusDto) =>
    request<CustomStatusDto>('/custom-statuses', { method: 'POST', body: JSON.stringify(dto) }),
  updateCustomStatus: (statusId: string, dto: UpdateCustomStatusDto) =>
    request<CustomStatusDto>(`/custom-statuses/${statusId}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  deleteCustomStatus: (statusId: string) =>
    request<{ removed: true }>(`/custom-statuses/${statusId}`, { method: 'DELETE' }),

  // ---- valeurs de champs personnalisés (par entité) ----
  getTaskCustomFields: (taskId: string) =>
    request<CustomFieldValueDto[]>(`/tasks/${taskId}/custom-fields`),
  setTaskCustomFields: (taskId: string, dto: UpsertCustomFieldValuesDto) =>
    request<CustomFieldValueDto[]>(`/tasks/${taskId}/custom-fields`, {
      method: 'PUT',
      body: JSON.stringify(dto),
    }),
  getProjectCustomFields: (projectId: string) =>
    request<CustomFieldValueDto[]>(`/projects/${projectId}/custom-fields`),
  setProjectCustomFields: (projectId: string, dto: UpsertCustomFieldValuesDto) =>
    request<CustomFieldValueDto[]>(`/projects/${projectId}/custom-fields`, {
      method: 'PUT',
      body: JSON.stringify(dto),
    }),

  // ---- skills ----
  listSkills: () => request<SkillDto[]>('/skills'),
  listSkillPacks: () => request<SkillPackSummaryDto[]>('/skills/packs'),
  applySkillPack: (packId: string, opts?: { force?: boolean }) =>
    request<ApplySkillPackResultDto>(
      `/skills/packs/${encodeURIComponent(packId)}/apply${
        opts?.force ? '?force=1' : ''
      }`,
      { method: 'POST' },
    ),
  removeSkillPack: (packId: string) =>
    request<RemoveSkillPackResultDto>(
      `/skills/packs/${encodeURIComponent(packId)}`,
      { method: 'DELETE' },
    ),
  /** Enregistre/met à jour la *définition* d'un pack custom (org-scoped). */
  upsertCustomSkillPack: (dto: CreateSkillPackDto) =>
    request<SkillPackSummaryDto>('/skills/packs', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  /** Supprime la définition d'un pack custom (sans toucher au catalogue installé). */
  deleteCustomSkillPackDefinition: (packId: string) =>
    request<{ packId: string; deleted: true }>(
      `/skills/packs/${encodeURIComponent(packId)}/definition`,
      { method: 'DELETE' },
    ),
  /** Équipes auxquelles ce pack est restreint (vide = org-wide). */
  getSkillPackScope: (packId: string) =>
    request<PackScopeTeamDto[]>(
      `/skills/packs/${encodeURIComponent(packId)}/teams`,
    ),
  /** Admin only : restreint la visibilité d'un pack à certaines équipes. */
  setSkillPackScope: (packId: string, teamIds: string[]) =>
    request<PackScopeTeamDto[]>(
      `/skills/packs/${encodeURIComponent(packId)}/teams`,
      { method: 'PUT', body: JSON.stringify({ teamIds }) },
    ),
  skillsCapabilities: () =>
    request<{ canWriteCatalog: boolean }>('/skills/capabilities'),
  createSkill: (dto: CreateSkillDto) =>
    request<SkillDto>('/skills', { method: 'POST', body: JSON.stringify(dto) }),
  updateSkill: (skillId: string, dto: UpdateSkillDto) =>
    request<SkillDto>(`/skills/${skillId}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  deleteSkill: (skillId: string) =>
    request<{ id: string; deleted: true }>(`/skills/${skillId}`, { method: 'DELETE' }),
  listUserSkills: (userId: string) =>
    request<UserSkillDto[]>(`/users/${userId}/skills`),
  upsertUserSkill: (userId: string, skillId: string, level: number) =>
    request<UserSkillDto>(`/users/${userId}/skills/${skillId}`, {
      method: 'PUT',
      body: JSON.stringify({ level }),
    }),
  deleteUserSkill: (userId: string, skillId: string) =>
    request<{ userId: string; skillId: string; deleted: true }>(
      `/users/${userId}/skills/${skillId}`,
      { method: 'DELETE' },
    ),
  listProjectSkills: (projectId: string) =>
    request<ProjectSkillDto[]>(`/projects/${projectId}/skills`),
  availableProjectSkills: (projectId: string) =>
    request<AvailableSkillsDto>(`/projects/${projectId}/skills/available`),
  setProjectSkills: (projectId: string, skillIds: string[]) =>
    request<ProjectSkillDto[]>(`/projects/${projectId}/skills`, {
      method: 'PUT',
      body: JSON.stringify({ skillIds }),
    }),
  // ---- team skills ----
  listTeamSkills: (teamId: string) =>
    request<TeamSkillDto[]>(`/teams/${teamId}/skills`),
  setTeamSkills: (teamId: string, skillIds: string[]) =>
    request<TeamSkillDto[]>(`/teams/${teamId}/skills`, {
      method: 'PUT',
      body: JSON.stringify({ skillIds }),
    }),
  // ---- skill requests ----
  listSkillRequests: (opts?: { box?: 'mine' | 'inbox' | 'all'; status?: SkillRequestStatus }) =>
    request<SkillRequestDto[]>(`/skill-requests${qs({ box: opts?.box, status: opts?.status })}`),
  createSkillRequest: (dto: CreateSkillRequestDto) =>
    request<SkillRequestDto>('/skill-requests', { method: 'POST', body: JSON.stringify(dto) }),
  updateSkillRequestStatus: (id: string, status: SkillRequestStatus, note?: string) =>
    request<SkillRequestDto>(`/skill-requests/${id}/status`, {
      method: 'PATCH',
      body: JSON.stringify({ status, note }),
    }),
  suggestAssignees: (taskId: string, opts?: { from?: string; to?: string }) =>
    request<AssigneeSuggestionDto[]>(
      `/tasks/${taskId}/assignee-suggestions${qs({ from: opts?.from, to: opts?.to })}`,
    ),
  // ---- task required-skills (Phase E) ----
  listTaskRequiredSkills: (taskId: string) =>
    request<TaskRequiredSkillDto[]>(`/tasks/${taskId}/required-skills`),
  setTaskRequiredSkills: (taskId: string, items: Array<{ skillId: string; level?: number }>) =>
    request<TaskRequiredSkillDto[]>(`/tasks/${taskId}/required-skills`, {
      method: 'PUT',
      body: JSON.stringify({ items }),
    }),
  // ---- skill gap par projet (Phase F) ----
  projectSkillGap: (projectId: string) =>
    request<SkillGapRowDto[]>(`/projects/${projectId}/skills/gap`),
  // ---- bulk import (Phase G) ----
  bulkImportUserSkills: (csv: string, createMissing?: boolean) =>
    request<BulkImportUserSkillsResult>('/admin/users/skills/import', {
      method: 'POST',
      body: JSON.stringify({ csv, createMissing }),
    }),
  // ---- skill request summary (Phase C) ----
  skillRequestsSummary: () =>
    request<SkillRequestSummaryDto>('/skill-requests/mine/summary'),

  // ---- labels ----
  listLabels: (projectId: string) => request<LabelDto[]>(`/projects/${projectId}/labels`),
  createLabel: (projectId: string, dto: CreateLabelDto) =>
    request<LabelDto>(`/projects/${projectId}/labels`, {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  updateLabel: (projectId: string, labelId: string, dto: UpdateLabelDto) =>
    request<LabelDto>(`/projects/${projectId}/labels/${labelId}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  deleteLabel: (projectId: string, labelId: string) =>
    request(`/projects/${projectId}/labels/${labelId}`, { method: 'DELETE' }),

  // ---- gantt / dependencies (Phase 4) ----
  getGantt: (projectId: string) => request<GanttDto>(`/projects/${projectId}/gantt`),
  listDependencies: (projectId: string) =>
    request<DependencyDto[]>(`/projects/${projectId}/dependencies`),
  createDependency: (dto: CreateDependencyDto) =>
    request<DependencyDto>('/dependencies', { method: 'POST', body: JSON.stringify(dto) }),
  updateDependency: (id: string, dto: UpdateDependencyDto) =>
    request<DependencyDto>(`/dependencies/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  deleteDependency: (id: string) =>
    request(`/dependencies/${id}`, { method: 'DELETE' }),

  // ---- workload (Phase 5) ----
  getWorkSchedule: (userId: string) =>
    request<WorkScheduleDto>(`/users/${userId}/work-schedule`),
  putWorkSchedule: (userId: string, dto: UpsertWorkScheduleDto) =>
    request<WorkScheduleDto>(`/users/${userId}/work-schedule`, {
      method: 'PUT',
      body: JSON.stringify(dto),
    }),
  deleteWorkSchedule: (userId: string) =>
    request(`/users/${userId}/work-schedule`, { method: 'DELETE' }),

  // ---- admin settings (org-scoped) ----
  /** Sous-ensemble public lisible par tout user authentifié. */
  getPublicSettings: () =>
    request<{
      locale: string;
      /** Langue d'interface par défaut ('en'|'fr'|'it'|'de') — axe distinct de `locale`. */
      defaultLanguage: string;
      /** Langues d'interface activées (options du sélecteur). */
      enabledLanguages: string[];
      weekStart: 'monday' | 'sunday';
      hoursPerDay: number;
      skillsMaxLevel: number;
      skillsSelfEditEnabled: boolean;
      skillsLevelScale: Array<{ level: number; label: string }>;
      skillsLevelInputMode: 'number' | 'scale';
      fiscalYearStartMonth: number;
      autoplanConcentration: 'focus' | 'balanced' | 'spread';
    }>('/admin/settings/public'),
  // ---- licence (open-core, SPEC §16) ----
  /** État de la licence du tenant — lisible par tout user authentifié (FeatureGate + bandeau). */
  getLicense: () => request<LicenseStatusDto>('/license'),
  /** Historique des uploads de licence (admin). */
  getLicenseHistory: () => request<LicenseHistoryRowDto[]>('/admin/license/history'),
  /** Importe un nouveau fichier de licence (vérifie la signature). */
  uploadLicense: (token: string) =>
    request<LicenseStatusDto>('/admin/license', {
      method: 'POST',
      body: JSON.stringify({ token }),
    }),
  /** Retire la licence active → retour au core gratuit. */
  clearLicense: () => request<LicenseStatusDto>('/admin/license', { method: 'DELETE' }),

  getAdminSettings: () => request<OrgSettingsDto>('/admin/settings'),
  putAdminSettings: (body: OrgSettingsDto) =>
    request<OrgSettingsDto>('/admin/settings', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Usage MCP par tool sur la fenêtre courante (temps réel, tous jetons). */
  getMcpToolUsage: () =>
    request<{ windowSec: number; tools: Array<{ tool: string; count: number }> }>('/admin/mcp/tool-usage'),
  /** Upload du logo de l'organisation (PNG/JPEG/SVG/WebP/GIF, max 1 MB). */
  uploadOrgLogo: (file: File) =>
    multipartUpload<{ url: string; mime: string; sizeBytes: number }>(
      '/admin/branding/org-logo',
      file,
    ),
  removeOrgLogo: () =>
    request<{ ok: true }>('/admin/branding/org-logo', { method: 'DELETE' }),
  /** Test SMTP : déclenche l'envoi d'un mail "test" à l'adresse fournie (ou à l'admin courant). */
  sendNotificationsTest: (to?: string) =>
    request<{ deliveryId: string }>('/admin/notifications/test', {
      method: 'POST',
      body: JSON.stringify({ to }),
    }),
  /** Rendu HTML d'un template avec le branding org courant — pour le bouton "Preview". */
  previewNotificationTemplate: (template: 'assignment' | 'mention' | 'due' | 'status' | 'digest' | 'test') =>
    request<{ subject: string; html: string; text: string }>(`/admin/notifications/preview/${template}`),
  // -------- Webhooks (Phase 7) --------
  listWebhookEvents: () => request<{ events: string[] }>('/admin/webhooks/events'),
  listWebhooks: () => request<WebhookDto[]>('/admin/webhooks'),
  createWebhook: (dto: WebhookCreateDto) =>
    request<WebhookDto>('/admin/webhooks', { method: 'POST', body: JSON.stringify(dto) }),
  updateWebhook: (id: string, dto: WebhookUpdateDto) =>
    request<WebhookDto>(`/admin/webhooks/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  deleteWebhook: (id: string) =>
    request<{ id: string; deleted: true }>(`/admin/webhooks/${id}`, { method: 'DELETE' }),
  rotateWebhookSecret: (id: string) =>
    request<WebhookDto>(`/admin/webhooks/${id}/rotate-secret`, { method: 'POST' }),
  testWebhook: (id: string) =>
    request<{ deliveryId: string }>(`/admin/webhooks/${id}/test`, { method: 'POST' }),
  listWebhookDeliveries: (q: { webhookId?: string; limit?: number } = {}) =>
    request<WebhookDeliveryDto[]>(`/admin/webhooks/deliveries${qs(q)}`),
  retryWebhookDelivery: (id: string) =>
    request<WebhookDeliveryDto>(`/admin/webhooks/deliveries/${id}/retry`, { method: 'POST' }),
  // -------- Webhooks projet (self-service PM) --------
  projectWebhooksCanManage: (projectId: string) =>
    request<{ canManage: boolean }>(`/projects/${projectId}/webhooks/can-manage`),
  listProjectWebhookEvents: (projectId: string) =>
    request<{ events: string[] }>(`/projects/${projectId}/webhooks/events`),
  listProjectWebhooks: (projectId: string) =>
    request<WebhookDto[]>(`/projects/${projectId}/webhooks`),
  createProjectWebhook: (projectId: string, dto: WebhookCreateDto) =>
    request<WebhookDto>(`/projects/${projectId}/webhooks`, { method: 'POST', body: JSON.stringify(dto) }),
  updateProjectWebhook: (projectId: string, id: string, dto: WebhookUpdateDto) =>
    request<WebhookDto>(`/projects/${projectId}/webhooks/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  deleteProjectWebhook: (projectId: string, id: string) =>
    request<{ id: string; deleted: true }>(`/projects/${projectId}/webhooks/${id}`, { method: 'DELETE' }),
  rotateProjectWebhookSecret: (projectId: string, id: string) =>
    request<WebhookDto>(`/projects/${projectId}/webhooks/${id}/rotate-secret`, { method: 'POST' }),
  testProjectWebhook: (projectId: string, id: string) =>
    request<{ deliveryId: string }>(`/projects/${projectId}/webhooks/${id}/test`, { method: 'POST' }),
  listProjectWebhookDeliveries: (projectId: string, q: { limit?: number } = {}) =>
    request<WebhookDeliveryDto[]>(`/projects/${projectId}/webhooks/deliveries${qs(q)}`),
  retryProjectWebhookDelivery: (projectId: string, id: string) =>
    request<WebhookDeliveryDto>(`/projects/${projectId}/webhooks/deliveries/${id}/retry`, { method: 'POST' }),
  // -------- Journal d'audit (Phase 8) --------
  listAuditLogs: (q: AuditLogListQuery = {}) =>
    request<AuditLogListResponse>(`/admin/audit-logs${qs(q as Record<string, unknown>)}`),
  /** Export streaming JSON Lines / CEF → download navigateur. */
  exportAuditLogs: async (format: 'jsonl' | 'cef', q: AuditLogListQuery = {}) => {
    const { blob, filename } = await downloadFile(
      `/admin/audit-logs/export${qs({ ...(q as Record<string, unknown>), format })}`,
      `audit.${format}`,
    );
    saveBlob(blob, filename);
  },
  testAuditSyslog: () =>
    request<{ queued: boolean }>('/admin/audit-logs/syslog/test', { method: 'POST' }),
  // -------- Diagnostic / support --------
  /** Récupère l'instantané de diagnostic pour AFFICHAGE (non audité). */
  getDiagnostics: () => request<Record<string, unknown>>('/admin/diagnostics'),
  /** Récupère le bundle pour TÉLÉCHARGEMENT (audité `admin.diagnostics.exported`). */
  exportDiagnostics: () => request<Record<string, unknown>>('/admin/diagnostics/export'),
  /**
   * Journal des envois d'emails (status QUEUED/SENT/FAILED/SKIPPED) — fenêtre
   * glissante de 30 jours, pagination keyset : repasser `nextCursor` en
   * `cursor` pour la page suivante (null = fin).
   */
  listEmailDeliveries: (opts: { status?: string; cursor?: string; pageSize?: number } = {}) => {
    const q = new URLSearchParams();
    if (opts.status && opts.status !== 'ALL') q.set('status', opts.status);
    if (opts.cursor) q.set('cursor', opts.cursor);
    q.set('pageSize', String(opts.pageSize ?? 50));
    return request<EmailDeliveryPage>(`/admin/notifications/deliveries?${q}`);
  },
  /** Teste la connexion Microsoft Graph (provisioning Teams) — feature premium. */
  testTeamsProvisioning: () =>
    request<{ ok: boolean; message: string }>('/admin/teams-provisioning/test', { method: 'POST' }),
  /** Teste le bot token Slack (provisioning d'espaces de collaboration) — feature premium. */
  testSlackProvisioning: () =>
    request<{ ok: boolean; message: string }>('/admin/slack-provisioning/test', { method: 'POST' }),
  /** Provisionne le canal Slack d'un projet MAINTENANT (projet déjà actif). */
  provisionSlackForProject: (projectId: string) =>
    request<{ status: 'queued' | 'skipped' | 'done'; reason?: string; channelId?: string }>(
      `/admin/slack-provisioning/provision/${projectId}`,
      { method: 'POST' },
    ),
  // ---- Provisioning des espaces de collaboration, vue PROJET (onglet Intégrations) ----
  /** État des fournisseurs (Teams / Slack / Google Chat / Drive partagé) pour un projet. */
  getProjectCollabProvision: (projectId: string) =>
    request<
      {
        provider: 'msteams' | 'slack' | 'gchat' | 'gdrive';
        label: string;
        enabled: boolean;
        provisioned: boolean;
        status: string;
        url: string | null;
      }[]
    >(`/projects/${projectId}/collab-provision`),
  /** Provisionne maintenant l'espace d'un fournisseur pour ce projet. */
  provisionProjectCollab: (projectId: string, provider: string) =>
    request<{ status: string; reason?: string }>(
      `/projects/${projectId}/collab-provision/${provider}`,
      { method: 'POST' },
    ),
  /** Archive l'espace d'un fournisseur (Slack : archive + délie). */
  archiveProjectCollab: (projectId: string, provider: string) =>
    request<{ status: string; reason?: string }>(
      `/projects/${projectId}/collab-provision/${provider}`,
      { method: 'DELETE' },
    ),
  /**
   * Détache le lien LOCAL sans toucher au distant — débloque un projet dont
   * l'espace/équipe a été supprimé côté fournisseur (archive/re-sync en 404).
   */
  detachProjectCollab: (projectId: string, provider: string) =>
    request<{ status: string; reason?: string }>(
      `/projects/${projectId}/collab-provision/${provider}/detach`,
      { method: 'POST' },
    ),
  /**
   * Supprime l'espace distant (Google Chat uniquement — Chat n'a pas
   * d'archivage). Destructif et définitif côté Google.
   */
  deleteProjectCollabSpaceRemote: (projectId: string, provider: string) =>
    request<{ status: string; reason?: string }>(
      `/projects/${projectId}/collab-provision/${provider}/delete-space`,
      { method: 'POST' },
    ),
  /** Teste le compte de service Google Chat (provisioning d'espaces de collaboration) — feature premium. */
  testGoogleChatProvisioning: () =>
    request<{ ok: boolean; message: string }>('/admin/google-chat-provisioning/test', { method: 'POST' }),
  /**
   * Génère (ou régénère) la paire de clés du mode Workload Identity Federation
   * pour Google Chat. Renvoie le JWKS public + issuer à coller côté Google. La
   * clé privée reste en base (chiffrée), jamais renvoyée.
   */
  generateGoogleChatWifKey: () =>
    request<{ keyId: string; issuer: string; jwks: { keys: Record<string, unknown>[] } }>(
      '/admin/google-chat-provisioning/wif-key',
      { method: 'POST' },
    ),

  // ---- Provisioning Google Drive (Drive partagé par projet) ----
  testGoogleDriveProvisioning: () =>
    request<{ ok: boolean; message: string }>('/admin/google-drive-provisioning/test', { method: 'POST' }),
  /** Clé WIF du provisioning Drive (JWKS + issuer à coller côté Google). */
  generateGoogleDriveWifKey: () =>
    request<{ keyId: string; issuer: string; jwks: { keys: Record<string, unknown>[] } }>(
      '/admin/google-drive-provisioning/wif-key',
      { method: 'POST' },
    ),
  /** Envoie immédiatement l'export facturation planifié (Admin > Scheduled billing export). */
  sendBillingExportNow: () =>
    request<{ sent: number; skipped: boolean }>('/admin/billing-export/send-now', { method: 'POST' }),
  /** Aperçu de la purge (Admin > Data Management) : compte du soft-delete purgeable. */
  getDataPurgePreview: () =>
    request<{ total: number; byType: Record<string, number> }>('/admin/data/purge-preview'),
  /** Purge immédiate de TOUT le soft-delete. Irréversible. */
  purgeSoftDeleted: () =>
    request<{ total: number; byType: Record<string, number> }>('/admin/data/purge', {
      method: 'POST',
    }),
  /** Export org (JSON) → download navigateur. */
  exportOrgData: async () => {
    const { blob, filename } = await downloadFile('/admin/data/export', 'org-export.json');
    saveBlob(blob, filename);
  },
  /** Statut de l'équipe Teams d'un projet + 10 derniers logs de provisioning. */
  getMsTeamStatus: (projectId: string) =>
    request<{
      msTeamId: string | null;
      msTeamStatus: string;
      msTeamProvisionedAt: string | null;
      logs: Array<{
        id: string;
        action: string;
        status: string;
        teamId: string | null;
        membersAdded: number;
        membersSkipped: number;
        error: string | null;
        createdAt: string;
      }>;
    }>(`/projects/${projectId}/ms-team`),
  /** Déclenche le provisioning Teams maintenant (force = re-synchronisation). */
  provisionMsTeam: (projectId: string, force = false) =>
    request<{ status: string; reason?: string }>(
      `/projects/${projectId}/ms-team/provision${force ? '?force=1' : ''}`,
      { method: 'POST' },
    ),
  /** Archive l'équipe Teams du projet (manuel). */
  archiveMsTeam: (projectId: string) =>
    request<{ status: string; reason?: string }>(`/projects/${projectId}/ms-team/archive`, {
      method: 'POST',
    }),
  /** Vérifie l'intégrité d'une journée contre son ancre quotidienne. */
  verifyAuditDay: (date?: string) =>
    request<{
      ok: boolean | null;
      date: string;
      anchored: boolean;
      anchorAt?: string;
      sealedCount?: number | null;
      currentCount?: number;
      message?: string;
    }>(`/admin/audit-logs/verify${qs({ date })}`),
  // -------- Jetons API (Phase 9) --------
  // -------- Préférences notifications par user (#14) --------
  getMyNotificationPrefs: () =>
    request<UserNotificationPrefsDto>('/me/notification-prefs'),
  putMyNotificationPrefs: (body: UserNotificationPrefsDto) =>
    request<UserNotificationPrefsDto>('/me/notification-prefs', {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  // -------- Widgets de rapport par user × projet --------
  getReportWidgets: (projectId: string) =>
    request<ReportWidgetPreferenceDto>(`/projects/${projectId}/report-widgets`),
  putReportWidgets: (projectId: string, body: ReportWidgetPreferenceDto) =>
    request<ReportWidgetPreferenceDto>(`/projects/${projectId}/report-widgets`, {
      method: 'PUT',
      body: JSON.stringify(body),
    }),
  /** Self-service : change la langue d'interface préférée. null = hériter du défaut org. */
  setMyLanguage: (language: string | null) =>
    request<{ preferredLanguage: string | null }>('/me/preferences/language', {
      method: 'PUT',
      body: JSON.stringify({ language }),
    }),
  myApiTokenScopes: () => request<{ scopes: string[] }>('/me/api-tokens/scopes'),
  listMyApiTokens: () => request<ApiTokenDto[]>('/me/api-tokens'),
  createMyApiToken: (body: ApiTokenCreateBody) =>
    request<ApiTokenCreated>('/me/api-tokens', { method: 'POST', body: JSON.stringify(body) }),
  deleteMyApiToken: (id: string) =>
    request<{ id: string; revoked: true }>(`/me/api-tokens/${id}`, { method: 'DELETE' }),
  orgApiTokenScopes: () => request<{ scopes: string[] }>('/admin/api-tokens/scopes'),
  // ---- Clés de chiffrement (DORA) : statut + rotation KEK/DEK (crypto:manage) ----
  cryptoStatus: () => request<CryptoStatusDto>('/admin/crypto/status'),
  cryptoRewrapKeks: () =>
    request<{ rewrapped: number; total: number; activeKek: string }>('/admin/crypto/rewrap-keks', {
      method: 'POST',
    }),
  cryptoRotateDek: () =>
    request<{ mode: string; processed: number; failed: number; retiredPurged: boolean }>(
      '/admin/crypto/rotate-dek',
      { method: 'POST' },
    ),

  listOrgApiTokens: () => request<ApiTokenDto[]>('/admin/api-tokens'),
  createOrgApiToken: (body: ApiTokenCreateBody) =>
    request<ApiTokenCreated>('/admin/api-tokens', { method: 'POST', body: JSON.stringify(body) }),
  deleteOrgApiToken: (id: string) =>
    request<{ id: string; revoked: true }>(`/admin/api-tokens/${id}`, { method: 'DELETE' }),
  /** Télécharge un CSV (auth incluse via fetch) et déclenche le download navigateur. */
  downloadCsv: async (path: string, fallbackName: string) => {
    const { blob, filename } = await downloadFile(path, fallbackName);
    saveBlob(blob, filename);
  },
  listRoles: () => request<RoleDto[]>('/admin/roles'),
  listHolidayCountries: () =>
    request<{ countries: { code: string; name: string }[] }>('/admin/holidays/countries'),
  getDefaultHolidayCountry: () =>
    request<{ country: string }>('/admin/holidays/default'),
  previewHolidays: (q: { country?: string; from: string; to: string }) =>
    request<{ country: string; from: string; to: string; holidays: { date: string; name: string }[] }>(
      `/admin/holidays/preview${qs(q)}`,
    ),
  /** Lookup public accessible à tout membre — alimente les warnings task/timeline. */
  lookupHolidays: (q: { country?: string; from: string; to: string }) =>
    request<{ country: string; from: string; to: string; holidays: { date: string; name: string }[] }>(
      `/holidays${qs(q)}`,
    ),
  getOrgDefaultHolidayCountry: () =>
    request<{ country: string }>('/holidays/default-country'),
  listTimeOffs: (q: { from?: string; to?: string; userId?: string } = {}) =>
    request<TimeOffDto[]>(`/time-offs${qs(q)}`),
  createTimeOff: (dto: CreateTimeOffDto) =>
    request<TimeOffDto>('/time-offs', { method: 'POST', body: JSON.stringify(dto) }),
  updateTimeOff: (id: string, dto: UpdateTimeOffDto) =>
    request<TimeOffDto>(`/time-offs/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  deleteTimeOff: (id: string) =>
    request(`/time-offs/${id}`, { method: 'DELETE' }),
  bulkUpsertTimeOffs: (dto: {
    items: Array<{
      userId?: string;
      employeeId?: string;
      email?: string;
      startDate: string;
      endDate: string;
      type?: TimeOffDto['type'];
      notes?: string;
      externalId?: string;
    }>;
    source?: 'IMPORT' | 'API';
  }) =>
    request<{
      created: number;
      updated: number;
      errors: { index: number; reason: string }[];
      items: TimeOffDto[];
    }>('/time-offs/bulk-upsert', { method: 'POST', body: JSON.stringify(dto) }),
  importTimeOffsCsv: (dto: { csv: string; dateFormat?: 'iso' | 'eu' | 'us' }) =>
    request<{
      created: number;
      updated: number;
      errors: { index: number; reason: string }[];
      items: TimeOffDto[];
    }>('/time-offs/import-csv', { method: 'POST', body: JSON.stringify(dto) }),
  listAllocations: (q: { from?: string; to?: string; userId?: string; projectId?: string; taskId?: string } = {}) =>
    request<AllocationDto[]>(`/allocations${qs(q)}`),
  createAllocation: (dto: CreateAllocationDto) =>
    request<AllocationDto>('/allocations', { method: 'POST', body: JSON.stringify(dto) }),
  autoSplitAllocation: (dto: {
    userId: string;
    taskId: string;
    startDate: string;
    totalHours: number;
    hoursPerDay: number;
    mustFinishBy?: string;
    allowOvertime?: boolean;
    excludeAllocationIds?: string[];
  }) =>
    request<{
      startDate: string;
      endDate: string;
      hoursPerDay: number;
      workdays: number;
      blockedDays: number;
      effectiveHours: number;
      requestedHours: number;
      shortfallHours: number;
      hitDeadline: boolean;
      chunks: Array<{ startDate: string; endDate: string; hoursPerDay: number }>;
    }>('/allocations/auto-split', { method: 'POST', body: JSON.stringify(dto) }),
  /** Multi-personnes : répartit `totalHours` entre plusieurs assignees
   *  selon `strategy`. Dry-run — renvoie un plan par personne. */
  autoSplitMultiAllocation: (dto: {
    taskId: string;
    userIds: string[];
    startDate: string;
    totalHours: number;
    strategy: 'proportional' | 'equal' | 'greedy';
    hoursPerDayCap?: number;
    mustFinishBy?: string;
    allowOvertime?: boolean;
    excludeAllocationIds?: string[];
  }) =>
    request<{
      strategy: 'proportional' | 'equal' | 'greedy';
      startDate: string;
      endDate: string;
      requestedHours: number;
      effectiveHours: number;
      shortfallHours: number;
      hitDeadline: boolean;
      peopleUsed: number;
      peopleShort: number;
      perUser: Array<{
        userId: string;
        targetHours: number;
        effectiveHours: number;
        workdays: number;
        blockedDays: number;
        shortfallHours: number;
        startDate: string;
        endDate: string;
        chunks: Array<{ startDate: string; endDate: string; hoursPerDay: number }>;
      }>;
    }>('/allocations/auto-split-multi', { method: 'POST', body: JSON.stringify(dto) }),
  updateAllocation: (id: string, dto: UpdateAllocationDto) =>
    request<AllocationDto>(`/allocations/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  deleteAllocation: (id: string) =>
    request(`/allocations/${id}`, { method: 'DELETE' }),
  /** Move ONE day from a multi-day allocation atomically (server-side
   *  transactional split + create). Returns a snapshot for undo. */
  moveAllocationDay: (
    id: string,
    dto: import('@vaks-pm/shared').MoveAllocationDayDto,
  ) =>
    request<import('@vaks-pm/shared').MoveAllocationDayResultDto>(
      `/allocations/${id}/move-day`,
      { method: 'POST', body: JSON.stringify(dto) },
    ),
  getWorkload: (q: { from: string; to: string; projectId?: string; userId?: string; teamId?: string }) =>
    request<WorkloadGridDto>(`/workload${qs(q)}`),
  autoplan: (dto: AutoplanRequestDto) =>
    request<AutoplanResultDto>('/workload/autoplan', { method: 'POST', body: JSON.stringify(dto) }),
  /** Badge « plan obsolète » (Lot 3.3, AUTOPLAN_IMPROVEMENTS.md §3.3). */
  getPlanStatus: (projectId: string) =>
    request<PlanStatusDto>(`/workload/plan-status${qs({ projectId })}`),
  /** Vue agrégée des agents IA (Lot 5, AUTOPLAN_IMPROVEMENTS.md §5.1) —
   *  concurrence + budget (si `finance:view`) + file de revue. */
  getAgentsWorkload: (q: { from?: string; to?: string; projectId?: string }) =>
    request<AgentWorkloadDto>(`/workload/agents${qs(q)}`),

  // ---- teams ----
  listTeams: () => request<TeamDto[]>('/teams'),
  getTeam: (id: string) => request<TeamWithMembersDto>(`/teams/${id}`),
  createTeam: (dto: { name: string; description?: string | null; color?: string | null }) =>
    request<TeamDto>('/teams', { method: 'POST', body: JSON.stringify(dto) }),
  updateTeam: (
    id: string,
    dto: {
      name?: string;
      displayName?: string | null;
      description?: string | null;
      color?: string | null;
      canCreateNonBillableProject?: boolean;
      autoLicense?: boolean;
    },
  ) => request<TeamDto>(`/teams/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  // Soft-delete (archive, réversible).
  deleteTeam: (id: string) =>
    request<{ id: string; name: string; source: string; deleted: true }>(`/teams/${id}`, {
      method: 'DELETE',
    }),
  // Équipes archivées (admin) — avec compteur de membres.
  listArchivedTeams: () =>
    request<Array<TeamDto & { deletedAt: string | null; _count: { members: number } }>>(
      '/teams/archived',
    ),
  restoreTeam: (id: string) =>
    request<{ id: string; name: string; source: string; restored: true }>(
      `/teams/${id}/restore`,
      { method: 'POST' },
    ),
  // Suppression définitive (hard-delete) — uniquement sur une équipe archivée.
  purgeTeam: (id: string) =>
    request<{ id: string; name: string; purged: true }>(`/teams/${id}/purge`, {
      method: 'DELETE',
    }),
  addTeamMember: (teamId: string, dto: { userId: string; isLead?: boolean }) =>
    request<{ userId: string; isLead: boolean; user: { id: string; name: string; email: string } }>(
      `/teams/${teamId}/members`,
      { method: 'POST', body: JSON.stringify(dto) },
    ),
  updateTeamMember: (
    teamId: string,
    userId: string,
    dto: {
      isLead?: boolean;
      canCreateNonBillableProject?: boolean | null;
      defaultCostRate?: number | null;
      defaultBillRate?: number | null;
    },
  ) =>
    request<{
      userId: string;
      isLead: boolean;
      user: {
        id: string;
        name: string;
        email: string;
        canCreateNonBillableProject?: boolean | null;
        defaultCostRate?: number | null;
        defaultBillRate?: number | null;
      };
    }>(`/teams/${teamId}/members/${userId}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  removeTeamMember: (teamId: string, userId: string) =>
    request<{ teamId: string; userId: string; removed: true }>(
      `/teams/${teamId}/members/${userId}`,
      { method: 'DELETE' },
    ),

  // ---- clients / portefeuille ----
  listClients: (params?: { search?: string; status?: string; page?: number; pageSize?: number }) => {
    const qs = new URLSearchParams();
    if (params?.search) qs.set('search', params.search);
    if (params?.status) qs.set('status', params.status);
    if (params?.page) qs.set('page', String(params.page));
    if (params?.pageSize) qs.set('pageSize', String(params.pageSize));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<ClientListDto>(`/clients${suffix}`);
  },
  importClientsCsv: (csv: string) =>
    request<ClientImportResultDto>('/clients/import', {
      method: 'POST',
      body: JSON.stringify({ csv }),
    }),
  getClient: (id: string) =>
    request<
      ClientDto & {
        contacts: ContactDto[];
        projects: Array<{ id: string; key: string; name: string; status: string }>;
      }
    >(`/clients/${id}`),
  createClient: (dto: CreateClientDto) =>
    request<ClientDto>('/clients', { method: 'POST', body: JSON.stringify(dto) }),
  updateClient: (id: string, dto: UpdateClientDto) =>
    request<ClientDto>(`/clients/${id}`, { method: 'PATCH', body: JSON.stringify(dto) }),
  deleteClient: (id: string) => request(`/clients/${id}`, { method: 'DELETE' }),
  /** RGPD — blanchit les coordonnées PII du client (garde le nom du compte). */
  anonymizeClient: (id: string) =>
    request<{ id: string; anonymized: boolean }>(`/clients/${id}/anonymize`, { method: 'POST' }),
  listContacts: (clientId: string) =>
    request<ContactDto[]>(`/clients/${clientId}/contacts`),
  createContact: (clientId: string, dto: CreateContactDto) =>
    request<ContactDto>(`/clients/${clientId}/contacts`, {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  updateContact: (clientId: string, contactId: string, dto: UpdateContactDto) =>
    request<ContactDto>(`/clients/${clientId}/contacts/${contactId}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  deleteContact: (clientId: string, contactId: string) =>
    request(`/clients/${clientId}/contacts/${contactId}`, { method: 'DELETE' }),
  /** RGPD — anonymise complètement un contact (personne). */
  anonymizeContact: (clientId: string, contactId: string) =>
    request<{ id: string; anonymized: boolean }>(
      `/clients/${clientId}/contacts/${contactId}/anonymize`,
      { method: 'POST' },
    ),

  // ---- comments (Phase 6) ----
  listComments: (taskId: string) =>
    request<CommentDto[]>(`/tasks/${taskId}/comments`),
  createComment: (taskId: string, dto: CreateCommentDto) =>
    request<CommentDto>(`/tasks/${taskId}/comments`, {
      method: 'POST',
      body: JSON.stringify(dto),
    }),

  // ---- time entries (Phase 3) ----
  listTimeEntries: (q: { projectId: string; from: string; to: string }) =>
    request<TimeEntryDto[]>(`/time-entries${qs(q)}`),
  createTimeEntry: (dto: CreateTimeEntryDto) =>
    request<TimeEntryDto>('/time-entries', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  updateTimeEntry: (id: string, dto: UpdateTimeEntryDto) =>
    request<TimeEntryDto>(`/time-entries/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(dto),
    }),
  deleteTimeEntry: (id: string) =>
    request<void>(`/time-entries/${id}`, { method: 'DELETE' }),

  // ---- reports (Phase 3) ----
  projectStats: (projectId: string) =>
    request<ProjectStatsDto>(`/projects/${projectId}/stats`),
  burndown: (projectId: string, from: string, to: string) =>
    request<BurndownReportDto>(`/projects/${projectId}/burndown${qs({ from, to })}`),
  dueAdherence: (projectId: string) =>
    request<DueAdherenceDto>(`/projects/${projectId}/due-adherence`),
  projectByTeam: (projectId: string) =>
    request<ProjectByTeamDto>(`/projects/${projectId}/by-team`),
  timeBreakdown: (q: {
    projectId?: string;
    userId?: string;
    from?: string;
    to?: string;
  }) => request<TimeBreakdownDto>(`/reports/time-breakdown${qs(q)}`),
  tasksInWindow: (projectId: string, from: string, to: string) =>
    request<TasksInWindowReportDto>(
      `/projects/${projectId}/tasks-in-window${qs({ from, to })}`,
    ),
  getTimesheet: (q: { from: string; to: string; userId?: string }) =>
    request<TimesheetDto>(`/timesheet${qs(q)}`),

  // ---- ticketing live search (incrément 2) ----
  listTicketingSources: () =>
    request<Array<{ source: string; label: string }>>('/ticketing/sources'),
  searchTicketsLive: (params: { source: string; q: string; limit?: number }) =>
    request<Array<{ key: string; title: string; url?: string; status?: string; meta?: Record<string, string> }>>(
      `/ticketing/search${qs(params)}`,
    ),

  // ---- external tasks (tickets d'outils externes, timesheet only) ----
  upsertExternalTask: (dto: {
    source: string;
    key: string;
    title?: string;
    url?: string;
    clientId?: string;
  }) =>
    request<ExternalTaskDto>('/external-tasks', {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  searchExternalTasks: (q: { q?: string; source?: string; limit?: number }) =>
    request<ExternalTaskDto[]>(`/external-tasks${qs(q)}`),

  // ---- deliverables (chantier 2c) ----
  listDeliverables: (taskId: string) =>
    request<DeliverableDto[]>(`/tasks/${taskId}/deliverables`),
  submitDeliverable: (taskId: string, dto: CreateDeliverableDto) =>
    request<DeliverableDto>(`/tasks/${taskId}/deliverables`, {
      method: 'POST',
      body: JSON.stringify(dto),
    }),
  submitTaskForReview: (taskId: string) =>
    request<TaskDto>(`/tasks/${taskId}/submit-review`, { method: 'POST' }),
  reviewDeliverable: (taskId: string, deliverableId: string, dto: ReviewDeliverableDto) =>
    request<{ deliverable: DeliverableDto; task: TaskDto }>(
      `/tasks/${taskId}/deliverables/${deliverableId}/review`,
      { method: 'POST', body: JSON.stringify(dto) },
    ),

  // ---- attachments (Phase 6) ----
  listAttachments: (taskId: string) =>
    request<AttachmentDto[]>(`/tasks/${taskId}/attachments`),
  uploadAttachment: (taskId: string, file: File) =>
    multipartUpload<AttachmentDto>(`/tasks/${taskId}/attachments`, file),
  deleteAttachment: (id: string) =>
    request<{ id: string; deleted: true }>(`/attachments/${id}`, { method: 'DELETE' }),
  /** Fetches + triggers browser download for an attachment. */
  downloadAttachment: async (att: AttachmentDto): Promise<void> => {
    const { blob } = await downloadFile(
      `/attachments/${att.id}/download`,
      att.filename,
    );
    saveBlob(blob, att.filename);
  },
};

/** Résultats de la recherche globale (command palette ⌘K). */
export interface GlobalSearchResults {
  projects: { id: string; key: string; name: string }[];
  tasks: {
    id: string;
    title: string;
    projectId: string;
    projectKey: string;
    projectName: string;
    status: string;
  }[];
}
