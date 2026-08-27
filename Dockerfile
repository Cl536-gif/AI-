FROM node:22-alpine

WORKDIR /app

# The CloudBase build context is the repository root. Install only the
# backend runtime dependencies; local-kb-tool/node_modules is never copied.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

COPY backend/src ./src
COPY backend/public ./public

# local-kb-tool is included as a minimal runtime bundle. The query path needs
# these five modules and the two prebuilt Vectra indexes; source documents,
# evaluation reports, build tooling and its node_modules are excluded.
COPY local-kb-tool/src/embedder.js ./local-kb-tool/src/embedder.js
COPY local-kb-tool/src/kbPaths.js ./local-kb-tool/src/kbPaths.js
COPY local-kb-tool/src/keywordScore.js ./local-kb-tool/src/keywordScore.js
COPY local-kb-tool/src/query.js ./local-kb-tool/src/query.js
COPY local-kb-tool/src/vectorStore.js ./local-kb-tool/src/vectorStore.js
COPY local-kb-tool/data/index/diet/index.json ./local-kb-tool/data/index/diet/index.json
COPY local-kb-tool/data/index/body-composition/index.json ./local-kb-tool/data/index/body-composition/index.json

ENV NODE_ENV=production
ENV PORT=3001

EXPOSE 3001

CMD ["node", "src/server.js"]
