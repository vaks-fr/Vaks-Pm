import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { MutationContextService } from './mutation-context.service';

/**
 * Lit `X-Client-Mutation-Id` (et l'auteur depuis req.user) puis exécute le
 * handler dans un AsyncLocalStorage. Permet à n'importe quel service (et au
 * gateway WS) de retrouver ces infos sans modifier les signatures.
 */
@Injectable()
export class MutationContextInterceptor implements NestInterceptor {
  constructor(private readonly ctx: MutationContextService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<{
      headers?: Record<string, string | string[] | undefined>;
      user?: { id?: string; sub?: string };
    }>();
    const headerVal = req?.headers?.['x-client-mutation-id'];
    const clientMutationId = Array.isArray(headerVal) ? headerVal[0] : headerVal;
    const actorUserId = req?.user?.id ?? req?.user?.sub;
    return new Observable((sub) => {
      this.ctx.run({ clientMutationId, actorUserId }, () => {
        next.handle().subscribe({
          next: (v) => sub.next(v),
          error: (e) => sub.error(e),
          complete: () => sub.complete(),
        });
      });
    });
  }
}
