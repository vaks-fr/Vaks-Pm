import type { ReactNode } from 'react';
import { KNOWN_AGENT_MODELS } from '@vaks-pm/shared';
import { OFFICIAL_LOGO_PATHS } from './provider-logos.generated';

/**
 * Marque + logo par provider de modèle (partagé entre la fiche agent et les
 * panneaux de gouvernance). Logos SVG inline, self-contained (aucun asset
 * externe). Un provider absent retombe sur une tuile monogramme.
 */
export const PROVIDER_BRAND: Record<string, { label: string; color: string; short: string }> = {
  anthropic: { label: 'Anthropic', color: '#d97757', short: 'A' },
  openai: { label: 'OpenAI', color: '#10a37f', short: 'AI' },
  'azure-openai': { label: 'Azure OpenAI', color: '#0078d4', short: 'AZ' },
  google: { label: 'Google', color: '#4285f4', short: 'G' },
  mistral: { label: 'Mistral', color: '#fa520f', short: 'M' },
  'github-copilot': { label: 'GitHub Copilot', color: '#6e40c9', short: 'GH' },
  'microsoft-copilot': { label: 'Microsoft Copilot', color: '#0078d4', short: 'MS' },
  xai: { label: 'xAI (Grok)', color: '#111827', short: 'xAI' },
  deepseek: { label: 'DeepSeek', color: '#4d6bfe', short: 'DS' },
  zai: { label: 'Z.AI (GLM)', color: '#2f6df6', short: 'GLM' },
  meta: { label: 'Meta (Llama)', color: '#0064e0', short: 'L' },
  qwen: { label: 'Qwen', color: '#615ced', short: 'Qw' },
  moonshot: { label: 'Moonshot (Kimi)', color: '#111827', short: 'K' },
  cohere: { label: 'Cohere', color: '#39594d', short: 'Co' },
};

export function brandOf(provider: string) {
  return (
    PROVIDER_BRAND[provider] ?? {
      label: provider,
      color: 'var(--text-3)',
      short: provider.slice(0, 2).toUpperCase(),
    }
  );
}

/** Providers distincts présents au catalogue embarqué (ordre du catalogue). */
export const KNOWN_PROVIDERS: string[] = [...new Set(KNOWN_AGENT_MODELS.map((m) => m.provider))];

