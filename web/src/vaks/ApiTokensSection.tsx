/* ============================================================
   Jetons API (Phase 9). Mode `user` (PAT perso, dans les options du compte)
   ou `org` (clés organisation, panel admin — lecture seule v1).
   Le secret en clair n'est affiché QU'UNE FOIS, à la création.
   ============================================================ */
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../api/client';
import type { ApiTokenDto } from '../api/client';
import { useConfirm } from './confirm';
import SecretOnceBanner from './connectors/SecretOnceBanner';

type Flash = (msg: string, kind?: 'info' | 'ok' | 'err') => void;

/** Scopes connus (alimente les tooltips). Les libellés vivent dans i18n. */
const KNOWN_SCOPES = new Set<string>([
  'org:manage', 'org:settings', 'member:manage', 'role:manage',
  'project:create', 'project:view', 'project:view_all', 'project:update',
  'project:archive', 'project:delete', 'project:assign_managers',
  'task:create', 'task:view', 'task:update', 'task:delete',
  'comment:create', 'attachment:manage', 'time:log', 'allocation:manage',
  'timeoff:write',
  'report:view', 'report:view_all', 'finance:view', 'finance:manage',
  'webhook:manage', 'client:view', 'client:manage',
  'team:create', 'team:delete', 'team:manage_members',
  'skills:write', 'mcp:access', 'collab:link',
]);

const isoDate = (d: Date) => d.toISOString().slice(0, 10);
const plusYears = (n: number) => {
  const d = new Date();
  d.setFullYear(d.getFullYear() + n);
  return d;
};
const EXP_DEFAULT = isoDate(plusYears(1));
const EXP_MAX = isoDate(plusYears(2));
const EXP_MIN = isoDate(new Date(Date.now() + 86_400_000));

