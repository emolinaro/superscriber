// @vitest-environment node

import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { CasefileWorkspace } from "./casefile-workspace";
import { createCasefile } from "./test-fixtures";

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    refresh: vi.fn(),
    push: vi.fn(),
  }),
}));

vi.mock("@/components/ui/phone-safety", () => ({
  usePhoneSafetyMode: () => false,
}));

vi.mock("@/components/auth/session-recovery-dialog", () => ({
  SessionRecoveryDialog: () => null,
}));

vi.mock("@/components/orchestration-status-poller", () => ({
  OrchestrationStatusPoller: () => null,
}));

describe("CasefileWorkspace SSR", () => {
  it("renders a casefile on the server without reading window", () => {
    const html = renderToString(
      <CasefileWorkspace
        approveAction={vi.fn()}
        enterAdminActionModeAction={vi.fn()}
        exitAdminActionModeAction={vi.fn()}
        initialCasefile={createCasefile()}
        reopenAction={vi.fn()}
        requestChangesAction={vi.fn()}
        saveAction={vi.fn()}
        submitAction={vi.fn()}
        withdrawAction={vi.fn()}
      />,
    );

    expect(html).toContain("Governed recording");
  });
});
