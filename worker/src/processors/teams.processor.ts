import { TeamsJob } from '../queues';
import { internalHeaders } from '../internal-headers';

/**
 * Worker BullMQ pour la file `teams` (provisioning Microsoft Teams via Graph).
 *
 * Le worker est **stateless** : il ne lit ni conf ni secret. Il récupère un
 * contexte prêt à l'emploi auprès de l'API interne (token app Graph minté côté
 * API à partir du client secret chiffré, config snapshotée, membres résolus en
 * objectId Entra), exécute les appels Graph, puis POST le résultat. Le client
 * secret ne transite jamais par Redis ni par le worker.
 *
 * Idempotence/retries gérés par BullMQ (5 tentatives, backoff exp.).
 */

const GRAPH = 'https://graph.microsoft.com/v1.0';
const TIMEOUT_MS = 20_000;
const POLL_INTERVAL_MS = 3_000;
const POLL_MAX_TRIES = 20; // ~60 s : la création d'équipe Graph est asynchrone

interface ProvisionMember {
  objectId: string;
  /** true = à poser comme owner (au moins un owner est requis en app-only). */
  owner?: boolean;
}

interface ProvisionContext {
  token: string;
  teamName: string;
  description?: string;
  visibility: 'private' | 'public';
  channels: string[];
  /** Disposition des channels : `post` (Publications, défaut Teams) / `chat` (Fils de discussion). */
  channelLayout: 'post' | 'chat';
  /** Team déjà provisionnée (idempotence / archive / unarchive). */
  existingTeamId: string | null;
  members: ProvisionMember[];
  /** Comptes locaux sans externalId Entra, non invitables (compté pour le log). */
  membersSkipped: number;
  /** Reconcile : retirer de Teams les membres qui ne sont plus désirés (opt-in). */
  removeOnLeave: boolean;
}

interface ResultBody {
  action: TeamsJob['action'];
  status: 'SUCCESS' | 'FAILED' | 'PARTIAL';
  teamId?: string | null;
  /** Lien « ouvrir l'équipe dans Teams » (propriété `webUrl` du team Graph). */
  webUrl?: string | null;
  membersAdded?: number;
  membersSkipped?: number;
  error?: string | null;
  /** Échec DÉFINITIF (dernière tentative épuisée, ou cas non-retryable connu
   *  à l'avance) — signale à l'API qu'il faut alerter les admins du tenant,
   *  par opposition à un échec transitoire qui sera retenté par BullMQ. */
  terminal?: boolean;
  /** Numéro de la tentative ayant produit ce résultat (informatif). */
  attempts?: number;
}

async function fetchContext(job: TeamsJob): Promise<ProvisionContext | null> {
  const base = process.env.INTERNAL_API_URL ?? 'http://api:3000';
  const url = `${base}/api/v1/internal/teams-provisioning/projects/${job.projectId}/context?action=${job.action}`;
  const res = await fetch(url, { headers: internalHeaders(job.tenantSlug) });
  if (!res.ok) {
    const txt = await safeText(res);
    throw new Error(`context HTTP ${res.status}${txt ? ` — ${txt}` : ''}`);
  }
  const txt = await res.text();
  if (!txt) return null;
  return JSON.parse(txt) as ProvisionContext;
}

async function reportResult(job: TeamsJob, body: ResultBody): Promise<void> {
  const base = process.env.INTERNAL_API_URL ?? 'http://api:3000';
  try {
    await fetch(`${base}/api/v1/internal/teams-provisioning/projects/${job.projectId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', ...internalHeaders(job.tenantSlug) },
      body: JSON.stringify(body),
    });
  } catch {
    /* best-effort observability */
  }
}

/** Appel Graph générique avec timeout + parsing d'erreur lisible. */
async function graph(
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; headers: Headers; json: any }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(path.startsWith('http') ? path : `${GRAPH}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: ctrl.signal,
    });
    let json: any = null;
    const txt = await safeText(res);
    if (txt) {
      try {
        json = JSON.parse(txt);
      } catch {
        json = { raw: txt };
      }
    }
    return { status: res.status, headers: res.headers, json };
  } finally {
    clearTimeout(timer);
  }
}

