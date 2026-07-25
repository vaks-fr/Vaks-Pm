/**
 * Types et helpers SCIM 2.0 (RFC 7643/7644). On implémente le cœur User
 * (provisioning/déprovisioning depuis Entra) ; les Groups sont stubés.
 */

export const SCIM_SCHEMA_USER = 'urn:ietf:params:scim:schemas:core:2.0:User';
export const SCIM_SCHEMA_GROUP = 'urn:ietf:params:scim:schemas:core:2.0:Group';
/** Extension « enterprise user » (RFC 7643 §4.3) — porte `employeeNumber`,
 *  mappé sur notre `User.employeeId` (matricule RH/SIRH). */
export const SCIM_SCHEMA_ENTERPRISE = 'urn:ietf:params:scim:schemas:extension:enterprise:2.0:User';
export const SCIM_SCHEMA_LIST = 'urn:ietf:params:scim:api:messages:2.0:ListResponse';
export const SCIM_SCHEMA_ERROR = 'urn:ietf:params:scim:api:messages:2.0:Error';
export const SCIM_SCHEMA_PATCH = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';
export const SCIM_CONTENT_TYPE = 'application/scim+json';

/** Représentation interne minimale d'un User pour le mapping SCIM. */
export interface UserForScim {
  id: string;
  email: string;
  name: string;
  status: string; // 'ACTIVE' | 'SUSPENDED'
  externalId: string | null;
  employeeId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ScimUser {
  schemas: string[];
  id: string;
  externalId?: string;
  userName: string;
  name: { formatted: string };
  displayName: string;
  emails: Array<{ value: string; primary: boolean; type: string }>;
  active: boolean;
  meta: {
    resourceType: 'User';
    created: string;
    lastModified: string;
    location: string;
  };
  /** Extension enterprise (employeeNumber) ajoutée dynamiquement par clé URN. */
  [urn: string]: unknown;
}

/** Body attendu d'un POST/PUT /Users (sous-ensemble exploité). */
export interface ScimUserWrite {
  userName?: string;
  externalId?: string;
  displayName?: string;
  name?: { formatted?: string; givenName?: string; familyName?: string };
  emails?: Array<{ value?: string; primary?: boolean; type?: string }>;
  active?: boolean;
  /** Extension enterprise (`…enterprise:2.0:User`) avec `employeeNumber`. */
  [urn: string]: unknown;
}

export interface ScimPatchOp {
  schemas?: string[];
  Operations?: Array<{ op: string; path?: string; value?: unknown }>;
}

export function toScimUser(u: UserForScim, baseUrl: string): ScimUser {
  const r: ScimUser = {
    schemas: [SCIM_SCHEMA_USER],
    id: u.id,
    userName: u.email,
    name: { formatted: u.name },
    displayName: u.name,
    emails: [{ value: u.email, primary: true, type: 'work' }],
    active: u.status === 'ACTIVE',
    meta: {
      resourceType: 'User',
      created: u.createdAt.toISOString(),
      lastModified: u.updatedAt.toISOString(),
      location: `${baseUrl}/Users/${u.id}`,
    },
  };
  if (u.externalId) r.externalId = u.externalId;
  if (u.employeeId) {
    r.schemas = [...r.schemas, SCIM_SCHEMA_ENTERPRISE];
    r[SCIM_SCHEMA_ENTERPRISE] = { employeeNumber: u.employeeId };
  }
  return r;
}

export function scimList(resources: object[], total: number, startIndex: number): object {
  return {
    schemas: [SCIM_SCHEMA_LIST],
    totalResults: total,
    startIndex,
    itemsPerPage: resources.length,
    Resources: resources,
  };
}

export function scimError(status: number, detail: string, scimType?: string): object {
  return {
    schemas: [SCIM_SCHEMA_ERROR],
    status: String(status),
    ...(scimType ? { scimType } : {}),
    detail,
  };
}

/** Extrait l'email/userName + name + active d'un body d'écriture. */
export function readWrite(body: ScimUserWrite): {
  email?: string;
  name?: string;
  externalId?: string;
  active?: boolean;
  employeeId?: string;
} {
  const primaryEmail =
    body.emails?.find((e) => e.primary)?.value ?? body.emails?.[0]?.value;
  const email = (body.userName ?? primaryEmail)?.trim().toLowerCase();
  const joined = [body.name?.givenName, body.name?.familyName].filter(Boolean).join(' ');
  const name = body.name?.formatted ?? body.displayName ?? (joined || email);
  const ent = body[SCIM_SCHEMA_ENTERPRISE] as { employeeNumber?: string } | undefined;
  return {
    email,
    name: name?.trim(),
    externalId: body.externalId?.trim(),
    active: typeof body.active === 'boolean' ? body.active : undefined,
    employeeId: ent?.employeeNumber?.toString().trim() || undefined,
  };
}

/**
 * Parse un filtre SCIM simple `attr eq "value"` (le seul utilisé par Entra
 * pour matcher avant create). Renvoie `{ attr, value }` ou null.
 */
export function parseEqFilter(filter?: string): { attr: string; value: string } | null {
  if (!filter) return null;
  const m = /^\s*(\w+)\s+eq\s+"([^"]*)"\s*$/i.exec(filter);
  if (!m) return null;
  return { attr: m[1], value: m[2] };
}

/**
 * Applique une liste d'opérations PATCH (RFC 7644 §3.5.2) sur un delta
 * `{ name?, active?, email? }`. Gère les formes Entra : `op replace` avec
 * `path` ("active", "displayName", "name.formatted") OU avec un `value` objet.
 */
