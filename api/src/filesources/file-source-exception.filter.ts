import { ArgumentsHost, Catch, ExceptionFilter } from '@nestjs/common';
import { Response } from 'express';
import { FileSourceError, FileSourceErrorCode } from './file-source-provider.types';

/** Statut HTTP par code d'erreur métier (cf. plan). */
const STATUS: Record<FileSourceErrorCode, number> = {
  FS_DISABLED: 403,
  FS_FORBIDDEN: 403,
  FS_SOURCE_UNAVAILABLE: 409,
  FS_GRANT_PENDING: 409,
  FS_ITEM_NOT_FOUND: 404,
  FS_FILE_TOO_LARGE: 413,
  FS_UNSUPPORTED_FORMAT: 415,
  FS_THROTTLED: 429,
  FS_AUTH_FAILED: 502,
};

/**
 * Traduit une `FileSourceError` (domaine) en réponse HTTP avec un corps
 * machine-lisible `{ code, message, ...extra }` — même forme que `BINARY_DOCUMENT`
 * des context-documents, pour que l'agent branche dessus.
 */
@Catch(FileSourceError)
export class FileSourceExceptionFilter implements ExceptionFilter {
  catch(err: FileSourceError, host: ArgumentsHost): void {
    const res = host.switchToHttp().getResponse<Response>();
    const status = STATUS[err.code] ?? 500;
    if (err.code === 'FS_THROTTLED' && typeof err.extra?.retryAfter === 'number') {
      res.setHeader('Retry-After', String(err.extra.retryAfter));
    }
    res.status(status).json({ statusCode: status, code: err.code, message: err.message, ...(err.extra ?? {}) });
  }
}
