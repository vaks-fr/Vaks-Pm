/**
 * Corps des prompts, traduits.
 *
 * Séparé de `i18n.ts` (libellés courts du menu) pour que chacun reste lisible :
 * ici ce sont des textes longs, là des étiquettes.
 *
 * **Pourquoi les traduire alors que ce sont des instructions au modèle ?**
 * Parce que le client les **montre à l'utilisateur** — Claude affiche le texte
 * injecté comme une pièce jointe dépliable. Un utilisateur allemand verrait
 * sinon un pavé français. Seules les *descriptions de tools* restent en source
 * unique : elles, le modèle seul les lit.
 *
 * **Composition plutôt que duplication** : chaque prompt à argument fournit un
 * `lead` (« pour le projet X : ») et un `leadPick` (variante quand l'argument
 * est vide, précédée de `pick.*`), tous deux suivis du même `body`. Les
 * instructions longues ne sont donc écrites qu'une fois par langue.
 *
 * Les jetons `{project}`, `{person}`, `{brief}`, `{change}`, `{team}`, `{week}`
 * sont remplacés par `fmt()`.
 */

/** [en, fr, it, de] */
type Entry = [string, string, string, string];

export const P: Record<string, Entry> = {
  // ── Sélection en conversation quand l'argument est vide ──────────────────
  'pick.project': [
    "I did not specify a project. Ask me which one, in one short question. If I answer with a name or key, proceed directly — most project tools (e.g. `vaks_project_status`) resolve it themselves. Only call `vaks_list_projects` and show a NUMBERED LIST (key — name — status) if I ask to see all my projects, or if my answer is ambiguous. Once the project is known:",
    "Je n'ai pas précisé de projet. Demande-moi lequel, en une question courte. Si je réponds avec un nom ou une clé, poursuis directement — la plupart des tools projet (ex. `vaks_project_status`) le résolvent eux-mêmes. N'appelle `vaks_list_projects` (LISTE NUMÉROTÉE clé — nom — statut) que si je demande à voir tous mes projets, ou si ma réponse est ambiguë. Une fois le projet connu :",
    "Non ho indicato un progetto. Chiedimi quale, con una domanda breve. Se rispondo con un nome o una chiave, procedi direttamente — la maggior parte dei tool di progetto (es. `vaks_project_status`) lo risolve da sé. Chiama `vaks_list_projects` (ELENCO NUMERATO chiave — nome — stato) solo se chiedo di vedere tutti i miei progetti, o se la mia risposta è ambigua. Una volta noto il progetto:",
    'Ich habe kein Projekt angegeben. Frage mich, welches, mit einer kurzen Frage. Antworte ich mit Name oder Schlüssel, fahre direkt fort — die meisten Projekt-Tools (z. B. `vaks_project_status`) lösen das selbst auf. Rufe `vaks_list_projects` (NUMMERIERTE LISTE Schlüssel — Name — Status) nur auf, wenn ich alle meine Projekte sehen möchte oder meine Antwort mehrdeutig ist. Sobald das Projekt bekannt ist:',
  ],
  'pick.person': [
    "I did not specify a person. First call `vaks_read` on `users`, show me the people as a NUMBERED LIST (name — email) and wait for my choice. Do not move on to anything else before I answer. Once the person is chosen:",
    "Je n'ai pas précisé de personne. Commence par appeler `vaks_read` sur `users`, présente-moi les personnes en LISTE NUMÉROTÉE (nom — email) et attends que je choisisse. N'enchaîne sur rien d'autre avant ma réponse. Une fois la personne choisie :",
    "Non ho indicato una persona. Inizia chiamando `vaks_read` su `users`, mostrami le persone in ELENCO NUMERATO (nome — email) e aspetta la mia scelta. Non proseguire con altro prima della mia risposta. Una volta scelta la persona:",
    'Ich habe keine Person angegeben. Rufe zuerst `vaks_read` auf `users` auf, zeige mir die Personen als NUMMERIERTE LISTE (Name — E-Mail) und warte auf meine Wahl. Fahre vorher mit nichts anderem fort. Sobald die Person gewählt ist:',
  ],

  // ── Pilotage · radar de risque ───────────────────────────────────────────
  'pilot_risk_radar.body': [
    'Analyse my project portfolio and produce a PRIORITISED list of risks. Method: `vaks_list_projects` (scope all) to spot the hot projects (late, deadlines approaching, blocked status), then dig into each with `vaks_get_project_health`, `vaks_get_workload` (overload) and `vaks_get_skill_gap` (coverage). Follow exactly the format below, one line per risk, most severe first.',
    'Analyse mon portefeuille de projets et dresse une liste PRIORISÉE des risques. Méthode : `vaks_list_projects` (scope all) pour repérer les projets chauds (en retard, échéances proches, statut bloqué), puis pour chacun approfondis avec `vaks_get_project_health`, `vaks_get_workload` (surcharge) et `vaks_get_skill_gap` (couverture). Respecte exactement le format ci-dessous, une ligne par risque, du plus grave au moins grave.',
    'Analizza il mio portfolio di progetti e stila un elenco di rischi in ordine di PRIORITÀ. Metodo: `vaks_list_projects` (scope all) per individuare i progetti critici (in ritardo, scadenze vicine, stato bloccato), poi approfondisci ciascuno con `vaks_get_project_health`, `vaks_get_workload` (sovraccarico) e `vaks_get_skill_gap` (copertura). Rispetta esattamente il formato qui sotto, una riga per rischio, dal più grave al meno grave.',
    'Analysiere mein Projektportfolio und erstelle eine PRIORISIERTE Risikoliste. Vorgehen: `vaks_list_projects` (scope all), um kritische Projekte zu finden (verspätet, nahe Fristen, blockierter Status), dann jedes vertiefen mit `vaks_get_project_health`, `vaks_get_workload` (Überlast) und `vaks_get_skill_gap` (Abdeckung). Halte dich exakt an das Format unten, eine Zeile pro Risiko, vom schwersten zum leichtesten.',
  ],
  'pilot_risk_radar.skel': [
    '## Risk radar — portfolio\n\n| Project | Type | Severity | Finding | Recommended action |\n|---|---|---|---|---|\n',
    '## Radar de risque — portefeuille\n\n| Projet | Nature | Gravité | Constat | Action recommandée |\n|---|---|---|---|---|\n',
    '## Radar dei rischi — portfolio\n\n| Progetto | Natura | Gravità | Constatazione | Azione consigliata |\n|---|---|---|---|---|\n',
    '## Risiko-Radar — Portfolio\n\n| Projekt | Art | Schweregrad | Befund | Empfohlene Maßnahme |\n|---|---|---|---|---|\n',
  ],

  // ── Pilotage · revues en attente ─────────────────────────────────────────
  'pilot_pending_reviews.body': [
    'Give me the picture of what is waiting for my review. Call `vaks_read` on `me/pending-reviews` — the queue contains ONLY deliverables I can actually approve (never my own), oldest first, with `waitingDays` and `authorKind` (human or AI agent). Show me a PRIORITISED table (age first, then agent deliverables blocking a task), and state explicitly if the response is truncated (`truncated`). For the 3 most urgent, open the detail with `vaks_get_task` and `vaks_get_verification_requirements` so I know what to check before deciding. Do not make any review decision yourself: you prepare, I decide.',
    "Fais le point sur ce qui attend ma revue. Appelle `vaks_read` sur `me/pending-reviews` — la file ne contient QUE les livrables que je peux réellement approuver (jamais les miens), les plus anciens en tête, avec `waitingDays` et `authorKind` (humain ou agent IA). Présente-moi un tableau PRIORISÉ (ancienneté d'abord, puis livrables d'agents qui bloquent une tâche), et signale explicitement si la réponse est tronquée (`truncated`). Pour les 3 plus urgents, ouvre le détail avec `vaks_get_task` et `vaks_get_verification_requirements` afin que je sache quoi vérifier avant de trancher. Ne rends aucune décision de revue toi-même : tu prépares, je décide.",
    "Fai il punto su ciò che attende la mia revisione. Chiama `vaks_read` su `me/pending-reviews` — la coda contiene SOLO i deliverable che posso davvero approvare (mai i miei), i più vecchi per primi, con `waitingDays` e `authorKind` (umano o agente IA). Mostrami una tabella in ordine di PRIORITÀ (prima l'anzianità, poi i deliverable di agenti che bloccano un'attività) e segnala esplicitamente se la risposta è troncata (`truncated`). Per i 3 più urgenti, apri il dettaglio con `vaks_get_task` e `vaks_get_verification_requirements` così saprò cosa verificare prima di decidere. Non prendere alcuna decisione di revisione: tu prepari, io decido.",
    'Gib mir den Überblick, was auf meine Prüfung wartet. Rufe `vaks_read` auf `me/pending-reviews` auf — die Warteschlange enthält NUR Ergebnisse, die ich wirklich freigeben kann (niemals meine eigenen), älteste zuerst, mit `waitingDays` und `authorKind` (Mensch oder KI-Agent). Zeige mir eine PRIORISIERTE Tabelle (zuerst Alter, dann Agenten-Ergebnisse, die eine Aufgabe blockieren) und weise ausdrücklich darauf hin, wenn die Antwort gekürzt ist (`truncated`). Öffne für die 3 dringendsten das Detail mit `vaks_get_task` und `vaks_get_verification_requirements`, damit ich weiß, was ich vor der Entscheidung prüfen muss. Triff selbst keine Prüfentscheidung: du bereitest vor, ich entscheide.',
  ],

  // ── Projet · rapport de statut ───────────────────────────────────────────
  'project_status_report.lead': [
    'Write a clear status report for project « {project} »:',
    'Rédige un rapport de statut clair pour le projet « {project} » :',
    'Redigi un rapporto di stato chiaro per il progetto « {project} »:',
    'Verfasse einen klaren Statusbericht für das Projekt „{project}":',
  ],
  'project_status_report.leadPick': [
    'write a clear status report —',
    'rédige un rapport de statut clair —',
    'redigi un rapporto di stato chiaro —',
    'verfasse einen klaren Statusbericht —',
  ],
  'project_status_report.body': [
    "call `vaks_project_status` with the project's name — it resolves the id and returns stats, due-date adherence, tasks in the window, and workload in a SINGLE call. Factual tone, ready to share. Follow exactly the structure started below.",
    "appelle `vaks_project_status` avec le nom du projet — il résout l'id et renvoie stats, respect des échéances, tâches de la fenêtre et charge en UN SEUL appel. Ton factuel, prêt à partager. Respecte exactement la structure amorcée ci-dessous.",
    "chiama `vaks_project_status` con il nome del progetto — risolve l'id e restituisce statistiche, rispetto delle scadenze, attività nella finestra e carico di lavoro in UN'UNICA chiamata. Tono fattuale, pronto da condividere. Rispetta esattamente la struttura avviata qui sotto.",
    'rufe `vaks_project_status` mit dem Projektnamen auf — er löst die id auf und liefert Statistiken, Fristentreue, Aufgaben im Zeitfenster und Auslastung in EINEM EINZIGEN Aufruf. Sachlicher Ton, teilbereit. Halte dich exakt an die unten begonnene Struktur.',
  ],
  'project_status_report.skel': [
    '## Status report\n\n**Project** · **Period** · **Overall status** (🟢 / 🟠 / 🔴)\n\n### Progress\n\n### Milestones & deadlines\n\n### Risks & blockers\n\n### Next steps\n\n',
    '## Rapport de statut\n\n**Projet** · **Période** · **Statut global** (🟢 / 🟠 / 🔴)\n\n### Avancement\n\n### Jalons & échéances\n\n### Risques & blocages\n\n### Prochaines étapes\n\n',
    '## Rapporto di stato\n\n**Progetto** · **Periodo** · **Stato generale** (🟢 / 🟠 / 🔴)\n\n### Avanzamento\n\n### Milestone e scadenze\n\n### Rischi e blocchi\n\n### Prossimi passi\n\n',
    '## Statusbericht\n\n**Projekt** · **Zeitraum** · **Gesamtstatus** (🟢 / 🟠 / 🔴)\n\n### Fortschritt\n\n### Meilensteine & Fristen\n\n### Risiken & Blocker\n\n### Nächste Schritte\n\n',
  ],

  // ── Projet · lancer depuis un brief ──────────────────────────────────────
  'project_bootstrap.body': [
    "Here is a project brief:\n\n{brief}\n\nHelp me launch it in Vaks-PM, step by step, showing me each proposal BEFORE writing anything:\n1. Propose 2 or 3 pairs (short key in 2-3 capitals + name), let me choose, then create the project via `vaks_create_project`.\n2. Break the brief into concrete tasks (title, estimate in hours, possible milestones). Propose 2 distinct breakdowns — for instance a fine-grained one for tracking, and a broader one for delivery — then create the chosen one in bulk via `vaks_create_tasks`.\n3. Propose the key dependencies between tasks via `vaks_dependencies_manage`.\n4. Propose staffing (skills + real availability) via `vaks_get_skill_gap` / `vaks_suggest_assignees` then a preview `vaks_plan_project_preview` — WITHOUT applying.\nAt every step, expose the trade-off of each option (cost / time / risk) and wait for my choice before writing.",
    "Voici un brief de projet :\n\n{brief}\n\nAide-moi à le lancer dans Vaks-PM, étape par étape, en me montrant chaque proposition AVANT d'écrire :\n1. Propose 2 ou 3 couples (clé courte en 2-3 majuscules + nom), laisse-moi choisir, puis crée le projet via `vaks_create_project`.\n2. Décompose le brief en tâches concrètes (titre, estimé en heures, jalons éventuels). Propose-moi 2 découpages distincts — par exemple un découpage fin orienté suivi, et un découpage large orienté livraison — puis crée le retenu en lot via `vaks_create_tasks`.\n3. Propose les dépendances clés entre tâches via `vaks_dependencies_manage`.\n4. Propose un staffing (compétences + disponibilité réelle) via `vaks_get_skill_gap` / `vaks_suggest_assignees` puis un aperçu `vaks_plan_project_preview` — SANS appliquer.\nÀ chaque étape, expose l'arbitrage de chaque option (coût / délai / risque) et attends mon choix avant d'écrire.",
    "Ecco un brief di progetto:\n\n{brief}\n\nAiutami a avviarlo in Vaks-PM, passo dopo passo, mostrandomi ogni proposta PRIMA di scrivere:\n1. Proponi 2 o 3 coppie (chiave breve in 2-3 maiuscole + nome), fammi scegliere, poi crea il progetto con `vaks_create_project`.\n2. Scomponi il brief in attività concrete (titolo, stima in ore, eventuali milestone). Proponimi 2 suddivisioni distinte — ad esempio una fine orientata al monitoraggio e una ampia orientata alla consegna — poi crea quella scelta in blocco con `vaks_create_tasks`.\n3. Proponi le dipendenze chiave tra attività con `vaks_dependencies_manage`.\n4. Proponi l'assegnazione di risorse (competenze + disponibilità reale) con `vaks_get_skill_gap` / `vaks_suggest_assignees` poi un'anteprima `vaks_plan_project_preview` — SENZA applicare.\nA ogni passo, esponi il compromesso di ciascuna opzione (costo / tempi / rischio) e attendi la mia scelta prima di scrivere.",
    'Hier ist ein Projekt-Briefing:\n\n{brief}\n\nHilf mir, es in Vaks-PM zu starten, Schritt für Schritt, und zeige mir jeden Vorschlag, BEVOR du schreibst:\n1. Schlage 2 oder 3 Paare vor (kurzer Schlüssel aus 2-3 Großbuchstaben + Name), lass mich wählen, dann erstelle das Projekt über `vaks_create_project`.\n2. Zerlege das Briefing in konkrete Aufgaben (Titel, Schätzung in Stunden, mögliche Meilensteine). Schlage mir 2 unterschiedliche Aufteilungen vor — etwa eine feine zur Nachverfolgung und eine grobe zur Lieferung — und erstelle dann die gewählte gebündelt über `vaks_create_tasks`.\n3. Schlage die wichtigsten Abhängigkeiten zwischen Aufgaben über `vaks_dependencies_manage` vor.\n4. Schlage eine Besetzung vor (Fähigkeiten + echte Verfügbarkeit) über `vaks_get_skill_gap` / `vaks_suggest_assignees`, dann eine Vorschau `vaks_plan_project_preview` — OHNE anzuwenden.\nLege bei jedem Schritt die Abwägung jeder Option offen (Kosten / Zeit / Risiko) und warte auf meine Wahl, bevor du schreibst.',
  ],

  // ── Projet · clôturer ────────────────────────────────────────────────────
  'project_close.lead': [
    'Help me cleanly close project « {project} »:',
    'Aide-moi à clôturer proprement le projet « {project} » :',
    'Aiutami a chiudere correttamente il progetto « {project} »:',
    'Hilf mir, das Projekt „{project}" sauber abzuschließen:',
  ],
  'project_close.leadPick': [
    'help me close it cleanly —',
    'aide-moi à le clôturer proprement —',
    'aiutami a chiuderlo correttamente —',
    'hilf mir, es sauber abzuschließen —',
  ],
  'project_close.body': [
    "get the id via `vaks_list_projects`, then draw up a CLOSE-OUT CHECKLIST before any write: (a) still-open tasks via `vaks_list_project_tasks` — which block closing, which can be dropped; (b) deliverables still awaiting review via `vaks_read` on `me/pending-reviews`; (c) health and deadlines via `vaks_get_project_health`; (d) skills actually used via `vaks_get_skill_gap`, to flag the levels to update. Present the checklist with, for each blocking point, 2 options (handle now / close anyway) and their consequence. Only call `vaks_update_project` with status COMPLETED after my explicit approval, as the very last step.",
    "récupère l'id via `vaks_list_projects`, puis dresse une CHECKLIST DE CLÔTURE avant toute écriture : (a) tâches encore ouvertes via `vaks_list_project_tasks` — lesquelles bloquent la clôture, lesquelles peuvent être abandonnées ; (b) livrables encore en attente de revue via `vaks_read` sur `me/pending-reviews` ; (c) santé et échéances via `vaks_get_project_health` ; (d) compétences réellement mobilisées via `vaks_get_skill_gap`, pour signaler les niveaux à mettre à jour. Présente la checklist avec, pour chaque point bloquant, 2 options (traiter maintenant / clôturer malgré tout) et leur conséquence. N'appelle `vaks_update_project` avec le statut COMPLETED qu'après ma validation explicite, en tout dernier.",
    "recupera l'id con `vaks_list_projects`, poi stila una CHECKLIST DI CHIUSURA prima di qualsiasi scrittura: (a) attività ancora aperte con `vaks_list_project_tasks` — quali bloccano la chiusura, quali si possono abbandonare; (b) deliverable ancora in attesa di revisione con `vaks_read` su `me/pending-reviews`; (c) salute e scadenze con `vaks_get_project_health`; (d) competenze realmente impiegate con `vaks_get_skill_gap`, per segnalare i livelli da aggiornare. Presenta la checklist con, per ogni punto bloccante, 2 opzioni (trattare ora / chiudere comunque) e la relativa conseguenza. Chiama `vaks_update_project` con stato COMPLETED solo dopo la mia approvazione esplicita, come ultimissimo passo.",
    'hole die id über `vaks_list_projects` und erstelle dann eine ABSCHLUSS-CHECKLISTE vor jedem Schreibvorgang: (a) noch offene Aufgaben über `vaks_list_project_tasks` — welche den Abschluss blockieren, welche entfallen können; (b) Ergebnisse, die noch auf Prüfung warten, über `vaks_read` auf `me/pending-reviews`; (c) Gesundheit und Fristen über `vaks_get_project_health`; (d) tatsächlich eingesetzte Fähigkeiten über `vaks_get_skill_gap`, um die zu aktualisierenden Niveaus zu melden. Zeige die Checkliste mit je 2 Optionen pro Blockadepunkt (jetzt behandeln / trotzdem abschließen) und deren Folge. Rufe `vaks_update_project` mit Status COMPLETED erst nach meiner ausdrücklichen Freigabe auf, ganz zuletzt.',
  ],

  // ── Projet · annoncer un changement ──────────────────────────────────────
  'project_announce.lead': [
    'I want to inform the stakeholders of project « {project} » about this change:\n\n{change}\n\nSteps:',
    'Je veux prévenir les parties prenantes du projet « {project} » de ce changement :\n\n{change}\n\nÉtapes :',
    'Voglio informare gli stakeholder del progetto « {project} » di questo cambiamento:\n\n{change}\n\nPassaggi:',
    'Ich möchte die Beteiligten des Projekts „{project}" über diese Änderung informieren:\n\n{change}\n\nSchritte:',
  ],
  'project_announce.leadPick': [
    'I want to inform the stakeholders of a project about this change:\n\n{change}\n\n',
    "Je veux prévenir les parties prenantes d'un projet de ce changement :\n\n{change}\n\n",
    'Voglio informare gli stakeholder di un progetto di questo cambiamento:\n\n{change}\n\n',
    'Ich möchte die Beteiligten eines Projekts über diese Änderung informieren:\n\n{change}\n\n',
  ],
  'project_announce.body': [
    "find the project id via `vaks_list_projects`, then draft the announcement — a title (≤ 200 characters) and a plain-text body: the change, its impact, the next step. Propose 2 to 3 DISTINCT versions of the text (for instance one factual and brief, one more explanatory about impact, one reassuring) AND the recommended audience for each (`pm`, `sponsors`, `members`, `watchers` — default pm + sponsors). Wait for me to choose a version and approve BEFORE sending via `vaks_notify_stakeholders`. The email will go out attributed to my name.",
    "retrouve l'id du projet via `vaks_list_projects`, puis rédige l'annonce — un titre (≤ 200 caractères) et un corps en texte brut : le changement, son impact, la prochaine étape. Propose-moi 2 à 3 VERSIONS distinctes du texte (par exemple une factuelle et brève, une plus explicative sur l'impact, une orientée rassurance) ET l'audience recommandée pour chacune (`pm`, `sponsors`, `members`, `watchers` — par défaut pm + sponsors). Attends que je choisisse une version et que je valide AVANT d'envoyer via `vaks_notify_stakeholders`. L'email partira avec mon nom en attribution.",
    "trova l'id del progetto con `vaks_list_projects`, poi redigi l'annuncio — un titolo (≤ 200 caratteri) e un corpo in testo semplice: il cambiamento, il suo impatto, il passo successivo. Proponimi 2 o 3 VERSIONI distinte del testo (ad esempio una fattuale e breve, una più esplicativa sull'impatto, una rassicurante) E il pubblico consigliato per ciascuna (`pm`, `sponsors`, `members`, `watchers` — predefinito pm + sponsors). Aspetta che io scelga una versione e approvi PRIMA di inviare con `vaks_notify_stakeholders`. L'email partirà a mio nome.",
    'finde die Projekt-id über `vaks_list_projects` und verfasse dann die Ankündigung — einen Titel (≤ 200 Zeichen) und einen Fließtext: die Änderung, ihre Auswirkung, den nächsten Schritt. Schlage mir 2 bis 3 UNTERSCHIEDLICHE Textfassungen vor (etwa eine sachlich-kurze, eine ausführlichere zur Auswirkung, eine beruhigende) UND jeweils die empfohlene Zielgruppe (`pm`, `sponsors`, `members`, `watchers` — Standard pm + sponsors). Warte, bis ich eine Fassung gewählt und freigegeben habe, BEVOR du über `vaks_notify_stakeholders` sendest. Die E-Mail geht unter meinem Namen raus.',
  ],

  // ── Équipe · trouver du travail ──────────────────────────────────────────
  'team_find_work.lead': [
    'Find projects and tasks that suit « {person} »:',
    'Trouve des projets et tâches adaptés à « {person} » :',
    'Trova progetti e attività adatti a « {person} »:',
    'Finde Projekte und Aufgaben, die zu „{person}" passen:',
  ],
  'team_find_work.leadPick': [
    'find suitable projects and tasks for them —',
    'trouve-lui des projets et tâches adaptés —',
    'trovale progetti e attività adatti —',
    'finde passende Projekte und Aufgaben für sie —',
  ],
  'team_find_work.body': [
    'get their skills via `vaks_get_user_skills`, their load via `vaks_get_workload`, then cross-reference with `vaks_get_skill_gap` of active projects to propose where they would add the most value without being overloaded.',
    'récupère ses compétences via `vaks_get_user_skills`, sa charge via `vaks_get_workload`, puis croise avec `vaks_get_skill_gap` des projets actifs pour proposer où elle apporterait le plus de valeur sans être surchargée.',
    'recupera le sue competenze con `vaks_get_user_skills`, il suo carico con `vaks_get_workload`, poi incrocia con `vaks_get_skill_gap` dei progetti attivi per proporre dove porterebbe più valore senza essere sovraccaricata.',
    'hole ihre Fähigkeiten über `vaks_get_user_skills`, ihre Auslastung über `vaks_get_workload` und gleiche dann mit `vaks_get_skill_gap` der aktiven Projekte ab, um vorzuschlagen, wo sie den größten Mehrwert bringt, ohne überlastet zu werden.',
  ],

  // ── Équipe · staffer un projet ───────────────────────────────────────────
  'team_staff_project.lead': [
    'Propose staffing for project « {project} »:',
    'Propose un staffing pour le projet « {project} » :',
    'Proponi le risorse per il progetto « {project} »:',
    'Schlage eine Besetzung für das Projekt „{project}" vor:',
  ],
  'team_staff_project.leadPick': [
    'propose staffing —',
    'propose un staffing —',
    'proponi le risorse —',
    'schlage eine Besetzung vor —',
  ],
  'team_staff_project.body': [
    "get the id via `vaks_list_projects`, coverage via `vaks_get_skill_gap`, candidates per task via `vaks_suggest_assignees`, and a plan preview via `vaks_plan_project_preview` (apply NOTHING). Show me 2 to 3 DISTINCT staffing options — for instance a tight team, a load spread more widely, reinforcement on the missing skills — and for each: who does what, the load per person, the delivery window, the warnings, and its trade-off (cost / time / risk). Ask me to CHOOSE an option, then for my approval, BEFORE applying via `vaks_plan_project_apply`.",
    "récupère l'id via `vaks_list_projects`, la couverture via `vaks_get_skill_gap`, les candidats par tâche via `vaks_suggest_assignees`, et un aperçu de plan via `vaks_plan_project_preview` (n'applique RIEN). Présente-moi 2 à 3 options de staffing DISTINCTES — par exemple une équipe resserrée, une charge répartie plus largement, un renfort sur les compétences manquantes — et pour chacune : qui fait quoi, la charge par personne, la fenêtre de réalisation, les alertes, et son arbitrage (coût / délai / risque). Demande-moi de CHOISIR une option, puis ma validation, AVANT d'appliquer via `vaks_plan_project_apply`.",
    "recupera l'id con `vaks_list_projects`, la copertura con `vaks_get_skill_gap`, i candidati per attività con `vaks_suggest_assignees` e un'anteprima di piano con `vaks_plan_project_preview` (NON applicare nulla). Mostrami 2 o 3 opzioni di assegnazione DISTINTE — ad esempio una squadra ristretta, un carico distribuito più ampiamente, un rinforzo sulle competenze mancanti — e per ciascuna: chi fa cosa, il carico per persona, la finestra di realizzazione, gli avvisi e il compromesso (costo / tempi / rischio). Chiedimi di SCEGLIERE un'opzione, poi la mia approvazione, PRIMA di applicare con `vaks_plan_project_apply`.",
    'hole die id über `vaks_list_projects`, die Abdeckung über `vaks_get_skill_gap`, die Kandidaten je Aufgabe über `vaks_suggest_assignees` und eine Planvorschau über `vaks_plan_project_preview` (wende NICHTS an). Zeige mir 2 bis 3 UNTERSCHIEDLICHE Besetzungsoptionen — etwa ein kleines Team, eine breiter verteilte Last, Verstärkung bei fehlenden Fähigkeiten — und je Option: wer macht was, Last pro Person, Umsetzungsfenster, Warnungen und die Abwägung (Kosten / Zeit / Risiko). Bitte mich, eine Option zu WÄHLEN, dann um meine Freigabe, BEVOR du über `vaks_plan_project_apply` anwendest.',
  ],

  // ── Équipe · onboarder ───────────────────────────────────────────────────
  'team_onboard.lead': [
    'Help me onboard « {person} »:{team}',
    'Aide-moi à onboarder « {person} » :{team}',
    'Aiutami a inserire « {person} »:{team}',
    'Hilf mir, „{person}" einzuarbeiten:{team}',
  ],
  'team_onboard.leadPick': [
    'help me onboard them —{team}',
    "aide-moi à l'onboarder —{team}",
    'aiutami a inserirla —{team}',
    'hilf mir, sie einzuarbeiten —{team}',
  ],
  'team_onboard.team': [
    ' The target team is « {team} ».',
    " L'équipe visée est « {team} ».",
    ' Il team di destinazione è « {team} ».',
    ' Das Ziel-Team ist „{team}".',
  ],
  'team_onboard.body': [
    "take stock via `vaks_get_user_skills` (what they already know) and `vaks_get_workload` (their real capacity), then list the teams via `vaks_list_teams`. Propose to me, BEFORE any write: (a) 2 or 3 candidate teams with the reason for the attachment; (b) the skills to declare with their level, based on the `TeamSkill` of the target team; (c) a realistic first assignment via `vaks_suggest_assignees` on unstaffed tasks. Wait for my choice, then apply in this order: `vaks_teams_manage` (action `add_member`), `vaks_skills_assign` (action `set_user`) for each retained skill, and finally `vaks_update_task`. Never invent a skill level: if you do not have the information, ask me rather than declaring it.",
    "fais le point via `vaks_get_user_skills` (ce qu'elle sait déjà) et `vaks_get_workload` (sa capacité réelle), puis liste les équipes via `vaks_list_teams`. Propose-moi, AVANT toute écriture : (a) 2 ou 3 équipes candidates avec la raison du rattachement ; (b) les compétences à déclarer avec leur niveau, en te basant sur les `TeamSkill` de l'équipe visée ; (c) une première mission réaliste via `vaks_suggest_assignees` sur des tâches non pourvues. Attends mon choix, puis applique dans cet ordre : `vaks_teams_manage` (action `add_member`), `vaks_skills_assign` (action `set_user`) pour chaque compétence retenue, et enfin `vaks_update_task`. N'invente jamais un niveau de compétence : si tu n'as pas l'information, propose-le-moi en question plutôt que de le déclarer.",
    "fai il punto con `vaks_get_user_skills` (ciò che già sa) e `vaks_get_workload` (la sua capacità reale), poi elenca i team con `vaks_list_teams`. Proponimi, PRIMA di qualsiasi scrittura: (a) 2 o 3 team candidati con la ragione dell'assegnazione; (b) le competenze da dichiarare con il relativo livello, basandoti sui `TeamSkill` del team di destinazione; (c) una prima missione realistica con `vaks_suggest_assignees` su attività scoperte. Attendi la mia scelta, poi applica in quest'ordine: `vaks_teams_manage` (action `add_member`), `vaks_skills_assign` (action `set_user`) per ogni competenza scelta e infine `vaks_update_task`. Non inventare mai un livello di competenza: se non hai l'informazione, chiedimelo invece di dichiararlo.",
    'verschaffe dir einen Überblick über `vaks_get_user_skills` (was sie bereits kann) und `vaks_get_workload` (ihre echte Kapazität), liste dann die Teams über `vaks_list_teams` auf. Schlage mir VOR jedem Schreibvorgang vor: (a) 2 oder 3 Kandidaten-Teams mit Begründung der Zuordnung; (b) die zu erfassenden Fähigkeiten mit Niveau, gestützt auf die `TeamSkill` des Ziel-Teams; (c) eine realistische erste Aufgabe über `vaks_suggest_assignees` auf unbesetzten Aufgaben. Warte auf meine Wahl und wende dann in dieser Reihenfolge an: `vaks_teams_manage` (action `add_member`), `vaks_skills_assign` (action `set_user`) für jede gewählte Fähigkeit und zuletzt `vaks_update_task`. Erfinde niemals ein Fähigkeitsniveau: fehlt dir die Information, frage mich, statt es zu erfassen.',
  ],

  // ── Finance · audit de budget ────────────────────────────────────────────
  'finance_budget_audit.lead': [
    'Run the budget audit of project « {project} »:',
    "Fais l'audit budgétaire du projet « {project} » :",
    "Esegui l'audit di budget del progetto « {project} »:",
    'Führe das Budget-Audit des Projekts „{project}" durch:',
  ],
  'finance_budget_audit.leadPick': [
    'run its budget audit —',
    "fais-en l'audit budgétaire —",
    'eseguine l’audit di budget —',
    'führe dessen Budget-Audit durch —',
  ],
  'finance_budget_audit.body': [
    "get the id via `vaks_list_projects`, then read `vaks_read` on `projects/<id>/budget-summary` (budget, spend, forecast) and on `projects/<id>/evm` (earned value: SPI/CPI), complete with `vaks_list_expenses`. ⚠️ These financial reads are subject to the organisation setting `mcp.allowFinance`: if you get a 403, tell me plainly rather than trying to reconstruct the amounts some other way. Present: budget vs spend vs forecast, the variance and its trend, the cost lines that are drifting, and 2 to 3 quantified corrective levers with their impact. Read-only — do not modify budget or rates.",
    "récupère l'id via `vaks_list_projects`, puis lis `vaks_read` sur `projects/<id>/budget-summary` (budget, consommé, prévisionnel) et sur `projects/<id>/evm` (valeur acquise : SPI/CPI), complète avec `vaks_list_expenses`. ⚠️ Ces lectures financières sont soumises au réglage d'organisation `mcp.allowFinance` : si tu reçois un 403, dis-le-moi clairement plutôt que d'essayer de reconstituer les montants autrement. Présente : budget vs consommé vs prévisionnel, écart et sa tendance, postes de dépense qui dérivent, et 2 à 3 leviers de correction chiffrés avec leur impact. Lecture seule — ne modifie ni budget ni taux.",
    "recupera l'id con `vaks_list_projects`, poi leggi `vaks_read` su `projects/<id>/budget-summary` (budget, speso, previsione) e su `projects/<id>/evm` (valore acquisito: SPI/CPI), completa con `vaks_list_expenses`. ⚠️ Queste letture finanziarie dipendono dall'impostazione di organizzazione `mcp.allowFinance`: se ricevi un 403, dimmelo chiaramente invece di provare a ricostruire gli importi in altro modo. Presenta: budget vs speso vs previsione, scostamento e tendenza, voci di spesa che derivano e 2 o 3 leve correttive quantificate con il loro impatto. Sola lettura — non modificare né budget né tariffe.",
    'hole die id über `vaks_list_projects`, lies dann `vaks_read` auf `projects/<id>/budget-summary` (Budget, Verbrauch, Prognose) und auf `projects/<id>/evm` (Earned Value: SPI/CPI), ergänze mit `vaks_list_expenses`. ⚠️ Diese Finanzabfragen unterliegen der Organisationseinstellung `mcp.allowFinance`: bei einem 403 sage es mir klar, statt die Beträge anders zu rekonstruieren. Zeige: Budget vs. Verbrauch vs. Prognose, Abweichung und Trend, abdriftende Kostenpositionen sowie 2 bis 3 bezifferte Korrekturhebel mit ihrer Wirkung. Nur lesend — ändere weder Budget noch Sätze.',
  ],

  // ── Temps · rattrapage timesheet ─────────────────────────────────────────
  'time_timesheet_catchup.body': [
    "Help me catch up my timesheet{week}. Read it via `vaks_read` on `timesheet` with the `from` and `to` parameters (window capped at 92 days). The timesheet is strictly personal: it only ever returns mine. Compare, day by day, capacity against time actually logged and spot the EMPTY DAYS — ignoring weekends, time off and public holidays, where capacity is zero. For each empty day, propose plausible entries drawn from my current tasks (`vaks_list_my_tasks`), with the suggested duration and the reason. Show me all of it as a summary table and wait for my approval: only call `vaks_time_entries` (action `log`) after I agree, and never on a day that is already full.",
    "Aide-moi à rattraper ma timesheet{week}. Lis-la via `vaks_read` sur `timesheet` avec les paramètres `from` et `to` (fenêtre plafonnée à 92 jours). La timesheet est strictement personnelle : elle ne renvoie que la mienne. Compare, jour par jour, la capacité au temps réellement imputé et repère les JOURS CREUX — en ignorant week-ends, congés et jours fériés, où la capacité est nulle. Pour chaque jour creux, propose des imputations plausibles à partir de mes tâches en cours (`vaks_list_my_tasks`), avec la durée suggérée et la raison. Présente-moi le tout en tableau récapitulatif et attends ma validation : n'appelle `vaks_time_entries` (action `log`) qu'après mon accord, et jamais sur une journée déjà complète.",
    "Aiutami a recuperare il mio timesheet{week}. Leggilo con `vaks_read` su `timesheet` con i parametri `from` e `to` (finestra massima 92 giorni). Il timesheet è strettamente personale: restituisce solo il mio. Confronta, giorno per giorno, la capacità con il tempo effettivamente imputato e individua i GIORNI SCOPERTI — ignorando weekend, ferie e festività, dove la capacità è nulla. Per ogni giorno scoperto, proponi imputazioni plausibili a partire dalle mie attività in corso (`vaks_list_my_tasks`), con la durata suggerita e la ragione. Mostrami tutto in una tabella riepilogativa e attendi la mia approvazione: chiama `vaks_time_entries` (action `log`) solo dopo il mio consenso, e mai su una giornata già completa.",
    'Hilf mir, meine Zeiterfassung nachzutragen{week}. Lies sie über `vaks_read` auf `timesheet` mit den Parametern `from` und `to` (Fenster auf 92 Tage begrenzt). Die Zeiterfassung ist streng persönlich: sie liefert nur meine. Vergleiche Tag für Tag die Kapazität mit der tatsächlich gebuchten Zeit und finde die LEEREN TAGE — ohne Wochenenden, Abwesenheiten und Feiertage, an denen die Kapazität null ist. Schlage für jeden leeren Tag plausible Buchungen aus meinen laufenden Aufgaben vor (`vaks_list_my_tasks`), mit vorgeschlagener Dauer und Begründung. Zeige mir alles als Übersichtstabelle und warte auf meine Freigabe: rufe `vaks_time_entries` (action `log`) erst nach meiner Zustimmung auf und nie an einem bereits vollen Tag.',
  ],
  'time_timesheet_catchup.week': [
    ' for {week}',
    ' pour {week}',
    ' per {week}',
    ' für {week}',
  ],
  'time_timesheet_catchup.weekDefault': [
    ' for the current week',
    ' de la semaine en cours',
    ' della settimana corrente',
    ' für die laufende Woche',
  ],
};

/** Remplace les jetons `{x}` par leur valeur. Un jeton non fourni devient ''. */
export function fmt(s: string, vars: Record<string, string | undefined> = {}): string {
  return s.replace(/\{(\w+)\}/g, (_, k) => vars[k] ?? '');
}