export default function ApiTokensSection({
  mode,
  flash,
}: {
  mode: 'user' | 'org';
  flash?: Flash;
}) {
  const { t } = useTranslation('security');
  const confirm = useConfirm();
  const describeScope = (s: string): string =>
    KNOWN_SCOPES.has(s) ? t(`tokens.scopeDesc.${s}`) : t('tokens.scopeFallback');
  const A = useMemo(
    () =>
      mode === 'org'
        ? {
            list: api.listOrgApiTokens,
            scopes: api.orgApiTokenScopes,
            create: api.createOrgApiToken,
            del: api.deleteOrgApiToken,
          }
        : {
            list: api.listMyApiTokens,
            scopes: api.myApiTokenScopes,
            create: api.createMyApiToken,
            del: api.deleteMyApiToken,
          },
    [mode],
  );
  const say = (m: string, k: 'info' | 'ok' | 'err' = 'info') => (flash ? flash(m, k) : k === 'err' && alert(m));

  const [tokens, setTokens] = useState<ApiTokenDto[]>([]);
  const [catalog, setCatalog] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [showForm, setShowForm] = useState(false);
  const [name, setName] = useState('');
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [expiresAt, setExpiresAt] = useState(EXP_DEFAULT);
  const [created, setCreated] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const [ts, sc] = await Promise.all([A.list(), A.scopes()]);
      setTokens(ts);
      setCatalog(sc.scopes);
    } catch (e) {
      say((e as Error).message, 'err');
    } finally {
      setLoading(false);
    }
  }, [A]);
  useEffect(() => {
    refresh();
  }, [refresh]);

  const submit = async () => {
    if (!name.trim()) return say(t('tokens.nameRequired'), 'err');
    const scopes = Array.from(picked);
    if (mode === 'org' && scopes.length === 0) return say(t('tokens.scopeRequired'), 'err');
    if (!expiresAt) return say(t('tokens.expiryRequired'), 'err');
    try {
      const r = await A.create({
        name: name.trim(),
        scopes: mode === 'org' ? scopes : scopes.length ? scopes : undefined,
        expiresAt,
      });
      setCreated(r.token);
      setName('');
      setPicked(new Set());
      setExpiresAt(EXP_DEFAULT);
      setShowForm(false);
      refresh();
    } catch (e) {
      say((e as Error).message, 'err');
    }
  };

  const revoke = async (id: string) => {
    if (!(await confirm({ title: t('common:confirm'), message: t('tokens.revokeConfirm'), danger: true }))) return;
    try {
      await A.del(id);
      say(t('tokens.revoked'), 'ok');
      refresh();
    } catch (e) {
      say((e as Error).message, 'err');
    }
  };

  const toggle = (s: string) =>
    setPicked((prev) => {
      const n = new Set(prev);
      n.has(s) ? n.delete(s) : n.add(s);
      return n;
    });

  const inputStyle: React.CSSProperties = {
    padding: '8px 10px',
    border: '1px solid var(--border)',
    borderRadius: 6,
    background: 'var(--surface-2)',
    color: 'var(--text)',
  };

  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <div style={{ fontWeight: 700 }}>
          {mode === 'org' ? t('tokens.titleOrg') : t('tokens.titleUser')}
        </div>
        <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
          {mode === 'org' ? t('tokens.introOrg') : t('tokens.introUser')}
        </span>
        <div style={{ flex: 1 }} />
        <button className="btn btn-accent btn-sm" onClick={() => setShowForm((v) => !v)}>
          {showForm ? t('tokens.closeForm') : t('tokens.newToken')}
        </button>
      </div>

      {/* Secret affiché UNE SEULE FOIS */}
      {created && (
        <SecretOnceBanner
          secret={created}
          onCopied={() => say(t('tokens.copied'), 'ok')}
          onDismiss={() => setCreated(null)}
        />
      )}

      {/* Formulaire création */}
      {showForm && (
        <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 12, display: 'grid', gap: 10 }}>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('tokens.nameLabel')}</span>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder={t('tokens.namePlaceholder')} style={inputStyle} />
          </label>
          <div style={{ display: 'grid', gap: 6 }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>
              {t('tokens.scopesLabel')} {mode === 'org' ? t('tokens.scopesRequired') : t('tokens.scopesOptional')}
            </span>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
              {catalog.map((s) => (
                <button
                  key={s}
                  type="button"
                  title={describeScope(s)}
                  className={'btn btn-sm ' + (picked.has(s) ? 'btn-accent' : 'btn-line')}
                  onClick={() => toggle(s)}
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
          <label style={{ display: 'grid', gap: 4 }}>
            <span style={{ fontSize: 12, color: 'var(--text-3)' }}>{t('tokens.expiryLabel')}</span>
            <input
              type="date"
              required
              min={EXP_MIN}
              max={EXP_MAX}
              value={expiresAt}
              onChange={(e) => setExpiresAt(e.target.value)}
              style={{ ...inputStyle, width: 200 }}
            />
          </label>
          <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
            <button className="btn btn-line btn-sm" onClick={() => setShowForm(false)}>
              {t('common:cancel')}
            </button>
            <button className="btn btn-accent btn-sm" onClick={submit}>
              {t('tokens.createToken')}
            </button>
          </div>
        </div>
      )}

      {/* Liste */}
      {loading ? (
        <div style={{ color: 'var(--text-3)' }}>{t('tokens.loading')}</div>
      ) : tokens.length === 0 ? (
        <div style={{ color: 'var(--text-3)' }}>{t('tokens.noToken')}</div>
      ) : (
        <div style={{ display: 'grid', gap: 6 }}>
          {tokens.map((tok) => (
            <div
              key={tok.id}
              style={{
                border: '1px solid var(--border)',
                borderRadius: 8,
                padding: '8px 12px',
                display: 'grid',
                gap: 4,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontWeight: 600 }}>{tok.name}</span>
                <code style={{ fontSize: 11, color: 'var(--text-3)' }}>{tok.prefix}</code>
                <div style={{ flex: 1 }} />
                <button className="btn btn-line btn-sm" style={{ color: '#c92a2a' }} onClick={() => revoke(tok.id)}>
                  {t('tokens.revoke')}
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
                {tok.scopes.length === 0 ? (
                  <span className="badge-soft" style={{ fontSize: 11 }}>{t('tokens.allYourRights')}</span>
                ) : (
                  tok.scopes.map((s) => (
                    <span
                      key={s}
                      className="badge-soft"
                      style={{ fontSize: 11, cursor: 'help' }}
                      title={describeScope(s)}
                    >
                      {s}
                    </span>
                  ))
                )}
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-3)' }}>
                {tok.lastUsedAt ? t('tokens.lastUsed', { date: new Date(tok.lastUsedAt).toLocaleString() }) : t('tokens.neverUsed')}
                {tok.expiresAt ? t('tokens.expiresOn', { date: new Date(tok.expiresAt).toLocaleDateString() }) : t('tokens.noExpiry')}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
