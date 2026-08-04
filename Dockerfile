ARG NODE_IMAGE=docker.m.daocloud.io/library/node:22-bookworm-slim@sha256:f32b81066cde10a75dbac96646099533316d94bac4150c55da1636e1f0ffdc46
FROM ${NODE_IMAGE}

ARG CODEX_VERSION=0.146.0
ARG NPM_REGISTRY=https://registry.npmmirror.com

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci --omit=dev --registry="${NPM_REGISTRY}" \
    && npm install --global "@openai/codex@${CODEX_VERSION}" --registry="${NPM_REGISTRY}" \
    && npm cache clean --force

COPY --chown=node:node src ./src
COPY --chown=node:node public ./public
COPY --chown=node:node bin ./bin
COPY --chown=node:node package.json ./package.json
COPY deploy/docker-entrypoint.sh /usr/local/bin/comote-entrypoint

RUN mkdir -p /home/node/.codex /data /workspace \
    && chown -R node:node /home/node/.codex /data /workspace \
    && chmod 755 /usr/local/bin/comote-entrypoint

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=16208 \
    COMOTE_STATE_PATH=/data/state.json \
    COMOTE_PROJECT_ROOT=/workspace \
    COMOTE_CODEX_PATH=/usr/local/bin/codex

EXPOSE 16208

HEALTHCHECK --interval=10s --timeout=3s --start-period=15s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:16208/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/local/bin/comote-entrypoint"]
CMD ["node", "src/server/index.js"]
