FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY worker/package.json worker/
# --legacy-peer-deps : cf. api/Dockerfile (crash arborist npm sur npm install à froid).
RUN npm install --legacy-peer-deps
COPY packages/shared packages/shared
COPY worker worker
RUN npm run build -w @vaks-pm/shared && npm run build -w @vaks-pm/worker
# Gate de test STRUCTUREL : le build de l'image ÉCHOUE si la suite worker est
# rouge (miroir exact de api/Dockerfile). Tourne dans ce stage build car les
# devDeps (vitest) + dist shared y sont déjà présents. Désactivable
# ponctuellement via --build-arg SKIP_TESTS=1 (hotfix cassé-mais-urgent uniquement).
ARG SKIP_TESTS=0
RUN if [ "$SKIP_TESTS" = "1" ]; then echo "TESTS SKIPPED (SKIP_TESTS=1)"; else npm test -w @vaks-pm/worker; fi

FROM node:22-alpine
# Sécurité image : correctifs OS (apk upgrade) + retrait de npm/npx/yarn, jamais
# utilisés à l'exécution (`node dist/main.js`) — le npm embarqué par l'image Node
# portait à lui seul les CVE HIGH/CRITICAL du scan (tar, pacote, sigstore…).
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /app/worker/dist /app/worker/dist
COPY --from=build /app/worker/package.json /app/worker/package.json
WORKDIR /app/worker
CMD ["node", "dist/main.js"]
