import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'node:async_hooks';
import { PrismaClient } from '@db';

interface TenantStore {
  /** Client Prisma de la base du tenant courant (mode pooled). */
  client: PrismaClient;
  slug: string;
}

/**
 * Contexte tenant par requête (AsyncLocalStorage). Le middleware y place le
 * client Prisma de la base du tenant ; le `PrismaService` (proxy) le lit pour
 * router chaque requête DB vers la bonne base — de façon transparente pour les
 * 39 services qui injectent `PrismaService`.
 *
 * En mode `dedicated`, le store reste vide → le proxy retombe sur le client
 * global (comportement historique inchangé).
 */
@Injectable()
export class TenantContext {
  private readonly als = new AsyncLocalStorage<TenantStore>();

  /** Exécute `fn` avec le client du tenant lié au contexte. */
  run<T>(store: TenantStore, fn: () => T): T {
    return this.als.run(store, fn);
  }

  /** Client du tenant courant, ou `null` si hors contexte (mode dedicated). */
  current(): PrismaClient | null {
    return this.als.getStore()?.client ?? null;
  }

  currentSlug(): string | null {
    return this.als.getStore()?.slug ?? null;
  }
}
