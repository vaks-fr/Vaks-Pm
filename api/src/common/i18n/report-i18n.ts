/* ============================================================================
 * Server-side i18n for report EXPORTS (CSV / XLSX / PDF).
 *
 * The app has no backend i18n framework; exports were hardcoded French. This is
 * a tiny self-contained string table (en/fr/it/de) + a translator. The language
 * is resolved per request from `?lang=` (sent by the web UI = the user's current
 * UI language), falling back to `Accept-Language`, then English.
 *
 * Keep it dependency-free and synchronous so it can be used inline in any
 * controller handler. Filenames stay language-neutral (English) on purpose.
 * ========================================================================== */
import { createParamDecorator, type ExecutionContext } from '@nestjs/common';

export type ReportLang = 'en' | 'fr' | 'it' | 'de';
const LANGS: ReportLang[] = ['en', 'fr', 'it', 'de'];

// key -> [en, fr, it, de]
const D: Record<string, [string, string, string, string]> = {
  // -- common headers / labels --
  metric: ['Metric', 'Métrique', 'Metrica', 'Metrik'],
  value: ['Value', 'Valeur', 'Valore', 'Wert'],
  date: ['Date', 'Date', 'Data', 'Datum'],
  user: ['User', 'Utilisateur', 'Utente', 'Benutzer'],
  email: ['Email', 'Email', 'Email', 'E-Mail'],
  task: ['Task', 'Tâche', 'Attività', 'Aufgabe'],
  hours: ['Hours', 'Heures', 'Ore', 'Stunden'],
  overtime: ['Overtime', 'Heures sup', 'Straordinari', 'Überstunden'],
  billable: ['Billable', 'Facturable', 'Fatturabile', 'Abrechenbar'],
  description: ['Description', 'Description', 'Descrizione', 'Beschreibung'],
  title: ['Title', 'Titre', 'Titolo', 'Titel'],
  status: ['Status', 'Statut', 'Stato', 'Status'],
  start: ['Start', 'Début', 'Inizio', 'Beginn'],
  dueDate: ['Due date', 'Échéance', 'Scadenza', 'Fälligkeit'],
  estimateH: ['Estimate (h)', 'Estimé (h)', 'Stima (h)', 'Schätzung (Std.)'],
  progressPct: ['Progress %', 'Avancement %', 'Avanzamento %', 'Fortschritt %'],
  overdue: ['Overdue', 'En retard', 'In ritardo', 'Überfällig'],
  assignees: ['Assignees', 'Assignés', 'Assegnatari', 'Zuständige'],
  priority: ['Priority', 'Priorité', 'Priorità', 'Priorität'],
  number: ['No.', 'N°', 'N.', 'Nr.'],
  name: ['Name', 'Nom', 'Nome', 'Name'],
  project: ['Project', 'Projet', 'Progetto', 'Projekt'],
  label: ['Label', 'Label', 'Etichetta', 'Label'],
  yes: ['Yes', 'Oui', 'Sì', 'Ja'],
  no: ['No', 'Non', 'No', 'Nein'],

  // -- task statuses --
  'st.TODO': ['To do', 'À faire', 'Da fare', 'Zu erledigen'],
  'st.IN_PROGRESS': ['In progress', 'En cours', 'In corso', 'In Arbeit'],
  'st.IN_REVIEW': ['In review', 'En revue', 'In revisione', 'In Prüfung'],
  'st.ON_HOLD': ['On hold', 'En pause', 'In attesa', 'Wartet'],
  'st.DONE': ['Done', 'Terminé', 'Completato', 'Erledigt'],

  // -- project stats --
  'stats.totalTasks': ['Total tasks', 'Tâches total', 'Attività totali', 'Aufgaben gesamt'],
  'stats.completionPct': ['Completion %', 'Avancement %', 'Completamento %', 'Fertigstellung %'],
  'stats.estimatedHours': ['Estimated hours', 'Heures estimées', 'Ore stimate', 'Geschätzte Stunden'],
  'stats.doneEstimatedHours': ['Estimated hours done', 'Heures estimées terminées', 'Ore stimate completate', 'Geschätzte Stunden erledigt'],
  'stats.remainingHours': ['Remaining hours', 'Heures restantes', 'Ore rimanenti', 'Verbleibende Stunden'],
  'stats.spentHours': ['Time spent (h)', 'Temps passé (h)', 'Tempo speso (h)', 'Aufgewendete Zeit (Std.)'],
  'sheet.stats': ['Stats', 'Stats', 'Statistiche', 'Statistik'],
  'title.stats': ['Stats {key}', 'Stats {key}', 'Statistiche {key}', 'Statistik {key}'],

  // -- burndown --
  'bd.ideal': ['Ideal (h left)', 'Idéal (h restantes)', 'Ideale (h rimaste)', 'Ideal (Std. übrig)'],
  'bd.actual': ['Actual (h left)', 'Réel (h restantes)', 'Reale (h rimaste)', 'Tatsächlich (Std. übrig)'],
  'bd.doneTasks': ['Tasks done', 'Tâches terminées', 'Attività completate', 'Erledigte Aufgaben'],
  'sheet.burndown': ['Burndown', 'Burndown', 'Burndown', 'Burndown'],

  // -- due adherence --
  'da.completed': ['Completed', 'Terminées', 'Completate', 'Abgeschlossen'],
  'da.onTime': ['On time', 'À temps', 'In tempo', 'Pünktlich'],
  'da.late': ['Late', 'En retard', 'In ritardo', 'Verspätet'],
  'da.noDeadline': ['No deadline', 'Sans échéance', 'Senza scadenza', 'Ohne Frist'],
  'da.onTimePct': ['On-time %', '% à temps', '% in tempo', 'Pünktlich %'],
  'sheet.dueDates': ['Deadlines', 'Échéances', 'Scadenze', 'Fristen'],

  // -- tasks-in-window --
  'sheet.tasks': ['Tasks', 'Tâches', 'Attività', 'Aufgaben'],

  // -- time breakdown --
  'tb.billableHours': ['Billable hours', 'Heures facturables', 'Ore fatturabili', 'Abrechenbare Stunden'],
  'sheet.byProject': ['By project', 'Par projet', 'Per progetto', 'Nach Projekt'],
  'sheet.byUser': ['By user', 'Par utilisateur', 'Per utente', 'Nach Benutzer'],
  'sheet.byLabel': ['By label', 'Par label', 'Per etichetta', 'Nach Label'],
  'title.timeBreakdown': ['Time breakdown', 'Répartition du temps', 'Ripartizione del tempo', 'Zeitaufteilung'],

  // -- project report PDF --
  'pdf.projectReport': ['Project report', 'Rapport de projet', 'Report di progetto', 'Projektbericht'],
  'kpi.tasks': ['Tasks', 'Tâches', 'Attività', 'Aufgaben'],
  'kpi.tasksHint': ['{done} done', '{done} terminées', '{done} completate', '{done} erledigt'],
  'kpi.progress': ['Progress', 'Avancement', 'Avanzamento', 'Fortschritt'],
  'kpi.remaining': ['Remaining', 'Reste à faire', 'Rimanente', 'Verbleibend'],
  'kpi.overdue': ['Overdue', 'En retard', 'In ritardo', 'Überfällig'],
  'kpi.spent': ['Time spent', 'Temps passé', 'Tempo speso', 'Aufgewendete Zeit'],
  'sec.burndown': ['Burndown', 'Burndown', 'Burndown', 'Burndown'],
  'legend.ideal': ['Ideal', 'Idéal', 'Ideale', 'Ideal'],
  'legend.actual': ['Actual', 'Réel', 'Reale', 'Tatsächlich'],
  'note.noEstimate': [
    'No estimate on the project tasks — burndown unavailable.',
    'Aucune estimation sur les tâches du projet — burndown indisponible.',
    'Nessuna stima sulle attività del progetto — burndown non disponibile.',
    'Keine Schätzung für die Projektaufgaben – Burndown nicht verfügbar.',
  ],
  'sec.dueAdherence': ['Deadline adherence', 'Respect des échéances', 'Rispetto delle scadenze', 'Termineinhaltung'],
  'donut.onTimeCenter': ['on time', 'à temps', 'in tempo', 'pünktlich'],
  'note.noCompleted': [
    'No task completed in the period.',
    'Aucune tâche terminée sur la période.',
    'Nessuna attività completata nel periodo.',
    'Keine Aufgabe im Zeitraum abgeschlossen.',
  ],
  'sec.skillCoverage': ['Skill coverage', 'Couverture des compétences', 'Copertura delle competenze', 'Kompetenzabdeckung'],

  // -- reporting agents IA --
  'sec.agents': ['AI agents', 'Agents IA', 'Agenti IA', 'KI-Agenten'],
  'sheet.agentsSummary': ['Summary', 'Synthèse', 'Sintesi', 'Übersicht'],
  'sheet.agentsPerAgent': ['Per agent', 'Par agent', 'Per agente', 'Pro Agent'],
  'sheet.agentsWeekly': ['Weekly', 'Hebdo', 'Settimanale', 'Wöchentlich'],
  'title.agents': ['AI agents report', 'Rapport agents IA', 'Report agenti IA', 'KI-Agenten-Bericht'],
  'ag.agent': ['Agent', 'Agent', 'Agente', 'Agent'],
  'ag.tasksCompleted': ['Tasks completed', 'Tâches terminées', 'Attività completate', 'Erledigte Aufgaben'],
  'ag.deliverables': ['Deliverables', 'Livrables', 'Deliverable', 'Deliverables'],
  'ag.approved': ['Approved', 'Approuvés', 'Approvati', 'Genehmigt'],
  'ag.firstPassPct': ['First-pass %', '1er coup %', '1º colpo %', 'Erstabnahme %'],
  'ag.avgRounds': ['Avg review rounds', 'Rounds de revue moy.', 'Round di revisione medi', 'Ø Review-Runden'],
  'ag.runs': ['Runs', 'Runs', 'Run', 'Runs'],
  'ag.tokens': [
    'Units (tokens / credits)',
    'Unités (tokens / crédits)',
    'Unità (token / crediti)',
    'Einheiten (Tokens / Credits)',
  ],
  'ag.tokensIn': ['Units in', 'Unités entrantes', 'Unità in ingresso', 'Einheiten ein'],
  'ag.tokensOut': ['Units out', 'Unités sortantes', 'Unità in uscita', 'Einheiten aus'],
  'ag.activeAgents': ['Active agents', 'Agents actifs', 'Agenti attivi', 'Aktive Agenten'],
  'ag.turnaroundH': ['Avg review turnaround (h)', 'Délai de revue moyen (h)', 'Tempo medio di revisione (h)', 'Ø Review-Dauer (Std.)'],
  'ag.weekStart': ['Week (Monday)', 'Semaine (lundi)', 'Settimana (lunedì)', 'Woche (Montag)'],
  'ag.count': ['Completed', 'Terminées', 'Completate', 'Erledigt'],
  'ag.window': ['Window', 'Période', 'Periodo', 'Zeitraum'],
  'ag.total': ['Total', 'Total', 'Totale', 'Gesamt'],
  'note.noAgentActivity': [
    'No agent activity in the period.',
    'Aucune activité d’agent sur la période.',
    'Nessuna attività degli agenti nel periodo.',
    'Keine Agenten-Aktivität im Zeitraum.',
  ],

  'kpi.covered': ['Covered', 'Couvertes', 'Coperte', 'Abgedeckt'],
  'kpi.splittable': ['Splittable', 'À splitter', 'Suddivisibili', 'Aufteilbar'],
  'kpi.partial': ['Partial', 'Partielles', 'Parziali', 'Teilweise'],
  'kpi.uncovered': ['Uncovered', 'Découvertes', 'Scoperte', 'Nicht abgedeckt'],
  'col.skill': ['Skill', 'Compétence', 'Competenza', 'Kompetenz'],
  'col.remainingH': ['Remaining (h)', 'Reste (h)', 'Rimanente (h)', 'Verbleibend (Std.)'],
  'col.freeH': ['Free (h)', 'Libres (h)', 'Libere (h)', 'Frei (Std.)'],
  'skillStatus.uncovered': ['Uncovered', 'Découverte', 'Scoperta', 'Nicht abgedeckt'],
  'skillStatus.partial': ['Partial', 'Partielle', 'Parziale', 'Teilweise'],
  'note.noAtRisk': [
    'No task at risk: all required skills are covered or splittable.',
    'Aucune tâche à risque : toutes les compétences requises sont couvertes ou splittables.',
    'Nessuna attività a rischio: tutte le competenze richieste sono coperte o suddivisibili.',
    'Keine gefährdete Aufgabe: alle erforderlichen Kompetenzen sind abgedeckt oder aufteilbar.',
  ],
  'sec.tasksInWindow': ['Tasks in window ({n})', 'Tâches dans la fenêtre ({n})', 'Attività nella finestra ({n})', 'Aufgaben im Zeitfenster ({n})'],
  'col.estShort': ['Est. (h)', 'Est. (h)', 'Stima (h)', 'Schätz. (Std.)'],
  'col.progShort': ['Prog. %', 'Av. %', 'Av. %', 'Fortschr. %'],

  // -- time breakdown PDF --
  'sub.projectFiltered': ['Filtered project', 'Projet filtré', 'Progetto filtrato', 'Gefiltertes Projekt'],
  'sub.wholeOrg': [
    'Whole organization (accessible scope)',
    'Toute l’organisation (périmètre accessible)',
    'Tutta l’organizzazione (ambito accessibile)',
    'Gesamte Organisation (zugänglicher Bereich)',
  ],
  'kpi.total': ['Total', 'Total', 'Totale', 'Gesamt'],
  'kpi.billable': ['Billable', 'Facturable', 'Fatturabile', 'Abrechenbar'],
  'kpi.nonBillable': ['Non-billable', 'Non facturable', 'Non fatturabile', 'Nicht abrechenbar'],

  // -- time entries --
  'sheet.timeEntries': ['Time entries', 'Saisies de temps', 'Registrazioni di tempo', 'Zeiteinträge'],
  'hdr.nEntries': ['{n} entry/entries', '{n} saisie(s)', '{n} registrazione/i', '{n} Eintrag/Einträge'],
  'kpi.overtime': ['Overtime', 'Heures sup', 'Straordinari', 'Überstunden'],
  'sec.hoursByUser': ['Hours per user', 'Heures par utilisateur', 'Ore per utente', 'Stunden pro Benutzer'],
  'sec.detail': ['Detail', 'Détail', 'Dettaglio', 'Detail'],
  'col.factShort': ['Bill.', 'Fact.', 'Fatt.', 'Abr.'],

  // -- billing export --
  'be.client': ['Client', 'Client', 'Cliente', 'Kunde'],
  'be.amount': ['Amount ({cur})', 'Montant ({cur})', 'Importo ({cur})', 'Betrag ({cur})'],
  'be.rate': ['Bill rate', 'Taux de vente', 'Tariffa', 'Verrechnungssatz'],
  'be.kind': ['Type', 'Type', 'Tipo', 'Typ'],
  'be.ticketSource': ['Ticket source', 'Source ticket', 'Origine ticket', 'Ticket-Quelle'],
  'be.ticketKey': ['Ticket key', 'Clé ticket', 'Chiave ticket', 'Ticket-Schlüssel'],
  'be.ticketUrl': ['Ticket URL', 'URL ticket', 'URL ticket', 'Ticket-URL'],
  'kind.standard': ['Standard', 'Standard', 'Standard', 'Standard'],
  'kind.external': ['External ticket', 'Ticket externe', 'Ticket esterno', 'Externes Ticket'],
  'sheet.billingDetail': ['Billing detail', 'Détail facturation', 'Dettaglio fatturazione', 'Abrechnungsdetail'],
  'title.billingExport': ['Billing export', 'Export facturation', 'Export fatturazione', 'Abrechnungsexport'],

  // -- workload --
  'wl.capacityH': ['Capacity (h)', 'Capacité (h)', 'Capacità (h)', 'Kapazität (Std.)'],
  'wl.plannedH': ['Planned (h)', 'Planifié (h)', 'Pianificato (h)', 'Geplant (Std.)'],
  'wl.loadPct': ['Load %', 'Charge %', 'Carico %', 'Auslastung %'],
  'wl.overloadedDays': ['Overloaded days', 'Jours surchargés', 'Giorni sovraccarichi', 'Überlastete Tage'],
  'wlStatus.holiday': ['holiday', 'férié', 'festivo', 'Feiertag'],
  'wlStatus.absence': ['absence', 'absence', 'assenza', 'Abwesenheit'],
  'wlStatus.nonWorking': ['non-working', 'non-ouvré', 'non lavorativo', 'arbeitsfrei'],
  'wlStatus.overload': ['overload', 'surcharge', 'sovraccarico', 'Überlastung'],
  'wlStatus.free': ['free', 'libre', 'libero', 'frei'],
  'wlStatus.ok': ['ok', 'ok', 'ok', 'ok'],
  'sheet.summary': ['Summary', 'Synthèse', 'Sintesi', 'Übersicht'],
  'sheet.detail': ['Detail', 'Détail', 'Dettaglio', 'Detail'],
  'title.workload': ['Workload', 'Charge de travail', 'Carico di lavoro', 'Arbeitslast'],
  'hdr.nPeople': ['{n} person(s)', '{n} personne(s)', '{n} persona/e', '{n} Person(en)'],
  'kpi.totalCapacity': ['Total capacity', 'Capacité totale', 'Capacità totale', 'Gesamtkapazität'],
  'kpi.planned': ['Planned', 'Planifié', 'Pianificato', 'Geplant'],
  'kpi.avgLoad': ['Average load', 'Charge moyenne', 'Carico medio', 'Durchschn. Auslastung'],
  'kpi.overloaded': ['Overloaded', 'Surchargés', 'Sovraccarichi', 'Überlastet'],
  'kpi.overloadedHint': ['load > 100%', 'charge > 100%', 'carico > 100%', 'Auslastung > 100%'],
  'sec.loadByPerson': ['Load rate per person', 'Taux de charge par personne', 'Tasso di carico per persona', 'Auslastung pro Person'],
  'sec.summary': ['Summary', 'Synthèse', 'Sintesi', 'Übersicht'],
  'col.person': ['Person', 'Personne', 'Persona', 'Person'],

  // -- skill gap --
  'sg.category': ['Category', 'Catégorie', 'Categoria', 'Kategorie'],
  'sg.tasks': ['Tasks', 'Tâches', 'Attività', 'Aufgaben'],
  'sheet.gapDetail': ['Detail per task', 'Détail par tâche', 'Dettaglio per attività', 'Detail pro Aufgabe'],
  'title.skillGap': ['Skill gap', 'Skill gap', 'Skill gap', 'Skill gap'],
  // gap detail columns
  'sg.level': ['Required level', 'Niveau requis', 'Livello richiesto', 'Erforderliches Niveau'],
  'sg.coverState': ['Coverage', 'Couverture', 'Copertura', 'Abdeckung'],
  'sg.remainingH': ['Remaining (h)', 'Reste (h)', 'Rimanente (h)', 'Verbleibend (Std.)'],
  'sg.freeH': ['Free (h)', 'Libres (h)', 'Libere (h)', 'Frei (Std.)'],
  'cover.fully': ['Covered', 'Couverte', 'Coperta', 'Abgedeckt'],
  'cover.splittable': ['Splittable', 'À splitter', 'Suddivisibile', 'Aufteilbar'],
  'cover.partial': ['Partial', 'Partielle', 'Parziale', 'Teilweise'],
  'cover.uncovered': ['Uncovered', 'Découverte', 'Scoperta', 'Nicht abgedeckt'],
  'sg.loggedH': ['Logged (h)', 'Loggé (h)', 'Registrate (h)', 'Erfasst (Std.)'],
  end: ['End', 'Fin', 'Fine', 'Ende'],
  'sg.qualified': ['Qualified', 'Qualifiés', 'Qualificati', 'Qualifiziert'],
  'sg.nearQualified': ['Near-qualified', 'Presque qualifiés', 'Quasi qualificati', 'Fast qualifiziert'],
  'sg.proposedSplit': ['Proposed split', 'Split proposé', 'Suddivisione proposta', 'Vorgeschlagene Aufteilung'],
  lvlAbbr: ['lvl', 'niv', 'liv', 'Stufe'],

  // -- client status deck (PPTX) --
  'sd.deckTitle': ['Project status', 'Point de statut', 'Stato del progetto', 'Projektstatus'],
  'sd.subtitle': ['Status report', 'Point de statut', 'Report di stato', 'Statusbericht'],
  'sd.preparedFor': ['Prepared for', 'Préparé pour', 'Preparato per', 'Erstellt für'],
  'sd.preparedBy': ['Prepared by', 'Préparé par', 'Preparato da', 'Erstellt von'],
  'sd.asOf': ['As of {date}', 'Au {date}', 'Al {date}', 'Stand {date}'],
  'sd.overallStatus': ['Overall status', 'Statut global', 'Stato generale', 'Gesamtstatus'],
  'sd.health.ON_TRACK': ['On track', 'Dans les temps', 'In linea', 'Im Plan'],
  'sd.health.AT_RISK': ['At risk', 'À risque', 'A rischio', 'Gefährdet'],
  'sd.health.OFF_TRACK': ['Off track', 'En dérive', 'Fuori rotta', 'Nicht im Plan'],
  'sd.health.NA': ['Not set', 'Non renseigné', 'Non indicato', 'Nicht gesetzt'],
  'sd.progress': ['Progress', 'Avancement', 'Avanzamento', 'Fortschritt'],
  'sd.tasksDone': ['{done}/{total} tasks done', '{done}/{total} tâches terminées', '{done}/{total} attività completate', '{done}/{total} Aufgaben erledigt'],
  'sd.tasksLabel': ['Tasks done', 'Tâches terminées', 'Attività completate', 'Aufgaben erledigt'],
  'sd.summary': ['Summary', 'Résumé', 'Sintesi', 'Zusammenfassung'],
  'sd.milestones': ['Milestones', 'Jalons', 'Milestone', 'Meilensteine'],
  'sd.msDone': ['Achieved', 'Atteints', 'Raggiunti', 'Erreicht'],
  'sd.msUpcoming': ['Upcoming', 'À venir', 'In arrivo', 'Anstehend'],
  'sd.msAtRisk': ['At risk', 'À risque', 'A rischio', 'Gefährdet'],
  'sd.nextSteps': ['Next steps', 'Prochaines étapes', 'Prossimi passi', 'Nächste Schritte'],
  'sd.risks': ['Risks & attention points', 'Risques & points d’attention', 'Rischi e punti di attenzione', 'Risiken & Aufmerksamkeitspunkte'],
  'sd.noRisks': ['No blocking point identified.', 'Aucun point bloquant identifié.', 'Nessun punto bloccante identificato.', 'Keine blockierenden Punkte identifiziert.'],
  'sd.noSummary': ['No summary provided.', 'Aucun résumé fourni.', 'Nessuna sintesi fornita.', 'Keine Zusammenfassung angegeben.'],
  'sd.noMilestones': ['No milestone defined.', 'Aucun jalon défini.', 'Nessuna milestone definita.', 'Keine Meilensteine definiert.'],
  'sd.noNextSteps': ['No upcoming task.', 'Aucune tâche à venir.', 'Nessuna attività in arrivo.', 'Keine anstehende Aufgabe.'],
  'sd.riskOverdue': ['{n} overdue task(s)', '{n} tâche(s) en retard', '{n} attività in ritardo', '{n} überfällige Aufgabe(n)'],
  'sd.riskMsAtRisk': ['{n} milestone(s) at risk', '{n} jalon(s) à risque', '{n} milestone a rischio', '{n} gefährdete(r) Meilenstein(e)'],
  'sd.internalProject': ['Internal project', 'Projet interne', 'Progetto interno', 'Internes Projekt'],
  'sd.remaining': ['Remaining', 'Restant', 'Rimanente', 'Verbleibend'],
  'sd.progressSlide': ['Progress & deadlines', 'Avancement & échéances', 'Avanzamento e scadenze', 'Fortschritt & Termine'],
  'sd.burndownTitle': ['Remaining work (burndown)', 'Reste à faire (burndown)', 'Lavoro rimanente (burndown)', 'Restarbeit (Burndown)'],
  'sd.noBurndown': ['No estimate — burndown unavailable.', 'Aucune estimation — burndown indisponible.', 'Nessuna stima — burndown non disponibile.', 'Keine Schätzung – Burndown nicht verfügbar.'],
};