function graphError(prefix: string, status: number, json: any): Error {
  const msg = json?.error?.message || json?.raw || `HTTP ${status}`;
  return new Error(`${prefix}: ${msg} (HTTP ${status})`);
}

async function safeText(res: Response): Promise<string | null> {
  try {
    const t = await res.text();
    return t || null;
  } catch {
    return null;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * Crée l'équipe à partir du template `standard`. En app-only, le corps DOIT
 * contenir au moins un membre `owner`. La création est asynchrone : Graph
 * renvoie 202 + un header `Content-Location: /teams/{id}` (l'id de l'équipe) et
 * `Location` vers l'opération à poller.
 */
async function createTeam(ctx: ProvisionContext): Promise<{ teamId: string; webUrl: string | null }> {
  const owner = ctx.members.find((m) => m.owner) ?? ctx.members[0];
  if (!owner) {
    throw new Error(
      'Aucun membre lié à Entra (externalId) disponible comme owner — impossible de créer l’équipe en app-only.',
    );
  }
  const body: Record<string, unknown> = {
    'template@odata.bind': `${GRAPH}/teamsTemplates('standard')`,
    displayName: ctx.teamName,
    description: ctx.description || ctx.teamName,
    visibility: ctx.visibility === 'public' ? 'Public' : 'Private',
    members: [
      {
        '@odata.type': '#microsoft.graph.aadUserConversationMember',
        roles: ['owner'],
        'user@odata.bind': `${GRAPH}/users('${owner.objectId}')`,
      },
    ],
  };
  const res = await graph(ctx.token, 'POST', '/teams', body);
  if (res.status !== 202 && res.status !== 201) {
    throw graphError('Création de l’équipe refusée', res.status, res.json);
  }
  // Content-Location: /teams/{teamId}
  const contentLoc = res.headers.get('content-location') || res.headers.get('location') || '';
  const m = contentLoc.match(/teams\(?'?([0-9a-f-]{36})'?\)?/i) || contentLoc.match(/teams\/([0-9a-f-]{36})/i);
  const teamId = m?.[1];
  if (!teamId) {
    throw new Error(`Création acceptée mais teamId introuvable (Content-Location="${contentLoc}")`);
  }
  // Poll : l'équipe n'est exploitable (channels/membres) qu'une fois provisionnée.
  const webUrl = await waitForTeam(ctx.token, teamId);
  return { teamId, webUrl };
}

/**
 * Attend que l'équipe réponde (propagation Graph après le 202) et renvoie son
 * `webUrl` (lien « ouvrir dans Teams »), stocké ensuite comme lien de l'espace
 * de collaboration côté vaks.
 */
async function waitForTeam(token: string, teamId: string): Promise<string | null> {
  for (let i = 0; i < POLL_MAX_TRIES; i++) {
    const res = await graph(token, 'GET', `/teams/${teamId}`);
    if (res.status === 200) return typeof res.json?.webUrl === 'string' ? res.json.webUrl : null;
    if (res.status !== 404) {
      // 404 = pas encore propagé ; autre code = erreur réelle
      throw graphError('Lecture de l’équipe', res.status, res.json);
    }
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error(`L’équipe ${teamId} n’est pas devenue disponible après ${POLL_MAX_TRIES} essais`);
}

/** Lit le `webUrl` d'une équipe existante (best-effort — null si indisponible). */
async function getTeamWebUrl(token: string, teamId: string): Promise<string | null> {
  try {
    const res = await graph(token, 'GET', `/teams/${teamId}`);
    return res.status === 200 && typeof res.json?.webUrl === 'string' ? res.json.webUrl : null;
  } catch {
    return null;
  }
}

/**
 * Crée les channels configurés (best-effort : un échec n'annule pas le reste).
 * `layoutType` définit la disposition (`post` = Publications, `chat` = Fils de
 * discussion) demandée par l'admin ; Teams applique `post` par défaut sinon.
 */
async function createChannels(ctx: ProvisionContext, teamId: string): Promise<void> {
  for (const name of ctx.channels) {
    const res = await graph(ctx.token, 'POST', `/teams/${teamId}/channels`, {
      displayName: name,
      membershipType: 'standard',
      layoutType: ctx.channelLayout,
    });
    // 201 = créé ; 409 = déjà présent (idempotent) — on tolère les deux.
    if (res.status !== 201 && res.status !== 409 && res.status !== 200) {
      // Loggué côté worker, non bloquant.
      console.error(`[teams] channel "${name}" KO: HTTP ${res.status} ${res.json?.error?.message ?? ''}`);
    }
  }
}

/**
 * Aligne la disposition du canal **General** (créé par le template `standard`
 * en `post`) sur le mode demandé. No-op si `post` (déjà le défaut Teams). Le
 * canal primaire est résolu via `/teams/{id}/primaryChannel`. Best-effort : un
 * échec n'annule pas le provisioning.
 */
async function setPrimaryChannelLayout(ctx: ProvisionContext, teamId: string): Promise<void> {
  if (ctx.channelLayout !== 'chat') return;
  const primary = await graph(ctx.token, 'GET', `/teams/${teamId}/primaryChannel`);
  const channelId = typeof primary.json?.id === 'string' ? primary.json.id : null;
  if (primary.status !== 200 || !channelId) {
    console.error(`[teams] primaryChannel introuvable: HTTP ${primary.status} ${primary.json?.error?.message ?? ''}`);
    return;
  }
  const res = await graph(ctx.token, 'PATCH', `/teams/${teamId}/channels/${encodeURIComponent(channelId)}`, {
    layoutType: ctx.channelLayout,
  });
  if (res.status !== 204 && res.status !== 200) {
    console.error(`[teams] General layoutType KO: HTTP ${res.status} ${res.json?.error?.message ?? ''}`);
  }
}

/**
 * Ajoute les membres (hors owner déjà posé à la création). Renvoie le nombre
 * effectivement ajoutés. Un membre déjà présent (409) compte comme succès.
 */
async function addMembers(ctx: ProvisionContext, teamId: string, ownerId: string): Promise<number> {
  let added = 0;
  for (const m of ctx.members) {
    if (m.objectId === ownerId) continue; // owner déjà membre
    const body = {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      roles: m.owner ? ['owner'] : [],
      'user@odata.bind': `${GRAPH}/users('${m.objectId}')`,
    };
    const res = await graph(ctx.token, 'POST', `/teams/${teamId}/members`, body);
    if (res.status === 201 || res.status === 200) added++;
    else if (res.status === 409) added++; // déjà membre
    else console.error(`[teams] add member ${m.objectId} KO: HTTP ${res.status} ${res.json?.error?.message ?? ''}`);
  }
  return added;
}

/** Liste les membres actuels de l'équipe (avec pagination Graph). */
async function listTeamMembers(
  token: string,
  teamId: string,
): Promise<Array<{ membershipId: string; objectId: string; owner: boolean }>> {
  const out: Array<{ membershipId: string; objectId: string; owner: boolean }> = [];
  let url: string | undefined = `/teams/${teamId}/members`;
  for (let guard = 0; guard < 20 && url; guard++) {
    const res = await graph(token, 'GET', url);
    if (res.status !== 200) throw graphError('Lecture des membres', res.status, res.json);
    const vals: any[] = Array.isArray(res.json?.value) ? res.json.value : [];
    for (const v of vals) {
      out.push({
        membershipId: String(v.id ?? ''),
        objectId: String(v.userId ?? '').toLowerCase(),
        owner: Array.isArray(v.roles) && v.roles.includes('owner'),
      });
    }
    url = typeof res.json?.['@odata.nextLink'] === 'string' ? res.json['@odata.nextLink'] : undefined;
  }
  return out.filter((m) => m.objectId && m.membershipId);
}

/**
 * Réconcilie la membership : ajoute les désirés manquants ; retire les présents
 * non désirés UNIQUEMENT si `removeOnLeave` (et jamais un owner — protège
 * l'équipe et évite de retirer le dernier propriétaire).
 */
async function reconcileMembers(
  ctx: ProvisionContext,
  teamId: string,
): Promise<{ added: number; removed: number }> {
  const actual = await listTeamMembers(ctx.token, teamId);
  const actualObjs = new Set(actual.map((a) => a.objectId));
  const desiredObjs = new Set(ctx.members.map((m) => m.objectId.toLowerCase()));

  let added = 0;
  for (const m of ctx.members) {
    if (actualObjs.has(m.objectId.toLowerCase())) continue;
    const body = {
      '@odata.type': '#microsoft.graph.aadUserConversationMember',
      roles: m.owner ? ['owner'] : [],
      'user@odata.bind': `${GRAPH}/users('${m.objectId}')`,
    };
    const res = await graph(ctx.token, 'POST', `/teams/${teamId}/members`, body);
    if (res.status === 201 || res.status === 200 || res.status === 409) added++;
    else console.error(`[teams] reconcile add ${m.objectId} KO: HTTP ${res.status} ${res.json?.error?.message ?? ''}`);
  }

  let removed = 0;
  if (ctx.removeOnLeave) {
    for (const a of actual) {
      if (desiredObjs.has(a.objectId) || a.owner) continue; // jamais retirer un owner
      const res = await graph(ctx.token, 'DELETE', `/teams/${teamId}/members/${a.membershipId}`);
      if (res.status === 200 || res.status === 204) removed++;
      else console.error(`[teams] reconcile remove ${a.objectId} KO: HTTP ${res.status}`);
    }
  }
  return { added, removed };
}

export async function processTeams(
  job: TeamsJob,
  attempt?: number,
  maxAttempts?: number,
): Promise<void> {
  const isTerminal = attempt !== undefined && maxAttempts !== undefined && attempt >= maxAttempts;
  let ctx: ProvisionContext | null;
  try {
    ctx = await fetchContext(job);
  } catch (err) {
    // fetchContext peut THROW (ex. `context HTTP 500` côté API) et cet appel est
    // HORS du try principal plus bas — sans ce catch, l'échec de récupération du
    // contexte (le cas le plus fréquent en boucle de retry) ne déclenchait JAMAIS
    // l'alerte terminale. On reporte FAILED+terminal à la dernière tentative puis
    // on relance (BullMQ ne retente plus au-delà de maxAttempts).
    const msg = err instanceof Error ? err.message : String(err);
    await reportResult(job, {
      action: job.action,
      status: 'FAILED',
      error: msg,
      terminal: isTerminal,
      attempts: attempt,
    });
    throw err instanceof Error ? err : new Error(msg);
  }
  if (!ctx) {
    // Bénin : projet supprimé entre l'enqueue et l'exécution, ou feature
    // désactivée entre-temps — PAS actionnable par un admin, pas d'alerte.
    await reportResult(job, {
      action: job.action,
      status: 'FAILED',
      error: 'Contexte de provisioning introuvable (projet supprimé ou feature désactivée ?)',
    });
    return; // pas de retry
  }

  try {
    if (job.action === 'archive') {
      if (!ctx.existingTeamId) {
        await reportResult(job, { action: 'archive', status: 'SUCCESS', error: null });
        return;
      }
      const res = await graph(ctx.token, 'POST', `/teams/${ctx.existingTeamId}/archive`, {
        shouldSetSpoSiteReadOnlyForMembers: false,
      });
      if (res.status !== 202 && res.status !== 200) throw graphError('Archivage', res.status, res.json);
      await reportResult(job, { action: 'archive', status: 'SUCCESS', teamId: ctx.existingTeamId });
      return;
    }

    if (job.action === 'unarchive') {
      if (!ctx.existingTeamId) {
        await reportResult(job, { action: 'unarchive', status: 'FAILED', error: 'Aucune équipe à désarchiver' });
        return;
      }
      const res = await graph(ctx.token, 'POST', `/teams/${ctx.existingTeamId}/unarchive`);
      if (res.status !== 202 && res.status !== 200) throw graphError('Désarchivage', res.status, res.json);
      await reportResult(job, { action: 'unarchive', status: 'SUCCESS', teamId: ctx.existingTeamId });
      return;
    }

    if (job.action === 'reconcile') {
      if (!ctx.existingTeamId) {
        await reportResult(job, { action: 'reconcile', status: 'FAILED', error: 'Aucune équipe à réconcilier' });
        return;
      }
      const { added, removed } = await reconcileMembers(ctx, ctx.existingTeamId);
      if (added > 0 || removed > 0) {
        console.log(`[teams] reconcile ${ctx.existingTeamId}: +${added} / -${removed}`);
      }
      await reportResult(job, {
        action: 'reconcile',
        status: 'SUCCESS',
        teamId: ctx.existingTeamId,
        membersAdded: added,
        membersSkipped: ctx.membersSkipped,
      });
      return;
    }

    // action === 'provision'
    // Condition PERMANENTE (pas de retry) : aucune équipe existante et aucun
    // membre lié à Entra → impossible de désigner un owner en app-only.
    if (!ctx.existingTeamId && ctx.members.length === 0) {
      await reportResult(job, {
        action: 'provision',
        status: 'FAILED',
        membersSkipped: ctx.membersSkipped,
        error:
          'Aucun membre lié à Entra (externalId) sur ce projet — ajoutez au moins un utilisateur ' +
          'provenant de votre annuaire Entra (via SSO/SCIM) comme membre du projet.',
        terminal: true, // actionnable par un admin, pas transitoire → alerte
        attempts: attempt ?? 1,
      });
      return; // terminal : on ne relance pas
    }
    let teamId: string;
    let webUrl: string | null;
    if (ctx.existingTeamId) {
      teamId = ctx.existingTeamId;
      webUrl = await getTeamWebUrl(ctx.token, teamId); // re-provisioning : relit le lien
    } else {
      ({ teamId, webUrl } = await createTeam(ctx));
      // Persiste le teamId DÈS qu'il est connu, avant les étapes best-effort
      // (channels/membres) qui peuvent throw. Sans ça, un retry BullMQ après
      // un échec ici relirait existingTeamId=null et recréerait une équipe en
      // double (createTeam n'est pas idempotent côté Graph app-only).
      await reportResult(job, { action: 'provision', status: 'SUCCESS', teamId, webUrl });
    }
    const owner = ctx.members.find((m) => m.owner) ?? ctx.members[0];
    await setPrimaryChannelLayout(ctx, teamId);
    await createChannels(ctx, teamId);
    const added = await addMembers(ctx, teamId, owner?.objectId ?? '');
    const status: ResultBody['status'] = ctx.membersSkipped > 0 ? 'PARTIAL' : 'SUCCESS';
    console.log(`[teams] provisioned team ${teamId} (${status}, +${added + (owner ? 1 : 0)} members)`);
    await reportResult(job, {
      action: 'provision',
      status,
      teamId,
      webUrl,
      membersAdded: added + (owner ? 1 : 0),
      membersSkipped: ctx.membersSkipped,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    // Dernière tentative épuisée → échec DÉFINITIF, silencieux sinon : le
    // signale à l'API (alerte admins) AVANT de rethrow.
    const isTerminal = attempt !== undefined && maxAttempts !== undefined && attempt >= maxAttempts;
    await reportResult(job, {
      action: job.action,
      status: 'FAILED',
      error: msg,
      terminal: isTerminal,
      attempts: attempt,
    });
    throw err instanceof Error ? err : new Error(msg); // laisse BullMQ retry
  }
}
