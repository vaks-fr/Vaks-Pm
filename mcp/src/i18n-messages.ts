/**
 * Messages du serveur MCP lus par l'HUMAIN (erreurs affichées par le client IA,
 * titres des resources dans son menu) — dans les 4 langues du produit. Même
 * ligne de partage que `i18n.ts` : les descriptions de tools / corps de prompts,
 * lus par le modèle, restent en source unique (anglais).
 *
 * Langue : celle de l'utilisateur (`preferredLanguage`, après le handshake),
 * sinon l'`Accept-Language` du client IA (erreurs AVANT le handshake), sinon
 * l'anglais.
 */
import { pickLang, type Lang } from './i18n.js';

type Entry = Record<Lang, string>;

const M = {
  shuttingDown: {
    en: 'MCP server shutting down, retry (another replica takes over).',
    fr: 'Serveur MCP en cours d’arrêt, réessayer (un autre réplica prend le relais).',
    it: 'Server MCP in arresto, riprovare (subentra un’altra replica).',
    de: 'MCP-Server wird heruntergefahren, bitte erneut versuchen (ein anderes Replikat übernimmt).',
  },
  unknownHost: {
    en: 'Unrecognized host.',
    fr: 'Hôte non reconnu.',
    it: 'Host non riconosciuto.',
    de: 'Unbekannter Host.',
  },
  tokenRequired: {
    en: 'A Vaks-PM access token is required (Authorization: Bearer vaks_…).',
    fr: 'Jeton d’accès Vaks-PM requis (Authorization: Bearer vaks_…).',
    it: 'È richiesto un token di accesso Vaks-PM (Authorization: Bearer vaks_…).',
    de: 'Ein Vaks-PM-Zugriffstoken ist erforderlich (Authorization: Bearer vaks_…).',
  },
  accessExpired: {
    en:
      'Vaks-PM access expired or disconnected. This AI connection was revoked (by you in ' +
      'Security → AI connections, or by an administrator) or the token expired. ' +
      'Reconnect the Vaks-PM connector to continue.',
    fr:
      'Accès Vaks-PM expiré ou déconnecté. Cette connexion IA a été révoquée (par vous-même ' +
      'dans Sécurité → Connexions IA, ou par un administrateur) ou le jeton a expiré. ' +
      'Reconnectez le connecteur Vaks-PM pour continuer.',
    it:
      'Accesso a Vaks-PM scaduto o disconnesso. Questa connessione IA è stata revocata (da te in ' +
      'Sicurezza → Connessioni IA, o da un amministratore) oppure il token è scaduto. ' +
      'Riconnetti il connettore Vaks-PM per continuare.',
    de:
      'Vaks-PM-Zugriff abgelaufen oder getrennt. Diese KI-Verbindung wurde widerrufen (von Ihnen unter ' +
      'Sicherheit → KI-Verbindungen oder von einem Administrator) oder das Token ist abgelaufen. ' +
      'Verbinden Sie den Vaks-PM-Connector erneut, um fortzufahren.',
  },
  accessDenied: {
    en: 'Access denied by Vaks-PM for this token.',
    fr: 'Accès refusé par Vaks-PM pour ce jeton.',
    it: 'Accesso negato da Vaks-PM per questo token.',
    de: 'Zugriff für dieses Token von Vaks-PM verweigert.',
  },
  apiUnavailable: {
    en: 'Vaks-PM API unavailable, retry in a few moments.',
    fr: 'API Vaks-PM indisponible, réessayer dans quelques instants.',
    it: 'API Vaks-PM non disponibile, riprovare tra qualche istante.',
    de: 'Vaks-PM-API nicht verfügbar, bitte in Kürze erneut versuchen.',
  },
  internalError: {
    en: 'MCP server internal error.',
    fr: 'Erreur interne du serveur MCP.',
    it: 'Errore interno del server MCP.',
    de: 'Interner Fehler des MCP-Servers.',
  },
  methodNotAllowed: {
    en: 'Method not allowed (stateless MCP server: use POST /mcp).',
    fr: 'Méthode non autorisée (serveur MCP stateless : utiliser POST /mcp).',
    it: 'Metodo non consentito (server MCP stateless: usare POST /mcp).',
    de: 'Methode nicht erlaubt (zustandsloser MCP-Server: POST /mcp verwenden).',
  },
  // ── Erreurs relayées de l'API (ApiClient.explain) ──
  apiUnreachable: {
    en: 'Cannot reach the Vaks-PM API ({0}).',
    fr: 'Impossible de joindre l’API Vaks-PM ({0}).',
    it: 'Impossibile raggiungere l’API Vaks-PM ({0}).',
    de: 'Die Vaks-PM-API ist nicht erreichbar ({0}).',
  },
  apiTimeout: {
    en: 'Timed out reaching the API.',
    fr: 'Délai dépassé en joignant l’API.',
    it: 'Timeout nel raggiungere l’API.',
    de: 'Zeitüberschreitung beim Erreichen der API.',
  },
  api401: {
    en:
      'Vaks-PM access cut: this AI connection was disconnected (by the user in Security → ' +
      'AI connections, or by an administrator) or the token expired. To continue, the user must ' +
      'reconnect the Vaks-PM connector in their AI client.',
    fr:
      'Accès Vaks-PM coupé : cette connexion IA a été déconnectée (par l’utilisateur dans ' +
      'Sécurité → Connexions IA, ou par un administrateur) ou le jeton a expiré. ' +
      'Pour continuer, l’utilisateur doit reconnecter le connecteur Vaks-PM dans son client IA.',
    it:
      'Accesso a Vaks-PM interrotto: questa connessione IA è stata disconnessa (dall’utente in ' +
      'Sicurezza → Connessioni IA, o da un amministratore) oppure il token è scaduto. Per continuare, ' +
      'l’utente deve riconnettere il connettore Vaks-PM nel proprio client IA.',
    de:
      'Vaks-PM-Zugriff getrennt: Diese KI-Verbindung wurde getrennt (vom Benutzer unter Sicherheit → ' +
      'KI-Verbindungen oder von einem Administrator) oder das Token ist abgelaufen. Um fortzufahren, ' +
      'muss der Benutzer den Vaks-PM-Connector in seinem KI-Client erneut verbinden.',
  },
  api403: {
    en: 'Access denied: the user’s scope does not cover this operation ({0}).',
    fr: 'Accès refusé : le périmètre de l’utilisateur ne couvre pas cette opération ({0}).',
    it: 'Accesso negato: il perimetro dell’utente non copre questa operazione ({0}).',
    de: 'Zugriff verweigert: Der Berechtigungsumfang des Benutzers deckt diesen Vorgang nicht ab ({0}).',
  },
  api404: {
    en: 'Resource not found ({0}).',
    fr: 'Ressource introuvable ({0}).',
    it: 'Risorsa non trovata ({0}).',
    de: 'Ressource nicht gefunden ({0}).',
  },
  api429: {
    en: 'Too many requests (rate limit). Retry later.',
    fr: 'Trop de requêtes (rate-limit). Réessayer plus tard.',
    it: 'Troppe richieste (rate limit). Riprovare più tardi.',
    de: 'Zu viele Anfragen (Rate-Limit). Später erneut versuchen.',
  },
  apiOther: {
    en: 'API error ({0}): {1}',
    fr: 'Erreur API ({0}) : {1}',
    it: 'Errore API ({0}): {1}',
    de: 'API-Fehler ({0}): {1}',
  },
  // ── Resources (menu du client) ──
  resTaskContextTitle: {
    en: 'Task context',
    fr: 'Contexte de tâche',
    it: 'Contesto dell’attività',
    de: 'Aufgabenkontext',
  },
  resTaskContextDesc: {
    en: 'Acceptance criteria, living project journal and available document sources for a task.',
    fr: 'Critères d’acceptation, journal vivant du projet et sources de documents disponibles pour une tâche.',
    it: 'Criteri di accettazione, diario vivo del progetto e fonti documentali disponibili per un’attività.',
    de: 'Abnahmekriterien, lebendes Projektjournal und verfügbare Dokumentquellen für eine Aufgabe.',
  },
  resTaskFileTitle: {
    en: 'Document attached to a task',
    fr: 'Document rattaché à une tâche',
    it: 'Documento collegato a un’attività',
    de: 'Einer Aufgabe zugeordnetes Dokument',
  },
  resTaskFileDesc: {
    en: 'Text content extracted from an external-source document (SharePoint, Google Drive). Live proxy: nothing is copied into Vaks-PM.',
    fr: 'Contenu texte extrait d’un document de la source externe (SharePoint, Google Drive). Proxy live : rien n’est copié côté Vaks-PM.',
    it: 'Contenuto testuale estratto da un documento della fonte esterna (SharePoint, Google Drive). Proxy live: nulla viene copiato in Vaks-PM.',
    de: 'Aus einem Dokument der externen Quelle (SharePoint, Google Drive) extrahierter Text. Live-Proxy: nichts wird in Vaks-PM kopiert.',
  },
} satisfies Record<string, Entry>;

export type MsgKey = keyof typeof M;

/** Message localisé ; `{0}`, `{1}`… remplacés par `args` dans l'ordre. */
export function msg(lang: Lang, key: MsgKey, ...args: Array<string | number>): string {
  const tpl = M[key][lang] ?? M[key].en;
  return tpl.replace(/\{(\d+)\}/g, (_, i: string) => String(args[Number(i)] ?? ''));
}

/** Première langue produit trouvée dans un en-tête `Accept-Language`, sinon EN. */
export function langFromAcceptLanguage(header: string | string[] | undefined): Lang {
  const raw = Array.isArray(header) ? header[0] : header;
  for (const part of (raw ?? '').split(',')) {
    const tag = part.split(';')[0].trim();
    if (!tag) continue;
    const lang = pickLang(tag);
    // pickLang retombe sur EN pour une langue inconnue : ne l'accepter que si
    // l'étiquette désigne vraiment l'anglais, sinon tenter la suivante.
    if (lang !== 'en' || tag.toLowerCase().startsWith('en')) return lang;
  }
  return 'en';
}
