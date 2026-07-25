/* ============================================================
   Vaks — board-column label localization.
   Board columns are stored with a fixed name (the backend seeds the defaults
   in French: « À faire », « En cours », …). To make the kanban / list / task
   detail follow the UI language, we map the *known default* names (FR + EN) to
   a localized status label. A custom (user-renamed) column is NOT in the map,
   so it passes through unchanged — renaming a column is never overridden.

   Keyed by NAME (not by the column's status) on purpose: a board can hold
   several columns sharing the same TaskStatus (e.g. two custom IN_PROGRESS
   lanes) — only the name distinguishes them.
   ============================================================ */
import type { TFunction } from 'i18next';

const COL_NAME_KEY: Record<string, string> = {
  backlog: 'backlog',
  'to do': 'todo', todo: 'todo', 'à faire': 'todo', 'a faire': 'todo',
  'in progress': 'progress', 'en cours': 'progress',
  'on hold': 'hold', 'en attente': 'hold', 'en pause': 'hold',
  'in review': 'review', 'en revue': 'review',
  done: 'done', 'terminé': 'done', termine: 'done',
};

/**
 * Localize a board-column name when it's one of the recognized defaults;
 * otherwise return it verbatim (custom names are preserved).
 */
export function localizeColName(name: string, t: TFunction): string {
  const key = COL_NAME_KEY[(name ?? '').trim().toLowerCase()];
  return key ? t('tasks:status.' + key) : name;
}
