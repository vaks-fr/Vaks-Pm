/* ============================================================
   Vaks — Démo statique : table de routage du faux backend.
   ----------------------------------------------------------------
   `resolve(method, path, query, body)` matche (méthode, motif de path) et
   renvoie une valeur JSON (ou throw `DemoHttpError`). Les handlers de lecture
   dérivent du store ; les mutations (Phase 4) le mutent + persist(). Fallback
   sûr : jamais d'écran cassé (GET inconnu → `[]`).
   ============================================================ */
import { getState, currentUser } from './store';
import { computeDashboard, computeTimesheet } from './compute';
import { DemoHttpError, type DemoResult } from './routes-shared';
import * as m from './mutations';
import * as cv from './compute-views';
import { DEMO_TEAM_MEMBERS } from './seed';
import { resolveDemoLanguage, DEMO_LOCALE_BY_LANG } from './config';

// Ré-export pour handler.ts (qui importe depuis './routes').
export { DemoHttpError };
export type { DemoResult };

interface Ctx {
  params: Record<string, string>;
  query: Record<string, string>;
  body: unknown;
}
type Handler = (ctx: Ctx) => DemoResult | Promise<DemoResult>;
interface Route {
  method: string;
  regex: RegExp;
  keys: string[];
  handler: Handler;
}

const routes: Route[] = [];

/** Enregistre une route. `path` peut contenir des `:param`. */
function route(method: string, path: string, handler: Handler): void {
  const keys: string[] = [];
  const pattern = path
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/\/:([a-zA-Z0-9_]+)/g, (_m, k: string) => {
      keys.push(k);
      return '/([^/]+)';
    });
  routes.push({ method, regex: new RegExp(`^${pattern}$`), keys, handler });
}
const GET = (p: string, h: Handler) => route('GET', p, h);
const POST = (p: string, h: Handler) => route('POST', p, h);
const PATCH = (p: string, h: Handler) => route('PATCH', p, h);
const DELETE = (p: string, h: Handler) => route('DELETE', p, h);

/* ============================================================
   Settings + licence + auth
   ============================================================ */

const DEMO_LANG = resolveDemoLanguage();
const PUBLIC_SETTINGS = {
  locale: DEMO_LANG ? (DEMO_LOCALE_BY_LANG[DEMO_LANG] ?? 'fr-FR') : 'fr-FR',
  defaultLanguage: DEMO_LANG ?? 'fr',
  enabledLanguages: ['en', 'fr', 'it', 'de'],
  weekStart: 'monday' as const,
  hoursPerDay: 8,
  skillsMaxLevel: 10,
  skillsSelfEditEnabled: true,
  skillsLevelScale: [] as Array<{ level: number; label: string }>,
  skillsLevelInputMode: 'number' as const,
  fiscalYearStartMonth: 1,
};

function demoLicense() {
  const now = new Date();
  const exp = new Date(now.getTime() + 365 * 86_400_000);
  return {
    status: 'active' as const,
    features: [
      'sso-oidc', 'sso-saml', 'scim', 'siem-export', 'audit-advanced',
      'teams-provisioning', 'mcp',
    ],
    customer: 'Acme (démo)',
    issuedAt: now.toISOString(),
    expiresAt: exp.toISOString(),
    daysRemaining: 365,
    maxUsers: null,
    notes: 'Licence de démonstration',
    signatureValid: true,
    requireOnline: false,
    organizationId: 'org_demo',
  };
}

const FAKE_TOKENS = { accessToken: 'demo-access-token', refreshToken: 'demo-refresh-token' };

GET('/auth/me', () => currentUser());
POST('/auth/login', () => FAKE_TOKENS);
POST('/auth/login/mfa', () => FAKE_TOKENS);
POST('/auth/refresh', () => FAKE_TOKENS);
POST('/auth/logout', () => undefined);
GET('/auth/password-policy', () => ({ minLength: 8, requireUppercase: false, requireNumber: false, requireSymbol: false }));
GET('/auth/sso/providers', () => []);
GET('/admin/settings/public', () => PUBLIC_SETTINGS);
GET('/license', () => demoLicense());

/* ============================================================
   Lectures cœur (Phase 3)
   ============================================================ */

GET('/projects', () => getState().projects);

