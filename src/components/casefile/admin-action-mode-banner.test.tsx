// @vitest-environment jsdom

import * as React from "react";
import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatDateTimeUtc } from "@/lib/format";
import { AdminActionModeBanner } from "./admin-action-mode-banner";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("AdminActionModeBanner", () => {
  it("does not render action-mode entry when no server options are available", () => {
    render(
      <AdminActionModeBanner
        entryOptions={[]}
        onEnter={vi.fn()}
        onExit={vi.fn()}
        phoneSafetyMode={false}
        recordingTitle="Governed recording"
        session={null}
      />,
    );

    expect(screen.queryByRole("button", { name: "Enter reviewer action mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enter approver action mode" })).not.toBeInTheDocument();
  });

  it("collects recording, effective role, and a 10 to 500 character purpose before entry", async () => {
    const user = userEvent.setup();
    const onEnter = vi.fn().mockResolvedValue({ ok: true });
    render(
      <AdminActionModeBanner
        entryOptions={[{ effectiveRole: "reviewer" }, { effectiveRole: "approver" }]}
        onEnter={onEnter}
        onExit={vi.fn()}
        phoneSafetyMode={false}
        recordingTitle="Governed recording"
        session={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Enter reviewer action mode" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Enter approver action mode" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Enter reviewer action mode" }));

    expect(screen.getByRole("dialog", { name: "Enter admin action mode" })).toBeVisible();
    expect(screen.getByText("Recording Governed recording")).toBeVisible();
    expect(screen.getByText("Effective role Reviewer")).toBeVisible();
    expect(screen.getByText("Base role Admin")).toBeVisible();
    const confirmButton = screen.getAllByRole("button", { name: "Enter reviewer action mode" })[1];
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Purpose"), { target: { value: "Too short" } });
    expect(screen.getByText("9/500")).toBeVisible();
    expect(confirmButton).toBeDisabled();

    fireEvent.change(screen.getByLabelText("Purpose"), { target: { value: "Too short reason" } });
    expect(screen.getByText("16/500")).toBeVisible();
    expect(confirmButton).toBeEnabled();

    await user.click(confirmButton);
    expect(onEnter).toHaveBeenCalledWith({
      effectiveRole: "reviewer",
      purpose: "Too short reason",
    });
  });

  it("renders the persistent banner identity, purpose, expiry, and explicit exit", async () => {
    const user = userEvent.setup();
    const onExit = vi.fn().mockResolvedValue({ ok: true });
    render(
      <AdminActionModeBanner
        entryOptions={[]}
        onEnter={vi.fn()}
        onExit={onExit}
        phoneSafetyMode={false}
        recordingTitle="Governed recording"
        session={{
          id: "mode-1",
          effectiveRole: "reviewer",
          adminDisplayName: "Admin Example",
          baseRole: "admin",
          purpose: "Review the governed draft under direct oversight.",
          expiresAt: "2026-08-01T12:30:00.000Z",
        }}
      />,
    );

    expect(screen.getByLabelText("Admin action mode")).toBeVisible();
    expect(screen.getByText("Admin action mode: Reviewer")).toBeVisible();
    expect(screen.getByText("Admin Example (Admin)")).toBeVisible();
    expect(screen.getByText("Base role: Admin")).toBeVisible();
    expect(screen.getByText("Purpose: Review the governed draft under direct oversight.")).toBeVisible();
    expect(screen.getByText(`Expires ${formatDateTimeUtc("2026-08-01T12:30:00.000Z")}`)).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Exit action mode" }));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it("keeps self-approval entry absent when the server only allows reviewer mode", () => {
    render(
      <AdminActionModeBanner
        entryOptions={[{ effectiveRole: "reviewer" }]}
        onEnter={vi.fn()}
        onExit={vi.fn()}
        phoneSafetyMode={false}
        recordingTitle="Governed recording"
        session={null}
      />,
    );

    expect(screen.getByRole("button", { name: "Enter reviewer action mode" })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Enter approver action mode" })).not.toBeInTheDocument();
  });

  it("does not render action-mode entry in phone safety mode", () => {
    render(
      <AdminActionModeBanner
        entryOptions={[{ effectiveRole: "reviewer" }, { effectiveRole: "approver" }]}
        onEnter={vi.fn()}
        onExit={vi.fn()}
        phoneSafetyMode
        recordingTitle="Governed recording"
        session={null}
      />,
    );

    expect(screen.queryByRole("button", { name: "Enter reviewer action mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Enter approver action mode" })).not.toBeInTheDocument();
  });

  it("does not discard outside edits when expiry removes the active banner", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [session, setSession] = React.useState<{
        id: string;
        effectiveRole: "reviewer" | "approver";
        adminDisplayName: string;
        baseRole: "admin";
        purpose: string;
        expiresAt: string;
      } | null>({
        id: "mode-1",
        effectiveRole: "approver",
        adminDisplayName: "Admin Example",
        baseRole: "admin",
        purpose: "Approve the active governed revision.",
        expiresAt: "2026-08-01T12:30:00.000Z",
      });
      const [draft, setDraft] = React.useState("Local draft summary");

      return (
        <>
          <label htmlFor="draft-summary">Draft</label>
          <input id="draft-summary" onChange={(event) => setDraft(event.target.value)} value={draft} />
          <button type="button" onClick={() => setSession(null)}>
            Expire
          </button>
          <AdminActionModeBanner
            entryOptions={[{ effectiveRole: "reviewer" }]}
            onEnter={vi.fn()}
            onExit={vi.fn()}
            phoneSafetyMode={false}
            recordingTitle="Governed recording"
            session={session}
          />
        </>
      );
    }

    render(<Harness />);

    await user.clear(screen.getByLabelText("Draft"));
    await user.type(screen.getByLabelText("Draft"), "Preserved local draft");
    await user.click(screen.getByRole("button", { name: "Expire" }));

    expect(screen.getByLabelText("Draft")).toHaveValue("Preserved local draft");
    expect(screen.getByRole("button", { name: "Enter reviewer action mode" })).toBeVisible();
  });
});
