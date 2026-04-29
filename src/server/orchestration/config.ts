import { resolveEngineSharedSecret } from "@/server/orchestration/secret";

export type OrchestrationMode = "mock" | "internal" | "webhook";

export type OrchestrationConfig = {
  mode: OrchestrationMode;
  externalDispatchUrl: string | null;
  appBaseUrl: string | null;
  sharedSecret: string | null;
  dispatchTimeoutMs: number;
};

function normalizeMode(raw: string | undefined): OrchestrationMode {
  if (raw === "mock" || raw === "webhook") {
    return raw;
  }

  return "internal";
}

function normalizeUrl(raw: string | undefined) {
  if (!raw) {
    return null;
  }

  return raw.endsWith("/") ? raw.slice(0, -1) : raw;
}

export function getOrchestrationConfig(): OrchestrationConfig {
  const dispatchTimeoutMs = Number.parseInt(
    process.env.SUPERSCRIBER_ENGINE_DISPATCH_TIMEOUT_MS ?? "8000",
    10,
  );

  return {
    mode: normalizeMode(process.env.SUPERSCRIBER_ENGINE_MODE),
    externalDispatchUrl: normalizeUrl(process.env.SUPERSCRIBER_ENGINE_DISPATCH_URL),
    appBaseUrl: normalizeUrl(process.env.SUPERSCRIBER_APP_BASE_URL),
    sharedSecret: resolveEngineSharedSecret(),
    dispatchTimeoutMs:
      Number.isFinite(dispatchTimeoutMs) && dispatchTimeoutMs > 0
        ? dispatchTimeoutMs
        : 8000,
  };
}

export function getConfiguredAdapterId() {
  const mode = getOrchestrationConfig().mode;
  if (mode === "webhook") {
    return "external-webhook-engine";
  }
  if (mode === "mock") {
    return "mock-governed-engine";
  }

  return "internal-python-worker";
}
