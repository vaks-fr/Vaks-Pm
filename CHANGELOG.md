# Changelog

User-facing changes, most recent first.

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
