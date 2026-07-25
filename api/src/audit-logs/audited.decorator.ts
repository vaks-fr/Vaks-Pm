import { SetMetadata } from '@nestjs/common';
import type { AuditSeverity } from './audit-log.service';

export const AUDITED_KEY = 'audit:audited';
export const SKIP_AUDIT_KEY = 'audit:skip';

export interface AuditedMeta {
  /** Nom d'action curé (ex. 'task.update'). Prime sur la dérivation route. */
  action: string;
  /** resourceType explicite (défaut : premier segment de route). */
  resource?: string;
  /** Nom du param de route portant l'ID de la ressource (défaut 'id'). */
  idParam?: string;
  severity?: AuditSeverity;
}

/**
 * Marque une route pour l'audit avec un nom d'action curé. Aussi le SEUL
 * moyen d'auditer un GET (ex. téléchargement de pièce jointe) — les lectures
 * ne sont jamais capturées par défaut.
 */
export const Audited = (action: string, opts: Omit<AuditedMeta, 'action'> = {}) =>
  SetMetadata(AUDITED_KEY, { action, ...opts } satisfies AuditedMeta);

/**
 * Exclut une route de la capture générique de l'interceptor. À poser sur les
 * handlers déjà instrumentés par un hook explicite `logCritical` (anti
 * double-log), ou sur les mutations trop bruyantes/non pertinentes.
 */
export const SkipAudit = () => SetMetadata(SKIP_AUDIT_KEY, true);
