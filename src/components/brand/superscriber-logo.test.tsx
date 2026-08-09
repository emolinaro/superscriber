// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SuperscriberLogo } from "./superscriber-logo";

afterEach(cleanup);

describe("SuperscriberLogo", () => {
  it("keeps one accessible name around the exact split visible word", () => {
    const { container } = render(<SuperscriberLogo size="sm" />);
    const root = container.querySelector(".superscriber-logo");
    const name = container.querySelector(".superscriber-logo-name");
    const prefix = container.querySelector(".superscriber-logo-name-prefix");
    const core = container.querySelector(".superscriber-logo-name-core");
    const mark = container.querySelector("svg.superscriber-logo-mark");

    expect(root).toHaveClass("superscriber-logo-light", "superscriber-logo-sm");
    expect(name).toHaveAttribute("aria-label", "Superscriber");
    expect(name).toHaveTextContent("Superscriber");
    expect(prefix).toHaveTextContent(/^Super$/);
    expect(core).toHaveTextContent(/^scriber$/);
    expect(mark).toHaveAttribute("aria-hidden", "true");
    expect(mark).toHaveAttribute("viewBox", "0 0 64 64");
  });

  it("keeps inverse, large, custom-class, SVG path, and descriptor hooks", () => {
    const { container } = render(
      <SuperscriberLogo
        className="review-fixture"
        showDescriptor
        size="lg"
        tone="inverse"
      />,
    );

    expect(container.firstElementChild).toHaveClass(
      "superscriber-logo",
      "superscriber-logo-inverse",
      "superscriber-logo-lg",
      "review-fixture",
    );
    expect(container.querySelectorAll("svg path")).toHaveLength(6);
    expect(screen.getByText("Governed transcription appliance")).toHaveClass(
      "superscriber-logo-descriptor",
    );
  });
});
