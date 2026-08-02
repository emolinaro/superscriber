// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import type { AdministrationPolicyViewModel } from "@/server/administration/service";
import { PolicySection } from "./policy-section";

const model: AdministrationPolicyViewModel = {
  section: "policy",
  profile: {
    id: "strict",
    label: "Strict",
    description: "Policy facts for governed playback and export.",
  },
  rows: [
    { id: "playback", label: "Playback", uploader: "Denied", reviewer: "Allowed", approver: "Allowed", admin: "Allowed" },
    { id: "raw-download", label: "Raw download", uploader: "Denied", reviewer: "Denied", approver: "Denied", admin: "Allowed" },
    { id: "draft-edit", label: "Edit draft", uploader: "Allowed", reviewer: "Allowed", approver: "Denied", admin: "Denied" },
    { id: "submit", label: "Submit", uploader: "Allowed", reviewer: "Allowed", approver: "Denied", admin: "Denied" },
    { id: "withdraw", label: "Withdraw", uploader: "Denied", reviewer: "Allowed", approver: "Denied", admin: "Denied" },
    { id: "approve", label: "Approve", uploader: "Denied", reviewer: "Denied", approver: "Allowed", admin: "Denied" },
    { id: "request-changes", label: "Request changes", uploader: "Denied", reviewer: "Denied", approver: "Allowed", admin: "Denied" },
    { id: "reopen", label: "Reopen approved", uploader: "Denied", reviewer: "Denied", approver: "Allowed", admin: "Denied" },
    { id: "export", label: "Approved export", uploader: "Denied", reviewer: "Denied", approver: "Allowed", admin: "Allowed" },
    { id: "phone-safety", label: "Phone safety", uploader: "Server only", reviewer: "Server only", approver: "Server only", admin: "Server only" },
  ],
};

describe("PolicySection", () => {
  afterEach(() => {
    cleanup();
  });

  it("renders the complete read-only policy matrix without save controls", () => {
    render(<PolicySection model={model} phoneSafetyMode={false} />);

    for (const name of [
      "Playback",
      "Raw download",
      "Edit draft",
      "Submit",
      "Withdraw",
      "Approve",
      "Request changes",
      "Reopen approved",
      "Approved export",
      "Phone safety",
    ]) {
      expect(screen.getByRole("rowheader", { name })).toBeVisible();
    }
    expect(screen.queryByRole("button", { name: "Save policy" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update policy" })).not.toBeInTheDocument();
  });

  it("keeps policy facts visible on phone", () => {
    render(<PolicySection model={model} phoneSafetyMode={true} />);

    expect(screen.getAllByRole("rowheader", { name: "Phone safety" })[0]).toBeVisible();
    expect(screen.queryByRole("button", { name: "Save policy" })).not.toBeInTheDocument();
  });
});
