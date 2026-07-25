/* ============================================================
   Vaks — dialogue de confirmation thémé (remplace window.confirm)
   Usage : const confirm = useConfirm();
           if (await confirm({ title, message, danger })) { ... }
   ============================================================ */
import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Icon } from './primitives';

export interface ConfirmOptions {
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  /** Style « destructif » (bouton rouge) pour les suppressions. */
  danger?: boolean;
}

type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;

const ConfirmContext = createContext<ConfirmFn>(async () => false);

/** Hook : renvoie une fonction `confirm(opts) => Promise<boolean>`. */
export function useConfirm(): ConfirmFn {
  return useContext(ConfirmContext);
}

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation('common');
  const [state, setState] = useState<ConfirmOptions | null>(null);
  const resolver = useRef<((v: boolean) => void) | null>(null);

  const confirm = useCallback<ConfirmFn>(
    (opts) =>
      new Promise<boolean>((resolve) => {
        resolver.current = resolve;
        setState(opts);
      }),
    [],
  );

  const close = useCallback((v: boolean) => {
    setState(null);
    resolver.current?.(v);
    resolver.current = null;
  }, []);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false);
      else if (e.key === 'Enter') close(true);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [state, close]);

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <div
          onClick={() => close(false)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.55)',
            zIndex: 9000,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            padding: 24,
            backdropFilter: 'blur(2px)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            role="dialog"
            aria-modal="true"
            style={{
              background: 'var(--surface)',
              color: 'var(--text)',
              border: '1px solid var(--border)',
              borderRadius: 12,
              width: 'min(420px, 96vw)',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '0 24px 60px rgba(0,0,0,0.45)',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '16px 20px 8px' }}>
              {state.danger && (
                <span
                  style={{
                    display: 'grid',
                    placeItems: 'center',
                    width: 30,
                    height: 30,
                    flexShrink: 0,
                    borderRadius: '50%',
                    background: 'var(--c-over-bg)',
                    color: 'var(--c-over)',
                  }}
                >
                  <Icon name="warn" size={16} />
                </span>
              )}
              <h2 style={{ margin: 0, fontSize: 16, fontWeight: 700 }}>{state.title}</h2>
            </div>

            {state.message && (
              <p style={{ margin: 0, padding: '0 20px 16px', fontSize: 14, lineHeight: 1.5, color: 'var(--text-2)' }}>
                {state.message}
              </p>
            )}

            <div
              style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
                padding: '12px 20px',
                borderTop: '1px solid var(--border)',
              }}
            >
              <button className="btn btn-ghost btn-sm" onClick={() => close(false)}>
                {state.cancelLabel ?? t('cancel')}
              </button>
              <button
                className="btn btn-sm"
                autoFocus
                onClick={() => close(true)}
                style={
                  state.danger
                    ? { background: 'oklch(0.55 0.22 27)', color: '#fff', border: 0 }
                    : undefined
                }
              >
                {state.confirmLabel ?? t('confirm', { defaultValue: 'Confirm' })}
              </button>
            </div>
          </div>
        </div>
      )}
    </ConfirmContext.Provider>
  );
}
