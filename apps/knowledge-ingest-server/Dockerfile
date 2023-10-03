FROM node:24-slim AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/knowledge-schema/package.json packages/knowledge-schema/package.json
COPY apps/knowledge-ingest-server/package.json apps/knowledge-ingest-server/package.json
COPY apps/knowledge-local-importer/package.json apps/knowledge-local-importer/package.json

RUN npm ci

COPY packages/knowledge-schema packages/knowledge-schema
COPY apps/knowledge-ingest-server apps/knowledge-ingest-server
COPY apps/knowledge-local-importer apps/knowledge-local-importer

RUN npm run build -w @uknowledge/knowledge-schema \
  && npm run build -w @uknowledge/knowledge-ingest-server \
  && npm run build -w @uknowledge/knowledge-local-importer \
  && npm prune --omit=dev

FROM node:24-slim AS runtime

ENV NODE_ENV=production \
  KNOWLEDGE_HOST=0.0.0.0 \
  KNOWLEDGE_PORT=18765 \
  KNOWLEDGE_STORE=/data

WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends pandoc \
  && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/knowledge-schema/package.json ./packages/knowledge-schema/package.json
COPY --from=build /app/packages/knowledge-schema/dist ./packages/knowledge-schema/dist
COPY --from=build /app/apps/knowledge-ingest-server/package.json ./apps/knowledge-ingest-server/package.json
COPY --from=build /app/apps/knowledge-ingest-server/dist ./apps/knowledge-ingest-server/dist
COPY --from=build /app/apps/knowledge-local-importer/package.json ./apps/knowledge-local-importer/package.json
COPY --from=build /app/apps/knowledge-local-importer/dist ./apps/knowledge-local-importer/dist

RUN mkdir -p /data

EXPOSE 18765
VOLUME ["/data"]

CMD ["node", "--enable-source-maps", "apps/knowledge-ingest-server/dist/index.js"]
