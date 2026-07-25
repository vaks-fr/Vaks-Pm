import { Injectable, OnModuleInit, OnModuleDestroy, Logger } from '@nestjs/common';
import { PrismaClient } from '@db';
import { makePgAdapter } from './pg-adapter';
import { TenantContext } from '../tenancy/tenant-context.service';

/**
 * Client Prisma injecté partout. Multi-tenant transparent :
 *  - `dedicated` (on-premise / cellule) : se comporte comme un PrismaClient
 *    normal sur la base globale (comportement historique inchangé — hors
 *    contexte, le proxy retombe toujours sur ce client).
 *  - `pooled` (SaaS) : à chaque accès, le proxy délègue au client de la base
 *    du tenant courant (posé par le middleware dans `TenantContext`).
 *
 * Les 39 services continuent d'injecter `PrismaService` sans rien changer.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor(private readonly tenantCtx: TenantContext) {
    // Prisma 7 : le client Rust-free exige un driver adapter ; plus de lecture
    // implicite de `datasource.url`. DATABASE_URL est exporté dans l'env du
    // process au démarrage (cf. docker-stack.yml).
    super({ adapter: makePgAdapter(process.env.DATABASE_URL) });
    // `target` = ce client global (base par défaut / control plane). Si un
    // client de tenant est lié au contexte, on délègue dessus ; sinon `target`.
    return new Proxy(this, {
      get: (target, prop) => {
        const client: PrismaClient = this.tenantCtx?.current() ?? target;
        const value = Reflect.get(client, prop, client);
        return typeof value === 'function' ? value.bind(client) : value;
      },
    });
  }

  async onModuleInit() {
    await this.$connect();
    await this.backfillTaskNumbers();
  }
  async onModuleDestroy() {
    await this.$disconnect();
  }

  /**
   * Backfill idempotent : attribue un `number` séquentiel par projet aux
   * tâches historiques où `number = 0` (rows créées avant l'ajout de la
   * colonne). Ordre stable par createdAt puis id. Tourne à chaque boot mais
   * ne touche rien dès qu'il n'y a plus de 0 → no-op en régime établi.
   */
  private async backfillTaskNumbers() {
    try {
      const updated = await this.$executeRawUnsafe(`
        WITH next_numbers AS (
          SELECT id,
                 (
                   COALESCE(
                     (SELECT MAX(number) FROM "Task" t2 WHERE t2."projectId" = t1."projectId"),
                     0
                   )
                   + ROW_NUMBER() OVER (PARTITION BY "projectId" ORDER BY "createdAt", id)
                 ) AS n
          FROM "Task" t1
          WHERE number = 0
        )
        UPDATE "Task" SET number = next_numbers.n
        FROM next_numbers
        WHERE "Task".id = next_numbers.id;
      `);
      if (updated > 0) {
        this.logger.log(`Backfilled task.number on ${updated} historical row(s)`);
      }
    } catch (err) {
      this.logger.warn(`Task number backfill skipped: ${(err as Error).message}`);
    }
  }
}
