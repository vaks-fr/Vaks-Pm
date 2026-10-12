/* ============================================================
   Aperçu in-app d'un fichier TEXTE (Markdown, txt, csv, json, yaml, log…).
   Générique : utilisé pour l'espace Documents d'un projet, les livrables
   d'agents et les pièces jointes de tâche. Les binaires (pdf, docx, images…)
   continuent de se télécharger directement — cette modale ne s'ouvre que pour
   un fichier `isViewableDoc`.

   Le contenu est récupéré via un `fetchBlob()` fourni par l'appelant (la MÊME
   route de download que le téléchargement, blob → texte) : aucun endpoint neuf.
   Le Markdown est rendu par `renderMarkdown` (échappement HTML intégral en
   amont → pas de XSS). Un bouton « Télécharger » reste disponible dans l'aperçu.
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from '../primitives';
import { useEscapeKey, fmtBytes } from './shared';
import { renderMarkdown } from '../../lib/markdown';

/** Extensions rendues comme Markdown. */
const MD_EXT = new Set(['md', 'markdown']);
/** Extensions affichables en texte brut (aperçu monospace). */
const TEXT_EXT = new Set([
  'txt', 'csv', 'json', 'yaml', 'yml', 'log', 'xml', 'html', 'css', 'js', 'ts',
  'tsx', 'jsx', 'py', 'sh', 'sql', 'ini', 'conf', 'toml', 'env', 'diff', 'patch',
]);

/** Plafond d'aperçu : au-delà, on télécharge plutôt que de charger en mémoire. */
const MAX_VIEW_BYTES = 2 * 1024 * 1024;

function extOf(name: string): string {
  return name.trim().toLowerCase().split('.').pop() ?? '';
}

/**
 * Un fichier est-il visualisable en aperçu (vs. téléchargement direct) ?
 * `mimeType` est optionnel : certaines sources (PJ d'un livrable) ne le portent
 * pas, l'extension suffit alors à décider.
 */
export function isViewableDoc(d: { filename: string; mimeType?: string | null; sizeBytes: number }): boolean {
  if (d.sizeBytes > MAX_VIEW_BYTES) return false;
  const ext = extOf(d.filename);
  if (MD_EXT.has(ext) || TEXT_EXT.has(ext)) return true;
  // Repli sur le mimeType pour les fichiers sans extension connue.
  return !!d.mimeType && (d.mimeType.startsWith('text/') || d.mimeType === 'application/json');
}

interface Props {
  /** Métadonnées affichées dans l'en-tête et servant au choix du rendu. */
  target: { filename: string; sizeBytes: number };
  /** Récupère le contenu brut (blob) — typiquement la route de download. */
  fetchBlob: () => Promise<Blob>;
  onClose: () => void;
  /** Déclenche le téléchargement classique (bouton dans l'aperçu). */
  onDownload: () => void;
}

export function DocumentViewerModal({ target, fetchBlob, onClose, onDownload }: Props) {
  const { t } = useTranslation('projects');
  const [text, setText] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEscapeKey(onClose);

  const isMd = MD_EXT.has(extOf(target.filename));

  // `fetchBlob` change d'identité à chaque rendu du parent : on le fige dans un
  // ref pour ne charger qu'UNE fois (au montage / changement de fichier), sans
  // boucle de refetch.
  const fetchRef = useRef(fetchBlob);
  fetchRef.current = fetchBlob;

  useEffect(() => {
    let alive = true;
    setText(null);
    setError(null);
    fetchRef
      .current()
      .then((blob) => blob.text())
      .then((txt) => {
        if (alive) setText(txt);
      })
      .catch((e) => {
        if (alive) setError((e as Error).message);
      });
    return () => {
      alive = false;
    };
  }, [target.filename]);

  const rendered = useMemo(() => (isMd && text != null ? renderMarkdown(text) : null), [isMd, text]);

  return (
    <div className="md-overlay" onMouseDown={onClose} style={{ zIndex: 7000 }}>
      <div
        className="md-card doc-view-card"
        onMouseDown={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        style={{ width: 'min(820px, 100%)', outline: 'none' }}
      >
        <div className="md-head">
          <div
            className="anav-mark"
            style={{ width: 38, height: 38, background: 'var(--c-over-bg)', color: 'var(--c-over)' }}
          >
            <Icon name="eye" size={18} />
          </div>
          <div className="grow" style={{ minWidth: 0 }}>
            <div className="md-eyebrow mono">{fmtBytes(target.sizeBytes)}</div>
            <div className="md-title truncate">{target.filename}</div>
          </div>
          <button
            className="btn btn-ghost btn-sm"
            onClick={onDownload}
            title={t('documents.downloadTitle')}
          >
            <Icon name="download" size={14} /> {t('documents.downloadTitle')}
          </button>
          <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
            <Icon name="x" size={18} />
          </button>
        </div>
        <div className="md-body doc-view-body">
          {error ? (
            <div style={{ color: 'var(--danger)' }}>{error}</div>
          ) : text == null ? (
            <div style={{ color: 'var(--text-3)' }}>{t('documents.loading')}</div>
          ) : rendered != null ? (
            <div className="md-rendered" dangerouslySetInnerHTML={{ __html: rendered }} />
          ) : (
            <pre className="doc-view-pre">{text}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
