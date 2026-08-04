FROM node:22-bookworm-slim

WORKDIR /app

# Install only runtime dependencies for a smaller local image.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Comote starts `codex app-server` as a child process. The host's Windows
# binary cannot run inside this Linux image, so install the Linux CLI here.
RUN npm install --global @openai/codex@latest && npm cache clean --force

COPY public ./public
COPY src ./src
COPY bin ./bin
COPY docker-entrypoint.sh ./docker-entrypoint.sh

ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=16208 \
    COMOTE_STATE_PATH=/data/state.json \
    COMOTE_CODEX_PATH=/usr/local/bin/codex

VOLUME ["/data"]
EXPOSE 16208

ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
CMD ["node", "src/server/index.js"]
