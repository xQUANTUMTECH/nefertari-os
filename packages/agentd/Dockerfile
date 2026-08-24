# Nefertari agentd — headless approval API for containers (Railway, Docker, K8s).
# Runs `nefertari serve`: the HTTP gate over the same broker/journal/snapshot core.
# The MCP stdio server (src/server.mjs) is used by a co-located agent; this image
# exposes the human-gate control plane so approvals work without a shell.
#
# BUILD CONTEXT IS THE REPOSITORY ROOT, not this directory, because the image
# carries the Landlock enforcer built from packages/enforce:
#
#   docker build -f packages/agentd/Dockerfile -t nefertari-agentd .
#
# docker-compose.yml in this directory already sets that context.

# ---- enforce: the Landlock binary that makes reversibility a kernel fact ----
# Without this stage the image ships with no enforcer, the landlock driver finds
# nothing and silently degrades to fail-open — the container would classify
# actions as reversible without anything holding the command to it.
FROM rust:slim AS enforce
WORKDIR /build
COPY packages/enforce/Cargo.toml packages/enforce/Cargo.lock ./
COPY packages/enforce/src ./src
RUN cargo build --release

# ---- deps: install production node_modules against the lockfile ----
FROM node:20-slim AS deps
WORKDIR /app
COPY packages/agentd/package.json packages/agentd/package-lock.json ./
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
COPY packages/agentd/package.json ./
COPY packages/agentd/src ./src

# The landlock driver resolves this path with no configuration (third fallback
# in src/enforce.mjs). Landlock is unprivileged and works inside an ordinary
# container: verified on Docker Desktop / WSL2 at ABI 3, no seccomp exemption
# and no added capabilities. Requires a Linux kernel >= 5.13 under the runtime,
# which Docker Desktop provides on Windows and macOS alike.
COPY --from=enforce /build/target/release/nefertari-enforce /usr/local/bin/nefertari-enforce

# Non-root runtime user; /data holds the journal, pending queue and snapshots.
RUN useradd --uid 10001 --user-group --create-home --home-dir /home/nefertari --shell /usr/sbin/nologin nefertari \
 && mkdir -p /data \
 && chown -R nefertari:nefertari /data /app \
 && chmod 0755 /usr/local/bin/nefertari-enforce
USER nefertari
VOLUME ["/data"]
EXPOSE 7343

# Health uses the public /health route (no token needed). Reports pending count.
HEALTHCHECK --interval=30s --timeout=3s --start-period=5s --retries=3 \
  CMD node -e "require('http').get({host:'127.0.0.1',port:process.env.NEFERTARI_HTTP_PORT||7343,path:'/health'},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1))"

ENTRYPOINT ["node", "src/cli.mjs"]
CMD ["serve"]
