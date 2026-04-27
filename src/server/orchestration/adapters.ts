import { CanonicalOrchestrationAdapter, mockGovernedEngine } from "@/server/orchestration/mock-engine";
import { getConfiguredAdapterId } from "@/server/orchestration/config";

export const externalWebhookEngine: CanonicalOrchestrationAdapter = {
  id: "external-webhook-engine",
  stepVerification() {
    return null;
  },
  stepTranscriptJob() {
    return null;
  },
};

const ADAPTERS = new Map<string, CanonicalOrchestrationAdapter>([
  [mockGovernedEngine.id, mockGovernedEngine],
  [externalWebhookEngine.id, externalWebhookEngine],
]);

export function resolveAdapter(id: string | null | undefined) {
  if (!id) {
    return mockGovernedEngine;
  }

  return ADAPTERS.get(id) ?? mockGovernedEngine;
}

export function resolveConfiguredAdapter() {
  return resolveAdapter(getConfiguredAdapterId());
}