export type ReportT = (key: string, params?: Record<string, string | number>) => string;

/** Build a translator bound to a language. Unknown keys return the key itself. */
export function reportT(lang: ReportLang): ReportT {
  const i = Math.max(0, LANGS.indexOf(lang));
  return (key, params) => {
    const entry = D[key];
    let s = entry ? entry[i] : key;
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        s = s.replace(new RegExp('\\{' + k + '\\}', 'g'), String(v));
      }
    }
    return s;
  };
}

/** Localized label for a raw TaskStatus enum value (falls back to the raw value). */
export function statusLabel(lang: ReportLang, status: string): string {
  const key = 'st.' + status;
  return D[key] ? reportT(lang)(key) : status;
}

const normLang = (v?: string | null): ReportLang | null => {
  if (!v) return null;
  const c = v.trim().slice(0, 2).toLowerCase();
  return (LANGS as string[]).includes(c) ? (c as ReportLang) : null;
};

/**
 * Resolve the export language: explicit `?lang=` first (the web UI passes the
 * user's current UI language), then `Accept-Language`, then English.
 */
export function pickReportLang(raw?: string | null, acceptLanguage?: string | null): ReportLang {
  const direct = normLang(raw);
  if (direct) return direct;
  if (acceptLanguage) {
    for (const part of acceptLanguage.split(',')) {
      const c = normLang(part.split(';')[0]);
      if (c) return c;
    }
  }
  return 'en';
}

/** Param decorator: `@CurrentLang() lang: ReportLang` on any export handler. */
export const CurrentLang = createParamDecorator((_data: unknown, ctx: ExecutionContext): ReportLang => {
  const req = ctx.switchToHttp().getRequest();
  const q = (req.query?.lang ?? null) as string | null;
  const accept = (req.headers?.['accept-language'] ?? null) as string | null;
  return pickReportLang(q, accept);
});
