/* ============================================================
   Onglet « documents externes » d'un projet — navigation LECTURE SEULE d'une
   source de fichiers rattachée au projet (SharePoint de la team Teams, Drive
   partagé Google provisionné, …). Proxy live via l'API (aucune copie).
   Générique : paramétré par `source` (clé machine) + `label` (nom affiché).
   Navigation dossiers (breadcrumb), aperçu texte, lien sortant vers la source.
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api, type ContextFileEntry } from '../../api/client';
import { Icon } from '../primitives';
import { useFormat } from '../../lib/format';
import { safeUrl } from '../../lib/url';
import { fmtBytes } from './shared';

interface Props {
  projectId: string;
  /** Clé machine de la source (`sharepoint`, `google-drive`, …). */
  source: string;
  /** Nom affiché de la source (renvoyé par l'API : « Google Drive », …). */
  label: string;
  /** Couleur d'accent de la source (pour l'aperçu). */
  accent?: string;
  pushToast: (text: string, warn?: boolean) => void;
}

type Crumb = { id: string | null; name: string };

export function ContextFilesTab({ projectId, source, label, accent, pushToast }: Props) {
  const { t } = useTranslation('projects');
  const fmt = useFormat();
  const [stack, setStack] = useState<Crumb[]>([{ id: null, name: '' }]); // [0] = racine
  const [items, setItems] = useState<ContextFileEntry[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [preview, setPreview] = useState<{ doc: ContextFileEntry; content: string; truncated: boolean } | null>(null);
  const [previewLoading, setPreviewLoading] = useState<string | null>(null);
  const reqId = useRef(0);
  const accentColor = accent || '#038387';

  const cwd = stack[stack.length - 1];

  const load = useCallback(
    async (folderId: string | null, append: boolean, cur?: string) => {
      const my = ++reqId.current;
      append ? setLoadingMore(true) : setLoading(true);
      try {
        const res = await api.listProjectContextFiles(projectId, {
          source,
          folderId: folderId ?? undefined,
          cursor: cur,
        });
        if (my !== reqId.current) return; // course : réponse obsolète
        setItems((prev) => (append ? [...prev, ...res.items] : res.items));
        setCursor(res.nextCursor ?? null);
      } catch (e) {
        if (my === reqId.current) pushToast((e as Error).message, true);
      } finally {
        if (my === reqId.current) {
          setLoading(false);
          setLoadingMore(false);
        }
      }
    },
    [projectId, source, pushToast],
  );

  // (Re)charge à chaque changement de dossier courant (ou de source).
  useEffect(() => {
    setStack([{ id: null, name: '' }]);
  }, [source]);
  useEffect(() => {
    setItems([]);
    setCursor(null);
    void load(cwd.id, false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cwd.id, projectId, source]);

  const enterFolder = (f: ContextFileEntry) => setStack((s) => [...s, { id: f.id, name: f.name }]);
  const goTo = (idx: number) => setStack((s) => s.slice(0, idx + 1));

  const openFile = async (f: ContextFileEntry) => {
    setPreviewLoading(f.id);
    try {
      const res = await api.getProjectContextFile(projectId, source, f.id);
      setPreview({ doc: res.document, content: res.content, truncated: res.truncated });
    } catch (e) {
      pushToast((e as Error).message, true);
    } finally {
      setPreviewLoading(null);
    }
  };

  const sorted = useMemo(
    () =>
      [...items].sort((a, b) => {
        if (a.isFolder !== b.isFolder) return a.isFolder ? -1 : 1;
        return a.name.localeCompare(b.name);
      }),
    [items],
  );

  return (
    <div className="md-field">
      {/* Fil d'Ariane */}
      <div className="row gap1" style={{ flexWrap: 'wrap', marginBottom: 10, fontSize: 13, alignItems: 'center' }}>
        {stack.map((c, i) => (
          <React.Fragment key={`${c.id ?? 'root'}-${i}`}>
            {i > 0 && <Icon name="chevR" size={12} style={{ color: 'var(--text-3)' }} />}
            <button
              className="btn btn-ghost btn-sm"
              onClick={() => goTo(i)}
              style={i === stack.length - 1 ? { color: 'var(--accent)' } : undefined}
            >
              {i === 0 ? (
                <>
                  <Icon name="folder" size={13} /> {label}
                </>
              ) : (
                c.name
              )}
            </button>
          </React.Fragment>
        ))}
        <button className="icon-btn" title={t('contextFiles.refresh')} onClick={() => load(cwd.id, false)} style={{ marginLeft: 4 }}>
          <Icon name="refresh" size={13} />
        </button>
      </div>

      {loading ? (
        <div style={{ color: 'var(--text-3)', fontSize: 13 }}>{t('contextFiles.loading')}</div>
      ) : sorted.length === 0 ? (
        <div className="md-span" style={{ color: 'var(--text-3)' }}>{t('contextFiles.emptyFolder')}</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
          {sorted.map((f) =>
            f.isFolder ? (
              <div key={f.id} className="doc-row">
                <button className="doc-name" onClick={() => enterFolder(f)} style={{ fontWeight: 600 }}>
                  <Icon name="folder" size={14} style={{ color: 'var(--accent)' }} />
                  <span className="truncate">{f.name}</span>
                </button>
                <span className="doc-meta mono">{t('contextFiles.folder')}</span>
                <span className="doc-meta" />
                <div className="doc-actions" />
              </div>
            ) : (
              <div key={f.id} className="doc-row">
                <button
                  className="doc-name"
                  onClick={() => openFile(f)}
                  title={t('contextFiles.previewTitle')}
                  disabled={previewLoading === f.id}
                >
                  <Icon name={previewLoading === f.id ? 'refresh' : 'eye'} size={14} />
                  <span className="truncate">{f.name}</span>
                </button>
                <span className="doc-meta mono">{typeof f.size === 'number' ? fmtBytes(f.size) : ''}</span>
                <span className="doc-meta truncate">{f.lastModified ? fmt.dateTime(f.lastModified) : ''}</span>
                <div className="doc-actions">
                  {f.webUrl && (
                    <a
                      className="icon-btn"
                      href={safeUrl(f.webUrl)}
                      target="_blank"
                      rel="noreferrer noopener"
                      title={t('contextFiles.openIn', { source: label })}
                    >
                      <Icon name="link" size={13} />
                    </a>
                  )}
                </div>
              </div>
            ),
          )}
        </div>
      )}

      {cursor && (
        <div style={{ marginTop: 8 }}>
          <button className="btn btn-ghost btn-sm" disabled={loadingMore} onClick={() => load(cwd.id, true, cursor)}>
            {loadingMore ? t('contextFiles.loading') : t('contextFiles.loadMore')}
          </button>
        </div>
      )}

      <div className="md-hint" style={{ marginTop: 8 }}>
        {t('contextFiles.explainer', { source: label })}
      </div>

      {/* Aperçu texte d'un fichier */}
      {preview && (
        <div className="md-overlay" onMouseDown={() => setPreview(null)} style={{ zIndex: 8000 }}>
          <div
            className="md-card"
            role="dialog"
            aria-modal="true"
            onMouseDown={(e) => e.stopPropagation()}
            style={{ width: 'min(760px, 100%)', outline: 'none' }}
          >
            <div className="md-head">
              <div className="anav-mark" style={{ width: 38, height: 38, background: `color-mix(in oklch, ${accentColor} 16%, transparent)`, color: accentColor }}>
                <Icon name="eye" size={18} />
              </div>
              <div className="grow" style={{ minWidth: 0 }}>
                <div className="md-eyebrow mono">
                  {typeof preview.doc.size === 'number' ? fmtBytes(preview.doc.size) : label}
                  {preview.doc.lastModified ? ` · ${fmt.dateTime(preview.doc.lastModified)}` : ''}
                </div>
                <div className="md-title truncate">{preview.doc.name}</div>
              </div>
              {preview.doc.webUrl && (
                <a className="btn btn-ghost btn-sm" href={safeUrl(preview.doc.webUrl)} target="_blank" rel="noreferrer noopener">
                  <Icon name="link" size={13} /> {t('contextFiles.openIn', { source: label })}
                </a>
              )}
              <button className="icon-btn" onClick={() => setPreview(null)} aria-label={t('common:close')}>
                <Icon name="x" size={18} />
              </button>
            </div>
            <div className="md-body">
              {preview.truncated && <div className="md-hint" style={{ marginBottom: 6 }}>{t('contextFiles.truncated', { source: label })}</div>}
              <pre
                style={{
                  whiteSpace: 'pre-wrap',
                  wordBreak: 'break-word',
                  maxHeight: '60vh',
                  overflowY: 'auto',
                  fontSize: 13,
                  lineHeight: 1.5,
                  background: 'var(--surface-2)',
                  padding: 12,
                  borderRadius: 8,
                  margin: 0,
                }}
              >
                {preview.content || t('contextFiles.noText', { source: label })}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
