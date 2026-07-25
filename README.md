# Vaks-PM

**Outil de gestion de projet 100 % auto-hébergeable (on-premise), multi-utilisateurs, conçu pour des organisations de 200+ personnes.**
*Self-hostable project-management platform — API-first, multi-tenant, with AI agents as first-class actors.*

Kanban · listes de tâches · Gantt (dépendances, chemin critique) · suivi du temps &
reporting · timesheet hebdo · gestion de la charge (capacité) · jours fériés par pays ·
commentaires & @mentions · pièces jointes · notifications email · API REST + webhooks ·
clients & contacts · équipes & compétences · **agents IA** (acteurs de première classe :
identité, cycle de vie, budgets, vérification des livrables) · SSO (OIDC/SAML/SCIM) ·
connecteur MCP.

---

## Licence

Ce dépôt est distribué sous **Elastic License 2.0** (licence *source-available*, voir
[`LICENSE`](LICENSE)) — **et non une licence open source au sens OSI**.

En résumé, vous pouvez librement utiliser, copier, modifier et **auto-héberger** le logiciel.
Vous ne pouvez pas le proposer à des tiers comme service hébergé/managé, ni contourner le
mécanisme de clé de licence. Certaines **fonctionnalités premium** (SSO, SCIM, MCP,
provisioning Microsoft Teams…) sont présentes dans le code mais activées par une **clé de
licence** ; le cœur de l'application et toutes vos données restent pleinement accessibles
sans clé.

---

## Stack

| Couche | Techno |
|---|---|
| Frontend | React 18 + TypeScript (Vite), Tailwind + Radix/shadcn |
| Backend | NestJS (Node/TS) — API REST + WebSocket (Socket.IO) |
| ORM / migrations | Prisma 7 |
| Base de données | PostgreSQL 17 en HA (Patroni + etcd, LB HAProxy) |
| Cache / queues | Redis 7 (cache/pub-sub, jobs BullMQ) |
| Fichiers | Garage (S3 on-premise, compatible AWS SDK v3) |
| Reverse proxy / TLS | Traefik v3 |
| Orchestration | Docker Swarm / Kubernetes (prod) |
| OS VMs | Debian 13 Trixie |

TypeScript de bout en bout ; les services `api` / `worker` / `mcp` sont **sans état** et
scalables horizontalement.

## Structure (monorepo)

```
vaks-pm/
├── web/               # React + Vite
├── api/               # NestJS (REST + WebSocket)
├── worker/            # NestJS mode worker (BullMQ)
├── mcp/               # Serveur MCP (connecteur IA, Streamable-HTTP stateless)
├── packages/shared/   # Types & DTO partagés
├── infra/             # Patroni, HAProxy, Traefik, bootstrap cluster, backup
├── deploy/helm/       # Chart Kubernetes
├── docker-stack.yml   # Prod Docker Swarm
└── setup.sh           # Point d'entrée du déploiement on-premise
```

---

## Déploiement (production)

### Docker Swarm (on-premise, HA 3 nœuds)

Le déploiement est orchestré depuis une machine de pilotage via SSH par clés — **aucun
build local requis**, les images sont récupérées depuis GHCR.

```bash
cp .env.example .env.local          # credentials & hôtes (jamais commité)
bash setup.sh                       # wizard → infra/cluster.json → artefacts out/
bash setup.sh --deploy              # wizard puis orchestrateur de déploiement
```

Topologie cible : PostgreSQL en HA (Patroni/etcd/HAProxy), Redis et Garage (S3) répartis
en services Swarm, Traefik en frontal (80/443). Le backend se connecte à PostgreSQL **via
HAProxy**. Voir `infra/` pour le détail (`patroni.yml`, `haproxy.cfg`, `traefik.yml`,
scripts `infra/bootstrap/`).

### Kubernetes

Un chart Helm est fourni : [`deploy/helm/vaks-pm`](deploy/helm/vaks-pm) (les deux modes de
tenancy, PostgreSQL/Redis/MinIO bundlés optionnels).

---

## Images Docker

Les images des 4 services sont buildées par GitHub Actions
([`.github/workflows/build-images.yml`](.github/workflows/build-images.yml)) et poussées vers
le **GitHub Container Registry** :

```
ghcr.io/itsmepoy/vakspm-{api,web,worker,mcp}
  :latest        (branche par défaut)
  :sha-<short>   (immuable — pour épingler ou rollback un déploiement)
```

`docker-stack.yml` consomme ces images via `${VAKS_TAG:-latest}`. Pour tirer depuis un
registre miroir, surcharger `VAKS_IMAGE_PREFIX` (défaut `ghcr.io/itsmepoy/vakspm`). Le
déploiement effectue un rolling update (`docker service update --force --image …`) sans
downtime.

---

## Sécurité & conformité

RBAC appliqué côté serveur sur chaque route et événement WebSocket · audit log append-only
avec export SIEM (syslog RFC 5424) · anonymisation/portabilité RGPD · chiffrement au repos
(enveloppe DEK/KEK) · traçabilité des actions d'agents IA (`actorType=AGENT`) · jetons API
scopés (PAT & clés org) avec rate-limit.

---

## Documentation

La documentation utilisateur complète (installation, déploiement, sauvegarde/restauration,
SSO, API…) est publiée en ligne :

- 🇫🇷 **https://vaks-pm.com/docs/fr/index.html**
- 🇬🇧 **https://vaks-pm.com/docs/en/index.html**
