# Changelog

User-facing changes, most recent first.

## 2026-10-12-1 — 2026-10-12

### Risk register (RAID)
- New **Risks** tab on every project: a 5×5 probability × impact heatmap
  (click a cell to filter), an exposure summary by severity, and a sortable
  register with owner, score, status and mitigation.
- Risks can be **raised automatically**: a milestone at risk, a budget
  threshold being crossed or a forecast overrun opens (or updates) a risk on
  its own, and automatic risks that stay inactive are closed after 14 days.
  Your edits to status, owner and mitigation are never overwritten.

### Tasks & planning
- **Bulk edit**: from the List view, open an editable grid (status, assignee,
  due date, priority, estimate), select several tasks and apply changes in one
  go. Edits are kept as a draft until you click **Save** — or **Discard**.
- **Calendar**: a personal calendar card on the dashboard and a calendar tab
  on each project, showing due dates and milestones.
- **Calendar subscription (ICS)**: subscribe to your own tasks from Outlook,
  Google Calendar or Apple Calendar with a private feed link.
- **Planning (Gantt)**: Week and Month modes now fit the screen exactly with no
  stray horizontal scroll, and short custom ranges fill the whole width.
- When two reviewers decide on the same task at the same moment, the second
  one now gets a clear conflict message instead of both decisions applying.

### Documents
- **In-app preview** of Markdown and text files (`.md`, `.txt`, `.csv`,
  `.json`, `.yaml`…) for project documents, agent deliverables and task
  attachments — no download needed.
- Fixed: downloading a file whose name contains accents or emoji failed.

### Reports & finance
- Burndown and Cumulative Flow charts now stop at today instead of drawing a
  flat "actual" line into the future.
- Fixed clipped axis labels on the Earned Value and monthly cost/revenue
  charts for large amounts.
- **Finance by client**: client names are visible again (the column had
  collapsed), including the "Internal / no client" row.
- The cost breakdown no longer shows a phantom 1.00 forecast when a project
  has no costs; long KPI card titles wrap instead of overflowing.
- Workload: the subtitle no longer says "this week" when browsing another week.
- Statistics exports now include the AI-agent task statuses.

### AI agents & AI connector (MCP)
- AI agents automatically inherit access to the projects of their human
  owner (limited to projects where agents are enabled).
- AI connector error messages are now localized (English, French, Italian,
  German).
- Turning AI write access off (or back on) now also applies to existing AI
  connections, not only new ones.

### Administration & integrations
- New **personal access token policy**: choose who can create personal API
  tokens — everyone, administrators only, or nobody.
- Removing a user's seat now also stops their personal tokens and AI
  connections.
- SSO: when all seats are taken, users signing in for the first time are
  created as "seat pending" instead of being refused.
- **Slack** is now a webhook format (alongside Teams and generic JSON).
- New **metrics endpoint** for monitoring tools (Prometheus format,
  organization-scoped, `monitoring:read` scope).
- Microsoft Teams provisioning reports an invalid certificate as a
  configuration error instead of retrying endlessly.

### Fixes
- You are no longer signed out when the app is open in several browser tabs.
- Skill reminders now run for every organization in multi-tenant installs.

### Security & dependencies
- A broad security hardening pass and up-to-date third-party dependencies
  (no known vulnerable packages at release time).

### Upgrading a self-hosted install
- **Redis now requires a password.** On Docker Swarm, create the secret once
  before redeploying — `openssl rand -hex 32 | docker secret create redis_password -`
  (new installs get it from the bootstrap scripts). With Helm, `redis.auth` is
  enabled by default and the password is generated for you.

## 2026-08-16-2 — 2026-08-16

### Reports — redesigned KPI charts
- The Team KPI and project reports got a visual overhaul. The multi-project
  workload chart is now a sorted horizontal load view with a 100% marker and
  threshold colors; tasks-by-status are shown as per-member donuts; and the
  resource-utilization chart (billable vs operational) is now a clean, sorted
  horizontal share bar per person with a summary strip.
- The Earned Value chart now plots Earned Value alongside Planned and Actual
  cost, with a shaded cost-variance area (green when efficient, red when
  overspending).
- The Cumulative Flow chart is more readable: a clear date axis and a
  consistent height on any screen size.
- Task status colors now match the board everywhere (To do, In progress,
  In review, On hold, Done).
- Calmer empty states and metric cards (a ring gauge for utilization, mini-bars
  for logged vs allocated), with no more "alarming" red on neutral values.

### Notifications
- Durable in-app bell: notifications now persist across refreshes and offline
  periods, and cover the same events as email (assignments, mentions, status
  changes, due reminders, automations, project announcements, skill requests,
  admin alerts). Read state and history are synced to the server.

