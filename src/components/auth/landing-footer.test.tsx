// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SOURCE_REPOSITORY_URL, getDocsGuideUrl } from "@/lib/site-links";
import { LandingFooter } from "./landing-footer";

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
});

describe("LandingFooter", () => {
  it("links the source repository with a new-tab external affordance and a destination-stating name", () => {
    render(<LandingFooter docsGuideUrl={null} />);

    const link = screen.getByRole("link", {
      name: "github.com/emolinaro/superscriber (opens in a new tab)",
    });

    expect(link).toHaveAttribute("href", SOURCE_REPOSITORY_URL);
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("renders no user-guide link when the guide is not configured", () => {
    render(<LandingFooter docsGuideUrl={null} />);

    expect(screen.getAllByRole("link")).toHaveLength(1);
    expect(screen.queryByText(/user guide/i)).toBeNull();
  });

  it("renders the user-guide link with a new-tab external affordance iff configured", () => {
    render(<LandingFooter docsGuideUrl="https://emolinaro.github.io/superscriber/" />);

    const link = screen.getByRole("link", {
      name: "emolinaro.github.io/superscriber (opens in a new tab)",
    });

    expect(link).toHaveAttribute("href", "https://emolinaro.github.io/superscriber/");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});

describe("getDocsGuideUrl", () => {
  it("returns null when SUPERSCRIBER_DOCS_URL is unset or blank", () => {
    expect(getDocsGuideUrl({})).toBeNull();
    expect(getDocsGuideUrl({ SUPERSCRIBER_DOCS_URL: "   " })).toBeNull();
  });

  it("returns the configured http(s) URL", () => {
    expect(
      getDocsGuideUrl({ SUPERSCRIBER_DOCS_URL: "https://emolinaro.github.io/superscriber/" }),
    ).toBe("https://emolinaro.github.io/superscriber/");
  });

  it("fails quiet on a value that is not an http(s) URL, leaving no dead link", () => {
    expect(getDocsGuideUrl({ SUPERSCRIBER_DOCS_URL: "not-a-url" })).toBeNull();
    expect(getDocsGuideUrl({ SUPERSCRIBER_DOCS_URL: "file:///etc/passwd" })).toBeNull();
  });
});