GET('/projects/:id/board', ({ params }) => {
  const b = getState().boards.find((x) => x.projectId === params.id);
  if (!b) throw new DemoHttpError(404, 'Board introuvable');
  return b;
});

GET('/projects/:id/labels', ({ params }) =>
  getState().labels.filter((l) => l.projectId === params.id),
);

GET('/projects/:id/tasks', ({ params }) =>
  getState().tasks.filter((t) => t.projectId === params.id),
);

GET('/projects/:id/teams', () => []);
GET('/projects/:id/members', ({ params }) => {
  // Membres dérivés des assignés du projet. Forme alignée sur ce que consomme
  // ManageModal (`member.user.{id,name,email}` + `member.role.{key,name}` +
  // `isSponsor`) — un objet plat faisait planter le rendu de l'onglet Accès.
  const s = getState();
  const seen = new Set<string>();
  const out: Array<{
    userId: string;
    user: { id: string; name: string; email: string };
    role: { key: string; name: string };
    isSponsor?: boolean;
  }> = [];
  for (const t of s.tasks.filter((x) => x.projectId === params.id)) {
    for (const a of t.assignees) {
      if (seen.has(a.userId)) continue;
      seen.add(a.userId);
      out.push({
        userId: a.userId,
        user: { id: a.userId, name: a.name, email: a.email },
        role: { key: 'CONTRIBUTOR', name: 'Contributor' },
        isSponsor: false,
      });
    }
  }
  return out;
});

GET('/users', () => getState().users);
GET('/users/directory', () => ({ items: getState().users, nextCursor: null, total: getState().users.length }));
GET('/users/:id/work-schedule', ({ params }) => ({
  id: `ws_${params.id}`, userId: params.id, effectiveFrom: '2020-01-01',
  hoursMon: 8, hoursTue: 8, hoursWed: 8, hoursThu: 8, hoursFri: 8, hoursSat: 0, hoursSun: 0,
  occupancyPct: 100, isDefault: true,
}));
GET('/users/:id/skills', () => []);

// Agents IA (vue « Agents IA »)
GET('/me/agents', () => {
  const items = getState().agents;
  return { items, total: items.length, page: 1, pageSize: Math.max(10, items.length) };
});
GET('/me/agents/:id', ({ params }) => {
  const a = getState().agents.find((x) => x.id === params.id);
  if (!a) throw new DemoHttpError(404, 'Agent introuvable');
  return {
    ...a,
    usage: {
      runCount: 128, totalCost: 42.5, monthlyCost: 8.3, avgCostPerTask: 0.32, totalTokens: 3_450_000,
    },
    projects: [
      { id: 'proj_web', key: 'WEB', name: 'Refonte du site vitrine', status: 'ACTIVE', activeTasks: 2 },
    ],
  };
});

// Équipe (vue « Équipe ») — détail avec membres
GET('/teams/:id', ({ params }) => {
  const s = getState();
  const team = s.teams.find((t) => t.id === params.id);
  if (!team) throw new DemoHttpError(404, 'Équipe introuvable');
  const memberIds = DEMO_TEAM_MEMBERS[params.id] ?? [];
  const members = memberIds.map((uid, i) => {
    const u = s.users.find((x) => x.id === uid);
    const idx = s.users.findIndex((x) => x.id === uid);
    const cost = 55 + ((idx < 0 ? 0 : idx) % 6) * 8;
    return {
      userId: uid,
      isLead: i === 0,
      user: {
        id: uid, name: u?.name ?? uid, email: u?.email ?? '',
        canCreateNonBillableProject: null,
        defaultCostRate: cost, defaultBillRate: Math.round(cost * 1.7),
      },
    };
  });
  return { ...team, members };
});
GET('/teams/:id/skills', () => []);
GET('/skills/capabilities', () => ({ canWriteCatalog: false }));

GET('/custom-statuses', () => []);

GET('/time-entries', ({ query }) => {
  const s = getState();
  return s.timeEntries.filter((e) => {
    if (query.projectId) {
      const t = s.tasks.find((x) => x.id === e.taskId);
      if (!t || t.projectId !== query.projectId) return false;
    }
    if (query.from && e.date < query.from) return false;
    if (query.to && e.date > query.to) return false;
    return true;
  });
});

GET('/tasks/:id/comments', ({ params }) =>
  getState().comments.filter((c) => c.taskId === params.id),
);

