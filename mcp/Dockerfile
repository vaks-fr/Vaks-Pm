FROM node:22-alpine AS build
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY mcp/package.json mcp/
RUN npm install
COPY mcp mcp
RUN npm run build -w @vaks-pm/mcp

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY --from=build /app/node_modules /app/node_modules
COPY --from=build /app/mcp/dist /app/mcp/dist
COPY --from=build /app/mcp/package.json /app/mcp/package.json
WORKDIR /app/mcp
EXPOSE 8080
CMD ["node", "dist/main.js"]
