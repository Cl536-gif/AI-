# @xenova/transformers uses onnxruntime-node, which requires glibc's dynamic
# loader. Use Debian slim instead of Alpine (musl) so the native runtime loads
# correctly in CloudBase Run.
FROM node:22-bookworm-slim

WORKDIR /app

# The CloudBase build context is the repository root. Install only the
# backend runtime dependencies; local-kb-tool/node_modules is never copied.
COPY backend/package.json backend/package-lock.json ./
RUN npm ci --omit=dev

# Preserve the repository's backend/ directory level. Several backend modules
# resolve ../../../local-kb-tool relative to backend/src/services; flattening
# backend/src to /app/src would incorrectly resolve that path to /local-kb-tool.
COPY backend/src ./backend/src
COPY backend/public ./backend/public

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

# Bundle only the four files needed for offline query embeddings (~23 MB).
# This prevents first-request downloads without copying local-kb-tool/node_modules.
COPY local-kb-tool/models/Xenova/bge-small-zh-v1.5/config.json ./local-kb-tool/models/Xenova/bge-small-zh-v1.5/config.json
COPY local-kb-tool/models/Xenova/bge-small-zh-v1.5/tokenizer.json ./local-kb-tool/models/Xenova/bge-small-zh-v1.5/tokenizer.json
COPY local-kb-tool/models/Xenova/bge-small-zh-v1.5/tokenizer_config.json ./local-kb-tool/models/Xenova/bge-small-zh-v1.5/tokenizer_config.json
COPY local-kb-tool/models/Xenova/bge-small-zh-v1.5/onnx/model_quantized.onnx ./local-kb-tool/models/Xenova/bge-small-zh-v1.5/onnx/model_quantized.onnx

ENV NODE_ENV=production
ENV PORT=3001

WORKDIR /app/backend

EXPOSE 3001

CMD ["node", "src/server.js"]
