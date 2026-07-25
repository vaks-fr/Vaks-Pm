/* ============================================================
   Primitives connecteurs — identité visuelle des providers.
   Trois niveaux, du plus riche au plus générique :
   1. `PROVIDER_WORDMARKS` — logo « wordmark » large incluant le NOM de la
      marque (deux variantes thème clair/sombre, classes `.cn-wm-*` de
      admin.css). Remplace la tuile ET le libellé dans le picker.
   2. `PROVIDER_LOGOS` — glyph carré sans texte (logo produit officiel).
      Remplace le monogramme dans la tuile, le libellé reste affiché.
   3. Monogramme coloré — fallback quand le provider n'a aucun logo.
   ============================================================ */
import type { ReactNode } from 'react';
import type { NormalizedProvider } from './types';
// Logos de marque officiels (assets fournis, convertis EPS→PNG). Variante claire
// (texte foncé) pour thème clair, variante blanche pour thème sombre.
import snLogoColor from '../assets/sn-color.png';
import snLogoWhite from '../assets/sn-white.png';
// Glyph officiel Microsoft Entra (SVG couleur, lisible sur les deux thèmes).
import entraLogo from '../assets/entra.svg';
// Mark GitHub officiel (monochrome sombre → nécessite une pastille claire).
import githubLogo from '../assets/github.svg';
// Logos produits Microsoft (polychromes, lisibles sur les deux thèmes).
import msteamsLogo from '../assets/msteams.svg';
import sharepointLogo from '../assets/sharepoint.svg';
// Mark officiel Slack (polychrome, lisible sur les deux thèmes).
import slackLogo from '../assets/slack.svg';
// Glyph Google Chat (bulle verte, reproduction simplifiée du mark officiel).
import gchatLogo from '../assets/gchat.svg';
// Mark officiel Google Drive (triangle polychrome, lisible sur les deux thèmes).
import gdriveLogo from '../assets/gdrive.svg';

/**
 * Logos « wordmark » officiels des fournisseurs (larges, avec le nom), keyés par
 * clé normalisée. La bonne variante est choisie par CSS selon `data-theme`
 * (classes `.cn-wm-color` / `.cn-wm-white`, cf. admin.css).
 */
export const PROVIDER_WORDMARKS: Record<string, ReactNode> = {
  servicenow: (
    <>
      <img src={snLogoColor} alt="ServiceNow" className="cn-wm cn-wm-color" />
      <img src={snLogoWhite} alt="ServiceNow" className="cn-wm cn-wm-white" />
    </>
  ),
};

/**
 * Glyphs carrés (logo produit sans texte), keyés par clé normalisée. Utilisés
 * DANS la tuile à la place du monogramme — le libellé du provider reste affiché
 * à côté/dessous.
 *
 * `bg` : pastille de fond. Indispensable pour les marques **monochromes
 * sombres** (GitHub), qui disparaîtraient sur le thème sombre. Les logos
 * polychromes (Entra) s'en passent et occupent toute la tuile.
 */
export const PROVIDER_LOGOS: Record<string, { src: string; bg?: string }> = {
  'entra-agent': { src: entraLogo },
  github: { src: githubLogo, bg: '#ffffff' },
  msteams: { src: msteamsLogo },
  sharepoint: { src: sharepointLogo },
  slack: { src: slackLogo },
  gchat: { src: gchatLogo },
  // Deux clés pour la même marque : `gdrive` = provisioning du Drive partagé
  // (collab), `google-drive` = connecteur de lecture des documents (filesources).
  gdrive: { src: gdriveLogo },
  'google-drive': { src: gdriveLogo },
};

/** Tuile du provider : logo officiel si connu, sinon monogramme coloré. */
export function ProviderTile({
  p,
  size = 48,
}: {
  p: Pick<NormalizedProvider, 'label' | 'accent' | 'short'> & { key?: string };
  size?: number;
}) {
  const logo = p.key ? PROVIDER_LOGOS[p.key] : undefined;
  if (logo) {
    // Sur pastille : on rétrécit le glyph pour lui laisser une marge interne
    // (un mark collé aux bords de la pastille fait sale).
    const inner = logo.bg ? Math.round(size * 0.68) : size;
    return (
      <div
        aria-hidden
        style={{
          width: size,
          height: size,
          borderRadius: size * 0.28,
          display: 'grid',
          placeItems: 'center',
          flexShrink: 0,
          ...(logo.bg
            ? { background: logo.bg, border: '1px solid var(--border)' }
            : null),
        }}
      >
        <img src={logo.src} alt="" style={{ width: inner, height: inner, objectFit: 'contain' }} />
      </div>
    );
  }

  const accent = p.accent || 'var(--accent)';
  const mono = (p.short || p.label.slice(0, 2)).toLowerCase();
  return (
    <div
      aria-hidden
      style={{
        width: size,
        height: size,
        borderRadius: size * 0.28,
        background: `color-mix(in srgb, ${accent} 16%, var(--surface))`,
        border: `1px solid color-mix(in srgb, ${accent} 40%, var(--border))`,
        display: 'grid',
        placeItems: 'center',
        color: accent,
        fontWeight: 800,
        fontSize: size * 0.32,
        letterSpacing: '-0.02em',
        flexShrink: 0,
      }}
    >
      {mono}
    </div>
  );
}
