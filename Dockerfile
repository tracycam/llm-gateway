# The gateway as one image: the server bundled into one file, and the built console.
# Build from inside `gateway/` (scripts/build-gateway-image.sh does it):
#   docker build -t llm-gateway gateway
ARG BUN_IMAGE=oven/bun:1.4.2-slim@sha256:cb3bbbb08e13a4a2ff400f24c7a2a1d5efa83f6ef8544d52d95a519631e2fc61

FROM ${BUN_IMAGE} AS build
WORKDIR /src
# The console builds from its own lockfile; the backend is bundled by Bun and needs no install.
COPY web/package.json web/bun.lock web/
RUN cd web && bun install --frozen-lockfile
COPY . .
RUN cd web && bun run build
# Only the code main.ts reaches ends up in the bundle: no tests, no console sources.
RUN bun build main.ts --target=bun --outfile=/out/gateway.js
RUN mkdir /out/data

FROM ${BUN_IMAGE}
# Inside a container the gateway has to listen on every address; which host address is opened is
# the choice of whoever runs it (docker run -p). A listener that is not loopback requires
# ADMIN_TOKEN; the image contains no token.
ENV LISTEN=0.0.0.0 \
    PORT=8000 \
    DATA_DIR=/data \
    WEB_DIST_DIR=/app/web
COPY --from=build /out/gateway.js /app/gateway.js
COPY --from=build /src/web/dist /app/web
COPY --from=build --chown=bun:bun /out/data /data
USER bun
WORKDIR /app
VOLUME /data
EXPOSE 8000
HEALTHCHECK --interval=10s --timeout=3s --start-period=5s --retries=3 \
  CMD ["bun", "-e", "process.exit((await fetch('http://127.0.0.1:8000/healthz')).ok ? 0 : 1)"]
ARG REVISION=unknown
# The base image's labels describe Bun; the ones that would be wrong for this image are replaced.
LABEL org.opencontainers.image.title="LLM Gateway" \
      org.opencontainers.image.description="LLM Gateway: /v1 API, API keys, administration and Web console" \
      org.opencontainers.image.revision="${REVISION}" \
      org.opencontainers.image.version="${REVISION}" \
      org.opencontainers.image.source="" \
      org.opencontainers.image.url="" \
      org.opencontainers.image.licenses="" \
      org.opencontainers.image.created=""
ENTRYPOINT ["bun", "/app/gateway.js"]
