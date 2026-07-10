# Nefertari agentd — headless approval API for containers (Railway, Docker, K8s).
# Runs `nefertari serve`: the HTTP gate over the same broker/journal/snapshot core.
# The MCP stdio server (src/server.mjs) is used by a co-located agent; this image
# exposes the human-gate control plane so approvals work without a shell.

# ---- deps: install production node_modules against the lockfile ----
FROM node:20-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

# ---- runtime: minimal, non-root, healthchecked ----
FROM node:20-slim AS runtime
LABEL org.opencontainers.image.title="nefertari-agentd" \
      org.opencontainers.image.description="AI-native system layer: reversible actions + human gate + audit journal" \
      org.opencontainers.image.source="https://github.com/xQUANTUMTECH/nefertari-os" \
      org.opencontainers.image.licenses="AGPL-3.0-or-later"

ENV NODE_ENV=production \
    NEFERTARI_HOME=/data \
    NEFERTARI_HTTP_HOST=0.0.0.0 \
    NEFERTARI_HTTP_PORT=7343

WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src

# Non-root runtime user; /data holds the journal, pending queue and snapshots.
RUN useradd --uid 10001 --user-group --create-home --home-dir /home/nefertari --shell /usr/sbin/nologin nefertari \
 && mkdir -p /data \
 && chown -R nefertari:nefertari /data /app
USER nefertari
VOLUME ["/data"]
EXPOSE 7343

# Health uses the public /health route (no token needed). Reports pending count.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.NEFERTARI_HTTP_PORT||7343,path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "src/cli.mjs"]
CMD ["serve"]
