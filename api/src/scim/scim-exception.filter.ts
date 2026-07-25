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
import { SCIM_CONTENT_TYPE, scimError } from './scim.types';
import { translateExc } from '../common/i18n/exception-i18n';

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
    res
      .status(status)
      .type(SCIM_CONTENT_TYPE)
      .send(JSON.stringify(scimError(status, translateExc(detail, 'en'))));
  }
}
