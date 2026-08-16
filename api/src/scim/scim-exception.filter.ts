import {
  ArgumentsHost,
  CallHandler,
  Catch,
  ExceptionFilter,
  ExecutionContext,
  HttpException,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import type { Response } from 'express';
import { Observable } from 'rxjs';
import { translateExc } from '../common/i18n/exception-i18n';
import { SCIM_CONTENT_TYPE, scimError } from './scim.types';

/**
 * Pose `Content-Type: application/scim+json` AVANT la sérialisation Nest.
 * Express `res.json()` ne remplace pas un Content-Type déjà fixé → la réponse
 * sort bien en scim+json (et pas application/json).
 */
@Injectable()
export class ScimContentTypeInterceptor implements NestInterceptor {
  intercept(ctx: ExecutionContext, next: CallHandler): Observable<unknown> {
    ctx.switchToHttp().getResponse<Response>().setHeader('Content-Type', SCIM_CONTENT_TYPE);
    return next.handle();
  }
}

/**
 * Exception portant un `scimType` (RFC 7644 §3.12) en plus du statut HTTP.
 * Entra et Okta affichent ce code dans leur journal de provisioning : c'est lui
 * qui dit à l'admin *quoi* corriger, là où le statut seul ne dit que « refusé ».
 *
 * Le `detail` part tel quel vers l'IdP → **en anglais** (le lecteur est une
 * machine, puis un admin qui lit son journal ; la doc le cite verbatim).
 */
export class ScimException extends HttpException {
  constructor(
    status: number,
    detail: string,
    readonly scimType: string,
  ) {
    super(detail, status);
  }
}

/** 400 + `invalidFilter` : filtre qu'on ne sait pas évaluer (RFC 7644 §3.4.2.2). */
export class ScimInvalidFilterException extends ScimException {
  constructor(detail: string) {
    super(400, detail, 'invalidFilter');
  }
}

/**
 * Traduit toute exception levée sous `/scim/v2/*` au format d'erreur SCIM
 * (RFC 7644 §3.12) + content-type `application/scim+json`. Sans ça, Entra
 * reçoit le JSON d'erreur Nest standard et considère l'endpoint non conforme.
 *
 * Langue : **anglais, toujours**. L'appelant est un annuaire (Entra, Okta) qui
 * n'envoie pas d'Accept-Language ; le `detail` atterrit dans son journal de
 * provisioning, lu par un opérateur. On force donc la traduction en anglais
 * plutôt que de laisser passer le français source. Les messages déjà anglais
 * (ceux propres au module SCIM) traversent le dictionnaire sans changement.
 */
@Catch()
export class ScimExceptionFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const res = host.switchToHttp().getResponse<Response>();
    let status = 500;
    let detail = 'Internal server error';
    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const r = exception.getResponse();
      detail =
        typeof r === 'string'
          ? r
          : ((r as { message?: string | string[] }).message
              ? ([] as string[]).concat((r as { message: string | string[] }).message).join(', ')
              : exception.message);
    } else if (exception instanceof Error) {
      detail = exception.message;
    }
    // Le `detail` part vers l'IdP (Entra/Okta) → **toujours en anglais**, quelle
    // que soit la langue d'interface : le lecteur est une machine puis un admin
    // qui lit son journal de provisioning, et la doc cite ces chaînes verbatim.
    // Ce filtre de contrôleur court-circuite l'ExceptionI18nFilter global (qui,
    // lui, suit Accept-Language) ; on rejoue donc la traduction ici, forcée sur
    // `en`, en réutilisant le même dictionnaire. Les chaînes déjà anglaises (nos
    // erreurs de filtre, `User not found`…) passent inchangées.
    detail = translateExc(detail, 'en');
    // `scimType` explicite si l'exception en porte un ; sinon 409 → `uniqueness`,
    // le seul cas où notre surface a une cause unique et connue (collision
    // email / externalId / nom d'équipe).
    const scimType =
      exception instanceof ScimException ? exception.scimType : status === 409 ? 'uniqueness' : undefined;
    res.status(status).type(SCIM_CONTENT_TYPE).send(JSON.stringify(scimError(status, detail, scimType)));
  }
}