GET('/me/dashboard', () => computeDashboard());
GET('/timesheet', ({ query }) => {
  const today = new Date();
  const dow = (today.getDay() + 6) % 7;
  const mon = new Date(today.getTime() - dow * 86_400_000);
  const sun = new Date(mon.getTime() + 6 * 86_400_000);
  const from = query.from || mon.toISOString().slice(0, 10);
  const to = query.to || sun.toISOString().slice(0, 10);
  return computeTimesheet(from, to);
});
GET('/me/watching', () => getState().watching);
GET('/clients', () => ({ items: getState().clients, total: getState().clients.length }));
GET('/skills', () => getState().skills);
GET('/teams', () => getState().teams);
GET('/tasks/:id', ({ params }) => {
  const t = getState().tasks.find((x) => x.id === params.id);
  if (!t) throw new DemoHttpError(404, 'Tâche introuvable');
  return t;
});
GET('/tasks/:id/watchers', () => []);
GET('/projects/:id/watchers', () => []);

/* ============================================================
   Mutations (Phase 4) — mutent le store + persist()
   ============================================================ */

const body = (ctx: Ctx) => (ctx.body ?? {}) as Record<string, unknown>;

// Tâches
POST('/projects/:id/tasks', (ctx) => m.createTask(ctx.params.id, body(ctx)));
PATCH('/tasks/:id', (ctx) => m.updateTask(ctx.params.id, body(ctx)));
POST('/tasks/:id/move', (ctx) => m.moveTask(ctx.params.id, body(ctx)));
DELETE('/tasks/:id', (ctx) => m.deleteTask(ctx.params.id));

// Commentaires
POST('/tasks/:id/comments', (ctx) => m.createComment(ctx.params.id, body(ctx)));

// Étiquettes
POST('/projects/:id/labels', (ctx) => m.createLabel(ctx.params.id, body(ctx)));
PATCH('/projects/:id/labels/:labelId', (ctx) => m.updateLabel(ctx.params.id, ctx.params.labelId, body(ctx)));
DELETE('/projects/:id/labels/:labelId', (ctx) => m.deleteLabel(ctx.params.id, ctx.params.labelId));

// Saisies de temps
POST('/time-entries', (ctx) => m.createTimeEntry(body(ctx)));
PATCH('/time-entries/:id', (ctx) => m.updateTimeEntry(ctx.params.id, body(ctx)));
DELETE('/time-entries/:id', (ctx) => m.deleteTimeEntry(ctx.params.id));

// Watchers
POST('/tasks/:id/watch', (ctx) => m.watchTask(ctx.params.id, true));
DELETE('/tasks/:id/watch', (ctx) => m.watchTask(ctx.params.id, false));
POST('/projects/:id/watch', (ctx) => m.watchProject(ctx.params.id, true));
DELETE('/projects/:id/watch', (ctx) => m.watchProject(ctx.params.id, false));

/* ============================================================
   Vues calculées (Phase 5) — dérivées du store
   ============================================================ */

/** Fenêtre par défaut [aujourd'hui-90j, aujourd'hui+90j] si non fournie. */
function win(query: Record<string, string>): { from: string; to: string } {
  const today = new Date();
  const from = query.from || new Date(today.getTime() - 90 * 86_400_000).toISOString().slice(0, 10);
  const to = query.to || new Date(today.getTime() + 90 * 86_400_000).toISOString().slice(0, 10);
  return { from, to };
}

// Plan de charge
GET('/workload', ({ query }) => {
  const { from, to } = win(query);
  return cv.computeWorkload(from, to, query.teamId || undefined);
});

// Gantt / PERT
GET('/projects/:id/gantt', ({ params }) => cv.computeGantt(params.id));

