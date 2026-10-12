FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY mcp/package.json mcp/
# --legacy-peer-deps : cf. api/Dockerfile (crash arborist npm sur npm install à froid).
RUN npm install --legacy-peer-deps
COPY mcp mcp
RUN npm run build -w @vaks-pm/mcp
# Gate de test : le build de l'image ÉCHOUE si la suite mcp est rouge (même
# convention que api/worker). Désactivable via --build-arg SKIP_TESTS=1.
ARG SKIP_TESTS=0
RUN if [ "$SKIP_TESTS" = "1" ]; then echo "TESTS SKIPPED (SKIP_TESTS=1)"; else npm test -w @vaks-pm/mcp; fi

# Dépendances de PROD seules (pas de typescript/ts-node dans l'image finale :
# c'est la pièce exposée à Internet, surface minimale).
FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json ./
COPY mcp/package.json mcp/
RUN npm install --omit=dev --legacy-peer-deps && npm cache clean --force

FROM node:22-alpine
# Sécurité image : correctifs OS (apk upgrade) + retrait de npm/npx/yarn, jamais
# utilisés à l'exécution (`node dist/main.js`) — le npm embarqué par l'image Node
# portait à lui seul les CVE HIGH/CRITICAL du scan (tar, pacote, sigstore…).
RUN apk upgrade --no-cache \
 && rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx \
           /usr/local/bin/yarn /usr/local/bin/yarnpkg /opt/yarn-*
WORKDIR /app
ENV NODE_ENV=production
COPY --from=deps /app/node_modules /app/node_modules
COPY --from=build /app/mcp/dist /app/mcp/dist
COPY --from=build /app/mcp/package.json /app/mcp/package.json
WORKDIR /app/mcp
# Non-root : une RCE dans le conteneur n'obtient pas root.
USER node
EXPOSE 8080
CMD ["node", "dist/main.js"]
