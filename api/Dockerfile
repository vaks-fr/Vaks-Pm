# ---- build ----
FROM node:22-alpine AS build
RUN apk add --no-cache openssl
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY api/package.json api/
RUN npm install
COPY packages/shared packages/shared
COPY api api
RUN npm run build -w @vaks-pm/shared \
 && npm run prisma:generate -w @vaks-pm/api \
 && npm run build -w @vaks-pm/api

# ---- runtime ----
FROM node:22-alpine
RUN apk add --no-cache openssl
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
