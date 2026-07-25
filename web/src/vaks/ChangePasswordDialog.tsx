import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import { useAuth } from '../auth/AuthContext';
import { Icon } from './primitives';
import type { PasswordPolicyDto } from '@vaks-pm/shared';

/**
 * Dialog "Change password". Utilisé :
 *  - en mode `forced` (non-fermable) quand `user.mustChangePassword === true`
 *    (reset par un admin, ou expiration de mot de passe atteinte) ;
 *  - en mode `voluntary` depuis le panneau Security du user.
 *
 * Affiche en temps réel les exigences de la policy org (longueur, complexité)
 * et coche celles que le nouveau mot de passe satisfait.
 */
export default function ChangePasswordDialog({
  mode,
  onClose,
}: {
  mode: 'forced' | 'voluntary';
  onClose: () => void;
}) {
  const { t } = useTranslation('admin');
  const { user, refreshUser } = useAuth();
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [policy, setPolicy] = useState<PasswordPolicyDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // La policy ne s'applique qu'aux comptes LOCAL. Pour les break-glass
  // (authProvider != LOCAL avec allowLocalLogin), on saute les règles —
  // l'écran ne demande que la confirmation. Cohérent avec le backend qui
  // n'enforce rien dans ce cas.
  const policyApplies = user?.authProvider === 'LOCAL';

  useEffect(() => {
    if (!policyApplies) {
      setPolicy(null);
      return;
    }
    api.getPasswordPolicy().then(setPolicy).catch(() => setPolicy(null));
  }, [policyApplies]);

  // Validations live contre la policy.
  const checks = (() => {
    if (!policyApplies) {
      // Pour les break-glass : pas d'exigence de complexité, juste un mot de
      // passe non-vide, confirmation qui match et différent de l'actuel.
      return [
        { label: t('password.checkNotEmpty'), ok: next.length > 0 },
        { label: t('password.checkMatches'), ok: next.length > 0 && next === confirm },
        { label: t('password.checkDifferent'), ok: next.length > 0 && next !== current },
      ];
    }
    if (!policy) return [] as Array<{ label: string; ok: boolean }>;
    const list: Array<{ label: string; ok: boolean }> = [
      { label: t('password.checkMinLength', { count: policy.minLength }), ok: next.length >= policy.minLength },
    ];
    if (policy.complexity === 'Low') {
      list.push({ label: t('password.checkLetter'), ok: /[a-zA-Z]/.test(next) });
      list.push({ label: t('password.checkDigit'), ok: /\d/.test(next) });
    } else if (policy.complexity === 'Medium') {
      list.push({ label: t('password.checkLowercase'), ok: /[a-z]/.test(next) });
      list.push({ label: t('password.checkUppercase'), ok: /[A-Z]/.test(next) });
      list.push({ label: t('password.checkDigit'), ok: /\d/.test(next) });
    } else {
      list.push({ label: t('password.checkLowercase'), ok: /[a-z]/.test(next) });
      list.push({ label: t('password.checkUppercase'), ok: /[A-Z]/.test(next) });
      list.push({ label: t('password.checkDigit'), ok: /\d/.test(next) });
      list.push({ label: t('password.checkSpecial'), ok: /[^A-Za-z0-9]/.test(next) });
    }
    list.push({ label: t('password.checkMatches'), ok: next.length > 0 && next === confirm });
    list.push({ label: t('password.checkDifferent'), ok: next.length > 0 && next !== current });
    return list;
  })();
  const allOk = checks.length > 0 && checks.every((c) => c.ok);

  const submit = async () => {
    setError(null);
    setBusy(true);
    try {
      await api.changePassword(current, next);
      await refreshUser();
      setDone(true);
      // Auto-close en voluntary après 800ms ; en forced on laisse la nav suivre.
      setTimeout(() => onClose(), 800);
    } catch (e) {
      const msg = (e as Error).message;
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      onClick={(e) => {
        if (mode === 'voluntary' && e.target === e.currentTarget) onClose();
      }}
      style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.55)',
        display: 'grid', placeItems: 'center', zIndex: 1100, padding: 16,
      }}
    >
      <div style={{
        width: '100%', maxWidth: 460, background: 'var(--surface)',
        border: '1px solid var(--border)', borderRadius: 'var(--r-lg, 14px)',
        padding: 24, boxShadow: '0 12px 40px rgba(0,0,0,0.4)',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <h2 style={{ fontSize: 16, fontWeight: 700, margin: 0 }}>
            {mode === 'forced' ? t('password.titleForced') : t('password.titleVoluntary')}
          </h2>
          {mode === 'voluntary' && (
            <button className="icon-btn" onClick={onClose} aria-label={t('common:close')}>
              <Icon name="x" size={18} />
            </button>
          )}
        </div>

        {mode === 'forced' && (
          <p style={{ fontSize: 12.5, color: 'var(--text-3)', marginTop: 0, marginBottom: 14 }}>
            {t('password.forcedHint')}
          </p>
        )}

        <Field label={t('password.currentPassword')} type="password" value={current} onChange={setCurrent} autoFocus />
        <Field label={t('password.newPassword')} type="password" value={next} onChange={setNext} />
        <Field label={t('password.confirmNewPassword')} type="password" value={confirm} onChange={setConfirm} />

        {(policyApplies ? policy : true) && (
          <div style={{
            border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
            padding: '10px 12px', marginBottom: 12, fontSize: 12, background: 'var(--surface-2)',
          }}>
            <div style={{ fontWeight: 600, marginBottom: 6, color: 'var(--text-2)' }}>
              {policyApplies ? t('password.policyOrg') : t('password.requirements')}
            </div>
            {checks.map((c, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 8, color: c.ok ? '#22c55e' : 'var(--text-3)' }}>
                <Icon name={c.ok ? 'check' : 'dots'} size={12} />
                <span>{c.label}</span>
              </div>
            ))}
            {policyApplies && policy && policy.historyCount > 0 && (
              <div style={{ marginTop: 6, color: 'var(--text-3)', fontStyle: 'italic' }}>
                {t('password.cannotReuse', { count: policy.historyCount })}
              </div>
            )}
            {!policyApplies && (
              <div style={{ marginTop: 6, color: 'var(--text-3)', fontStyle: 'italic' }}>
                {t('password.breakGlassNoPolicy')}
              </div>
            )}
          </div>
        )}

        {error && (
          <div style={{ color: 'var(--c-over,#e5484d)', fontSize: 12.5, marginBottom: 10 }}>
            {error}
          </div>
        )}
        {done && (
          <div style={{ color: '#22c55e', fontSize: 12.5, marginBottom: 10 }}>
            {t('password.updated')}
          </div>
        )}

        <div style={{ display: 'flex', gap: 8 }}>
          {mode === 'voluntary' && (
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>{t('common:cancel')}</button>
          )}
          <button
            className="btn btn-accent"
            disabled={busy || !current || !allOk}
            onClick={submit}
            style={{ flex: 1 }}
          >
            {busy ? t('password.updating') : t('password.updatePassword')}
          </button>
        </div>
      </div>
    </div>
  );
}

function Field({
  label, type, value, onChange, autoFocus,
}: {
  label: string; type: string; value: string;
  onChange: (v: string) => void; autoFocus?: boolean;
}) {
  return (
    <div style={{ marginBottom: 12 }}>
      <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 6 }}>
        {label}
      </label>
      <input
        type={type}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        autoFocus={autoFocus}
        style={{
          width: '100%', padding: '8px 10px', background: 'var(--surface-2)',
          border: '1px solid var(--border)', borderRadius: 'var(--r-sm)',
          color: 'var(--text)', fontSize: 14,
        }}
      />
    </div>
  );
}
