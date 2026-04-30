FROM node:22-bookworm-slim AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV SUPERSCRIBER_ENGINE_MODE=internal
ARG SUPERSCRIBER_TRANSCRIBE_MODEL=small
ARG SUPERSCRIBER_PRELOAD_MODEL=1
ENV PATH="/opt/venv/bin:${PATH}"
ENV SUPERSCRIBER_TRANSCRIBE_MODEL=${SUPERSCRIBER_TRANSCRIBE_MODEL}
ENV SUPERSCRIBER_TRANSCRIBE_MODEL_DIR=/app/models
ENV SUPERSCRIBER_TRANSCRIBE_OFFLINE=1
ENV SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD=0
ENV SUPERSCRIBER_TRANSCRIBE_ALLOW_STUB_FALLBACK=0
WORKDIR /app

RUN apt-get update \
  && apt-get install -y --no-install-recommends bash ca-certificates python3 python3-venv tini \
  && rm -rf /var/lib/apt/lists/*

COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/worker ./worker
COPY --from=builder /app/scripts ./scripts

RUN python3 -m venv /opt/venv \
  && python3 -m pip install --no-cache-dir --upgrade pip \
  && python3 -m pip install --no-cache-dir -r /app/worker/requirements.txt \
  && if [ "${SUPERSCRIBER_PRELOAD_MODEL}" = "1" ]; then \
       SUPERSCRIBER_TRANSCRIBE_OFFLINE=0 \
       SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD=1 \
       python3 /app/worker/prefetch_model.py; \
     fi \
  && chmod +x /app/scripts/container-entrypoint.sh \
  && mkdir -p /app/data /app/models \
  && chown -R node:node /app

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python3 /app/scripts/http_probe.py "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/container-entrypoint.sh"]
