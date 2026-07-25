/* ============================================================
   SkillPicker — sélecteur de compétences avec recherche + dossiers.
   - query vide  → navigation par « dossiers » (category), repliables
   - query       → liste à plat filtrée (nom + description + catégorie)
   Supporte multi-sélection (checkbox) ou sélection unique (radio).
   Agnostique de l'API : on lui passe le catalogue (déjà filtré au périmètre
   du projet si besoin) et la sélection courante.
   ============================================================ */
import React, { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { SkillDto } from '@vaks-pm/shared';

function norm(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase();
}

export interface SkillPickerProps {
  skills: SkillDto[];
  selected: string[];
  onChange: (ids: string[]) => void;
  multiple?: boolean;
  placeholder?: string;
  emptyHint?: React.ReactNode;
  /** Hauteur max de la zone scrollable. */
  maxHeight?: number;
  /**
   * Contenu rendu à droite de chaque skill (ex. slider de niveau pour
   * UserSkillsDialog). Reçoit le skill et son état "sélectionné". Si défini,
   * le clic sur la ligne ne toggle PAS la sélection — c'est le callback du
   * sub-control (rendu via cette prop) qui décide.
   */
  renderItemAside?: (skill: SkillDto, isSelected: boolean) => React.ReactNode;
  /**
   * Contenu rendu sous la liste (ex. bouton "Demander une compétence" dans
   * TaskDetail). Reçoit la query courante (utile pour pré-remplir un dialog).
   */
  footer?: (query: string) => React.ReactNode;
  /**
   * Si vrai, l'item courant est cliquable mais sans checkbox/radio visible.
   * Sert quand la sélection se matérialise différemment (ex. dropdown qui
   * se ferme après pick — cas TaskDetail).
   */
  hideToggleControl?: boolean;
  /** Optionnel : auto-close-on-pick en mode single-select. */
  closeOnSelect?: boolean;
  /** Callback appelé après un pick si `closeOnSelect` est vrai. */
  onPicked?: () => void;
}

export default function SkillPicker({
  skills,
  selected,
  onChange,
  multiple = true,
  placeholder,
  emptyHint,
  maxHeight = 280,
  renderItemAside,
  footer,
  hideToggleControl = false,
  closeOnSelect = false,
  onPicked,
}: SkillPickerProps) {
  const { t } = useTranslation('skills');
  const UNCAT = t('uncategorized');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const selSet = useMemo(() => new Set(selected), [selected]);

  const toggle = (id: string) => {
    if (renderItemAside) {
      // Quand on a un aside (ex. slider de niveau), la ligne ne toggle pas —
      // c'est le sub-control qui pilote la sélection via onChange.
      return;
    }
    if (multiple) {
      const next = new Set(selSet);
      next.has(id) ? next.delete(id) : next.add(id);
      onChange(Array.from(next));
    } else {
      onChange(selSet.has(id) ? [] : [id]);
      if (closeOnSelect && onPicked) onPicked();
    }
  };

  const q = norm(query.trim());
  const matches = useMemo(() => {
    if (!q) return skills;
    return skills.filter((s) => {
      if (norm(s.name).includes(q)) return true;
      if (norm(s.description ?? '').includes(q)) return true;
      if (norm(s.category ?? '').includes(q)) return true;
      // Phase D : alias / synonymes
      const aliases = (s as SkillDto & { aliases?: string[] }).aliases ?? [];
      return aliases.some((a) => norm(a).includes(q));
    });
  }, [skills, q]);

  // Regroupe par catégorie (dossiers) quand on ne recherche pas.
  const folders = useMemo(() => {
    const map = new Map<string, SkillDto[]>();
    for (const s of matches) {
      const key = s.category?.trim() || UNCAT;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(s);
    }
    return Array.from(map.entries())
      .sort((a, b) =>
        a[0] === UNCAT ? 1 : b[0] === UNCAT ? -1 : a[0].localeCompare(b[0]),
      )
      .map(([cat, items]) => ({
        cat,
        items: items.sort((x, y) => x.name.localeCompare(y.name)),
      }));
  }, [matches, UNCAT]);

  const row = (s: SkillDto) => {
    const on = selSet.has(s.id);
    const hasAside = !!renderItemAside;
    const showCheckbox = !hideToggleControl && !hasAside;
    const interactive = !hasAside;
    const Tag: 'button' | 'div' = interactive ? 'button' : 'div';
    return (
      <Tag
        key={s.id}
        {...(interactive
          ? {
              type: 'button' as const,
              onClick: () => toggle(s.id),
              'aria-pressed': on,
            }
          : {})}
        title={s.description ?? s.name}
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          width: '100%',
          textAlign: 'left',
          padding: '6px 10px',
          border: 'none',
          background: on && !hasAside ? 'var(--accent-soft)' : 'transparent',
          borderRadius: 8,
          cursor: interactive ? 'pointer' : 'default',
          fontSize: 13,
          color: 'var(--text)',
        }}
      >
        {showCheckbox && (
          <span
            aria-hidden
            style={{
              width: 16,
              height: 16,
              borderRadius: multiple ? 4 : 8,
              border: on ? '5px solid var(--accent)' : '2px solid var(--border-2)',
              background: on && multiple ? 'var(--accent)' : 'var(--surface)',
              flex: '0 0 auto',
            }}
          />
        )}
        <span
          style={{
            width: 9,
            height: 9,
            borderRadius: 2,
            background: s.color ?? '#6d5efc',
            flex: '0 0 auto',
          }}
        />
        <span
          style={{
            flex: 1,
            fontWeight: on ? 600 : 400,
            minWidth: 0,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {s.name}
        </span>
        {hasAside && (
          <span style={{ flex: '0 0 auto' }} onClick={(e) => e.stopPropagation()}>
            {renderItemAside!(s, on)}
          </span>
        )}
      </Tag>
    );
  };

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <input
        className="atext"
        placeholder={placeholder ?? t('skills:catalog.searchPlaceholder')}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        style={{ width: '100%' }}
      />
      <div
        style={{
          maxHeight,
          overflowY: 'auto',
          border: '1px solid var(--border)',
          borderRadius: 10,
          padding: 6,
        }}
      >
        {matches.length === 0 ? (
          <div style={{ padding: 12, opacity: 0.6, fontSize: 13 }}>
            {emptyHint ?? t('skills:picker.noMatch')}
          </div>
        ) : q ? (
          // Recherche : liste à plat.
          matches.map(row)
        ) : (
          // Navigation par dossiers.
          folders.map(({ cat, items }) => {
            const isCollapsed = collapsed[cat];
            const selectedHere = items.filter((s) => selSet.has(s.id)).length;
            return (
              <div key={cat} style={{ marginBottom: 4 }}>
                <button
                  type="button"
                  onClick={() => setCollapsed((c) => ({ ...c, [cat]: !c[cat] }))}
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    width: '100%',
                    textAlign: 'left',
                    padding: '6px 8px',
                    border: 'none',
                    background: 'var(--surface-2)',
                    borderRadius: 8,
                    cursor: 'pointer',
                    fontSize: 12,
                    fontWeight: 600,
                    textTransform: 'uppercase',
                    letterSpacing: 0.4,
                    color: 'var(--text-3)',
                  }}
                >
                  <span style={{ width: 12 }}>{isCollapsed ? '▸' : '▾'}</span>
                  <span style={{ flex: 1 }}>{cat}</span>
                  <span style={{ opacity: 0.7 }}>
                    {selectedHere ? `${selectedHere}/` : ''}
                    {items.length}
                  </span>
                </button>
                {!isCollapsed && <div style={{ padding: '2px 0' }}>{items.map(row)}</div>}
              </div>
            );
          })
        )}
      </div>
      {footer && footer(query)}
    </div>
  );
}
