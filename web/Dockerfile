# ---- build ----
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY web/package.json web/
RUN npm install
COPY packages/shared packages/shared
COPY web web
RUN npm run build -w @vaks-pm/shared && npm run build -w @vaks-pm/web

# ---- runtime (nginx) ----
FROM nginx:alpine
# Upstream API host is configurable at container start. The nginx:alpine
# entrypoint runs envsubst over /etc/nginx/templates/*.template and writes the
# result to /etc/nginx/conf.d/. Default keeps the Swarm service name so dev/prod
# Swarm is unchanged; Kubernetes overrides API_UPSTREAM with the api Service DNS.
ENV API_UPSTREAM=http://api:3000
COPY web/default.conf.template /etc/nginx/templates/default.conf.template
COPY --from=build /app/web/dist /usr/share/nginx/html
EXPOSE 80
