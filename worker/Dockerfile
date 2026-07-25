FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY worker/package.json worker/
RUN npm install
COPY packages/shared packages/shared
COPY worker worker
RUN npm run build -w @vaks-pm/shared && npm run build -w @vaks-pm/worker

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/packages/shared/dist /app/packages/shared/dist
COPY --from=build /app/packages/shared/package.json /app/packages/shared/package.json
COPY --from=build /app/worker/dist /app/worker/dist
COPY --from=build /app/worker/package.json /app/worker/package.json
WORKDIR /app/worker
CMD ["node", "dist/main.js"]
