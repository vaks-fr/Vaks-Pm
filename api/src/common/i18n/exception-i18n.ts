/* ============================================================================
 * Server-side i18n for API EXCEPTION messages.
 *
 * The app throws French messages. Rather than touch ~250 throw sites, a global
 * exception filter (exception-i18n.filter.ts) catches HttpExceptions and
 * translates the message via this dictionary, keyed by the FRENCH source string
 * and resolved from the request's Accept-Language.
 *
 * Robustness: both the dictionary keys and the runtime message are NORMALIZED
 * before matching (curly→straight quotes, « » stripped, NBSP/whitespace
 * collapsed), so minor punctuation drift never breaks a lookup. Messages with
 * interpolated parts use `{}` placeholders (matched positionally and re-filled).
 *
 * Language: 'fr' is the source (pass-through). 'en' is the default fallback for
 * anything else, including unknown messages (which pass through untranslated).
 * ========================================================================== */
export type ExcLang = 'en' | 'fr' | 'it' | 'de';
const SUPPORTED: ExcLang[] = ['en', 'fr', 'it', 'de'];

// Normalize for matching (NOT for display).
function norm(s: string): string {
  return s
    .replace(/[’‘]/g, "'")
    .replace(/[«»]/g, '')
    .replace(/[  ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// FRENCH source -> [en, it, de]. `{}` marks an interpolated segment (same order
// in every language). Keep technical tokens (DRAFT, OIDC, scim:provision…) as-is.
const M: Record<string, [string, string, string]> = {
  "'from' doit précéder 'to'": ["'from' must come before 'to'", "'from' deve precedere 'to'", "'from' muss vor 'to' liegen"],
  'Accès au projet refusé': ['Project access denied', 'Accesso al progetto negato', 'Projektzugriff verweigert'],
  'Accès refusé (403) — la permission application AgentIdentity.Read.All manque (consentement admin requis).': ['Access denied (403) — the AgentIdentity.Read.All application permission is missing (admin consent required).', "Accesso negato (403) — manca l'autorizzazione applicativa AgentIdentity.Read.All (consenso amministratore richiesto).", 'Zugriff verweigert (403) — die Anwendungsberechtigung AgentIdentity.Read.All fehlt (Administratorzustimmung erforderlich).'],
  'Allocation introuvable': ['Allocation not found', 'Allocazione non trovata', 'Zuordnung nicht gefunden'],
  'Allocation refusée : {}h cumulées le {} (max {}h/jour).': ['Allocation rejected: {}h total on {} (max {}h/day).', 'Allocazione rifiutata: {}h totali il {} (max {}h/giorno).', 'Zuordnung abgelehnt: {}h gesamt am {} (max. {}h/Tag).'],
  'Assertion SAML vide.': ['Empty SAML assertion.', 'Asserzione SAML vuota.', 'Leere SAML-Assertion.'],
  'Assigné(s) hors périmètre projet : {}.': ['Assignee(s) outside the project scope: {}.', 'Assegnatario/i fuori dal perimetro del progetto: {}.', 'Zuständige außerhalb des Projektbereichs: {}.'],
  'Assigné(s) invalide(s)': ['Invalid assignee(s)', 'Assegnatario/i non valido/i', 'Ungültige Zuständige'],
  'Au moins un event est requis': ['At least one event is required', 'È richiesto almeno un evento', 'Mindestens ein Event ist erforderlich'],
  'Authentification Entra refusée : {}': ['Entra authentication refused: {}', 'Autenticazione Entra rifiutata: {}', 'Entra-Authentifizierung abgelehnt: {}'],
  'Aucun charter signé uploadé pour ce projet': ['No signed charter uploaded for this project', 'Nessun charter firmato caricato per questo progetto', 'Kein signierter Projektauftrag für dieses Projekt hochgeladen'],
  'Aucun compte ne correspond à cette identité (objectId) et la création automatique est désactivée.': ['No account matches this identity (objectId) and auto-provisioning is disabled.', "Nessun account corrisponde a questa identità (objectId) e la creazione automatica è disattivata.", 'Kein Konto entspricht dieser Identität (objectId), und die automatische Erstellung ist deaktiviert.'],
  'Aucun enrôlement en cours': ['No enrollment in progress', 'Nessuna registrazione in corso', 'Keine laufende Registrierung'],
  'Aucun template uploadé': ['No template uploaded', 'Nessun template caricato', 'Kein Template hochgeladen'],
  "Aucun utilisateur actif avec l'email {}": ['No active user with email {}', "Nessun utente attivo con l'email {}", 'Kein aktiver Benutzer mit der E-Mail {}'],
  "Aucune offre n'a été téléversée pour ce projet.": ['No offer has been uploaded for this project.', 'Nessuna offerta è stata caricata per questo progetto.', 'Für dieses Projekt wurde kein Angebot hochgeladen.'],
  'Aucune personne sélectionnée': ['No person selected', 'Nessuna persona selezionata', 'Keine Person ausgewählt'],
  'Auto-plan refusé : {}h cumulées pour le user {} le {} (max {}h/jour). Réduisez la charge manuelle ou revoyez les estimations des tâches.': ['Auto-plan rejected: {}h total for user {} on {} (max {}h/day). Reduce the manual load or revise the task estimates.', "Auto-plan rifiutato: {}h totali per l'utente {} il {} (max {}h/giorno). Riduci il carico manuale o rivedi le stime delle attività.", 'Auto-Plan abgelehnt: {}h gesamt für Benutzer {} am {} (max. {}h/Tag). Reduzieren Sie die manuelle Last oder überarbeiten Sie die Aufgabenschätzungen.'],
  'Blob du document introuvable': ['Document blob not found', 'Blob del documento non trovato', 'Dokument-Blob nicht gefunden'],
  'CA invalide : un certificat PEM est attendu': ['Invalid CA: a PEM certificate is expected', 'CA non valida: è atteso un certificato PEM', 'Ungültige CA: ein PEM-Zertifikat wird erwartet'],
  'CSV vide ou sans ligne de données': ['Empty CSV or no data rows', 'CSV vuoto o senza righe di dati', 'Leere CSV oder keine Datenzeilen'],
  'Ce pack est réservé à des équipes spécifiques. Demandez à un admin de vous y donner accès.': ['This pack is restricted to specific teams. Ask an admin to grant you access.', 'Questo pacchetto è riservato a team specifici. Chiedi a un amministratore di darti accesso.', 'Dieses Paket ist auf bestimmte Teams beschränkt. Bitten Sie einen Admin um Zugriff.'],
  "Ce point d'accès n'est pas ouvert aux jetons d'API.": ['This endpoint is not open to API tokens.', "Questo endpoint non è aperto ai token API.", 'Dieser Endpunkt ist nicht für API-Token freigegeben.'],
  'Ce projet est un conteneur de tickets externes — création de tâche réservée à POST /external-tasks.': ['This project is an external-ticket container — task creation is reserved to POST /external-tasks.', 'Questo progetto è un contenitore di ticket esterni — la creazione di attività è riservata a POST /external-tasks.', 'Dieses Projekt ist ein Container für externe Tickets — die Aufgabenerstellung ist POST /external-tasks vorbehalten.'],
  'Certificat client invalide : un certificat PEM est attendu': ['Invalid client certificate: a PEM certificate is expected', 'Certificato client non valido: è atteso un certificato PEM', 'Ungültiges Client-Zertifikat: ein PEM-Zertifikat wird erwartet'],
  "Cet utilisateur n'est pas Project Manager": ['This user is not a Project Manager', 'Questo utente non è un Project Manager', 'Dieser Benutzer ist kein Project Manager'],
  'Cette licence est destinée à une autre organisation ({}).': ['This license is for another organization ({}).', "Questa licenza è destinata a un'altra organizzazione ({}).", 'Diese Lizenz ist für eine andere Organisation bestimmt ({}).'],
  "Cette fonctionnalité (« {} ») requiert une licence active. Contactez votre éditeur pour l'activer.": ['This feature ("{}") requires an active license. Contact your vendor to enable it.', 'Questa funzionalità («{}») richiede una licenza attiva. Contatta il tuo fornitore per attivarla.', 'Diese Funktion („{}") erfordert eine aktive Lizenz. Wenden Sie sich an Ihren Anbieter, um sie zu aktivieren.'],
  'Ce fournisseur n’est pas de type OIDC.': ['This provider is not an OIDC provider.', 'Questo fornitore non è di tipo OIDC.', 'Dieser Anbieter ist kein OIDC-Anbieter.'],
  'Ce fournisseur n’est pas de type SAML.': ['This provider is not a SAML provider.', 'Questo fornitore non è di tipo SAML.', 'Dieser Anbieter ist kein SAML-Anbieter.'],
  'Challenge MFA expiré': ['MFA challenge expired', 'Challenge MFA scaduta', 'MFA-Challenge abgelaufen'],
  'Configuration incomplète (tenantId / clientId / clientSecret).': ['Incomplete configuration (tenantId / clientId / clientSecret).', 'Configurazione incompleta (tenantId / clientId / clientSecret).', 'Unvollständige Konfiguration (tenantId / clientId / clientSecret).'],
  'Connecté à Microsoft Graph (agentIdentities lisibles).': ['Connected to Microsoft Graph (agentIdentities readable).', 'Connesso a Microsoft Graph (agentIdentities leggibili).', 'Mit Microsoft Graph verbunden (agentIdentities lesbar).'],
  'Connecteur désactivé — activez-le avant de synchroniser.': ['Connector disabled — enable it before syncing.', 'Connettore disattivato — attivalo prima di sincronizzare.', 'Connector deaktiviert — aktivieren Sie ihn vor der Synchronisierung.'],
  'Connecteur introuvable.': ['Connector not found.', 'Connettore non trovato.', 'Connector nicht gefunden.'],
  'Challenge MFA invalide': ['Invalid MFA challenge', 'Challenge MFA non valida', 'Ungültige MFA-Challenge'],
  'Cible Microsoft sans tenant Entra identifiable — impossible de vérifier la destination.': ['Microsoft target with no identifiable Entra tenant — cannot verify the destination.', 'Destinazione Microsoft senza tenant Entra identificabile — impossibile verificare la destinazione.', 'Microsoft-Ziel ohne identifizierbaren Entra-Tenant — Ziel kann nicht überprüft werden.'],
  'Client introuvable': ['Client not found', 'Cliente non trovato', 'Kunde nicht gefunden'],
  'Code MFA invalide': ['Invalid MFA code', 'Codice MFA non valido', 'Ungültiger MFA-Code'],
  'Code invalide': ['Invalid code', 'Codice non valido', 'Ungültiger Code'],
  'Colonne inconnue pour ce projet': ['Unknown column for this project', 'Colonna sconosciuta per questo progetto', 'Unbekannte Spalte für dieses Projekt'],
  'Colonne introuvable': ['Column not found', 'Colonna non trovata', 'Spalte nicht gefunden'],
  "Colonne non vide ({} tâche(s)) : déplace-les d'abord": ['Column not empty ({} task(s)): move them first', 'Colonna non vuota ({} attività): spostale prima', 'Spalte nicht leer ({} Aufgabe(n)): verschieben Sie sie zuerst'],
  'Colonne obligatoire manquante : name': ['Missing required column: name', 'Colonna obbligatoria mancante: name', 'Erforderliche Spalte fehlt: name'],
  'Colonnes obligatoires manquantes : email et name': ['Missing required columns: email and name', 'Colonne obbligatorie mancanti: email e name', 'Erforderliche Spalten fehlen: email und name'],
  'Commentaire introuvable': ['Comment not found', 'Commento non trovato', 'Kommentar nicht gefunden'],
  'Compte SSO : la connexion locale est désactivée (activez le break-glass pour un reset).': ['SSO account: local login is disabled (enable break-glass for a reset).', 'Account SSO: il login locale è disattivato (abilita il break-glass per un reset).', 'SSO-Konto: lokale Anmeldung ist deaktiviert (Break-Glass für einen Reset aktivieren).'],
  "Compte temporairement verrouillé jusqu'à {}": ['Account temporarily locked until {}', 'Account temporaneamente bloccato fino a {}', 'Konto vorübergehend gesperrt bis {}'],
  'Compétence requise hors du périmètre des équipes du projet. Choisissez une compétence couverte par une équipe affectée, ou émettez une demande de compétence.': ["Required skill outside the project teams' scope. Choose a skill covered by an assigned team, or raise a skill request.", "Competenza richiesta fuori dal perimetro dei team del progetto. Scegli una competenza coperta da un team assegnato, o emetti una richiesta di competenza.", 'Erforderliche Kompetenz außerhalb des Bereichs der Projektteams. Wählen Sie eine von einem zugewiesenen Team abgedeckte Kompetenz oder stellen Sie eine Kompetenzanfrage.'],
  'Compétence(s) hors du périmètre des équipes du projet : {}. Faites couvrir ce skill par une équipe affectée, ou émettez une demande de compétence.': ["Skill(s) outside the project teams' scope: {}. Have this skill covered by an assigned team, or raise a skill request.", 'Competenza/e fuori dal perimetro dei team del progetto: {}. Fai coprire questa competenza da un team assegnato, o emetti una richiesta di competenza.', 'Kompetenz(en) außerhalb des Bereichs der Projektteams: {}. Lassen Sie diese Kompetenz von einem zugewiesenen Team abdecken oder stellen Sie eine Kompetenzanfrage.'],
  'Compétence(s) hors du périmètre des équipes du projet.': ["Skill(s) outside the project teams' scope.", 'Competenza/e fuori dal perimetro dei team del progetto.', 'Kompetenz(en) außerhalb des Bereichs der Projektteams.'],
  'Contact introuvable': ['Contact not found', 'Contatto non trovato', 'Kontakt nicht gefunden'],
  'Coût introuvable': ['Cost not found', 'Costo non trovato', 'Kosten nicht gefunden'],
  'Création refusée : créerait un cycle': ['Creation rejected: would create a cycle', 'Creazione rifiutata: creerebbe un ciclo', 'Erstellung abgelehnt: würde einen Zyklus erzeugen'],
  'Demande introuvable': ['Request not found', 'Richiesta non trovata', 'Anfrage nicht gefunden'],
  'Document introuvable': ['Document not found', 'Documento non trovato', 'Dokument nicht gefunden'],
  'Domaine invalide : {}': ['Invalid domain: {}', 'Dominio non valido: {}', 'Ungültige Domain: {}'],
  'Domaine non autorisé. Domaines permis : {}': ['Domain not allowed. Allowed domains: {}', 'Dominio non consentito. Domini permessi: {}', 'Domain nicht erlaubt. Erlaubte Domains: {}'],
  'Délai dépassé en joignant Microsoft.': ['Timed out reaching Microsoft.', 'Timeout nel contattare Microsoft.', 'Zeitüberschreitung beim Erreichen von Microsoft.'],
  'Dépendance déjà existante': ['Dependency already exists', 'Dipendenza già esistente', 'Abhängigkeit existiert bereits'],
  'Dépendance introuvable': ['Dependency not found', 'Dipendenza non trovata', 'Abhängigkeit nicht gefunden'],
  'Enroll token invalide ou expiré': ['Invalid or expired enroll token', 'Token di registrazione non valido o scaduto', 'Ungültiges oder abgelaufenes Enroll-Token'],
  'Entrée introuvable': ['Entry not found', 'Voce non trovata', 'Eintrag nicht gefunden'],
  'Fenêtre KPI trop large (max ~1 an).': ['KPI window too wide (max ~1 year).', 'Finestra KPI troppo ampia (max ~1 anno).', 'KPI-Fenster zu groß (max. ~1 Jahr).'],
  "Fenêtre d'alerte brute-force : entre 1 et 120 minutes": ['Brute-force alert window: between 1 and 120 minutes', 'Finestra di allerta brute-force: tra 1 e 120 minuti', 'Brute-Force-Alarmfenster: zwischen 1 und 120 Minuten'],
  'Fenêtre limitée à 92 jours': ['Window limited to 92 days', 'Finestra limitata a 92 giorni', 'Fenster auf 92 Tage begrenzt'],
  'Fichier introuvable dans le stockage': ['File not found in storage', 'File non trovato nello storage', 'Datei im Speicher nicht gefunden'],
  'Fichier manquant (champ "file")': ['Missing file (field "file")', 'File mancante (campo "file")', 'Datei fehlt (Feld "file")'],
  'Fournisseur SSO inconnu ou désactivé.': ['Unknown or disabled SSO provider.', 'Provider SSO sconosciuto o disattivato.', 'Unbekannter oder deaktivierter SSO-Anbieter.'],
  'Fournisseur introuvable.': ['Provider not found.', 'Provider non trovato.', 'Anbieter nicht gefunden.'],
  'Hôte syslog invalide : {}': ['Invalid syslog host: {}', 'Host syslog non valido: {}', 'Ungültiger Syslog-Host: {}'],
  'IdP a refusé : {}{}': ['IdP refused: {}{}', "L'IdP ha rifiutato: {}{}", 'IdP hat abgelehnt: {}{}'],
  'Identifiants invalides': ['Invalid credentials', 'Credenziali non valide', 'Ungültige Anmeldedaten'],
  "Impossible d'activer : SSO URL (entryPoint) et certificat de signature de l'IdP requis.": ['Cannot activate: SSO URL (entryPoint) and IdP signing certificate required.', "Impossibile attivare: SSO URL (entryPoint) e certificato di firma dell'IdP richiesti.", 'Aktivierung nicht möglich: SSO-URL (entryPoint) und IdP-Signaturzertifikat erforderlich.'],
  "Impossible d'activer : aucun client secret défini pour ce fournisseur. Renseignez-le ci-dessus.": ['Cannot activate: no client secret set for this provider. Enter it above.', 'Impossibile attivare: nessun client secret impostato per questo provider. Inseriscilo sopra.', 'Aktivierung nicht möglich: kein Client-Secret für diesen Anbieter festgelegt. Geben Sie es oben ein.'],
  "Impossible d'activer : discovery URL et client ID requis.": ['Cannot activate: discovery URL and client ID required.', 'Impossibile attivare: discovery URL e client ID richiesti.', 'Aktivierung nicht möglich: Discovery-URL und Client-ID erforderlich.'],
  'Impossible de créer le compte : un compte avec cet email ou cet identifiant existe déjà.': ['Cannot create the account: an account with this email or identifier already exists.', "Impossibile creare l'account: un account con questa email o identificativo esiste già.", 'Konto kann nicht erstellt werden: ein Konto mit dieser E-Mail oder Kennung existiert bereits.'],
  'Impossible de créer une dépendance sur un ticket externe.': ['Cannot create a dependency on an external ticket.', 'Impossibile creare una dipendenza su un ticket esterno.', 'Auf einem externen Ticket kann keine Abhängigkeit erstellt werden.'],
  'Impossible de planifier une allocation sur un ticket externe (timesheet uniquement).': ['Cannot plan an allocation on an external ticket (timesheet only).', 'Impossibile pianificare un\'allocazione su un ticket esterno (solo timesheet).', 'Auf einem externen Ticket kann keine Zuordnung geplant werden (nur Zeiterfassung).'],
  'Impossible de retirer le statut groupe : la tâche contient encore des sous-éléments.': ['Cannot remove the group status: the task still contains sub-items.', 'Impossibile rimuovere lo stato gruppo: l\'attività contiene ancora sotto-elementi.', 'Gruppenstatus kann nicht entfernt werden: die Aufgabe enthält noch Unterelemente.'],
  'Impossible de ré-étaler : aucune capacité disponible pour cette personne.': ['Cannot re-spread: no capacity available for this person.', 'Impossibile ridistribuire: nessuna capacità disponibile per questa persona.', 'Neuverteilung nicht möglich: keine Kapazität für diese Person verfügbar.'],
  'Incohérence de tenant sur le callback SAML.': ['Tenant mismatch on the SAML callback.', 'Incoerenza di tenant nel callback SAML.', 'Tenant-Konflikt im SAML-Callback.'],
  'Incohérence de tenant sur le callback SSO.': ['Tenant mismatch on the SSO callback.', 'Incoerenza di tenant nel callback SSO.', 'Tenant-Konflikt im SSO-Callback.'],
  'Jeton API invalide ou révoqué': ['Invalid or revoked API token', 'Token API non valido o revocato', 'Ungültiges oder widerrufenes API-Token'],
  'Jeton SCIM invalide ou révoqué': ['Invalid or revoked SCIM token', 'Token SCIM non valido o revocato', 'Ungültiges oder widerrufenes SCIM-Token'],
  'Jeton SCIM manquant': ['Missing SCIM token', 'Token SCIM mancante', 'SCIM-Token fehlt'],
  'Jeton introuvable': ['Token not found', 'Token non trovato', 'Token nicht gefunden'],
  "L'offre ne peut être envoyée qu'en phase DRAFT ou OFFER_SENT (actuel : {}).": ['The offer can only be sent in DRAFT or OFFER_SENT phase (current: {}).', "L'offerta può essere inviata solo in fase DRAFT o OFFER_SENT (attuale: {}).", 'Das Angebot kann nur in der Phase DRAFT oder OFFER_SENT gesendet werden (aktuell: {}).'],
  "L'offre ne peut être envoyée que depuis le statut DRAFT (actuel : {}).": ['The offer can only be sent from the DRAFT status (current: {}).', "L'offerta può essere inviata solo dallo stato DRAFT (attuale: {}).", 'Das Angebot kann nur aus dem Status DRAFT gesendet werden (aktuell: {}).'],
  "L'organisation n'autorise pas votre rôle à modifier le catalogue de skills.": ['The organization does not allow your role to edit the skill catalogue.', "L'organizzazione non consente al tuo ruolo di modificare il catalogo delle competenze.", 'Die Organisation erlaubt Ihrer Rolle nicht, den Kompetenzkatalog zu bearbeiten.'],
  "L'étape « offre » ne concerne que les projets facturables.": ['The "offer" step only applies to billable projects.', 'La fase «offerta» riguarda solo i progetti fatturabili.', 'Der Schritt „Angebot" gilt nur für abrechenbare Projekte.'],
  'Label introuvable': ['Label not found', 'Etichetta non trovata', 'Label nicht gefunden'],
  'Label(s) invalide(s)': ['Invalid label(s)', 'Etichetta/e non valida/e', 'Ungültige(s) Label'],
  'Le charter ne peut être édité qu\'en phase DRAFT ou CHARTER_REVIEW': ['The charter can only be edited in DRAFT or CHARTER_REVIEW phase', 'Il charter può essere modificato solo in fase DRAFT o CHARTER_REVIEW', 'Der Projektauftrag kann nur in der Phase DRAFT oder CHARTER_REVIEW bearbeitet werden'],
  "Le charter signé doit être uploadé avant d'activer le projet": ['The signed charter must be uploaded before activating the project', 'Il charter firmato deve essere caricato prima di attivare il progetto', 'Der signierte Projektauftrag muss vor der Aktivierung des Projekts hochgeladen werden'],
  "Le charter signé ne peut être uploadé qu'en phase DRAFT ou CHARTER_REVIEW": ['The signed charter can only be uploaded in DRAFT or CHARTER_REVIEW phase', 'Il charter firmato può essere caricato solo in fase DRAFT o CHARTER_REVIEW', 'Der signierte Projektauftrag kann nur in der Phase DRAFT oder CHARTER_REVIEW hochgeladen werden'],
  "Le fichier de l'offre est introuvable dans le stockage.": ['The offer file is not found in storage.', "Il file dell'offerta non è stato trovato nello storage.", 'Die Angebotsdatei wurde im Speicher nicht gefunden.'],
  'Le groupe « {} » est mappé plusieurs fois. Chaque groupe ne peut viser qu\'un seul rôle.': ['The group "{}" is mapped multiple times. Each group can target only one role.', 'Il gruppo «{}» è mappato più volte. Ogni gruppo può puntare a un solo ruolo.', 'Die Gruppe „{}" ist mehrfach zugeordnet. Jede Gruppe kann nur eine Rolle ansteuern.'],
  'Le single sign-on {} requiert une licence active. Connectez-vous avec un compte local ou contactez votre éditeur.': ['{} single sign-on requires an active license. Sign in with a local account or contact your vendor.', 'Il single sign-on {} richiede una licenza attiva. Accedi con un account locale o contatta il tuo fornitore.', 'Das {}-Single-Sign-on erfordert eine aktive Lizenz. Melden Sie sich mit einem lokalen Konto an oder wenden Sie sich an Ihren Anbieter.'],
  "Le jeton n'a pas le scope scim:provision": ['The token lacks the scim:provision scope', 'Il token non ha lo scope scim:provision', 'Dem Token fehlt der Scope scim:provision'],
  'Le nouveau mot de passe doit être différent.': ['The new password must be different.', 'La nuova password deve essere diversa.', 'Das neue Passwort muss anders sein.'],
  "Le parent doit être un groupe (cochez 'Mark as group' sur la tâche parente).": ["The parent must be a group (check 'Mark as group' on the parent task).", "Il padre deve essere un gruppo (seleziona 'Mark as group' sull'attività padre).", "Das übergeordnete Element muss eine Gruppe sein (aktivieren Sie 'Mark as group' bei der übergeordneten Aufgabe)."],
  "Le projet n'est rattaché à aucun client.": ['The project is not linked to any client.', 'Il progetto non è collegato a nessun cliente.', 'Das Projekt ist keinem Kunden zugeordnet.'],
  "Le type facturable / non-facturable ne peut être changé qu'en DRAFT": ['The billable / non-billable type can only be changed in DRAFT', 'Il tipo fatturabile / non fatturabile può essere cambiato solo in DRAFT', 'Der Typ abrechenbar / nicht abrechenbar kann nur in DRAFT geändert werden'],
  'Les agents IA sont désactivés sur ce projet.': ['AI agents are disabled on this project.', "Gli agenti IA sono disattivati su questo progetto.", 'KI-Agenten sind für dieses Projekt deaktiviert.'],
  'Les deux tâches doivent appartenir au même projet': ['Both tasks must belong to the same project', 'Entrambe le attività devono appartenere allo stesso progetto', 'Beide Aufgaben müssen zum selben Projekt gehören'],
  'Les notifications email sont désactivées (kill switch org). Activez-les dans Admin > Notifications.': ['Email notifications are disabled (org kill switch). Enable them in Admin > Notifications.', 'Le notifiche email sono disattivate (kill switch org). Attivale in Admin > Notifiche.', 'E-Mail-Benachrichtigungen sind deaktiviert (Org-Kill-Switch). Aktivieren Sie sie unter Admin > Benachrichtigungen.'],
  'Lien de réinitialisation invalide ou expiré.': ['Invalid or expired reset link.', 'Link di reimpostazione non valido o scaduto.', 'Ungültiger oder abgelaufener Reset-Link.'],
  'Limite de licences atteinte : {} siège(s).': ['License limit reached: {} seat(s).', 'Limite di licenze raggiunto: {} postazione/i.', 'Lizenzlimit erreicht: {} Platz/Plätze.'],
  'Livraison introuvable': ['Delivery not found', 'Consegna non trovata', 'Zustellung nicht gefunden'],
  'Livraison introuvable pour ce projet': ['Delivery not found for this project', 'Consegna non trovata per questo progetto', 'Zustellung für dieses Projekt nicht gefunden'],
  'MFA déjà activé': ['MFA already enabled', 'MFA già attivata', 'MFA bereits aktiviert'],
  'MFA est obligatoire pour ce compte (policy ou break-glass). Demandez à un admin de le reset si nécessaire.': ['MFA is required for this account (policy or break-glass). Ask an admin to reset it if needed.', 'MFA è obbligatoria per questo account (policy o break-glass). Chiedi a un amministratore di reimpostarla se necessario.', 'MFA ist für dieses Konto erforderlich (Richtlinie oder Break-Glass). Bitten Sie einen Admin, sie bei Bedarf zurückzusetzen.'],
  'MIME non autorisé ({}). Attendu : .docx': ['MIME not allowed ({}). Expected: .docx', 'MIME non consentito ({}). Atteso: .docx', 'MIME nicht erlaubt ({}). Erwartet: .docx'],
  'MIME type non autorisé ({}). Attendu : PDF ou Word.': ['MIME type not allowed ({}). Expected: PDF or Word.', 'Tipo MIME non consentito ({}). Atteso: PDF o Word.', 'MIME-Typ nicht erlaubt ({}). Erwartet: PDF oder Word.'],
  'Membre introuvable dans cette équipe': ['Member not found in this team', 'Membro non trovato in questo team', 'Mitglied in diesem Team nicht gefunden'],
  'Membre introuvable sur ce projet': ['Member not found on this project', 'Membro non trovato in questo progetto', 'Mitglied in diesem Projekt nicht gefunden'],
  'Mot de passe actuel invalide': ['Current password is invalid', 'Password attuale non valida', 'Aktuelles Passwort ist ungültig'],
  'Mot de passe invalide': ['Invalid password', 'Password non valida', 'Ungültiges Passwort'],
  'Nom requis': ['Name required', 'Nome richiesto', 'Name erforderlich'],
  'Non authentifié': ['Not authenticated', 'Non autenticato', 'Nicht authentifiziert'],
  'Organisation introuvable pour ce domaine': ['Organization not found for this domain', 'Organizzazione non trovata per questo dominio', 'Organisation für diese Domain nicht gefunden'],
  'Pack custom introuvable': ['Custom pack not found', 'Pacchetto personalizzato non trovato', 'Benutzerdefiniertes Paket nicht gefunden'],
  'Pack introuvable': ['Pack not found', 'Pacchetto non trovato', 'Paket nicht gefunden'],
  'Pièce jointe introuvable': ['Attachment not found', 'Allegato non trovato', 'Anhang nicht gefunden'],
  'Port syslog invalide : {}': ['Invalid syslog port: {}', 'Porta syslog non valida: {}', 'Ungültiger Syslog-Port: {}'],
  'Projet introuvable': ['Project not found', 'Progetto non trovato', 'Projekt nicht gefunden'],
  'Confirmation requise pour « {} ». Rappelez ce tool avec le jeton fourni pour l\'exécuter.': ['Confirmation required for “{}”. Call this tool again with the provided token to execute it.', 'Conferma richiesta per «{}». Richiama questo strumento con il token fornito per eseguirlo.', 'Bestätigung erforderlich für „{}“. Rufen Sie dieses Werkzeug mit dem bereitgestellten Token erneut auf, um es auszuführen.'],
  'Jeton de confirmation invalide, expiré ou déjà utilisé. Relancez l\'action pour obtenir un nouveau défi.': ['Invalid, expired or already used confirmation token. Retry the action to get a new challenge.', 'Token di conferma non valido, scaduto o già utilizzato. Riprova l’azione per ottenere una nuova sfida.', 'Ungültiges, abgelaufenes oder bereits verwendetes Bestätigungstoken. Wiederholen Sie die Aktion, um eine neue Anforderung zu erhalten.'],
  'Confirmation indisponible : le service de sécurité est momentanément injoignable.': ['Confirmation unavailable: the security service is temporarily unreachable.', 'Conferma non disponibile: il servizio di sicurezza è temporaneamente irraggiungibile.', 'Bestätigung nicht verfügbar: Der Sicherheitsdienst ist vorübergehend nicht erreichbar.'],
  'Quota de l\'outil « {} » atteint pour cette organisation ({} appels/minute).': ["Tool “{}” quota reached for this organization ({} calls/minute).", 'Quota dello strumento «{}» raggiunta per questa organizzazione ({} chiamate/minuto).', 'Kontingent des Werkzeugs „{}“ für diese Organisation erreicht ({} Aufrufe/Minute).'],
  'Projet introuvable dans cette organisation': ['Project not found in this organization', 'Progetto non trovato in questa organizzazione', 'Projekt in dieser Organisation nicht gefunden'],
  'Protocole syslog invalide : {} (tcp|tls)': ['Invalid syslog protocol: {} (tcp|tls)', 'Protocollo syslog non valido: {} (tcp|tls)', 'Ungültiges Syslog-Protokoll: {} (tcp|tls)'],
  'Provider OIDC incomplet (discovery/clientId manquant).': ['Incomplete OIDC provider (discovery/clientId missing).', 'Provider OIDC incompleto (discovery/clientId mancante).', 'Unvollständiger OIDC-Anbieter (discovery/clientId fehlt).'],
  'Provider SAML incomplet (entryPoint / certificat IdP manquant).': ['Incomplete SAML provider (entryPoint / IdP certificate missing).', 'Provider SAML incompleto (entryPoint / certificato IdP mancante).', 'Unvollständiger SAML-Anbieter (entryPoint / IdP-Zertifikat fehlt).'],
  'Refresh token invalide': ['Invalid refresh token', 'Refresh token non valido', 'Ungültiges Refresh-Token'],
  'Ressource introuvable': ['Resource not found', 'Risorsa non trovata', 'Ressource nicht gefunden'],
  'Réponse SAML absente (SAMLResponse manquant).': ['Missing SAML response (SAMLResponse absent).', 'Risposta SAML assente (SAMLResponse mancante).', 'Fehlende SAML-Antwort (SAMLResponse fehlt).'],
  'Réservé au Team Manager de cette équipe (ou à un admin).': ['Reserved for the Team Manager of this team (or an admin).', 'Riservato al Team Manager di questo team (o a un amministratore).', 'Dem Team Manager dieses Teams (oder einem Admin) vorbehalten.'],
  'Réservé aux admins': ['Admins only', 'Solo amministratori', 'Nur für Admins'],
  "Rétention du journal d'audit : entre 30 et 3650 jours": ['Audit log retention: between 30 and 3650 days', 'Conservazione del log di audit: tra 30 e 3650 giorni', 'Audit-Log-Aufbewahrung: zwischen 30 und 3650 Tagen'],
  'Réponse Graph inattendue (HTTP {}).': ['Unexpected Graph response (HTTP {}).', 'Risposta Graph inattesa (HTTP {}).', 'Unerwartete Graph-Antwort (HTTP {}).'],
  'SSO indisponible': ['SSO unavailable', 'SSO non disponibile', 'SSO nicht verfügbar'],
  'Rôle inconnu : {}': ['Unknown role: {}', 'Ruolo sconosciuto: {}', 'Unbekannte Rolle: {}'],
  'Rôle {} introuvable': ['Role {} not found', 'Ruolo {} non trovato', 'Rolle {} nicht gefunden'],
  'Scope du jeton insuffisant': ['Insufficient token scope', 'Scope del token insufficiente', 'Unzureichender Token-Scope'],
  'Scope(s) invalide(s) : {}': ['Invalid scope(s): {}', 'Scope non valido/i: {}', 'Ungültige(r) Scope(s): {}'],
  "Secret client OIDC absent (SSO_OIDC_CLIENT_SECRET non monté). Contactez l'administrateur.": ['OIDC client secret missing (SSO_OIDC_CLIENT_SECRET not mounted). Contact the administrator.', "Client secret OIDC assente (SSO_OIDC_CLIENT_SECRET non montato). Contatta l'amministratore.", 'OIDC-Client-Secret fehlt (SSO_OIDC_CLIENT_SECRET nicht eingebunden). Wenden Sie sich an den Administrator.'],
  'Secret client OIDC illisible (clé de chiffrement ?).': ['OIDC client secret unreadable (encryption key?).', 'Client secret OIDC illeggibile (chiave di cifratura?).', 'OIDC-Client-Secret nicht lesbar (Verschlüsselungsschlüssel?).'],
  'Session expirée (inactivité)': ['Session expired (inactivity)', 'Sessione scaduta (inattività)', 'Sitzung abgelaufen (Inaktivität)'],
  'Session révoquée (force-logout)': ['Session revoked (force-logout)', 'Sessione revocata (force-logout)', 'Sitzung widerrufen (Force-Logout)'],
  "Seuil d'alerte brute-force : entre 3 et 50 échecs": ['Brute-force alert threshold: between 3 and 50 failures', 'Soglia di allerta brute-force: tra 3 e 50 fallimenti', 'Brute-Force-Alarmschwelle: zwischen 3 und 50 Fehlversuchen'],
  'Seul un Project Manager (du projet concerné), un Portfolio Manager ou un admin peut émettre une demande de compétence.': ['Only a Project Manager (of the project), a Portfolio Manager or an admin can raise a skill request.', 'Solo un Project Manager (del progetto), un Portfolio Manager o un amministratore può emettere una richiesta di competenza.', 'Nur ein Project Manager (des Projekts), ein Portfolio Manager oder ein Admin kann eine Kompetenzanfrage stellen.'],
  'Seul un Team Manager de cette équipe (ou un admin) peut en gérer les membres': ['Only a Team Manager of this team (or an admin) can manage its members', 'Solo un Team Manager di questo team (o un amministratore) può gestirne i membri', 'Nur ein Team Manager dieses Teams (oder ein Admin) kann dessen Mitglieder verwalten'],
  'Seul un Team Manager de cette équipe (ou un admin) peut la modifier': ['Only a Team Manager of this team (or an admin) can edit it', 'Solo un Team Manager di questo team (o un amministratore) può modificarlo', 'Nur ein Team Manager dieses Teams (oder ein Admin) kann es bearbeiten'],
  'Seul un administrateur global peut accorder le statut admin': ['Only a global administrator can grant admin status', 'Solo un amministratore globale può concedere lo stato di amministratore', 'Nur ein globaler Administrator kann den Admin-Status erteilen'],
  'Seul un administrateur global peut modifier ce paramètre': ['Only a global administrator can change this setting', 'Solo un amministratore globale può modificare questa impostazione', 'Nur ein globaler Administrator kann diese Einstellung ändern'],
  "Seul un administrateur global peut modifier le compte d'un admin": ["Only a global administrator can edit an admin's account", "Solo un amministratore globale può modificare l'account di un amministratore", 'Nur ein globaler Administrator kann das Konto eines Admins bearbeiten'],
  "Seul un administrateur peut restreindre la visibilité d'un pack.": ["Only an administrator can restrict a pack's visibility.", 'Solo un amministratore può limitare la visibilità di un pacchetto.', 'Nur ein Administrator kann die Sichtbarkeit eines Pakets einschränken.'],
  'Seul un lead de cette équipe (ou un admin) peut gérer ses compétences.': ['Only a lead of this team (or an admin) can manage its skills.', 'Solo un lead di questo team (o un amministratore) può gestirne le competenze.', 'Nur ein Lead dieses Teams (oder ein Admin) kann dessen Kompetenzen verwalten.'],
  "Seul un lead de l'équipe (ou un admin) peut traiter cette demande.": ['Only a team lead (or an admin) can handle this request.', 'Solo un lead del team (o un amministratore) può gestire questa richiesta.', 'Nur ein Team-Lead (oder ein Admin) kann diese Anfrage bearbeiten.'],
  'Seule une offre envoyée (OFFER_SENT) peut être acceptée (actuel : {}).': ['Only a sent offer (OFFER_SENT) can be accepted (current: {}).', "Solo un'offerta inviata (OFFER_SENT) può essere accettata (attuale: {}).", 'Nur ein gesendetes Angebot (OFFER_SENT) kann angenommen werden (aktuell: {}).'],
  'Seule une offre envoyée (OFFER_SENT) peut être refusée (actuel : {}).': ['Only a sent offer (OFFER_SENT) can be refused (current: {}).', "Solo un'offerta inviata (OFFER_SENT) può essere rifiutata (attuale: {}).", 'Nur ein gesendetes Angebot (OFFER_SENT) kann abgelehnt werden (aktuell: {}).'],
  'Seuls les projets en DRAFT ou CHARTER_REVIEW peuvent être supprimés. Archive le projet à la place.': ['Only projects in DRAFT or CHARTER_REVIEW can be deleted. Archive the project instead.', 'Solo i progetti in DRAFT o CHARTER_REVIEW possono essere eliminati. Archivia invece il progetto.', 'Nur Projekte in DRAFT oder CHARTER_REVIEW können gelöscht werden. Archivieren Sie das Projekt stattdessen.'],
  'Signature de licence invalide — le fichier est corrompu ou émis par une autre clé.': ['Invalid license signature — the file is corrupted or issued by another key.', 'Firma della licenza non valida — il file è corrotto o emesso da un\'altra chiave.', 'Ungültige Lizenzsignatur — die Datei ist beschädigt oder wurde mit einem anderen Schlüssel ausgestellt.'],
  "Skill gap réservé aux Project Managers, Portfolio Managers, leads d'équipe affectée et admins.": ['Skill gap is reserved for Project Managers, Portfolio Managers, assigned team leads and admins.', 'Lo skill gap è riservato a Project Manager, Portfolio Manager, lead dei team assegnati e amministratori.', 'Die Kompetenzlücke ist Project Managern, Portfolio Managern, zugewiesenen Team-Leads und Admins vorbehalten.'],
  'Skill introuvable': ['Skill not found', 'Competenza non trovata', 'Kompetenz nicht gefunden'],
  'Sévérité minimale invalide : {}': ['Invalid minimum severity: {}', 'Severità minima non valida: {}', 'Ungültige Mindestschwere: {}'],
  'Task introuvable': ['Task not found', 'Attività non trovata', 'Aufgabe nicht gefunden'],
  'Template invalide : {}. Vérifie que chaque balise {placeholder} est bien fermée.': ['Invalid template: {}. Check that each {placeholder} tag is properly closed.', 'Template non valido: {}. Verifica che ogni tag {placeholder} sia chiuso correttamente.', 'Ungültige Vorlage: {}. Prüfen Sie, dass jeder {placeholder}-Tag korrekt geschlossen ist.'],
  'Tenant Entra invalide (GUID 8-4-4-4-12 attendu) : {}': ['Invalid Entra tenant (GUID 8-4-4-4-12 expected): {}', 'Tenant Entra non valido (atteso GUID 8-4-4-4-12): {}', 'Ungültiger Entra-Tenant (GUID 8-4-4-4-12 erwartet): {}'],
  'Tenant Entra non autorisé ({}). Tenants permis : {}': ['Entra tenant not allowed ({}). Allowed tenants: {}', 'Tenant Entra non consentito ({}). Tenant permessi: {}', 'Entra-Tenant nicht erlaubt ({}). Erlaubte Tenants: {}'],
  'Time off introuvable': ['Time off not found', 'Assenza non trovata', 'Abwesenheit nicht gefunden'],
  'Token de licence vide.': ['Empty license token.', 'Token di licenza vuoto.', 'Leeres Lizenz-Token.'],
  'Token émis pour un autre tenant': ['Token issued for another tenant', "Token emesso per un altro tenant", 'Token für einen anderen Tenant ausgestellt'],
  'Transition {} → {} interdite (lifecycle {})': ['Transition {} → {} not allowed (lifecycle {})', 'Transizione {} → {} non consentita (lifecycle {})', 'Übergang {} → {} nicht zulässig (Lebenszyklus {})'],
  'Tri invalide': ['Invalid sort', 'Ordinamento non valido', 'Ungültige Sortierung'],
  'Tu ne peux modifier que tes propres entrées': ['You can only edit your own entries', 'Puoi modificare solo le tue voci', 'Sie können nur Ihre eigenen Einträge bearbeiten'],
  'Tu ne peux supprimer que tes propres pièces jointes': ['You can only delete your own attachments', 'Puoi eliminare solo i tuoi allegati', 'Sie können nur Ihre eigenen Anhänge löschen'],
  'Type de fichier non autorisé ({}).': ['File type not allowed ({}).', 'Tipo di file non consentito ({}).', 'Dateityp nicht erlaubt ({}).'],
  'Type de plateforme inconnu : {}': ['Unknown platform type: {}', 'Tipo di piattaforma sconosciuto: {}', 'Unbekannter Plattformtyp: {}'],
  'Tâche inconnue': ['Unknown task', 'Attività sconosciuta', 'Unbekannte Aufgabe'],
  'Tâche introuvable': ['Task not found', 'Attività non trovata', 'Aufgabe nicht gefunden'],
  'Tâche parente invalide': ['Invalid parent task', 'Attività padre non valida', 'Ungültige übergeordnete Aufgabe'],
  'URL doit utiliser http:// ou https://': ['URL must use http:// or https://', 'L\'URL deve usare http:// o https://', 'URL muss http:// oder https:// verwenden'],
  'URL invalide': ['Invalid URL', 'URL non valido', 'Ungültige URL'],
  'URL refusée : cible interne/privée interdite (anti-SSRF).': ['URL rejected: internal/private target forbidden (anti-SSRF).', 'URL rifiutato: destinazione interna/privata vietata (anti-SSRF).', 'URL abgelehnt: internes/privates Ziel verboten (Anti-SSRF).'],
  'Un Team Manager doit rattacher le projet à au moins une de ses équipes': ['A Team Manager must link the project to at least one of their teams', 'Un Team Manager deve collegare il progetto ad almeno uno dei suoi team', 'Ein Team Manager muss das Projekt mindestens einem seiner Teams zuordnen'],
  'Un client avec ce nom existe déjà': ['A client with this name already exists', 'Esiste già un cliente con questo nome', 'Ein Kunde mit diesem Namen existiert bereits'],
  "Un compte avec cet email existe déjà mais n'est pas lié à cette identité IdP (objectId).": ['An account with this email already exists but is not linked to this IdP identity (objectId).', "Esiste già un account con questa email ma non è collegato a questa identità IdP (objectId).", 'Ein Konto mit dieser E-Mail existiert bereits, ist aber nicht mit dieser IdP-Identität (objectId) verknüpft.'],
  'Un coût récurrent (mensuel / annuel) exige une date de début (startDate).': ['A recurring cost (monthly / annual) requires a start date (startDate).', 'Un costo ricorrente (mensile / annuale) richiede una data di inizio (startDate).', 'Wiederkehrende Kosten (monatlich / jährlich) erfordern ein Startdatum (startDate).'],
  'Un fournisseur avec ce slug existe déjà.': ['A provider with this slug already exists.', 'Esiste già un provider con questo slug.', 'Ein Anbieter mit diesem Slug existiert bereits.'],
  'Un label avec ce nom existe déjà': ['A label with this name already exists', 'Esiste già un\'etichetta con questo nome', 'Ein Label mit diesem Namen existiert bereits'],
  'Un ou plusieurs skillIds invalides': ['One or more invalid skillIds', 'Uno o più skillId non validi', 'Ein oder mehrere ungültige skillIds'],
  'Un projet interne portant ce nom existe déjà. Choisissez un autre nom ou rattachez le projet à un client.': ['An internal project with this name already exists. Choose another name or link the project to a client.', 'Esiste già un progetto interno con questo nome. Scegli un altro nome o collega il progetto a un cliente.', 'Ein internes Projekt mit diesem Namen existiert bereits. Wählen Sie einen anderen Namen oder ordnen Sie das Projekt einem Kunden zu.'],
  'Un projet portant ce nom existe déjà pour ce client. Choisissez un autre nom ou un autre client.': ['A project with this name already exists for this client. Choose another name or another client.', 'Esiste già un progetto con questo nome per questo cliente. Scegli un altro nome o un altro cliente.', 'Ein Projekt mit diesem Namen existiert bereits für diesen Kunden. Wählen Sie einen anderen Namen oder einen anderen Kunden.'],
  'Un skill avec ce nom existe déjà': ['A skill with this name already exists', 'Esiste già una competenza con questo nome', 'Eine Kompetenz mit diesem Namen existiert bereits'],
  'Un skill avec ce nom existe déjà : "{}"': ['A skill with this name already exists: "{}"', 'Esiste già una competenza con questo nome: "{}"', 'Eine Kompetenz mit diesem Namen existiert bereits: "{}"'],
  'Une clé organisation doit avoir au moins un scope.': ['An organization key must have at least one scope.', 'Una chiave organizzazione deve avere almeno uno scope.', 'Ein Organisationsschlüssel muss mindestens einen Scope haben.'],
  "Une date d'expiration est requise (max 2 ans — pas de jeton permanent).": ['An expiration date is required (max 2 years — no permanent token).', 'È richiesta una data di scadenza (max 2 anni — nessun token permanente).', 'Ein Ablaufdatum ist erforderlich (max. 2 Jahre — kein permanentes Token).'],
  "Une date de début doit être définie avant d'activer le projet": ['A start date must be set before activating the project', 'Una data di inizio deve essere impostata prima di attivare il progetto', 'Ein Startdatum muss vor der Aktivierung des Projekts festgelegt werden'],
  'Une ou plusieurs équipes invalides': ['One or more invalid teams', 'Uno o più team non validi', 'Ein oder mehrere ungültige Teams'],
  'Une ou plusieurs équipes sont introuvables': ['One or more teams not found', 'Uno o più team non trovati', 'Ein oder mehrere Teams nicht gefunden'],
  "Une tâche ne peut pas dépendre d'elle-même": ['A task cannot depend on itself', 'Un\'attività non può dipendere da sé stessa', 'Eine Aufgabe kann nicht von sich selbst abhängen'],
  'Une tâche ne peut être sa propre parente': ['A task cannot be its own parent', 'Un\'attività non può essere padre di sé stessa', 'Eine Aufgabe kann nicht ihr eigenes übergeordnetes Element sein'],
  'Une équipe active porte déjà ce nom ou cet identifiant externe — renommez-la avant de restaurer.': ['An active team already has this name or external identifier — rename it before restoring.', 'Un team attivo ha già questo nome o identificativo esterno — rinominalo prima di ripristinare.', 'Ein aktives Team trägt bereits diesen Namen oder diese externe Kennung — benennen Sie es vor dem Wiederherstellen um.'],
  'Une équipe avec ce nom existe déjà': ['A team with this name already exists', 'Esiste già un team con questo nome', 'Ein Team mit diesem Namen existiert bereits'],
  'Une équipe nommée « {} » existe déjà.': ['A team named "{}" already exists.', 'Esiste già un team chiamato «{}».', 'Ein Team mit dem Namen „{}" existiert bereits.'],
  "User cible non assigné à la tâche — assigne-le d'abord.": ['Target user not assigned to the task — assign them first.', "Utente target non assegnato all'attività — assegnalo prima.", 'Zielbenutzer nicht der Aufgabe zugewiesen — weisen Sie ihn zuerst zu.'],
  'User introuvable': ['User not found', 'Utente non trovato', 'Benutzer nicht gefunden'],
  'Utilisateur déjà membre de cette équipe': ['User is already a member of this team', 'Utente già membro di questo team', 'Benutzer ist bereits Mitglied dieses Teams'],
  'Utilisateur introuvable': ['User not found', 'Utente non trovato', 'Benutzer nicht gefunden'],
  'Utilisateur introuvable dans cette organisation': ['User not found in this organization', 'Utente non trovato in questa organizzazione', 'Benutzer in dieser Organisation nicht gefunden'],
  "Utilisez les actions « Accepter » / « Refuser » l'offre pour cette transition.": ['Use the "Accept" / "Refuse" offer actions for this transition.', 'Usa le azioni «Accetta» / «Rifiuta» l\'offerta per questa transizione.', 'Verwenden Sie für diesen Übergang die Aktionen „Annehmen" / „Ablehnen" des Angebots.'],
  'Votre rôle ne permet pas de gérer les webhooks de ce périmètre.': ['Your role does not allow managing webhooks in this scope.', 'Il tuo ruolo non consente di gestire i webhook di questo perimetro.', 'Ihre Rolle erlaubt es nicht, Webhooks in diesem Bereich zu verwalten.'],
  "Vous devez être team lead d'une équipe dont cet utilisateur est membre": ['You must be team lead of a team this user belongs to', 'Devi essere team lead di un team di cui questo utente è membro', 'Sie müssen Team-Lead eines Teams sein, dem dieser Benutzer angehört'],
  "Vous n'avez pas accès au planning de cet utilisateur": ["You do not have access to this user's schedule", "Non hai accesso alla pianificazione di questo utente", 'Sie haben keinen Zugriff auf den Zeitplan dieses Benutzers'],
  "Vous n'avez pas accès au profil de compétences de cet utilisateur": ["You do not have access to this user's skill profile", "Non hai accesso al profilo competenze di questo utente", 'Sie haben keinen Zugriff auf das Kompetenzprofil dieses Benutzers'],
  "Vous ne pouvez rattacher le projet qu'à des équipes que vous pilotez": ['You can only link the project to teams you lead', 'Puoi collegare il progetto solo a team che guidi', 'Sie können das Projekt nur Teams zuordnen, die Sie leiten'],
  'Webhook introuvable': ['Webhook not found', 'Webhook non trovato', 'Webhook nicht gefunden'],
  'Webhook introuvable pour ce projet': ['Webhook not found for this project', 'Webhook non trovato per questo progetto', 'Webhook für dieses Projekt nicht gefunden'],
  'billRate négatif': ['negative billRate', 'billRate negativo', 'negativer billRate'],
  'columnIds doit contenir exactement toutes les colonnes du board': ['columnIds must contain exactly all the board columns', 'columnIds deve contenere esattamente tutte le colonne della board', 'columnIds muss genau alle Spalten des Boards enthalten'],
  'csv (string) requis': ['csv (string) required', 'csv (string) richiesto', 'csv (string) erforderlich'],
  'currentPassword et newPassword requis': ['currentPassword and newPassword required', 'currentPassword e newPassword richiesti', 'currentPassword und newPassword erforderlich'],
  'desiredLevel doit être entre 1 et {}': ['desiredLevel must be between 1 and {}', 'desiredLevel deve essere tra 1 e {}', 'desiredLevel muss zwischen 1 und {} liegen'],
  'displayName requis': ['displayName required', 'displayName richiesto', 'displayName erforderlich'],
  'displayName requis.': ['displayName required.', 'displayName richiesto.', 'displayName erforderlich.'],
  'expiresAt doit être dans le futur': ['expiresAt must be in the future', 'expiresAt deve essere nel futuro', 'expiresAt muss in der Zukunft liegen'],
  'expiresAt invalide': ['invalid expiresAt', 'expiresAt non valido', 'ungültiges expiresAt'],
  'hoursPerDay doit être compris entre 0 et 24.': ['hoursPerDay must be between 0 and 24.', 'hoursPerDay deve essere compreso tra 0 e 24.', 'hoursPerDay muss zwischen 0 und 24 liegen.'],
  'id du pack : slug minuscule [a-z0-9_-], 1–64 caractères': ['pack id: lowercase slug [a-z0-9_-], 1–64 characters', 'id del pacchetto: slug minuscolo [a-z0-9_-], 1–64 caratteri', 'Paket-ID: Kleinbuchstaben-Slug [a-z0-9_-], 1–64 Zeichen'],
  'kind invalide. Attendu : {}': ['invalid kind. Expected: {}', 'kind non valido. Atteso: {}', 'ungültiger kind. Erwartet: {}'],
  'label requis (1–80 caractères)': ['label required (1–80 characters)', 'label richiesto (1–80 caratteri)', 'label erforderlich (1–80 Zeichen)'],
  'level doit être entre 1 et {}': ['level must be between 1 and {}', 'level deve essere tra 1 e {}', 'level muss zwischen 1 und {} liegen'],
  'linkMatchKey doit être `upn` ou `email`.': ['linkMatchKey must be `upn` or `email`.', 'linkMatchKey deve essere `upn` o `email`.', 'linkMatchKey muss `upn` oder `email` sein.'],
  'linkStrategy doit être `link` ou `reject`.': ['linkStrategy must be `link` or `reject`.', 'linkStrategy deve essere `link` o `reject`.', 'linkStrategy muss `link` oder `reject` sein.'],
  'oidcDiscoveryUrl doit être une URL https valide.': ['oidcDiscoveryUrl must be a valid https URL.', 'oidcDiscoveryUrl deve essere un URL https valido.', 'oidcDiscoveryUrl muss eine gültige https-URL sein.'],
  'outcome invalide': ['invalid outcome', 'outcome non valido', 'ungültiges outcome'],
  'projectId requis pour scope=project': ['projectId required for scope=project', 'projectId richiesto per scope=project', 'projectId erforderlich für scope=project'],
  'samlEntryPoint doit être une URL https valide.': ['samlEntryPoint must be a valid https URL.', 'samlEntryPoint deve essere un URL https valido.', 'samlEntryPoint muss eine gültige https-URL sein.'],
  'samlIdpCert doit être un certificat X.509 au format PEM.': ['samlIdpCert must be an X.509 certificate in PEM format.', 'samlIdpCert deve essere un certificato X.509 in formato PEM.', 'samlIdpCert muss ein X.509-Zertifikat im PEM-Format sein.'],
  'scopeId requis pour un périmètre PROJECT/TEAM': ['scopeId required for a PROJECT/TEAM scope', 'scopeId richiesto per un perimetro PROJECT/TEAM', 'scopeId erforderlich für einen PROJECT/TEAM-Bereich'],
  'scopeType invalide: {}': ['invalid scopeType: {}', 'scopeType non valido: {}', 'ungültiger scopeType: {}'],
  'severity invalide': ['invalid severity', 'severity non valida', 'ungültige severity'],
  'skills : 500 entrées max par pack': ['skills: max 500 entries per pack', 'skills: max 500 voci per pacchetto', 'skills: max. 500 Einträge pro Paket'],
  'skills : tableau non vide requis': ['skills: non-empty array required', 'skills: array non vuoto richiesto', 'skills: nicht-leeres Array erforderlich'],
  'skills[{}].name requis (1–80)': ['skills[{}].name required (1–80)', 'skills[{}].name richiesto (1–80)', 'skills[{}].name erforderlich (1–80)'],
  'slug invalide ([a-z0-9-], 2–40 caractères).': ['invalid slug ([a-z0-9-], 2–40 characters).', 'slug non valido ([a-z0-9-], 2–40 caratteri).', 'ungültiger slug ([a-z0-9-], 2–40 Zeichen).'],
  'token et newPassword requis': ['token and newPassword required', 'token e newPassword richiesti', 'token und newPassword erforderlich'],
  'totalHours trop élevé : la plage proposée dépasse 5 ans.': ['totalHours too high: the proposed range exceeds 5 years.', 'totalHours troppo alto: l\'intervallo proposto supera 5 anni.', 'totalHours zu hoch: der vorgeschlagene Bereich überschreitet 5 Jahre.'],
  'type doit être OIDC ou SAML.': ['type must be OIDC or SAML.', 'type deve essere OIDC o SAML.', 'type muss OIDC oder SAML sein.'],
  'userId requis pour scope=user': ['userId required for scope=user', 'userId richiesto per scope=user', 'userId erforderlich für scope=user'],
  'userName (email) déjà utilisé par un autre compte': ['userName (email) already used by another account', 'userName (email) già usato da un altro account', 'userName (email) bereits von einem anderen Konto verwendet'],
  'userName (email) ou employeeNumber déjà utilisé': ['userName (email) or employeeNumber already used', 'userName (email) o employeeNumber già usato', 'userName (email) oder employeeNumber bereits verwendet'],
  'userName (email) requis': ['userName (email) required', 'userName (email) richiesto', 'userName (email) erforderlich'],
  'defaultOwnerId invalide : humain ACTIF requis.': ['Invalid defaultOwnerId: an ACTIVE human is required.', 'defaultOwnerId non valido: è richiesto un umano ATTIVO.', 'Ungültige defaultOwnerId: ein AKTIVER Mensch ist erforderlich.'],
  'webhooks.managePolicy invalide : {}': ['invalid webhooks.managePolicy: {}', 'webhooks.managePolicy non valido: {}', 'ungültige webhooks.managePolicy: {}'],
  '{} : date invalide': ['{}: invalid date', '{}: data non valida', '{}: ungültiges Datum'],
  '{} introuvable': ['{} not found', '{} non trovato', '{} nicht gefunden'],
  "{} n'est pas un rôle d'organisation.": ['{} is not an organization role.', '{} non è un ruolo di organizzazione.', '{} ist keine Organisationsrolle.'],
  "{} n'est pas un rôle de projet": ['{} is not a project role', '{} non è un ruolo di progetto', '{} ist keine Projektrolle'],
  'Échec de la connexion SSO': ['SSO sign-in failed', 'Accesso SSO non riuscito', 'SSO-Anmeldung fehlgeschlagen'],
  "Échec de validation de l'assertion SAML.": ['SAML assertion validation failed.', "Convalida dell'asserzione SAML non riuscita.", 'Validierung der SAML-Assertion fehlgeschlagen.'],
  "Échec de validation de l'assertion SAML : {}{}": ['SAML assertion validation failed: {}{}', "Convalida dell'asserzione SAML non riuscita: {}{}", 'Validierung der SAML-Assertion fehlgeschlagen: {}{}'],
  "Échec de validation de la réponse de l'IdP.": ['IdP response validation failed.', "Convalida della risposta dell'IdP non riuscita.", 'Validierung der IdP-Antwort fehlgeschlagen.'],
  'Édition des tâches refusée sur ce projet (projet facturable — réservé aux Project Managers / Contributors du projet)': ['Task editing denied on this project (billable project — reserved for the project\'s Project Managers / Contributors)', 'Modifica delle attività negata su questo progetto (progetto fatturabile — riservato a Project Manager / Collaboratori del progetto)', 'Aufgabenbearbeitung in diesem Projekt verweigert (abrechenbares Projekt — den Project Managern / Mitwirkenden des Projekts vorbehalten)'],
  "Édition non autorisée : il faut être admin, team lead de cet utilisateur, ou que l'organisation autorise l'auto-édition.": ['Editing not allowed: you must be an admin, team lead of this user, or the organization must allow self-editing.', "Modifica non consentita: devi essere amministratore, team lead di questo utente, oppure l'organizzazione deve consentire l'auto-modifica.", 'Bearbeitung nicht erlaubt: Sie müssen Admin, Team-Lead dieses Benutzers sein, oder die Organisation muss die Selbstbearbeitung zulassen.'],
  'Équipe archivée introuvable': ['Archived team not found', 'Team archiviato non trovato', 'Archiviertes Team nicht gefunden'],
  "Équipe archivée introuvable — archivez-la d'abord (soft-delete) avant la suppression définitive.": ['Archived team not found — archive it first (soft-delete) before permanent deletion.', 'Team archiviato non trovato — archivialo prima (soft-delete) prima dell\'eliminazione definitiva.', 'Archiviertes Team nicht gefunden — archivieren Sie es zuerst (Soft-Delete), bevor Sie es endgültig löschen.'],
  'Équipe introuvable': ['Team not found', 'Team non trovato', 'Team nicht gefunden'],
  'Équipe introuvable dans cette organisation': ['Team not found in this organization', 'Team non trovato in questa organizzazione', 'Team in dieser Organisation nicht gefunden'],
  'Équipe synchronisée depuis {} : composition gérée par l\'IdP': ['Team synced from {}: membership managed by the IdP', 'Team sincronizzato da {}: composizione gestita dall\'IdP', 'Team von {} synchronisiert: Mitgliedschaft wird vom IdP verwaltet'],
  'Équipe synchronisée depuis {} : le nom est géré par l\'IdP — utilisez le « nom d\'affichage » à la place.': ['Team synced from {}: the name is managed by the IdP — use the "display name" instead.', 'Team sincronizzato da {}: il nome è gestito dall\'IdP — usa il «nome visualizzato» al suo posto.', 'Team von {} synchronisiert: der Name wird vom IdP verwaltet — verwenden Sie stattdessen den „Anzeigenamen".'],
  'Énumération Graph échouée (HTTP {}).': ['Graph enumeration failed (HTTP {}).', 'Enumerazione Graph non riuscita (HTTP {}).', 'Graph-Enumeration fehlgeschlagen (HTTP {}).'],
  'État de session SAML invalide ou expiré.': ['Invalid or expired SAML session state.', 'Stato di sessione SAML non valido o scaduto.', 'Ungültiger oder abgelaufener SAML-Sitzungsstatus.'],
  'État de session SSO invalide ou expiré.': ['Invalid or expired SSO session state.', 'Stato di sessione SSO non valido o scaduto.', 'Ungültiger oder abgelaufener SSO-Sitzungsstatus.'],
  // ── Connecteur IA / OAuth (audit MCP 2026-09) ──
  "Le connecteur IA (MCP) est désactivé pour votre organisation. Contactez votre administrateur.": ['The AI connector (MCP) is disabled for your organization. Contact your administrator.', "Il connettore IA (MCP) è disattivato per la tua organizzazione. Contatta il tuo amministratore.", 'Der KI-Connector (MCP) ist für Ihre Organisation deaktiviert. Wenden Sie sich an Ihren Administrator.'],
  "Le connecteur IA (MCP) n'accepte que les jetons d'API Vaks-PM.": ['The AI connector (MCP) only accepts Vaks-PM API tokens.', 'Il connettore IA (MCP) accetta solo token API Vaks-PM.', 'Der KI-Connector (MCP) akzeptiert nur Vaks-PM-API-Token.'],
  "La création de jetons d'API personnels est désactivée par votre organisation.": ['Creating personal API tokens is disabled by your organization.', 'La creazione di token API personali è disattivata dalla tua organizzazione.', 'Das Erstellen persönlicher API-Token ist von Ihrer Organisation deaktiviert.'],
  "Les sessions ouvertes via la passerelle IA ne donnent accès qu'à l'authentification.": ['Sessions opened through the AI gateway only give access to authentication.', "Le sessioni aperte tramite il gateway IA danno accesso solo all'autenticazione.", 'Über das KI-Gateway geöffnete Sitzungen gewähren nur Zugriff auf die Authentifizierung.'],
  'Compte désactivé — la connexion IA a été coupée.': ['Account disabled — the AI connection has been cut.', 'Account disattivato — la connessione IA è stata interrotta.', 'Konto deaktiviert — die KI-Verbindung wurde getrennt.'],
  'Client OAuth révoqué — se reconnecter.': ['OAuth client revoked — reconnect.', 'Client OAuth revocato — riconnettersi.', 'OAuth-Client widerrufen — erneut verbinden.'],
  'client_id requis pour ce client.': ['client_id required for this client.', 'client_id obbligatorio per questo client.', 'client_id für diesen Client erforderlich.'],
  'client_secret invalide.': ['Invalid client_secret.', 'client_secret non valido.', 'Ungültiges client_secret.'],
  'Le jeton doit porter les claims `exp` et `iat` (jeton sans expiration refusé).': ['The token must carry the `exp` and `iat` claims (tokens without expiry are refused).', 'Il token deve contenere i claim `exp` e `iat` (token senza scadenza rifiutato).', 'Das Token muss die Claims `exp` und `iat` enthalten (Token ohne Ablauf werden abgelehnt).'],
};

// Precompute exact + pattern matchers on normalized keys.
const idxOf: Record<string, number> = { en: 0, it: 1, de: 2 };
const exact = new Map<string, [string, string, string]>();
const patterns: Array<{ re: RegExp; tr: [string, string, string] }> = [];
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
for (const [fr, tr] of Object.entries(M)) {
  const n = norm(fr);
  if (n.includes('{}')) {
    const re = new RegExp('^' + n.split('{}').map(escapeRe).join('(.*?)') + '$', 's');
    patterns.push({ re, tr });
  } else {
    exact.set(n, tr);
  }
}

/** Translate a (French source) exception message into `lang`. Unknown messages
 *  and 'fr' pass through unchanged. */
export function translateExc(message: string, lang: ExcLang): string {
  if (lang === 'fr') return message;
  const i = idxOf[lang];
  if (i === undefined) return message;
  const n = norm(message);
  const ex = exact.get(n);
  if (ex) return ex[i] || message;
  for (const p of patterns) {
    const m = p.re.exec(n);
    if (m) {
      const caps = m.slice(1);
      let k = 0;
      const out = p.tr[i].replace(/\{\}/g, () => caps[k++] ?? '');
      return out || message;
    }
  }
  return message;
}

const normLang = (v?: string | null): ExcLang | null => {
  if (!v) return null;
  const c = v.trim().slice(0, 2).toLowerCase();
  return (SUPPORTED as string[]).includes(c) ? (c as ExcLang) : null;
};

/** Resolve the language from Accept-Language. Default = English. */
export function pickExcLang(acceptLanguage?: string | null): ExcLang {
  if (acceptLanguage) {
    for (const part of acceptLanguage.split(',')) {
      const c = normLang(part.split(';')[0]);
      if (c) return c;
    }
  }
  return 'en';
}
