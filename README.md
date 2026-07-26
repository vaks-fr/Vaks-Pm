# Vaks-PM

**Fully self-hostable (on-premise), multi-user project-management platform, built for organizations of 200+ people.**
*API-first, multi-tenant, with AI agents as first-class actors.*

Kanban · task lists · Gantt (dependencies, critical path) · time tracking &
reporting · weekly timesheets · workload management (capacity) · per-country public
holidays · comments & @mentions · attachments · email notifications · REST API + webhooks ·
clients & contacts · teams & skills · **AI agents** (first-class actors:
identity, lifecycle, budgets, deliverable verification) · SSO (OIDC/SAML/SCIM) ·
MCP connector.

---

## License

This repository is distributed under the **Elastic License 2.0** (a *source-available*
license, see [`LICENSE`](LICENSE)) — **not an OSI-approved open source license**.

In short, you may freely use, copy, modify and **self-host** the software.
You may not offer it to third parties as a hosted/managed service, nor circumvent the
license-key mechanism. Certain **premium features** (SSO, SCIM, MCP, Microsoft Teams
provisioning…) are present in the code but unlocked by a **license key**; the core of the
application and all of your data stay fully accessible without any key.

---

## Stack

| Layer | Technology |
|---|---|
| Frontend | React 18 + TypeScript (Vite), Tailwind + Radix/shadcn |
| Backend | NestJS (Node/TS) — REST API + WebSocket (Socket.IO) |
| ORM / migrations | Prisma 7 |
| Database | PostgreSQL 17 in HA (Patroni + etcd, HAProxy LB) |
| Cache / queues | Redis 7 (cache/pub-sub, BullMQ jobs) |
| Files | Garage (on-premise S3, AWS SDK v3 compatible) |
| Reverse proxy / TLS | Traefik v3 |
| Orchestration | Docker Swarm / Kubernetes (prod) |
| VM OS | Debian 13 Trixie |

TypeScript end to end; the `api` / `worker` / `mcp` services are **stateless** and
horizontally scalable.

## Structure (monorepo)

```
vaks-pm/
├── web/               # React + Vite
├── api/               # NestJS (REST + WebSocket)
├── worker/            # NestJS worker mode (BullMQ)
├── mcp/               # MCP server (AI connector, stateless Streamable-HTTP)
├── packages/shared/   # Shared types & DTOs
├── infra/             # Patroni, HAProxy, Traefik, cluster bootstrap, backup
├── deploy/helm/       # Kubernetes chart
├── docker-stack.yml   # Docker Swarm (prod)
└── setup.sh           # On-premise deployment entry point
```

---

## Deployment (production)

### Docker Swarm (on-premise, 3-node HA)

Deployment is orchestrated from a control workstation over key-based SSH — **no local
build required**, images are pulled from GHCR.

```bash
cp .env.example .env.local          # credentials & hosts (never committed)
bash setup.sh                       # wizard → infra/cluster.json → artifacts in out/
bash setup.sh --deploy              # wizard, then the deployment orchestrator
```

Target topology: PostgreSQL in HA (Patroni/etcd/HAProxy), Redis and Garage (S3) spread
across Swarm services, Traefik at the edge (80/443). The backend connects to PostgreSQL
**via HAProxy**. See `infra/` for the details (`patroni.yml`, `haproxy.cfg`, `traefik.yml`,
the `infra/bootstrap/` scripts).

### Kubernetes

A Helm chart is provided: [`deploy/helm/vaks-pm`](deploy/helm/vaks-pm) (both tenancy
modes, optional bundled PostgreSQL/Redis/MinIO).

---

## Docker images

The images for the 4 services are built by GitHub Actions
([`.github/workflows/build-images.yml`](.github/workflows/build-images.yml)) and pushed to
the **GitHub Container Registry**:

```
ghcr.io/thomasvaxelaire-vaks/vakspm-{api,web,worker,mcp}
  :latest        (default branch)
  :sha-<short>   (immutable — to pin or roll back a deployment)
```

`docker-stack.yml` consumes these images via `${VAKS_TAG:-latest}`. To pull from a mirror
registry, override `VAKS_IMAGE_PREFIX` (default `ghcr.io/thomasvaxelaire-vaks/vakspm`). Deployment
performs a rolling update (`docker service update --force --image …`) with no downtime.

---

## Security & compliance

Server-side RBAC enforced on every route and WebSocket event · append-only audit log with
SIEM export (syslog RFC 5424) · GDPR anonymization/portability · encryption at rest
(DEK/KEK envelope) · AI-agent action traceability (`actorType=AGENT`) · scoped API tokens
(PATs & org keys) with rate limiting.

---

## Documentation

The full user documentation (installation, deployment, backup/restore, SSO, API…) is
published online:

- 🇬🇧 **https://vaks-pm.com/docs/en/index.html**
- 🇫🇷 **https://vaks-pm.com/docs/fr/index.html**
