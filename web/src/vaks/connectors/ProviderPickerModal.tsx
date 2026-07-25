/* ============================================================
   Primitives connecteurs — modale de choix du provider.
   Grille de cartes (wordmark ou monogramme) + recherche. Strings par
   défaut sur `integrations:connectors.picker*` (génériques), surchar-
   geables par section via `labels`.
   ============================================================ */
import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../primitives';
import type { NormalizedProvider } from './types';
import { PROVIDER_WORDMARKS, ProviderTile } from './ProviderTile';

export interface PickerLabels {
  title?: string;
  heading?: string;
  blurb?: string;
  searchPlaceholder?: string;
  noResults?: string;
  select?: string;
}

export default function ProviderPickerModal({
  providers,
  onPick,
  onClose,
  labels,
}: {
  providers: NormalizedProvider[];
  onPick: (p: NormalizedProvider) => void;
  onClose: () => void;
  labels?: PickerLabels;
}) {
  const { t } = useTranslation('integrations');
  const [q, setQ] = useState('');
  const filtered = useMemo(() => {
    const term = q.trim().toLowerCase();
    if (!term) return providers;
    return providers.filter((p) => `${p.label} ${p.key} ${p.blurb ?? ''}`.toLowerCase().includes(term));
  }, [providers, q]);

  return (
    <div
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(0,0,0,0.55)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 1100,
        padding: 16,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 720,
          maxHeight: '85vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--surface)',
          border: '1px solid var(--border)',
          borderRadius: 'var(--r-lg, 14px)',
          boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
          overflow: 'hidden',
        }}
      >
        {/* header */}
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '16px 20px',
            borderBottom: '1px solid var(--border)',
          }}
        >
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>
            {labels?.title ?? t('connectors.pickerTitle')}
          </h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>

        {/* intro + search */}
        <div style={{ padding: '14px 20px 0', display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <ProviderTile p={{ label: '◳', accent: 'var(--accent)' }} size={40} />
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {labels?.heading ?? t('connectors.pickerHeading')}
              </div>
              <div style={{ fontSize: 12.5, color: 'var(--text-3)', lineHeight: 1.5 }}>
                {labels?.blurb ?? t('connectors.pickerBlurb')}
              </div>
            </div>
          </div>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              border: '1px solid var(--border)',
              borderRadius: 'var(--r-md, 10px)',
              padding: '8px 12px',
              color: 'var(--text-faint)',
            }}
          >
            <Icon name="search" size={15} />
            <input
              autoFocus
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder={labels?.searchPlaceholder ?? t('connectors.pickerSearch')}
              style={{
                flex: 1,
                background: 'transparent',
                border: 'none',
                outline: 'none',
                color: 'var(--text)',
                fontSize: 13,
                fontFamily: 'inherit',
              }}
            />
          </div>
        </div>

        {/* grid */}
        <div style={{ padding: 20, overflowY: 'auto' }}>
          {filtered.length === 0 ? (
            <div style={{ color: 'var(--text-3)', fontSize: 13, textAlign: 'center', padding: 24 }}>
              {labels?.noResults ?? t('connectors.pickerNoResults')}
            </div>
          ) : (
            <div
              style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))',
                gap: 14,
              }}
            >
              {filtered.map((p) => (
                <div
                  key={p.key}
                  style={{
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r-md, 10px)',
                    background: 'var(--surface)',
                    display: 'flex',
                    flexDirection: 'column',
                    alignItems: 'center',
                    overflow: 'hidden',
                    // Remplit la cellule de grille : toutes les cartes d'une
                    // rangée ont la même hauteur.
                    height: '100%',
                  }}
                >
                  {/* `flex:1` absorbe la hauteur excédentaire → le bouton
                      « Select » reste aligné en bas quelle que soit la taille du
                      logo (wordmark seul vs tuile + libellé). */}
                  <div
                    style={{
                      display: 'flex',
                      flexDirection: 'column',
                      alignItems: 'center',
                      justifyContent: 'center',
                      gap: 10,
                      padding: '18px 12px 14px',
                      minHeight: 86,
                      flex: 1,
                      width: '100%',
                    }}
                  >
                    {PROVIDER_WORDMARKS[p.key] ? (
                      <div style={{ display: 'grid', placeItems: 'center', width: '100%' }}>
                        {PROVIDER_WORDMARKS[p.key]}
                      </div>
                    ) : (
                      <>
                        <ProviderTile p={p} />
                        <span style={{ fontWeight: 700, fontSize: 14, textAlign: 'center' }}>{p.label}</span>
                      </>
                    )}
                  </div>
                  <button
                    onClick={() => onPick(p)}
                    style={{
                      width: '100%',
                      padding: '10px 0',
                      borderTop: '1px solid var(--border)',
                      background: 'transparent',
                      color: 'var(--accent)',
                      fontWeight: 600,
                      fontSize: 13,
                      cursor: 'pointer',
                      marginTop: 'auto', // ceinture-bretelles : toujours en bas
                    }}
                  >
                    {labels?.select ?? t('connectors.pickerSelect')}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
