/* ============================================================
   Vaks — Projects panel : étape commerciale « offre »
   (envoi au client par email + accept/refuse + compteur de refus)
   Rendu dans l'onglet Général, projets FACTURABLES en DRAFT / OFFER_SENT.
   ============================================================ */
import React, { useEffect, useState } from 'react';
import { useTranslation, Trans } from 'react-i18next';
import { Icon } from '../primitives';
import { api } from '../../api/client';
import {
  ProjectStatus,
  type ProjectDto,
  type ProjectDocumentDto,
} from '@vaks-pm/shared';
import { useAuth } from '../../auth/AuthContext';
import { useFormat } from '../../lib/format';
import { ConfirmDialog } from './shared';

interface OfferSectionProps {
  project: ProjectDto;
  onProjectChanged: (p: ProjectDto) => void;
  pushToast: (text: string, warn?: boolean) => void;
}

/** Résout l'email destinataire côté UI (mirroir du backend) : contact principal
 *  avec email > n'importe quel contact avec email > email du client. */
function resolveRecipient(
  contacts: Array<{ name: string; email: string | null; isPrimary: boolean }>,
  clientEmail: string | null,
  clientName: string,
): { email: string; name: string } | null {
  const primary = contacts.find((c) => c.isPrimary && c.email);
  if (primary?.email) return { email: primary.email, name: primary.name };
  const any = contacts.find((c) => c.email);
  if (any?.email) return { email: any.email, name: any.name };
  if (clientEmail) return { email: clientEmail, name: clientName };
  return null;
}

