# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY web/package.json web/
# --legacy-peer-deps : cf. api/Dockerfile (crash arborist npm sur npm install à froid).
RUN npm install --legacy-peer-deps
COPY packages/shared packages/shared
COPY web web
RUN npm run build -w @vaks-pm/shared && npm run build -w @vaks-pm/web
# Gate de test STRUCTUREL (miroir api/Dockerfile) : le build de l'image ÉCHOUE
# si la suite web est rouge. Tourne dans ce stage (build statique déjà produit
# ci-dessus) où devDeps + specs + source shared sont présents ; le stage
# runtime nginx ci-dessous ne copie que `dist/`, donc n'est jamais affecté par
# ce gate. Désactivable ponctuellement via --build-arg SKIP_TESTS=1 (hotfix
# cassé-mais-urgent uniquement).
ARG SKIP_TESTS=0
RUN if [ "$SKIP_TESTS" = "1" ]; then echo "TESTS SKIPPED (SKIP_TESTS=1)"; else npm test -w @vaks-pm/web; fi

# ---- runtime (nginx) ----
FROM nginx:alpine
# Correctifs OS de l'image de base (libexpat, util-linux… cf. scan Trivy).
RUN apk upgrade --no-cache
# Upstream API host is configurable at container start. The nginx:alpine
# entrypoint runs envsubst over /etc/nginx/templates/*.template and writes the
# result to /etc/nginx/conf.d/. Default keeps the Swarm service name so dev/prod
# Swarm is unchanged; Kubernetes overrides API_UPSTREAM with the api Service DNS.
ENV API_UPSTREAM=http://api:3000
COPY web/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