export function applyPatch(ops: ScimPatchOp['Operations']): {
  name?: string;
  active?: boolean;
  email?: string;
  employeeId?: string | null;
} {
  const delta: { name?: string; active?: boolean; email?: string; employeeId?: string | null } = {};
  for (const op of ops ?? []) {
    const verb = (op.op || '').toLowerCase();
    if (verb !== 'replace' && verb !== 'add' && verb !== 'remove') continue;
    const path = (op.path || '').toLowerCase();
    const val = op.value;
    if (path === 'active') {
      delta.active = val === true || val === 'true' || val === 'True';
    } else if (path === 'displayname' || path === 'name.formatted') {
      if (typeof val === 'string') delta.name = val;
    } else if (path === 'username') {
      if (typeof val === 'string') delta.email = val.trim().toLowerCase();
    } else if (path.endsWith('employeenumber')) {
      // Extension enterprise → User.employeeId. remove / valeur vide = effacer.
      delta.employeeId = verb === 'remove' || val == null || val === ''
        ? null
        : String(val).trim();
    } else if (!op.path && val && typeof val === 'object') {
      // Forme "replace whole" : value = { active?, displayName?, name?, userName? }
      const v = val as ScimUserWrite & { active?: boolean };
      if (typeof v.active === 'boolean') delta.active = v.active;
      const nm = v.name?.formatted ?? v.displayName;
      if (typeof nm === 'string') delta.name = nm;
      if (typeof v.userName === 'string') delta.email = v.userName.trim().toLowerCase();
      const ent = v[SCIM_SCHEMA_ENTERPRISE] as { employeeNumber?: string } | undefined;
      if (ent && 'employeeNumber' in ent) delta.employeeId = ent.employeeNumber?.toString().trim() || null;
    }
  }
  return delta;
}

// ============================================================
// Groups (→ Teams)
// ============================================================

/** Représentation interne minimale d'une Team pour le mapping SCIM Group. */
export interface TeamForScim {
  id: string;
  name: string;
  externalId: string | null;
  createdAt: Date;
  updatedAt: Date;
  members: Array<{ userId: string; name: string }>;
}

export interface ScimGroup {
  schemas: string[];
  id: string;
  externalId?: string;
  displayName: string;
  members: Array<{ value: string; display?: string; $ref?: string }>;
  meta: { resourceType: 'Group'; created: string; lastModified: string; location: string };
}

export interface ScimGroupWrite {
  displayName?: string;
  externalId?: string;
  members?: Array<{ value?: string; display?: string }>;
}

export function toScimGroup(t: TeamForScim, baseUrl: string): ScimGroup {
  const g: ScimGroup = {
    schemas: [SCIM_SCHEMA_GROUP],
    id: t.id,
    displayName: t.name,
    members: t.members.map((m) => ({
      value: m.userId,
      display: m.name,
      $ref: `${baseUrl}/Users/${m.userId}`,
    })),
    meta: {
      resourceType: 'Group',
      created: t.createdAt.toISOString(),
      lastModified: t.updatedAt.toISOString(),
      location: `${baseUrl}/Groups/${t.id}`,
    },
  };
  if (t.externalId) g.externalId = t.externalId;
  return g;
}

/** Délta résolu d'un PATCH de groupe. `replaceMembers` non-undefined = on
 *  REMPLACE l'ensemble des membres par cette liste. */
export interface GroupPatchDelta {
  displayName?: string;
  externalId?: string;
  addMembers: string[];
  removeMembers: string[];
  replaceMembers?: string[];
}

function membersFromValue(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v
    .map((m) => (m && typeof m === 'object' ? (m as { value?: string }).value : undefined))
    .filter((x): x is string => typeof x === 'string' && x.length > 0);
}

/**
 * Parse les opérations PATCH d'un groupe (RFC 7644 + formes Entra).
 * Gère : displayName/externalId replace ; members add/replace (value array) ;
 * members remove par `value` array OU par path filtré `members[value eq "x"]`.
 */
export function parseGroupPatch(ops: ScimPatchOp['Operations']): GroupPatchDelta {
  const d: GroupPatchDelta = { addMembers: [], removeMembers: [] };
  for (const op of ops ?? []) {
    const verb = (op.op || '').toLowerCase();
    const path = op.path || '';
    const lpath = path.toLowerCase();
    const val = op.value;
    // path filtré : members[value eq "<id>"]
    const m = /members\[value eq "([^"]+)"\]/i.exec(path);
    if (m) {
      if (verb === 'remove') d.removeMembers.push(m[1]);
      else if (verb === 'add' || verb === 'replace') d.addMembers.push(m[1]);
      continue;
    }
    if (lpath === 'members') {
      if (verb === 'add') d.addMembers.push(...membersFromValue(val));
      else if (verb === 'replace') d.replaceMembers = membersFromValue(val);
      else if (verb === 'remove') {
        const ids = membersFromValue(val);
        if (ids.length) d.removeMembers.push(...ids);
        else d.replaceMembers = []; // remove sans cible = vider
      }
      continue;
    }
    if (lpath === 'displayname' && typeof val === 'string') d.displayName = val;
    else if (lpath === 'externalid' && typeof val === 'string') d.externalId = val;
    else if (!op.path && val && typeof val === 'object') {
      const v = val as ScimGroupWrite;
      if (typeof v.displayName === 'string') d.displayName = v.displayName;
      if (typeof v.externalId === 'string') d.externalId = v.externalId;
      if (Array.isArray(v.members)) d.replaceMembers = membersFromValue(v.members);
    }
  }
  return d;
}
