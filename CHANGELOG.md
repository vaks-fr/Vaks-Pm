# Changelog

User-facing changes, most recent first.

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
