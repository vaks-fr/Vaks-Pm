/* ============================================================
   CustomFieldControl — rend l'input adéquat pour une valeur de champ
   personnalisé selon le type de sa définition. Sérialisation canonique en
   texte (nombre→"42", date→ISO, checkbox→"true"/"false", select→option) :
   c'est ce que le backend attend et renvoie.
   ============================================================ */
import React from 'react';
import type { CustomFieldDefinitionDto } from '@vaks-pm/shared';

export function CustomFieldControl({
  def,
  value,
  onChange,
  disabled,
}: {
  def: CustomFieldDefinitionDto;
  value: string | null;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const v = value ?? '';

  switch (def.type) {
    case 'number':
      return (
        <input
          className="td-in grow"
          type="number"
          value={v}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'date':
      return (
        <input
          className="td-date mono"
          type="date"
          // On stocke l'ISO ; l'input date attend YYYY-MM-DD (10 premiers car.).
          value={v ? v.slice(0, 10) : ''}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );

    case 'checkbox':
      return (
        <input
          type="checkbox"
          checked={v === 'true'}
          disabled={disabled}
          onChange={(e) => onChange(e.target.checked ? 'true' : 'false')}
        />
      );

    case 'select':
      return (
        <select
          className="td-in grow"
          value={v}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        >
          {/* Option vide = « non renseigné » (efface la valeur côté serveur). */}
          <option value="">—</option>
          {def.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      );

    case 'text':
    default:
      return (
        <input
          className="td-in grow"
          type="text"
          value={v}
          disabled={disabled}
          onChange={(e) => onChange(e.target.value)}
        />
      );
  }
}
