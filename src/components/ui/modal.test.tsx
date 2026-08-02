// @vitest-environment jsdom

import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import { Modal } from "./modal";

function ModalTestHarness() {
  const [open, setOpen] = useState(false);

  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Modal
        description="Confirm the governed action."
        open={open}
        onClose={() => setOpen(false)}
        title="Confirm action"
      >
        <button type="button">Secondary action</button>
        <button type="button" onClick={() => setOpen(false)}>
          Close modal
        </button>
      </Modal>
    </>
  );
}

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Modal", () => {
  it("traps modal focus, makes the app inert, closes on Escape, and restores focus", async () => {
    const user = userEvent.setup();
    const appRoot = document.createElement("div");
    appRoot.id = "app-root";
    document.body.append(appRoot);

    render(<ModalTestHarness />, { container: appRoot });

    await user.click(screen.getByRole("button", { name: "Open" }));
    expect(screen.getByRole("dialog", { name: "Confirm action" })).toBeVisible();
    expect(document.querySelector("#app-root")).toHaveAttribute("inert");
    expect(document.body).toHaveStyle({ overflow: "hidden" });

    await user.tab();
    expect(screen.getByRole("button", { name: "Close modal" })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("button", { name: "Secondary action" })).toHaveFocus();

    await user.keyboard("{Escape}");
    expect(screen.getByRole("button", { name: "Open" })).toHaveFocus();
    expect(document.querySelector("#app-root")).not.toHaveAttribute("inert");
    expect(document.body.style.overflow).toBe("");
  });

  it("wires title and description for accessible dialog labelling", async () => {
    const user = userEvent.setup();
    const appRoot = document.createElement("div");
    appRoot.id = "app-root";
    document.body.append(appRoot);

    render(<ModalTestHarness />, { container: appRoot });

    await user.click(screen.getByRole("button", { name: "Open" }));

    const dialog = screen.getByRole("dialog", { name: "Confirm action" });
    expect(dialog).toHaveAttribute("aria-describedby");
    expect(screen.getByText("Confirm the governed action.")).toHaveAttribute(
      "id",
      dialog.getAttribute("aria-describedby"),
    );
  });
});
