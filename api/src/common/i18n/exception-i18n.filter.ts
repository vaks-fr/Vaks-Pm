/* ============================================================================
 * Global filter that localizes HttpException messages on the way out.
 * Reads Accept-Language, translates the (French source) `message` via the
 * exception dictionary, and preserves the standard Nest error response shape.
 * Unknown messages / 'fr' / non-HTTP contexts pass through unchanged.
 * ========================================================================== */
import { ArgumentsHost, Catch, ExceptionFilter, HttpException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { pickExcLang, translateExc } from './exception-i18n';

@Catch(HttpException)
export class ExceptionI18nFilter implements ExceptionFilter {
  catch(exception: HttpException, host: ArgumentsHost): void {
    if (host.getType() !== 'http') throw exception; // WS / RPC → leave to their handlers
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const lang = pickExcLang(req.headers['accept-language'] as string | undefined);

    const status = exception.getStatus();
    const r = exception.getResponse();
    let body: Record<string, unknown>;
    if (typeof r === 'string') {
      body = { statusCode: status, message: translateExc(r, lang) };
    } else {
      body = { ...(r as Record<string, unknown>) };
      const msg = body.message;
      if (typeof msg === 'string') {
        body.message = translateExc(msg, lang);
      } else if (Array.isArray(msg)) {
        body.message = msg.map((m) => (typeof m === 'string' ? translateExc(m, lang) : m));
      }
      // `error` (HTTP reason phrase, e.g. "Bad Request") stays as-is.
    }
    res.status(status).json(body);
  }
}
