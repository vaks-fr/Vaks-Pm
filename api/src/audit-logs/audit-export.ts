/**
 * Formats d'export SIEM : JSON Lines (1 objet/ligne) et CEF (ArcSight
 * Common Event Format) + helpers de parsing/streaming partagés entre le
 * controller admin (`/admin/audit-logs`) et le controller public
 * (`/audit-logs`, scope `audit:read`).
 */
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import type { Response } from 'express';
import type { AuditActorType, AuditListFilters, AuditLogService, AuditOutcome, AuditSeverity } from './audit-log.service';

/** Minimal contrat licence — évite un import de service dans ce module utilitaire. */
interface LicenseGate {
  hasFeature(feature: 'siem-export'): Promise<boolean>;
}

/**
 * Le format **CEF** (ArcSight, destiné aux SIEM) relève de la feature premium
 * `siem-export` ; JSON Lines reste du core gratuit. Utilisé par les deux
 * controllers d'export (admin + API publique). 403 `LICENSE_FEATURE_DISABLED`
 * si CEF est demandé sans licence.
 */
export async function assertExportFormatLicensed(
  query: Record<string, string | undefined>,
  licenses: LicenseGate,
): Promise<void> {
  if (query.format === 'cef' && !(await licenses.hasFeature('siem-export'))) {
    throw new ForbiddenException({
      statusCode: 403,
      error: 'LICENSE_FEATURE_DISABLED',
      message:
        "L'export CEF (SIEM) requiert une licence active (« siem-export »). " +
        'Utilisez le format JSON Lines, ou contactez votre éditeur.',
      feature: 'siem-export',
    });
  }
}

const ACTOR_TYPES = ['USER', 'API_TOKEN', 'AGENT', 'SYSTEM', 'ANONYMOUS'];

const EXPORT_BATCH = 1_000;
const EXPORT_MAX_ROWS = 100_000;

/** Valide + normalise les query params de listing/export (400 si invalides). */
export function parseAuditFilters(q: Record<string, string | undefined>): AuditListFilters {
  for (const k of ['from', 'to'] as const) {
    if (q[k] && Number.isNaN(new Date(q[k]!).getTime())) {
      throw new BadRequestException(`${k} : date invalide`);
    }
  }
  if (q.severity && !['INFO', 'WARNING', 'CRITICAL'].includes(q.severity)) {
    throw new BadRequestException('severity invalide');
  }
  if (q.outcome && !['SUCCESS', 'FAILURE'].includes(q.outcome)) {
    throw new BadRequestException('outcome invalide');
  }
  if (q.actorType && !ACTOR_TYPES.includes(q.actorType)) {
    throw new BadRequestException('actorType invalide');
  }
  return {
    from: q.from,
    to: q.to,
    action: q.action,
    actorId: q.actorId,
    actorType: q.actorType as AuditActorType | undefined,
    severity: q.severity as AuditSeverity | undefined,
    outcome: q.outcome as AuditOutcome | undefined,
    resourceType: q.resourceType,
    resourceId: q.resourceId,
    q: q.q,
  };
}

/**
 * Export streaming JSON Lines / CEF — keyset par lots de 1000, cap 100 000
 * lignes. Écrit directement dans la réponse (Content-Disposition attachment).
 */
export async function streamAuditExport(
  audit: AuditLogService,
  orgId: string,
  query: Record<string, string | undefined>,
  res: Response,
): Promise<void> {
  const format = query.format === 'cef' ? 'cef' : 'jsonl';
  const filters = parseAuditFilters(query);
  const stamp = new Date().toISOString().slice(0, 10);
  res.setHeader(
    'Content-Type',
    format === 'cef' ? 'text/plain; charset=utf-8' : 'application/x-ndjson',
  );
  res.setHeader('Content-Disposition', `attachment; filename="audit-${stamp}.${format}"`);
  let cursor: string | undefined;
  let written = 0;
  for (;;) {
    const { items, nextCursor } = await audit.list(orgId, {
      ...filters,
      cursor,
      pageSize: EXPORT_BATCH,
    });
    for (const row of items) {
      res.write((format === 'cef' ? toCefLine(row) : toJsonLine(row)) + '\n');
    }
    written += items.length;
    if (!nextCursor || written >= EXPORT_MAX_ROWS) break;
    cursor = nextCursor;
  }
  res.end();
}

interface AuditRowLike {
  id: string;
  organizationId: string;
  createdAt: Date;
  action: string;
  severity: string;
  outcome: string;
  actorType: string;
  actorId: string | null;
  actorLabel: string | null;
  resourceType: string | null;
  resourceId: string | null;
  resourceLabel: string | null;
  route: string | null;
  method: string | null;
  statusCode: number | null;
  ip: string | null;
  userAgent: string | null;
  detail: unknown;
}

export const CEF_VENDOR = 'Vaks';
export const CEF_PRODUCT = 'VaksPM';
export const CEF_VERSION = '1.0';

const CEF_SEVERITY: Record<string, number> = { INFO: 3, WARNING: 6, CRITICAL: 9 };

/** Échappement CEF : `\` et `|` dans l'en-tête ; `\` et `=` dans les extensions. */
function cefHeaderEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/\|/g, '\\|');
}
function cefExtEscape(v: string): string {
  return v.replace(/\\/g, '\\\\').replace(/=/g, '\\=').replace(/\r?\n/g, ' ');
}

export function toJsonLine(row: AuditRowLike): string {
  return JSON.stringify({
    id: row.id,
    organizationId: row.organizationId,
    createdAt: row.createdAt.toISOString(),
    action: row.action,
    severity: row.severity,
    outcome: row.outcome,
    actorType: row.actorType,
    actorId: row.actorId,
    actorLabel: row.actorLabel,
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    resourceLabel: row.resourceLabel,
    route: row.route,
    method: row.method,
    statusCode: row.statusCode,
    ip: row.ip,
    userAgent: row.userAgent,
    detail: row.detail ?? undefined,
  });
}

export function toCefLine(row: AuditRowLike): string {
  const sev = CEF_SEVERITY[row.severity] ?? 3;
  const ext: string[] = [`rt=${row.createdAt.getTime()}`, `outcome=${row.outcome}`];
  if (row.actorLabel) ext.push(`suser=${cefExtEscape(row.actorLabel)}`);
  if (row.actorId) ext.push(`suid=${cefExtEscape(row.actorId)}`);
  if (row.ip) ext.push(`src=${cefExtEscape(row.ip)}`);
  if (row.method) ext.push(`requestMethod=${cefExtEscape(row.method)}`);
  if (row.route) ext.push(`request=${cefExtEscape(row.route)}`);
  if (row.resourceType) ext.push(`cs1Label=resourceType cs1=${cefExtEscape(row.resourceType)}`);
  if (row.resourceId) ext.push(`cs2Label=resourceId cs2=${cefExtEscape(row.resourceId)}`);
  if (row.resourceLabel) ext.push(`cs4Label=resourceLabel cs4=${cefExtEscape(row.resourceLabel)}`);
  ext.push(`cs3Label=org cs3=${cefExtEscape(row.organizationId)}`);
  ext.push(`externalId=${cefExtEscape(row.id)}`);
  const action = cefHeaderEscape(row.action);
  return `CEF:0|${CEF_VENDOR}|${CEF_PRODUCT}|${CEF_VERSION}|${action}|${action}|${sev}|${ext.join(' ')}`;
}
