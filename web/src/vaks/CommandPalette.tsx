/* ============================================================
   Vaks — Command palette (⌘K / Ctrl+K) : global search
   Projets + tâches, bornés au périmètre accessible (API /search).
   ============================================================ */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api as ApiClient, type GlobalSearchResults } from '../api/client';
import { Icon } from './primitives';

type Item =
  | { kind: 'project'; id: string; key: string; name: string }
  | { kind: 'task'; id: string; title: string; projectId: string; projectKey: string; projectName: string };

export function CommandPalette({
  onClose,
  onSelectProject,
  onSelectTask,
}: {
  onClose: () => void;
  onSelectProject: (projectId: string) => void;
  onSelectTask: (projectId: string, taskId: string) => void;
}) {
  const { t } = useTranslation('common');
  const [q, setQ] = useState('');
  const [res, setRes] = useState<GlobalSearchResults>({ projects: [], tasks: [] });
  const [loading, setLoading] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const reqId = useRef(0);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Recherche débouncée (200 ms). `reqId` ignore les réponses hors-séquence.
  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) {
      setRes({ projects: [], tasks: [] });
      setLoading(false);
      return;
    }
    setLoading(true);
    const id = ++reqId.current;
    const h = setTimeout(() => {
      ApiClient.globalSearch(term)
        .then((r) => {
          if (id === reqId.current) {
            setRes(r);
            setActive(0);
          }
        })
        .catch(() => {
          if (id === reqId.current) setRes({ projects: [], tasks: [] });
        })
        .finally(() => {
          if (id === reqId.current) setLoading(false);
        });
    }, 200);
    return () => clearTimeout(h);
  }, [q]);

  // Liste plate sélectionnable (projets puis tâches) pour la navigation clavier.
  const items: Item[] = useMemo(
    () => [
      ...res.projects.map((p) => ({ kind: 'project' as const, ...p })),
      ...res.tasks.map((t2) => ({
        kind: 'task' as const,
        id: t2.id,
        title: t2.title,
        projectId: t2.projectId,
        projectKey: t2.projectKey,
        projectName: t2.projectName,
      })),
    ],
    [res],
  );

  const choose = (it: Item) => {
    if (it.kind === 'project') onSelectProject(it.id);
    else onSelectTask(it.projectId, it.id);
    onClose();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      onClose();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, items.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (items[active]) choose(items[active]);
    }
  };

  const term = q.trim();
  const projOffset = 0;
  const taskOffset = res.projects.length;

  return (
    <div className="cmdk-overlay" onMouseDown={onClose}>
      <div className="cmdk-panel" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-modal="true">
        <div className="cmdk-search">
          <Icon name="search" size={17} />
          <input
            ref={inputRef}
            className="cmdk-input"
            value={q}
            placeholder={t('cmdk.placeholder')}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={onKeyDown}
            aria-label={t('cmdk.placeholder')}
          />
          {loading && <Icon name="refresh" size={15} />}
        </div>

        <div className="cmdk-results">
          {term.length < 2 ? (
            <div className="cmdk-hintrow">{t('cmdk.typeMore')}</div>
          ) : items.length === 0 && !loading ? (
            <div className="cmdk-hintrow">{t('cmdk.empty', { q: term })}</div>
          ) : (
            <>
              {res.projects.length > 0 && <div className="cmdk-group">{t('cmdk.projects')}</div>}
              {res.projects.map((p, i) => {
                const idx = projOffset + i;
                return (
                  <button
                    key={'p' + p.id}
                    className={'cmdk-item' + (active === idx ? ' cmdk-on' : '')}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() => choose({ kind: 'project', ...p })}
                  >
                    <Icon name="dash" size={15} />
                    <span className="cmdk-mono">{p.key}</span>
                    <span className="cmdk-label">{p.name}</span>
                  </button>
                );
              })}

              {res.tasks.length > 0 && <div className="cmdk-group">{t('cmdk.tasks')}</div>}
              {res.tasks.map((tk, i) => {
                const idx = taskOffset + i;
                return (
                  <button
                    key={'t' + tk.id}
                    className={'cmdk-item' + (active === idx ? ' cmdk-on' : '')}
                    onMouseEnter={() => setActive(idx)}
                    onClick={() =>
                      choose({
                        kind: 'task',
                        id: tk.id,
                        title: tk.title,
                        projectId: tk.projectId,
                        projectKey: tk.projectKey,
                        projectName: tk.projectName,
                      })
                    }
                  >
                    <Icon name="check" size={15} />
                    <span className="cmdk-label">{tk.title}</span>
                    <span className="cmdk-mono cmdk-dim">{tk.projectKey}</span>
                  </button>
                );
              })}
            </>
          )}
        </div>

        <div className="cmdk-foot">{t('cmdk.hint')}</div>
      </div>
    </div>
  );
}
