export type OrchestrationMode = "mock" | "webhook";

export type OrchestrationConfig = {
  mode: OrchestrationMode;
  externalDispatchUrl: string | null;
  appBaseUrl: string | null;
  sharedSecret: string | null;
  dispatchTimeoutMs: number;
};

function normalizeMode(raw: string | undefined): OrchestrationMode {
  return raw === "webhook" ? "webhook" : "mock";
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
    sharedSecret: process.env.SUPERSCRIBER_ENGINE_SHARED_SECRET ?? null,
    dispatchTimeoutMs:
      Number.isFinite(dispatchTimeoutMs) && dispatchTimeoutMs > 0
        ? dispatchTimeoutMs
        : 8000,
  };
}

export function getConfiguredAdapterId() {
  return getOrchestrationConfig().mode === "webhook"
    ? "external-webhook-engine"
    : "mock-governed-engine";
}