### Branding
- Your organization's logo now appears in the app itself — sidebar, mobile top
  bar and login screen — not just in emails, with a discreet "powered by
  Vaks-PM" footer. Falls back to the default mark when no custom logo is set.

### Fixes
- SSO (SAML): a configurable clock-skew tolerance fixes intermittent login
  failures caused by time drift between the identity provider and the host.
- SCIM provisioning: standards-compliant filter parsing (RFC 7644) prevents
  duplicate-account loops with identity providers such as Microsoft Entra.
- AI agents on the board: a task that is released or whose lease expires no
  longer stays stuck in the "In progress" column.
- Smaller board fixes: the filter bar no longer drifts when scrolling
  horizontally, the "New task" button opens the composer, and PERT/Timeline
  labels are clearer.

### Performance
- Faster rendering of the Kanban, Timeline, PERT and Workload views, and fewer
  redundant database queries across reports, finance and workload.

### Security & operations
- On-premise: encryption can now be enabled after installation on an
  already-running cluster (disks, database TLS, backups, overlay network),
  with a guided runbook.
- General security and reliability hardening.

## 2026-08-10-1 — 2026-08-10

### AI agents — cost tracking & management
- **Execution cost tracking**: track how much your AI agents cost to run —
  in tokens or in credits depending on the provider — with per-project and
  per-task attribution that feeds project budgets and P&L.
- **Model price catalog**: an up-to-date catalog of AI models and their prices
  (with an offline fallback) and official provider logos, so you can pick a
  model and see its rate at a glance.
- **Redesigned agent setup**: creating an agent is now a guided step-by-step
  wizard (provider → model → capabilities → cost); editing uses clear tabs, and
  the owner field is a searchable picker that scales to large directories.
- **Event-driven agent wake-up**: agents can be notified the moment a task is
  assigned or a review round is needed, instead of only polling — with capacity
  limits so an agent is never triggered beyond what it can actually take on.
- **Automatic cost for credit-billed agents** (e.g. Microsoft Copilot): Vaks now
  measures or estimates their run cost for you.

### Reports
- **Client status deck (PowerPoint)**: export a project status point as a
  ready-to-share .pptx, with a persisted project health status (red/amber/green).

### Board
- **Clearer agent statuses on the Kanban**: agent-specific task statuses (claimed,
  changes requested, approved…) now appear as sub-groups within their column.

### AI connector (MCP)
- **Microsoft Copilot Studio compatibility**: smoother authentication so the
  connector works cleanly with Copilot Studio.

### Fixes
- Restored the framing of the team and skill chips in a project's "Team & access" tab.
- AI agents now display their identity email in the admin and workspace views.
- The "Team KPI" navigation entry is shown only to team leads and administrators.

### Quality & security
- Security and reliability hardening.

## 2026-08-05-1 — 2026-08-05

### AI connector (MCP)
- **Simpler setup with Microsoft Copilot Studio**: you can now create a
  pre-registered OAuth client without entering a callback URL upfront (a
  standard default is applied), and edit a client's callback later without
  regenerating its secret.
- **Immediate disconnect**: turning the AI connector off now instantly cuts
  existing connections, not just new sign-ins.

### Quality & security
- Security and reliability hardening around the AI connector.
- Updated third-party dependencies to address reported vulnerabilities.

## 2026-08-03-4 — 2026-08-03

### Workload planning — major overhaul
- **Priorities now respected**: urgent, critical and deadline-driven tasks are scheduled first (previously the priority order was not actually applied to the plan).
- **Less scattering**: the planner groups work from the same project/skill so people aren't spread across too many fronts at once.
- **Realistic calendar**: durations skip weekends and public holidays; all **4 dependency types** (finish-to-start, start-to-start, finish-to-finish, start-to-finish) are now available in the Gantt.
- **Project-manager controls**: placement strategy (as-soon-as-possible / deadline-aware), a concentration slider (focused / balanced / spread), a planning horizon (3 months → whole project), "reschedule a single person", and applying only a partial selection of the plan.
- **Clearer plan**: translated, clickable warnings that open the task they refer to, a visual distinction between manual and auto-generated allocations, and a discreet "plan out of date" banner.
- **Absorbing the unexpected**: capacity now accounts for time actually logged; a "Free up today" action shifts a person's remaining work when an incident hits; and the project manager is alerted when a scheduled task whose window has passed never started.
- **AI agents in planning**: see an agent's load in its own unit (tasks in progress, review queue, budget) and get a qualified agent suggested for an unassigned task — always subject to human approval, never auto-assigned.

### Notifications
- **Teams provisioning failure alert**: after repeated failures, organization administrators are now notified (email + audit log).

### Quality & security
- Security and reliability hardening.
- Various usability improvements in the workload view.
