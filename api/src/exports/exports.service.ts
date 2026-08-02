import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { S3Service } from '../storage/s3.service';
import { TenantContext } from '../tenancy/tenant-context.service';
import { UsersService } from '../users/users.service';
import { ExportJobStore, type ExportJobRecord, type ExportKind } from './export-job.store';
import { getExportQueue } from './export-queue';

/** Kinds réellement câblés à un rendu. */
const SUPPORTED: ExportKind[] = ['me_data_json'];

@Injectable()
export class ExportsService {
  private readonly logger = new Logger(ExportsService.name);

  constructor(
    private readonly store: ExportJobStore,
    private readonly s3: S3Service,
    private readonly users: UsersService,
    private readonly tenant: TenantContext,
  ) {}

  /**
   * Enfile un export. Répond immédiatement — c'est tout l'objet du lot : sortir
   * les rendus longs du chemin de requête, où ils butent sur le timeout Traefik
   * et sur la patience du client IA.
   */
  async start(
    orgId: string,
    userId: string,
    kind: ExportKind,
    params: Record<string, unknown>,
  ): Promise<{ jobId: string; status: string }> {
    if (!SUPPORTED.includes(kind)) {
      throw new BadRequestException(
        `Type d'export non pris en charge : ${kind}. Types disponibles : ${SUPPORTED.join(', ')}.`,
      );
    }
    const rec = await this.store.create({ orgId, userId, kind, params });
    await getExportQueue().add('export', {
      jobId: rec.id,
      organizationId: orgId,
      tenantSlug: this.tenant.currentSlug() ?? null,
    });
    return { jobId: rec.id, status: rec.status };
  }

  async status(id: string, orgId: string, userId: string): Promise<ExportJobRecord> {
    const rec = await this.store.get(id, orgId, userId);
    // 404 et non 403 quand le job appartient à quelqu'un d'autre : on ne
    // confirme pas l'existence d'un export d'autrui.
    if (!rec) throw new NotFoundException('Export introuvable');
    return rec;
  }

  /** Contenu de l'artefact, après contrôle de propriété. */
  async download(id: string, orgId: string, userId: string): Promise<{ buffer: Buffer; rec: ExportJobRecord }> {
    const rec = await this.status(id, orgId, userId);
    if (rec.status !== 'DONE' || !rec.s3Key) {
      throw new BadRequestException(`Export non disponible (statut : ${rec.status}).`);
    }
    const buffer = await this.s3.getObjectBuffer(this.s3.buckets.exports, rec.s3Key);
    return { buffer, rec };
  }

  /**
   * Exécute le rendu. Appelé **par le worker** via la route interne : le worker
   * n'a ni base ni utilitaires de rendu, il ne fait que déclencher (et
   * retenter). C'est ici que tout l'état du job est écrit.
   */
  async run(jobId: string): Promise<void> {
    const rec = await this.store.getRaw(jobId);
    if (!rec) throw new NotFoundException('Export introuvable');
    if (rec.status === 'DONE') return; // idempotent : un retry BullMQ ne refait rien
    await this.store.patch(jobId, { status: 'RUNNING' });
    try {
      const { buffer, contentType, ext } = await this.render(rec);
      const key = `${rec.orgId}/${rec.id}.${ext}`;
      await this.s3.putObject(this.s3.buckets.exports, key, buffer, contentType);
      await this.store.patch(jobId, {
        status: 'DONE',
        s3Key: key,
        contentType,
        bytes: buffer.length,
      });
    } catch (e) {
      const msg = (e as Error).message ?? 'échec du rendu';
      this.logger.error(`export ${jobId} failed: ${msg}`);
      // On marque FAILED plutôt que de laisser le job à RUNNING : le client doit
      // pouvoir distinguer « en cours » de « ne viendra jamais ».
      await this.store.patch(jobId, { status: 'FAILED', error: msg.slice(0, 500) });
      throw e;
    }
  }

  private async render(
    rec: ExportJobRecord,
  ): Promise<{ buffer: Buffer; contentType: string; ext: string }> {
    switch (rec.kind) {
      case 'me_data_json': {
        // Portabilité RGPD (art. 20). Le plus gros export par utilisateur, et
        // le plus lent sur un compte ancien — d'où son câblage en premier.
        const data = await this.users.exportData(rec.orgId, rec.userId);
        return {
          buffer: Buffer.from(JSON.stringify(data, null, 2), 'utf8'),
          contentType: 'application/json',
          ext: 'json',
        };
      }
      default:
        throw new BadRequestException(`Type d'export non pris en charge : ${rec.kind}.`);
    }
  }
}
