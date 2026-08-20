# Node base image pinned by digest (node:24-bookworm-slim at Node 24.18.1,
# multi-arch index digest). The CI workflow logs the resolved digest on every
# run; move both the tag and the digest deliberately when upgrading Node.
ARG NODE_BASE_IMAGE=node:24.18.1-bookworm-slim@sha256:235600a8101ab264e117b1768e925532262668dc9b581ef1dd7d96ced463b8e7
FROM ${NODE_BASE_IMAGE} AS base
ENV NEXT_TELEMETRY_DISABLED=1
WORKDIR /app

FROM base AS deps
COPY package.json package-lock.json ./
RUN npm ci

FROM base AS builder
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build

FROM ${NODE_BASE_IMAGE} AS runtime
ENV NODE_ENV=production
ENV NEXT_TELEMETRY_DISABLED=1
ENV PORT=3000
ENV SUPERSCRIBER_ENGINE_MODE=internal
ARG SUPERSCRIBER_TRANSCRIBE_MODEL=small
ARG SUPERSCRIBER_PRELOAD_MODEL=1
# diarization-bundle: set SUPERSCRIBER_PRELOAD_DIARIZATION=1 and pass the
# gated Hugging Face token once via a BuildKit secret mount (docker build
# --secret id=hf_token,env=SUPERSCRIBER_HUGGINGFACE_TOKEN) to vendor the
# pinned speaker-diarization-3.1 bundle into the image. The secret is
# mounted for that RUN step only: it never appears in image history or in
# the final image. With a token supplied, a failed gated fetch fails the
# build; without one the prefetch stays optional and non-fatal.
ARG SUPERSCRIBER_PRELOAD_DIARIZATION=0
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
COPY --from=builder /app/public ./public
COPY --from=builder /app/worker ./worker
COPY --from=builder /app/scripts ./scripts

RUN --mount=type=secret,id=hf_token,required=false \
  python3 -m venv /opt/venv \
  && python3 -m pip install --no-cache-dir --upgrade pip \
  # CPU-only torch wheels keep the appliance image free of CUDA runtimes.
  && python3 -m pip install --no-cache-dir torch==2.8.0 torchaudio==2.8.0 \
       --index-url https://download.pytorch.org/whl/cpu \
  && python3 -m pip install --no-cache-dir -r /app/worker/requirements.txt \
  && if [ "${SUPERSCRIBER_PRELOAD_MODEL}" = "1" ]; then \
       SUPERSCRIBER_TRANSCRIBE_OFFLINE=0 \
       SUPERSCRIBER_TRANSCRIBE_ALLOW_RUNTIME_DOWNLOAD=1 \
       python3 /app/worker/prefetch_model.py; \
     fi \
  && if [ "${SUPERSCRIBER_PRELOAD_DIARIZATION}" = "1" ]; then \
       if [ -s /run/secrets/hf_token ]; then \
         SUPERSCRIBER_HUGGINGFACE_TOKEN="$(cat /run/secrets/hf_token)" \
           python3 /app/worker/prefetch_diarization.py; \
       else \
         python3 /app/worker/prefetch_diarization.py || true; \
       fi; \
     fi \
  && chmod +x /app/scripts/container-entrypoint.sh \
  && mkdir -p /app/data /app/models \
  && chown -R node:node /app

VOLUME ["/app/data"]
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=30s --retries=3 \
  CMD python3 /app/scripts/http_probe.py "http://127.0.0.1:${PORT:-3000}/api/health" || exit 1

ENTRYPOINT ["/usr/bin/tini", "--", "/app/scripts/container-entrypoint.sh"]
