/* ============================================================
   CustomFieldValuesSection — édite les valeurs des champs personnalisés d'une
   entité (tâche ou projet). Autonome : charge et persiste seul, comme
   RecurrenceSection (PAS via le patch natif de l'entité). Masqué s'il n'y a
   aucun champ applicable.

   Persistance : chaque champ est sauvegardé indépendamment (PUT d'un seul
   fieldId — le backend ne touche que celui-là). Les inputs libres (texte,
   nombre, date) sauvegardent au blur pour éviter une requête par frappe ;
   select et checkbox sauvegardent au changement.
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { CustomFieldValueDto } from '@vaks-pm/shared';
import { CustomFieldControl } from './CustomFieldControl';
import {
  apiGetTaskCustomFields,
  apiSetTaskCustomFields,
  apiGetProjectCustomFields,
  apiSetProjectCustomFields,
} from './api';

export function CustomFieldValuesSection({
  kind,
  entityId,
  pushError,
}: {
  kind: 'task' | 'project';
  entityId: string;
  /** Notifie une erreur de sauvegarde (le composant a déjà rollback l'affichage). */
  pushError?: (msg: string) => void;
}) {
  const { t } = useTranslation('customfields');
  const [rows, setRows] = useState<CustomFieldValueDto[] | null>(null);
  // Buffer d'édition local (valeur affichée), distinct de la valeur persistée.
  const [draft, setDraft] = useState<Record<string, string>>({});

  const load = kind === 'task' ? apiGetTaskCustomFields : apiGetProjectCustomFields;
  const save = kind === 'task' ? apiSetTaskCustomFields : apiSetProjectCustomFields;

  useEffect(() => {
    let alive = true;
    load(entityId)
      .then((r) => {
        if (!alive) return;
        setRows(r);
        setDraft(Object.fromEntries(r.map((x) => [x.fieldId, x.value ?? ''])));
      })
      .catch(() => alive && setRows([]));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [entityId, kind]);

  const persist = useCallback(
    async (fieldId: string, value: string) => {
      try {
        const updated = await save(entityId, [{ fieldId, value }]);
        // Resynchronise depuis la réponse serveur (valeur canonique).
        setRows(updated);
        setDraft((d) => ({ ...d, [fieldId]: updated.find((x) => x.fieldId === fieldId)?.value ?? '' }));
      } catch (e) {
        // Rollback l'affichage sur la dernière valeur persistée connue.
        const known = rows?.find((x) => x.fieldId === fieldId)?.value ?? '';
        setDraft((d) => ({ ...d, [fieldId]: known }));
        pushError?.((e as Error).message);
      }
    },
    [entityId, rows, save, pushError],
  );

  const applicable = useMemo(() => rows ?? [], [rows]);

  if (rows === null) return null; // pas encore chargé
  if (applicable.length === 0) return null; // aucun champ applicable : rien à afficher

  return (
    <div className="td-section">
      <div className="td-stitle">{t('sectionTitle')}</div>
      <div className="td-props">
        {applicable.map((row) => {
          const def = row.definition;
          const val = draft[def.id] ?? '';
          const immediate = def.type === 'select' || def.type === 'checkbox';
          return (
            <div
              className="td-prop"
              key={def.id}
              // Les inputs libres (texte/nombre/date) persistent au blur, qui
              // remonte (focusout) jusqu'à ce conteneur — une requête à la fin
              // de la saisie, pas à chaque frappe.
              onBlur={
                immediate
                  ? undefined
                  : () => {
                      if ((draft[def.id] ?? '') !== (row.value ?? '')) void persist(def.id, draft[def.id] ?? '');
                    }
              }
            >
              <span className="td-plabel">{def.name}</span>
              <CustomFieldControl
                def={def}
                value={val}
                onChange={(v) => {
                  setDraft((d) => ({ ...d, [def.id]: v }));
                  if (immediate) void persist(def.id, v);
                }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
