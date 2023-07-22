FROM node:24-bookworm AS build

WORKDIR /app

COPY package.json package-lock.json tsconfig.base.json ./
COPY packages/knowledge-schema/package.json packages/knowledge-schema/package.json
COPY apps/knowledge-ingest-server/package.json apps/knowledge-ingest-server/package.json

RUN npm ci

COPY packages/knowledge-schema packages/knowledge-schema
COPY apps/knowledge-ingest-server apps/knowledge-ingest-server

RUN npm run build -w @uknowledge/knowledge-schema \
  && npm run build -w @uknowledge/knowledge-ingest-server \
  && npm prune --omit=dev

FROM node:24-bookworm AS runtime

ENV NODE_ENV=production \
  KNOWLEDGE_HOST=0.0.0.0 \
  KNOWLEDGE_PORT=18765 \
  KNOWLEDGE_STORE=/data

WORKDIR /app

COPY package.json package-lock.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/knowledge-schema/package.json ./packages/knowledge-schema/package.json
COPY --from=build /app/packages/knowledge-schema/dist ./packages/knowledge-schema/dist
COPY --from=build /app/apps/knowledge-ingest-server/package.json ./apps/knowledge-ingest-server/package.json
COPY --from=build /app/apps/knowledge-ingest-server/dist ./apps/knowledge-ingest-server/dist

RUN mkdir -p /data

EXPOSE 18765
VOLUME ["/data"]

CMD ["node", "--enable-source-maps", "apps/knowledge-ingest-server/dist/index.js"]
