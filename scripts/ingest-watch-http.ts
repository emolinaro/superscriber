export const DEFAULT_INGEST_WATCH_BASE_URL = "http://localhost:3000";
export const INGEST_WATCH_REQUEST_TIMEOUT_MS = 30_000;

export function resolveIngestWatchBaseUrl(configuredUrl: string | undefined) {
  return (configuredUrl ?? DEFAULT_INGEST_WATCH_BASE_URL).replace(/\/$/, "");
}

export class BoundedFetch {
  private readonly activeControllers = new Set<AbortController>();

  constructor(
    private readonly timeoutMs = INGEST_WATCH_REQUEST_TIMEOUT_MS,
    private readonly fetchImplementation: typeof fetch = fetch,
  ) {
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
      throw new RangeError("Request timeout must be a positive number.");
    }
  }

  async request(input: string | URL | Request, init: RequestInit = {}) {
    const controller = new AbortController();
    const upstreamSignal = init.signal;
    const forwardAbort = () => controller.abort(upstreamSignal?.reason);
    if (upstreamSignal?.aborted) {
      forwardAbort();
    } else {
      upstreamSignal?.addEventListener("abort", forwardAbort, { once: true });
    }
    const timeout = setTimeout(() => {
      controller.abort(new Error(`request timed out after ${this.timeoutMs} ms`));
    }, this.timeoutMs);
    this.activeControllers.add(controller);
    try {
      const response = await this.fetchImplementation(input, {
        ...init,
        signal: controller.signal,
      });
      const body = await response.arrayBuffer();
      return new Response(body.byteLength > 0 ? body : null, {
        headers: response.headers,
        status: response.status,
        statusText: response.statusText,
      });
    } finally {
      clearTimeout(timeout);
      upstreamSignal?.removeEventListener("abort", forwardAbort);
      this.activeControllers.delete(controller);
    }
  }

  abortAll(reason = new Error("watcher shutting down")) {
    for (const controller of this.activeControllers) {
      controller.abort(reason);
    }
  }
}