export function OfferSection({ project, onProjectChanged, pushToast }: OfferSectionProps) {
  const { t } = useTranslation('projects');
  const fmt = useFormat();
  const { can } = useAuth();
  const canManage = can('project:update');

  const [docs, setDocs] = useState<ProjectDocumentDto[] | null>(null);
  const [recipient, setRecipient] = useState<{ email: string; name: string } | null>(null);
  const [recipientLoaded, setRecipientLoaded] = useState(false);
  // Action en cours : 'email' | 'accept' | 'refuse' | 'send' | null.
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmEmail, setConfirmEmail] = useState(false);
  const [refusing, setRefusing] = useState(false);
  const [refuseReason, setRefuseReason] = useState('');

  // Offre téléversée ? (document de type OFFER)
  const offerDoc = docs?.find((d) => d.kind === 'OFFER') ?? null;

  useEffect(() => {
    let alive = true;
    api
      .listProjectDocuments(project.id)
      .then((d) => alive && setDocs(d))
      .catch(() => alive && setDocs([]));
    return () => {
      alive = false;
    };
  }, [project.id, project.status]);

  useEffect(() => {
    let alive = true;
    if (!project.clientId) {
      setRecipient(null);
      setRecipientLoaded(true);
      return;
    }
    setRecipientLoaded(false);
    api
      .getClient(project.clientId)
      .then((c) => {
        if (!alive) return;
        setRecipient(resolveRecipient(c.contacts ?? [], c.email, c.name));
        setRecipientLoaded(true);
      })
      .catch(() => {
        if (!alive) return;
        setRecipient(null);
        setRecipientLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [project.clientId]);

  const status = project.status;
  const refusalCount = project.offerRefusalCount ?? 0;

  // Raisons de blocage de l'envoi par email (affichées en hint).
  const blockers: string[] = [];
  if (!project.clientId) blockers.push(t('offer.noClientBlocker'));
  else if (recipientLoaded && !recipient)
    blockers.push(t('offer.noContactBlocker'));
  if (docs && !offerDoc) blockers.push(t('offer.noOfferBlocker'));
  const canEmail = canManage && blockers.length === 0;

  async function doEmail() {
    setBusy('email');
    setConfirmEmail(false);
    try {
      const next = await api.emailOffer(project.id);
      onProjectChanged(next);
      pushToast(t('offer.sentTo', { recipient: next.sentTo }));
    } catch (e) {
      pushToast(t('offer.sendFailed', { message: (e as Error).message }), true);
    } finally {
      setBusy(null);
    }
  }

  async function doSendNoEmail() {
    setBusy('send');
    try {
      const next = await api.sendOffer(project.id);
      onProjectChanged(next);
      pushToast(t('offer.markedSent'));
    } catch (e) {
      pushToast(t('offer.actionFailed', { message: (e as Error).message }), true);
    } finally {
      setBusy(null);
    }
  }

  async function doAccept() {
    setBusy('accept');
    try {
      const next = await api.acceptOffer(project.id);
      onProjectChanged(next);
      pushToast(t('offer.accepted'));
    } catch (e) {
      pushToast(t('offer.actionFailed', { message: (e as Error).message }), true);
    } finally {
      setBusy(null);
    }
  }

  async function doRefuse() {
    setBusy('refuse');
    try {
      const next = await api.refuseOffer(project.id, refuseReason.trim() || undefined);
      onProjectChanged(next);
      setRefusing(false);
      setRefuseReason('');
      pushToast(t('offer.refused'));
    } catch (e) {
      pushToast(t('offer.actionFailed', { message: (e as Error).message }), true);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="md-field">
      <div className="md-label row" style={{ justifyContent: 'space-between' }}>
        <span>{t('offer.title')}</span>
        {refusalCount > 0 && (
          <span
            className="pj-status"
            title={t('offer.refusedTitle', { count: refusalCount })}
            style={{ color: 'oklch(0.5 0.13 25)', background: 'oklch(0.95 0.05 25)' }}
          >
            <Icon name="warn" size={12} /> {t('offer.refusedBadge', { count: refusalCount })}
          </span>
        )}
      </div>

      {status === ProjectStatus.DRAFT && (
        <>
          <div className="md-hint" style={{ marginBottom: 6 }}>
            {t('offer.draftHint')}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-accent btn-sm"
              disabled={!canEmail || busy !== null}
              onClick={() => setConfirmEmail(true)}
              title={canEmail ? '' : t('offer.unavailable', { reasons: blockers.join(' · ') })}
            >
              <Icon name="inbox" size={14} />{' '}
              {busy === 'email' ? t('offer.sending') : t('offer.sendToClient')}
            </button>
            {canManage && (
              <button
                className="btn btn-line btn-sm"
                disabled={busy !== null}
                onClick={doSendNoEmail}
                title={t('offer.markAsSentTitle')}
              >
                {busy === 'send' ? '…' : t('offer.markAsSent')}
              </button>
            )}
          </div>
          {blockers.length > 0 && (
            <div className="md-warn" style={{ marginTop: 6 }}>
              <Icon name="warn" size={13} /> {t('offer.emailUnavailable', { reasons: blockers.join(' · ') })}
            </div>
          )}
          {offerDoc && (
            <div className="md-hint" style={{ marginTop: 6 }}>
              <Trans t={t} i18nKey="offer.attachment" values={{ filename: offerDoc.filename }} components={[<b />]} />
              {recipient ? (
                <Trans t={t} i18nKey="offer.recipientSuffix" values={{ email: recipient.email }} components={[<b />]} />
              ) : null}
            </div>
          )}
        </>
      )}

      {status === ProjectStatus.OFFER_SENT && (
        <>
          <div className="md-hint" style={{ marginBottom: 8 }}>
            {t('offer.sentHint', { date: project.offerSentAt ? t('offer.sentHintDate', { date: fmt.dateTime(project.offerSentAt) }) : '' })}
          </div>
          <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
            <button
              className="btn btn-accent btn-sm"
              disabled={!canManage || busy !== null}
              onClick={doAccept}
              style={{ background: 'oklch(0.55 0.14 155)' }}
            >
              <Icon name="check" size={14} /> {busy === 'accept' ? '…' : t('offer.acceptOffer')}
            </button>
            <button
              className="btn btn-line btn-sm"
              disabled={!canManage || busy !== null}
              onClick={() => setRefusing(true)}
            >
              <Icon name="x" size={14} /> {t('offer.refuseOffer')}
            </button>
            {canEmail && (
              <button
                className="btn btn-line btn-sm"
                disabled={busy !== null}
                onClick={() => setConfirmEmail(true)}
                title={t('offer.resendTitle')}
              >
                <Icon name="inbox" size={14} /> {busy === 'email' ? t('offer.sending') : t('offer.resend')}
              </button>
            )}
          </div>
        </>
      )}

      {/* Confirmation d'envoi par email */}
      {confirmEmail && recipient && offerDoc && (
        <ConfirmDialog
          eyebrow={t('offer.confirmEmailEyebrow')}
          title={t('offer.confirmEmailTitle', { email: recipient.email })}
          confirmLabel={t('offer.confirmEmailConfirm')}
          busyLabel={t('offer.confirmEmailBusy')}
          busy={busy === 'email'}
          onConfirm={doEmail}
          onCancel={() => setConfirmEmail(false)}
        >
          <div className="md-span">
            <Trans
              t={t}
              i18nKey="offer.confirmEmailBody"
              values={{ filename: offerDoc.filename, name: recipient.name, email: recipient.email }}
              components={[<b />, <b />]}
            />
            {status === ProjectStatus.DRAFT && <>{t('offer.confirmEmailMovesToSent')}</>}
          </div>
        </ConfirmDialog>
      )}

      {/* Refus + raison */}
      {refusing && (
        <ConfirmDialog
          eyebrow={t('offer.refuseEyebrow')}
          title={t('offer.refuseTitle')}
          confirmLabel={t('offer.refuseConfirm')}
          busyLabel="…"
          busy={busy === 'refuse'}
          onConfirm={doRefuse}
          onCancel={() => {
            setRefusing(false);
            setRefuseReason('');
          }}
        >
          <div className="md-span">
            {t('offer.refuseBody', { count: refusalCount })}
            <textarea
              className="atext"
              placeholder={t('offer.refuseReasonPlaceholder')}
              value={refuseReason}
              onChange={(e) => setRefuseReason(e.target.value)}
              rows={3}
              style={{ width: '100%', marginTop: 8, resize: 'vertical' }}
            />
          </div>
        </ConfirmDialog>
      )}
    </div>
  );
}
