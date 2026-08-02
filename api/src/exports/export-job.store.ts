import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import Redis from 'ioredis';
import { TenantContext } from '../tenancy/tenant-context.service';

/** Durée de rétention d'un job (et de son artefact référencé). */
export const EXPORT_JOB_TTL_SEC = 24 * 3600;
/** Au-delà, un job `RUNNING` sans heartbeat est réputé perdu. */
const STALE_AFTER_MS = 20 * 60_000;

export type ExportStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'STALE';

/** Nature de l'export — détermine le rendu côté service. */
export type ExportKind =
  | 'project_report_pdf'
  | 'project_report_xlsx'
  | 'time_breakdown_xlsx'
  | 'workload_xlsx'
  | 'me_data_json';

export interface ExportJobRecord {
  id: string;
  orgId: string;
  /** Demandeur : un job est **privé**, y compris entre utilisateurs d'une org. */
  userId: string;
  kind: ExportKind;
  params: Record<string, unknown>;
  status: ExportStatus;
  s3Key?: string;
  contentType?: string;
  bytes?: number;
  error?: string;
  createdAt: number;
  updatedAt: number;
}

/**
 * État des jobs d'export, en Redis.
 *
 * **Pas de modèle Prisma en v1**, délibérément : un changement de schéma impose
 * un `db push` SUPERUSER sur les quatre bases avant tout rolling update, ce qui
 * est un risque nettement supérieur à ce que la persistance apporterait ici.
 *
 * Conséquence assumée : Redis tourne en un seul réplica, donc un redémarrage
 * perd les enregistrements. L'artefact survit dans Garage mais devient
 * inatteignable. À 24 h de TTL, c'est un compromis acceptable ; le modèle Prisma
 * est le correctif le jour où l'historique deviendra nécessaire.
 */
@Injectable()
export class ExportJobStore implements OnModuleDestroy {
  private readonly redis: Redis;

  constructor(config: ConfigService, private readonly tenant: TenantContext) {
    this.redis = new Redis(config.get<string>('redisUrl') ?? 'redis://redis:6379', {
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
      lazyConnect: false,
    });
    this.redis.on('error', (e) => {
      // eslint-disable-next-line no-console
      console.error(`[export-store] redis error: ${e.message}`);
    });
  }

  onModuleDestroy() {
    this.redis.disconnect();
  }

  private key(id: string): string {
    return `mcpjob:${this.tenant.currentSlug() ?? '_'}:${id}`;
  }

  async create(input: {
    orgId: string;
    userId: string;
    kind: ExportKind;
    params: Record<string, unknown>;
  }): Promise<ExportJobRecord> {
    const now = Date.now();
    const rec: ExportJobRecord = {
      id: randomUUID(),
      ...input,
      status: 'QUEUED',
      createdAt: now,
      updatedAt: now,
    };
    await this.redis.set(this.key(rec.id), JSON.stringify(rec), 'EX', EXPORT_JOB_TTL_SEC);
    return rec;
  }

  /**
   * Lecture **avec contrôle de propriété**. `orgId` ET `userId` sont vérifiés :
   * sans le second, un utilisateur pourrait sonder les exports d'un collègue de
   * la même organisation (un export RGPD, par exemple).
   */
  async get(id: string, orgId: string, userId: string): Promise<ExportJobRecord | null> {
    const raw = await this.redis.get(this.key(id));
    if (!raw) return null;
    const rec = JSON.parse(raw) as ExportJobRecord;
    if (rec.orgId !== orgId || rec.userId !== userId) return null;
    // Un job resté RUNNING sans nouvelle est signalé plutôt que laissé à
    // tourner indéfiniment côté client (l'API a pu mourir en plein rendu).
    if (rec.status === 'RUNNING' && Date.now() - rec.updatedAt > STALE_AFTER_MS) {
      return { ...rec, status: 'STALE' };
    }
    return rec;
  }

  /** Lecture sans contrôle — réservée au chemin interne (worker → API). */
  async getRaw(id: string): Promise<ExportJobRecord | null> {
    const raw = await this.redis.get(this.key(id));
    return raw ? (JSON.parse(raw) as ExportJobRecord) : null;
  }

  async patch(id: string, patch: Partial<ExportJobRecord>): Promise<void> {
    const rec = await this.getRaw(id);
    if (!rec) return;
    const next = { ...rec, ...patch, updatedAt: Date.now() };
    await this.redis.set(this.key(id), JSON.stringify(next), 'EX', EXPORT_JOB_TTL_SEC);
  }
}
