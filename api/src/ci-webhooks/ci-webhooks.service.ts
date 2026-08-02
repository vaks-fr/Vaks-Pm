import { Injectable, Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { AuditLogService } from '../audit-logs/audit-log.service';
import { AUDIT_ACTIONS } from '../audit-logs/audit-actions';
import { CiConnectorsService } from './ci-connectors.service';
import {
  CiProvider,
  isCiProvider,
  parseCiPayload,
  signatureHeaderFor,
  verifyCiSignature,
} from './ci-providers';

/** TTL du buffer des résultats CI en attente d'appariement (§8.1). */
const PENDING_TTL_MS = 24 * 60 * 60 * 1000;

export interface CiIngestResult {
  ok: boolean;
  /** Payload reçu mais non exploitable (ping, run en cours…) — pas une erreur. */
  ignored?: boolean;
  reason?: string;
}

/**
 * Corroboration serveur d'une preuve `ci_signed` (§3, §6 porte 2). vaks-pm ne
 * fait JAMAIS confiance au `status` déclaré par l'agent pour `ci_signed` : il le
 * dérive du résultat CI **signé** reçu via webhook et bufferisé, matché par
 * `commitSha`. `corroborated:false` = aucune preuve signée trouvée (→ statut
 * `pending`, gate WAIT).
 */
export interface CiCorroboration {
  status: 'pass' | 'fail' | 'pending';
  corroborated: boolean;
  reason: 'matched' | 'no_result' | 'no_commit_sha' | 'repo_mismatch';
  provider: string | null;
  conclusion: string | null;
  runUrl: string | null;
  commitSha: string | null;
  /** Dépôt d'origine du build matché (ou du build rejeté en `repo_mismatch`). */
  repo: string | null;
}

/**
 * Webhooks CI ENTRANTS (phase C, AGENTS_VERIFICATION.md §9.2). vaks-pm reçoit un
 * résultat signé que la CI pousse, vérifie la signature HMAC (seule opération
 * « active »), et bufferise le verdict par `commitSha` pour l'apparier au
 * livrable `ci_signed` au moment du gate. AUCUN accès sortant.
 */
@Injectable()
export class CiWebhooksService {
  private readonly log = new Logger(CiWebhooksService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: CiConnectorsService,
    private readonly audit: AuditLogService,
  ) {}

  /**
   * Ingère un webhook CI. Le contexte tenant (org) est déjà posé par le
   * `TenantMiddleware` depuis le Host (mode pooled). Fail-safe : on ne throw
   * jamais côté appelant HTTP au-delà d'un statut ; la CI ne doit pas boucler.
   */
  async ingest(
    provider: string,
    rawBody: Buffer | undefined,
    headers: Record<string, string | string[] | undefined>,
    parsedBody: unknown,
  ): Promise<CiIngestResult> {
    const prov = provider.trim().toLowerCase();
    if (!isCiProvider(prov)) return { ok: false, reason: 'unknown_provider' };

    const org = await this.prisma.organization.findFirst({ select: { id: true } });
    if (!org) {
      this.log.warn(`CI webhook reçu (provider=${prov}) mais aucune org dans le contexte tenant`);
      return { ok: false, reason: 'no_tenant' };
    }
    const orgId = org.id;

    const secret = await this.connectors.getActiveSecret(orgId, prov);
    if (!secret) {
      await this.reject(orgId, prov, 'no_connector', null);
      return { ok: false, reason: 'no_connector' };
    }

    const sigHeader = headers[signatureHeaderFor(prov as CiProvider)];
    const signature = Array.isArray(sigHeader) ? sigHeader[0] : sigHeader;
    // Le raw body est indispensable : signer le body re-sérialisé ne matcherait
    // pas (espaces, ordre des clés). `main.ts` le capture via le hook `verify`.
    const body = rawBody ?? Buffer.from(typeof parsedBody === 'string' ? parsedBody : JSON.stringify(parsedBody ?? {}), 'utf8');
    if (!verifyCiSignature(secret, body, signature)) {
      await this.reject(orgId, prov, 'bad_signature', null);
      await this.connectors.noteEvent(orgId, prov, false, 'signature invalide');
      return { ok: false, reason: 'bad_signature' };
    }

    const parsed = parseCiPayload(prov as CiProvider, parsedBody);
    if (!parsed) {
      // Signature valide mais événement non terminal (ping, run en cours) → no-op.
      await this.connectors.noteEvent(orgId, prov, true, null);
      return { ok: true, ignored: true, reason: 'not_terminal' };
    }

    const payloadSha256 = createHash('sha256').update(body).digest('hex');
    const now = new Date();
    await this.prisma.ciResultPending.create({
      data: {
        organizationId: orgId,
        provider: prov,
        commitSha: parsed.commitSha,
        conclusion: parsed.conclusion,
        runId: parsed.runId,
        runUrl: parsed.runUrl,
        repo: parsed.repo,
        payloadSha256,
        receivedAt: now,
        expiresAt: new Date(now.getTime() + PENDING_TTL_MS),
      },
    });
    await this.connectors.noteEvent(orgId, prov, true, null);
    void this.audit.log({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CI_RESULT_RECEIVED,
      severity: 'INFO',
      actorType: 'SYSTEM',
      resourceType: 'ciResult',
      resourceLabel: `${prov}:${parsed.commitSha.slice(0, 12)}`,
      detail: {
        provider: prov,
        commitSha: parsed.commitSha,
        conclusion: parsed.conclusion,
        runId: parsed.runId,
        payloadSha256,
      },
    });
    this.log.log(`CI result org=${orgId} ${prov} ${parsed.commitSha.slice(0, 12)} → ${parsed.conclusion}`);
    return { ok: true };
  }

  private async reject(orgId: string, provider: string, reason: string, commitSha: string | null): Promise<void> {
    void this.audit.log({
      organizationId: orgId,
      action: AUDIT_ACTIONS.CI_WEBHOOK_REJECTED,
      severity: 'WARNING',
      actorType: 'SYSTEM',
      resourceType: 'ciResult',
      resourceLabel: provider,
      detail: { provider, reason, commitSha },
    });
  }

  /**
   * Corrobore une preuve `ci_signed` d'un livrable contre le buffer de résultats
   * CI signés (le plus récent non expiré pour ce commit). Ne consomme rien (le
   * TTL/cron purge) — un livrable peut être ré-évalué. Aucun effet de bord.
   */
  async corroborate(
    orgId: string,
    commitSha: string | null | undefined,
    allowedRepos?: string[] | null,
  ): Promise<CiCorroboration> {
    if (!commitSha?.trim()) {
      return {
        status: 'pending',
        corroborated: false,
        reason: 'no_commit_sha',
        provider: null,
        conclusion: null,
        runUrl: null,
        commitSha: null,
        repo: null,
      };
    }
    const sha = commitSha.trim();
    // Binding dépôt (audit sécu 2026-08-01, finding #3) : un projet qui a déclaré
    // ses dépôts (onglet IA) exige que la preuve CI provienne de l'UN d'eux — un
    // build vert d'un autre dépôt de l'org ne corrobore plus. Liste VIDE =
    // comportement historique (match org-wide), la protection s'active dès qu'un
    // dépôt est renseigné sur le projet.
    const repos = (allowedRepos ?? []).map((r) => r.trim()).filter(Boolean);
    const enforceRepo = repos.length > 0;
    const now = new Date();
    const row = await this.prisma.ciResultPending.findFirst({
      where: {
        organizationId: orgId,
        commitSha: sha,
        expiresAt: { gt: now },
        ...(enforceRepo ? { repo: { in: repos } } : {}),
      },
      orderBy: { receivedAt: 'desc' },
      select: { provider: true, conclusion: true, runUrl: true, commitSha: true, repo: true },
    });
    if (!row) {
      // Distinguer « aucun build signé » de « build existant mais mauvais dépôt » :
      // plus clair pour le reviewer, et rend le rejet du binding explicite.
      if (enforceRepo) {
        const other = await this.prisma.ciResultPending.findFirst({
          where: { organizationId: orgId, commitSha: sha, expiresAt: { gt: now } },
          orderBy: { receivedAt: 'desc' },
          select: { repo: true },
        });
        if (other) {
          return {
            status: 'pending',
            corroborated: false,
            reason: 'repo_mismatch',
            provider: null,
            conclusion: null,
            runUrl: null,
            commitSha: sha,
            repo: other.repo,
          };
        }
      }
      return {
        status: 'pending',
        corroborated: false,
        reason: 'no_result',
        provider: null,
        conclusion: null,
        runUrl: null,
        commitSha: sha,
        repo: null,
      };
    }
    return {
      status: row.conclusion === 'success' ? 'pass' : 'fail',
      corroborated: true,
      reason: 'matched',
      provider: row.provider,
      conclusion: row.conclusion,
      runUrl: row.runUrl,
      commitSha: row.commitSha,
      repo: row.repo,
    };
  }

  /** Purge des résultats CI expirés (appelé par le cron). Renvoie le nb supprimé. */
  async purgeExpired(): Promise<number> {
    const res = await this.prisma.ciResultPending.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    return res.count;
  }
}
