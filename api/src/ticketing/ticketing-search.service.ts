import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ConnectorsAdminService } from './connectors-admin.service';
import { TicketProviderRegistry } from './ticket-provider.registry';
import type { TicketCandidate } from './ticket-provider.types';

interface CacheEntry {
  data: TicketCandidate[];
  expiresAt: number;
}

const CACHE_TTL_MS = 60_000;
const CACHE_MAX_SIZE = 500;

export interface TicketSourceDto {
  source: string;
  label: string;
}

/**
 * Recherche live dans les connecteurs de ticketing externes.
 *
 * Cache in-process par `(orgId, source, q)` — TTL 60 s. Acceptable en
 * multi-réplica : les résultats sont éphémères et lecture-seule.
 */
@Injectable()
export class TicketingSearchService {
  private readonly log = new Logger(TicketingSearchService.name);
  private readonly cache = new Map<string, CacheEntry>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly connectors: ConnectorsAdminService,
    private readonly registry: TicketProviderRegistry,
  ) {}

  /** Sources actives exposées au picker timesheet (scope `time:log`). */
  async listSources(orgId: string): Promise<TicketSourceDto[]> {
    const rows = await this.prisma.ticketingConnector.findMany({
      where: { organizationId: orgId, enabled: true },
      select: { source: true, label: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r) => ({ source: r.source, label: r.label }));
  }

  /** Recherche live dans un connecteur. Retourne [] si non configuré ou erreur (fail-open). */
  async search(
    orgId: string,
    userEmail: string,
    source: string,
    q: string,
    limit = 20,
  ): Promise<TicketCandidate[]> {
    if (!source || !q) return [];

    const cacheKey = `${orgId}|${source}|${q}`;
    const cached = this.cache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.data;

    const provider = this.registry.get(source);
    if (!provider?.search) return [];

    const ctx = await this.connectors.resolveProviderContext(orgId, source);
    if (!ctx) return [];

    try {
      const results = await provider.search(ctx, { q, userEmail, limit });
      this.cache.set(cacheKey, { data: results, expiresAt: Date.now() + CACHE_TTL_MS });
      this.evictStale();
      return results;
    } catch (err) {
      this.log.warn(`[ticketing] search(${source}, "${q}") failed: ${(err as Error).message}`);
      return [];
    }
  }

  private evictStale(): void {
    if (this.cache.size <= CACHE_MAX_SIZE) return;
    const now = Date.now();
    for (const [k, v] of this.cache) {
      if (v.expiresAt < now) this.cache.delete(k);
      if (this.cache.size <= CACHE_MAX_SIZE) break;
    }
  }
}
