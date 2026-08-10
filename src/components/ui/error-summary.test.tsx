// @vitest-environment jsdom

import { useId, useState } from "react";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});
import { EmptyState } from "./empty-state";
import { ErrorSummary } from "./error-summary";
import { InlineNotice } from "./inline-notice";
import { PageSkeleton } from "./page-skeleton";
import { StatusBadge } from "./status-badge";

function ErrorSummaryHarness() {
  const fieldId = useId();

  return (
    <>
      <ErrorSummary
        errors={[
          { fieldId, label: "Title", message: "Title is required." },
          { fieldId: "recording-language", label: "Language", message: "Choose a language." },
        ]}
      />
      <label htmlFor={fieldId}>Title</label>
      <input id={fieldId} />
      <label htmlFor="recording-language">Language</label>
      <select id="recording-language">
        <option>English</option>
      </select>
    </>
  );
}

describe("ErrorSummary", () => {
  it("focuses the summary and links to invalid fields", async () => {
    const user = userEvent.setup();
    render(<ErrorSummaryHarness />);

    const summary = screen.getByRole("alert", { name: "There is a problem" });
    await waitFor(() => {
      expect(summary).toHaveFocus();
    });

    await user.click(screen.getByRole("link", { name: "Title - Title is required." }));
    expect(screen.getByLabelText("Title")).toHaveFocus();
  });

  it("never re-steals focus while the same logical errors re-render (typing-focus)", async () => {
    const user = userEvent.setup();

    function Harness() {
      const [value, setValue] = useState("");
      return (
        <>
          {/* Callers rebuild the array per render; focus keys on content. */}
          <ErrorSummary
            errors={[{ fieldId: "demo-input", label: "Title", message: "Title is required." }]}
          />
          <label htmlFor="demo-input">Title</label>
          <input
            id="demo-input"
            onChange={(event) => setValue(event.target.value)}
            value={value}
          />
        </>
      );
    }

    render(<Harness />);

    const summary = screen.getByRole("alert", { name: "There is a problem" });
    await waitFor(() => expect(summary).toHaveFocus());

    await user.click(screen.getByLabelText("Title"));
    await user.type(screen.getByLabelText("Title"), "abc");

    expect(screen.getByLabelText("Title")).toHaveFocus();
    expect(screen.getByLabelText("Title")).toHaveValue("abc");
  });
});

describe("feedback primitives", () => {
  it("renders status text with an icon", () => {
    render(<StatusBadge tone="success">Verified</StatusBadge>);

    expect(screen.getByText("Verified")).toBeVisible();
    expect(document.querySelector(".status-badge__icon")).not.toBeNull();
  });

  it("renders an inline notice with accessible text", () => {
    render(<InlineNotice tone="warning">Review required</InlineNotice>);

    expect(screen.getByText("Review required")).toBeVisible();
    expect(screen.getByRole("status")).toHaveTextContent("Review required");
  });

  it("announces empty states and loading surfaces", () => {
    render(
      <>
        <EmptyState title="No assignments" description="Assignments will appear here." />
        <PageSkeleton surface="workspace" />
      </>
    );

    expect(screen.getByRole("status", { name: "No assignments" })).toHaveTextContent(
      "Assignments will appear here.",
    );
    expect(screen.getByRole("status", { name: "Loading workspace" })).toBeVisible();
  });
});