const PROVIDER_SVG: Record<string, ReactNode> = {
  anthropic: (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <path fill="#D97757" d="M15.3 3.6h-3.1l5.6 16.8h3.2L15.3 3.6zM8.7 3.6L3 20.4h3.3l1.16-3.53h5.62L14.25 20.4h3.3L11.86 3.6H8.7zm-.36 10.2L10 8.6l1.66 5.2H8.34z" />
    </svg>
  ),
  openai: (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <path fill="#10A37F" d="M21.3 9.9a5.4 5.4 0 0 0-.46-4.42 5.44 5.44 0 0 0-5.86-2.6A5.4 5.4 0 0 0 6.9 3.9a5.4 5.4 0 0 0-3.6 2.62 5.44 5.44 0 0 0 .67 6.37 5.4 5.4 0 0 0 .46 4.43 5.44 5.44 0 0 0 5.86 2.6A5.4 5.4 0 0 0 17.1 20a5.4 5.4 0 0 0 3.6-2.62 5.44 5.44 0 0 0-.67-6.37zM12 20.1a4 4 0 0 1-2.57-.93l.13-.07 4.27-2.47a.7.7 0 0 0 .35-.6V9.98l1.8 1.05v4.98A4.03 4.03 0 0 1 12 20.1zM5.3 16.9a4 4 0 0 1-.48-2.7l.13.08 4.27 2.47a.7.7 0 0 0 .7 0l5.22-3.01v2.08l-4.32 2.5a4.03 4.03 0 0 1-5.5-1.42zM4.2 7.9a4 4 0 0 1 2.1-1.76v5.02a.68.68 0 0 0 .34.6l5.2 3-1.8 1.05-4.27-2.46a4.03 4.03 0 0 1-1.57-5.45zm14.83 3.45l-5.22-3.03 1.8-1.04 4.32 2.5a4.02 4.02 0 0 1-.62 7.26v-5.09a.7.7 0 0 0-.28-.6zM20.82 8.6l-.13-.08-4.27-2.48a.7.7 0 0 0-.7 0l-5.21 3.01V7l4.32-2.49a4.03 4.03 0 0 1 5.99 4.18zM9.5 12.35L7.7 11.3V6.32a4.03 4.03 0 0 1 6.6-3.09l-.13.07L9.9 5.77a.7.7 0 0 0-.35.6l-.05 5.98zm.98-2.1L12 9.35l1.53.88v1.77L12 14.9l-1.53-.88z" />
    </svg>
  ),
  'azure-openai': (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <path fill="#0078D4" d="M9.3 3.5h6l-6.2 12.3h4.6L6.9 20.5 3 20.4 9.3 3.5zm4.1 6.3l3.4-6.3h4.3L21 20.4h-8.9l4.9-1.9-3.6-4.4z" />
    </svg>
  ),
  google: (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <path fill="#4285F4" d="M21.6 12.2c0-.63-.06-1.25-.16-1.84H12v3.49h5.38a4.6 4.6 0 0 1-2 3.02v2.5h3.24c1.9-1.75 2.98-4.33 2.98-7.17z" />
      <path fill="#34A853" d="M12 22c2.7 0 4.96-.9 6.62-2.42l-3.24-2.5c-.9.6-2.05.96-3.38.96-2.6 0-4.8-1.76-5.58-4.12H3.06v2.6A10 10 0 0 0 12 22z" />
      <path fill="#FBBC05" d="M6.42 13.92a6 6 0 0 1 0-3.84v-2.6H3.06a10 10 0 0 0 0 9.04l3.36-2.6z" />
      <path fill="#EA4335" d="M12 5.96c1.47 0 2.79.5 3.83 1.5l2.87-2.87A10 10 0 0 0 3.06 7.48l3.36 2.6C7.2 7.72 9.4 5.96 12 5.96z" />
    </svg>
  ),
  mistral: (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <path fill="#F7D046" d="M3 4h4v4H3zM17 4h4v4h-4z" />
      <path fill="#F2A73B" d="M3 8h4v4H3zM9 8h4v4H9zM17 8h4v4h-4z" />
      <path fill="#EE792F" d="M3 12h4v4H3zM9 12h4v4H9zM17 12h4v4h-4z" />
      <path fill="#EB5829" d="M3 16h4v4H3zM17 16h4v4h-4z" />
    </svg>
  ),
  'github-copilot': (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <path fill="#6E40C9" d="M12 2.2A9.8 9.8 0 0 0 8.9 21.3c.49.09.67-.21.67-.47v-1.8c-2.72.6-3.3-1.16-3.3-1.16-.44-1.14-1.09-1.44-1.09-1.44-.9-.6.07-.6.07-.6.98.07 1.5 1.02 1.5 1.02.88 1.5 2.3 1.07 2.86.82.09-.64.34-1.07.62-1.32-2.17-.25-4.45-1.09-4.45-4.83 0-1.07.38-1.94 1.02-2.62-.1-.25-.44-1.25.1-2.6 0 0 .83-.27 2.72 1a9.4 9.4 0 0 1 4.95 0c1.89-1.27 2.72-1 2.72-1 .54 1.35.2 2.35.1 2.6.64.68 1.02 1.55 1.02 2.62 0 3.75-2.29 4.58-4.47 4.82.35.3.66.9.66 1.82v2.7c0 .26.18.57.68.47A9.8 9.8 0 0 0 12 2.2z" />
    </svg>
  ),
  'microsoft-copilot': (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <path fill="#F25022" d="M3 3h8.5v8.5H3z" />
      <path fill="#7FBA00" d="M12.5 3H21v8.5h-8.5z" />
      <path fill="#00A4EF" d="M3 12.5h8.5V21H3z" />
      <path fill="#FFB900" d="M12.5 12.5H21V21h-8.5z" />
    </svg>
  ),
  deepseek: (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <path fill="#4D6BFE" d="M3.6 11.6c.6-.7 1.6-1 2.6-.7.6-1.9 2.4-3.3 4.6-3.3 2.7 0 4.8 2.1 4.8 4.8 0 .5-.1 1-.2 1.4 1 .1 1.9.5 1.9 1.1 0 .8-1.2 1.2-3 1.2H8.6c-2.6 0-4.6-1.3-4.6-3 0-.4.1-.8.4-1.1-.6-.2-1-.8-.8-1.4z" />
      <circle cx="13.4" cy="11" r="0.95" fill="#fff" />
    </svg>
  ),
  qwen: (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <circle cx="11" cy="12" r="7" fill="none" stroke="#615CED" strokeWidth="2.6" />
      <path d="M13 14l5 5" fill="none" stroke="#615CED" strokeWidth="2.6" strokeLinecap="round" />
    </svg>
  ),
  meta: (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <g fill="none" stroke="#0064E0" strokeWidth="2.4">
        <circle cx="8.5" cy="12" r="4" />
        <circle cx="15.5" cy="12" r="4" />
      </g>
    </svg>
  ),
  zai: (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <path d="M6.5 6.5h11L6.5 17.5h11" fill="none" stroke="#2F6DF6" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  ),
  xai: (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <path fill="#111827" d="M3.8 3.5h4l3.9 5.4 3.9-5.4h4l-6 8.2 6.4 8.8h-4l-4.3-5.9-4.3 5.9h-4l6.4-8.8z" />
    </svg>
  ),
  moonshot: (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <path fill="#111827" d="M15 3.5a8.5 8.5 0 1 0 5.5 15A7 7 0 0 1 15 3.5z" />
    </svg>
  ),
  cohere: (
    <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
      <circle cx="12" cy="12" r="7.5" fill="none" stroke="#39594D" strokeWidth="2.6" />
      <circle cx="12" cy="12" r="2.4" fill="#39594D" />
    </svg>
  ),
};

export function ProviderLogo({ provider, size = 18 }: { provider: string; size?: number }) {
  // Priorité aux logos OFFICIELS (simple-icons, monochromes) teintés couleur de
  // marque ; sinon mark stylisé maison (openai/xai/glm/cohere) ; sinon monogramme.
  const official = OFFICIAL_LOGO_PATHS[provider];
  if (official?.length) {
    const color = brandOf(provider).color;
    return (
      <span aria-hidden style={{ width: size, height: size, flexShrink: 0, display: 'inline-grid', placeItems: 'center' }}>
        <svg viewBox="0 0 24 24" width="100%" height="100%" aria-hidden>
          {official.map((d, i) => (
            <path key={i} fill={color} d={d} />
          ))}
        </svg>
      </span>
    );
  }
  const svg = PROVIDER_SVG[provider];
  if (svg) {
    return (
      <span aria-hidden style={{ width: size, height: size, flexShrink: 0, display: 'inline-grid', placeItems: 'center' }}>
        {svg}
      </span>
    );
  }
  const b = brandOf(provider);
  return (
    <span
      aria-hidden
      style={{
        width: size, height: size, borderRadius: 5, flexShrink: 0,
        display: 'inline-grid', placeItems: 'center',
        background: b.color, color: '#fff',
        fontSize: Math.round(size * 0.48), fontWeight: 700, lineHeight: 1,
      }}
    >
      {b.short}
    </span>
  );
}