// Reports
GET('/projects/:id/report-widgets', () => cv.computeReportWidgets());
GET('/projects/:id/stats', ({ params }) => cv.computeStats(params.id));
GET('/projects/:id/burndown', ({ params, query }) => {
  const { from, to } = win(query);
  return cv.computeBurndown(params.id, from, to);
});
GET('/projects/:id/due-adherence', ({ params }) => cv.computeDueAdherence(params.id));
GET('/reports/time-breakdown', ({ query }) => {
  const { from, to } = win(query);
  return cv.computeTimeBreakdown(query.projectId ?? '', from, to);
});
GET('/projects/:id/tasks-in-window', ({ params, query }) => {
  const { from, to } = win(query);
  return cv.computeTasksInWindow(params.id, from, to);
});
GET('/projects/:id/cfd', ({ params, query }) => {
  const { from, to } = win(query);
  return { projectId: params.id, from, to, granularity: 'day', points: [] };
});
GET('/projects/:id/quality', ({ params }) => ({
  projectId: params.id, totalTasks: 0, reworkedTasks: 0, reworkRatePct: 0,
  bugCount: 0, bugRatePct: 0, scopeAddedTasks: 0, scopeAddedEstimateHours: 0, hasBaselineDate: false,
}));
GET('/projects/:id/agents-report', ({ params, query }) => {
  const { from, to } = win(query);
  return {
    projectId: params.id, enabled: false, from, to, tasksCompleted: 0, weekly: [],
    approvedDeliverables: 0, firstPassApprovalPct: null, avgReviewRounds: null,
    avgReviewTurnaroundHours: null, activeAgents: 0, runs: 0, tokensIn: 0, tokensOut: 0, perAgent: [],
  };
});
GET('/projects/:id/by-team', ({ params }) => ({ projectId: params.id, hoursByTeam: [], tasksByTeam: [] }));

// Finance
GET('/projects/:id/budget-summary', ({ params }) => cv.computeBudgetSummary(params.id));
GET('/projects/:id/evm', ({ params }) => cv.computeEvm(params.id));
GET('/projects/:id/agent-rates', ({ params }) => cv.computeAgentRates(params.id));
GET('/projects/:id/expenses', () => []);
GET('/finance/portfolio', ({ query }) => {
  const { from, to } = win(query);
  return cv.computePortfolioFinance(from, to);
});

// KPI équipe / portefeuille
GET('/teams/:id/report', ({ params, query }) => {
  const { from, to } = win(query);
  return cv.computeTeamReport(params.id, from, to);
});
GET('/teams/:id/kpi', ({ params, query }) => {
  const { from, to } = win(query);
  return cv.computeTeamKpi(params.id, from, to);
});
GET('/reports/portfolio-kpi', ({ query }) => {
  const { from, to } = win(query);
  return cv.computePortfolioKpi(from, to, query.teamId || undefined);
});

/* ============================================================
   Dispatch
   ============================================================ */

/** Résout un appel. Fallbacks : `/admin`//`/internal` → 404 ; GET inconnu →
 *  `[]` (jamais de crash converter) ; mutation inconnue → 204. */
export async function resolve(
  method: string,
  path: string,
  query: Record<string, string>,
  body: unknown,
): Promise<DemoResult> {
  // Admin & interne : hors périmètre démo.
  if (path.startsWith('/admin/') || path.startsWith('/internal/')) {
    if (path !== '/admin/settings/public') throw new DemoHttpError(404, 'Indisponible en démo');
  }

  // Upload de fichiers : désactivé en démo (aucun stockage S3). On renvoie une
  // erreur claire que l'UI affiche (toast) au moment de l'envoi.
  if (method === 'POST' && typeof FormData !== 'undefined' && body instanceof FormData) {
    throw new DemoHttpError(
      400,
      "L’upload de fichiers est désactivé dans la démo en ligne. Dans le produit réel, vos pièces jointes sont stockées de façon sécurisée (S3 on-premise).",
    );
  }

  // Exports de fichiers (CSV/XLSX/PDF) : rendu serveur non reproductible côté
  // navigateur → on renvoie un petit fichier propre plutôt qu'un JSON vide.
  const extMatch = /\.(csv|xlsx|pdf)$/i.exec(path);
  if (extMatch || /\/(export|billing-export)/.test(path)) {
    const body =
      'Vaks-PM — Export de démonstration\r\n' +
      'Les exports de fichiers (CSV / Excel / PDF) sont désactivés dans la démo en ligne.\r\n' +
      'Dans le produit réel, ce bouton génère le fichier complet côté serveur.\r\n';
    return new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'text/csv;charset=utf-8',
        'Content-Disposition': 'attachment; filename="vaks-demo-export.csv"',
      },
    });
  }

  for (const r of routes) {
    if (r.method !== method) continue;
    const m = r.regex.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
    return r.handler({ params, query, body });
  }

  // Fallback sûr.
  if (method === 'GET') return [];
  return undefined;
}
