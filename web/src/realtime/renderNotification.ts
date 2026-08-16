import type { TFunction } from 'i18next';
import type { InboxNotificationDto } from '@vaks-pm/shared';
import type { Notification } from './store';

/**
 * Kinds dont le libellé est **rendu serveur** (langue du destinataire) : on
 * affiche `title`/`body` tels quels. Les autres (« perso ») portent des données
 * structurées et sont rendus ici via l'i18n de l'UI, exactement comme l'ancienne
 * cloche éphémère — la langue affichée suit celle de l'interface.
 */
const SERVER_RENDERED = new Set([
  'automation',
  'announcement',
  'admin_alert',
  'skill_expiring',
  'skill_request',
]);

/**
 * `InboxNotificationDto` (REST ou WS) → item de store rendu. Utilisé à la fois
 * par l'hydratation (`GET /me/notifications`) et par le flux temps réel, pour
 * garantir un rendu identique quelle que soit la source.
 */
export function renderInboxItem(dto: InboxNotificationDto, t: TFunction): Notification {
  let title = dto.title ?? '';
  let body: string | undefined = dto.body ?? undefined;

  if (!SERVER_RENDERED.has(dto.kind)) {
    switch (dto.kind) {
      case 'assignment':
        title = t('realtime.assignedToYou');
        body = dto.taskTitle;
        break;
      case 'mention':
        title = t('realtime.mentionedYou', { name: dto.actorName ?? t('realtime.someone') });
        body = dto.excerpt ?? dto.taskTitle;
        break;
      case 'status':
        title = t('realtime.statusChangedTitle');
        body = t('realtime.statusChangedBody', {
          task: dto.taskTitle ?? '',
          from: dto.fromStatus ?? '',
          to: dto.toStatus ?? '',
        });
        break;
      case 'comment':
        title = t('realtime.newComment');
        body = dto.excerpt ?? dto.taskTitle;
        break;
      case 'due':
        title = t('realtime.dueSoonTitle');
        body = t('realtime.dueSoonBody', { task: dto.taskTitle ?? '' });
        break;
      case 'over_estimate':
        title = t('realtime.overEstimateTitle');
        body = t('realtime.overEstimateBody', { task: dto.taskTitle ?? '' });
        break;
      default:
        title = dto.title ?? dto.kind;
    }
  }

  return {
    id: dto.id,
    kind: dto.kind,
    title,
    body,
    at: dto.createdAt ? Date.parse(dto.createdAt) || Date.now() : Date.now(),
    taskId: dto.taskId,
    projectId: dto.projectId,
    url: dto.url,
    read: Boolean(dto.read),
  };
}
