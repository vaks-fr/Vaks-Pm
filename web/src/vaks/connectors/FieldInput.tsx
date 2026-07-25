/* ============================================================
   Primitives connecteurs — rendu d'un champ de config selon son
   descripteur. Extrait de TicketingConnectorsSection et élargi des
   types `toggle` / `segmented` / `select` (providers décrits côté UI,
   ex. Collaboration spaces — aucun changement API).
   ============================================================ */
import { useTranslation } from 'react-i18next';
import type { NormalizedField } from './types';
import type { DraftState } from './draft';

export default function FieldInput({
  field,
  draft,
  setDraft,
}: {
  field: NormalizedField;
  draft: DraftState;
  setDraft: (fn: (d: DraftState) => DraftState) => void;
}) {
  const { t } = useTranslation('integrations');
  const isSecret = field.secret;
  const alreadySet = draft.secretsConfigured.includes(field.key);
  const val = isSecret ? (draft.secrets[field.key] ?? '') : draft.config[field.key];

  const setConfig = (v: unknown) =>
    setDraft((d) => ({ ...d, config: { ...d.config, [field.key]: v } }));

  if (field.type === 'multiselect') {
    const selected: string[] = Array.isArray(val) ? (val as string[]) : [];
    const toggle = (opt: string) =>
      setDraft((d) => {
        const cur = Array.isArray(d.config[field.key]) ? (d.config[field.key] as string[]) : [];
        const next = cur.includes(opt) ? cur.filter((x) => x !== opt) : [...cur, opt];
        return { ...d, config: { ...d.config, [field.key]: next } };
      });
    return (
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {(field.options ?? []).map((o) => {
          const on = selected.includes(o.value);
          return (
            <button
              key={o.value}
              type="button"
              className="btn btn-ghost"
              onClick={() => toggle(o.value)}
              style={{
                fontSize: 12,
                padding: '4px 10px',
                border: '1px solid var(--border)',
                background: on ? 'color-mix(in oklch, var(--accent) 18%, var(--surface))' : 'var(--surface)',
                color: on ? 'var(--accent)' : 'var(--text-2)',
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (field.type === 'toggle') {
    return (
      <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
        <input type="checkbox" checked={val === true} onChange={(e) => setConfig(e.target.checked)} />
        {field.placeholder ?? ''}
      </label>
    );
  }

  if (field.type === 'segmented') {
    return (
      <div style={{ display: 'flex', gap: 6 }}>
        {(field.options ?? []).map((o) => {
          const on = val === o.value;
          return (
            <button
              key={o.value}
              type="button"
              className="btn btn-ghost"
              onClick={() => setConfig(o.value)}
              style={{
                fontSize: 12,
                padding: '4px 12px',
                border: '1px solid var(--border)',
                background: on ? 'color-mix(in oklch, var(--accent) 18%, var(--surface))' : 'var(--surface)',
                color: on ? 'var(--accent)' : 'var(--text-2)',
              }}
            >
              {o.label}
            </button>
          );
        })}
      </div>
    );
  }

  if (field.type === 'select') {
    return (
      <select
        className="td-in"
        value={String(val ?? '')}
        onChange={(e) => setConfig(e.target.value)}
        style={{ width: '100%' }}
      >
        {(field.options ?? []).map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'textarea') {
    return (
      <textarea
        className="td-in"
        rows={3}
        value={String(val ?? '')}
        placeholder={isSecret && alreadySet ? t('connectors.secretKeepPlaceholder') : field.placeholder}
        autoComplete={isSecret ? 'off' : undefined}
        onChange={(e) =>
          isSecret
            ? setDraft((d) => ({ ...d, secrets: { ...d.secrets, [field.key]: e.target.value } }))
            : setConfig(e.target.value)
        }
        style={{ width: '100%', resize: 'vertical', fontFamily: 'inherit' }}
      />
    );
  }

  return (
    <input
      className="td-in"
      type={isSecret ? 'password' : field.type === 'url' ? 'url' : 'text'}
      value={isSecret ? (draft.secrets[field.key] ?? '') : String(val ?? '')}
      placeholder={isSecret && alreadySet ? t('connectors.secretKeepPlaceholder') : field.placeholder}
      autoComplete={isSecret ? 'new-password' : 'off'}
      onChange={(e) =>
        setDraft((d) =>
          isSecret
            ? { ...d, secrets: { ...d.secrets, [field.key]: e.target.value } }
            : { ...d, config: { ...d.config, [field.key]: e.target.value } },
        )
      }
      style={{ width: '100%' }}
    />
  );
}
