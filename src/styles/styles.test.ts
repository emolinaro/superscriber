import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const REPO_ROOT = resolve(__dirname, "../..");
const STYLES_DIR = resolve(REPO_ROOT, "src/styles");
const GLOBALS_PATH = resolve(REPO_ROOT, "app/globals.css");

function readAllProductCss() {
  const globalCss = readFileSync(GLOBALS_PATH, "utf8");
  const styleCss = readdirSync(STYLES_DIR)
    .filter((entry) => entry.endsWith(".css"))
    .sort()
    .map((entry) => readFileSync(resolve(STYLES_DIR, entry), "utf8"))
    .join("\n");

  return `${globalCss}\n${styleCss}`;
}

describe("product css contract", () => {
  it("keeps the exact hardened tokens and bans legacy visual grammar", () => {
    const css = readAllProductCss();

    expect(css).toContain("--color-teal-700: #163d38");
    expect(css).toContain("--color-focus: #0b6f64");
    expect(css).toContain("--motion-fast: 120ms");
    expect(css).toContain("--motion-slow: 180ms");
    expect(css).toContain("--type-44: 44px");
    expect(css).not.toMatch(/waveform|annotation-rail|queue-card|gradient|backdrop-filter|legacy\.css/);
  });

  it("keeps the exact responsive, sticky, reduced-motion, and export rules", () => {
    const css = readAllProductCss();

    expect(css).toContain("@media (prefers-reduced-motion: reduce)");
    expect(css).toContain("animation: none !important");
    expect(css).toContain("transition-duration: 0.01ms !important");
    expect(css).toContain("scroll-behavior: auto !important");
    expect(css).toContain("min-height: var(--type-44)");
    expect(css).toContain("html, body {");
    expect(css).toContain("overflow-x: clip");
    expect(css).toContain("top: 64px");
    expect(css).toContain("top: 132px");
    expect(css).toContain("bottom: 0");
    expect(css).toContain("position: fixed");
    expect(css).toContain("@media (max-width: 389px)");
    expect(css).toContain("390px");
    expect(css).toContain("@media (min-width: 768px) and (max-width: 959px)");
    expect(css).toContain("@media (min-width: 960px) and (max-width: 1099px)");
    expect(css).toContain("@media (min-width: 1100px)");
    expect(css).toContain("grid-template-columns: minmax(0, 7fr) minmax(280px, 3fr)");
  });
});
