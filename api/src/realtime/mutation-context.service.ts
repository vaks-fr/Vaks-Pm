import { Injectable } from '@nestjs/common';
import { AsyncLocalStorage } from 'async_hooks';

interface MutationContext {
  clientMutationId?: string;
  actorUserId?: string;
}

/**
 * Stocke par requête HTTP le `clientMutationId` envoyé par le front
 * (header `X-Client-Mutation-Id`) et l'identifiant de l'auteur. Le
 * gateway WS lit ces valeurs au moment de l'émission et les inclut dans
 * le payload, ce qui permet au client d'origine de dédupliquer les events
 * qu'il a lui-même provoqués (et donc déjà patchés en optimistic).
 */
@Injectable()
export class MutationContextService {
  private readonly als = new AsyncLocalStorage<MutationContext>();

  run<T>(ctx: MutationContext, fn: () => T): T {
    return this.als.run(ctx, fn);
  }

  get(): MutationContext {
    return this.als.getStore() ?? {};
  }
}
