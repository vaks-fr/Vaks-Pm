# ---- build ----
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY api/package.json api/
# --legacy-peer-deps : contourne un crash d'arborist npm 10.9.x (edgesOut null
# dans #loadPeerSet, ex. @edge-runtime/vm@*) sur `npm install` à froid. Les
# versions restent pinnées par package.json + `overrides` racine ; on relâche
# seulement la strictness peer-deps de npm 7+.
RUN npm install --legacy-peer-deps
COPY packages/shared packages/shared
COPY api api
RUN npm run build -w @vaks-pm/shared \
 && npm run prisma:generate -w @vaks-pm/api \
 && npm run build -w @vaks-pm/api
# Gate de test STRUCTUREL : le build de l'image ÉCHOUE si la suite api est rouge.
# Tourne ici (stage build) car devDeps + specs + client Prisma généré + dist shared
# y sont déjà présents. vitest 4 / vite 8 requis (l'alias `@db` ne résout pas sous
# vite 7 en contexte api-only — cf. mémoire project_test_harness_state). Désactivable
# ponctuellement via --build-arg SKIP_TESTS=1 (hotfix cassé-mais-urgent uniquement).
ARG SKIP_TESTS=0
RUN if [ "$SKIP_TESTS" = "1" ]; then echo "⚠️  TESTS SKIPPED (SKIP_TESTS=1)"; else npm test -w @vaks-pm/api; fi

# ---- runtime ----
FROM node:22-alpine
# Correctifs OS + npm à jour : le démarrage fait `npx prisma db push`, npm doit
# rester — mais celui embarqué par l'image Node porte des CVE (tar, pacote…).
RUN apk upgrade --no-cache && apk add --no-cache openssl \
 && npm install -g npm@12.1.0 && npm cache clean --force \
 && rm -rf /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
ENV NODE_ENV=production
# Version de PUSH (convention yyyy-mm-dd-nbpushtoday) injectée au build et
# exposée par GET /admin/diagnostics (carte Application). `dev` si non fournie.
ARG APP_VERSION=dev
ENV APP_VERSION=$APP_VERSION
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /app/api/dist /app/api/dist
COPY --from=build /app/api/static /app/api/static
COPY --from=build /app/api/package.json /app/api/package.json
COPY --from=build /app/api/prisma /app/api/prisma
# Prisma 7 : config CLI requise par `prisma db push` au démarrage.
COPY --from=build /app/api/prisma.config.ts /app/api/prisma.config.ts
WORKDIR /app/api
EXPOSE 3000
CMD ["node", "dist/main.js"]
