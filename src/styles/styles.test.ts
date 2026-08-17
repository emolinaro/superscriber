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
  it("keeps every stylesheet structurally balanced", () => {
    for (const entry of readdirSync(STYLES_DIR).filter((file) =>
      file.endsWith(".css"),
    )) {
      const css = readFileSync(resolve(STYLES_DIR, entry), "utf8");
      const open = (css.match(/\{/g) ?? []).length;
      const close = (css.match(/\}/g) ?? []).length;
      expect(
        { file: entry, open, close },
        `${entry} has ${open} "{" but ${close} "}"`,
      ).toEqual({ file: entry, open: close, close });
    }
  });

  it("keeps the exact hardened tokens and bans legacy visual grammar", () => {
    const css = readAllProductCss();

    expect(css).toContain("--color-teal-700: #163d38");
    expect(css).toContain("--color-focus: #0b6f64");
    expect(css).toContain("--motion-fast: 120ms");
    expect(css).toContain("--motion-slow: 180ms");
    expect(css).toContain("--type-44: 44px");
    expect(css).not.toMatch(/waveform|annotation-rail|queue-card|gradient|backdrop-filter|legacy\.css/);
  });

  it("declares the appearance system: explicit dark tokens with system-mode parity", () => {
    const tokens = readFileSync(resolve(STYLES_DIR, "tokens.css"), "utf8");

    // Rendering contract: data-theme on <html> wins; without it the media
    // query follows the OS. Light stays the canonical default.
    expect(tokens).toContain("color-scheme: light dark");
    expect(tokens).toContain('[data-theme="dark"]');
    expect(tokens).toContain("@media (prefers-color-scheme: dark)");
    expect(tokens).toContain(
      ':root:not([data-theme="light"]):not([data-theme="dark"])',
    );

    // The same override arms both the explicit selector and the system
    // fallback: identical dark token sets in each.
    for (const token of [
      "--color-bone",
      "--color-paper",
      "--color-ink",
      "--color-muted",
      "--color-line",
      "--color-teal-700",
      "--color-focus",
      "--color-on-primary",
      "--color-on-danger",
      "--color-raised",
      "--color-selected",
    ]) {
      expect(tokens).toMatch(new RegExp(`:root\\s*\\{[^}]*${token}:`, "m"));
      const explicitBlock = tokens.match(/\[data-theme="dark"\]\s*\{([^}]*)\}/);
      expect(explicitBlock?.[1]).toContain(`${token}:`);
      const systemBlock = tokens.match(
        /@media \(prefers-color-scheme: dark\)[\s\S]*?:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\)\s*\{([^}]*)\}/,
      );
      expect(systemBlock?.[1]).toContain(`${token}:`);
    }
  });

  it("keeps filled controls on on-role text instead of hard-coded white", () => {
    const css = readAllProductCss();

    const primary = css.match(/\.button-primary\s*\{([^}]*)\}/);
    expect(primary?.[1]).toContain("color: var(--color-on-primary)");
    expect(css).not.toContain("color: #fff;");
  });

  it("keeps visited auth doors at their tab colors", () => {
    const auth = readFileSync(resolve(STYLES_DIR, "auth.css"), "utf8");
    const visited = auth.match(/\.auth-tabs__tab:visited\s*\{([^}]*)\}/);
    const selectedVisited = auth.match(
      /\.auth-tabs__tab\[data-selected="true"\]:visited\s*\{([^}]*)\}/,
    );

    expect(visited?.[1]).toContain("color: var(--color-teal-700)");
    expect(selectedVisited?.[1]).toContain("color: var(--color-on-primary)");
  });

  it("leaves no literal light fills that would glare or wash out in dark mode", () => {
    // brand.css is exempt: its light block anchors the mark's light backdrop
    // deliberately, and its dark retone carries the mode adaptation.
    const adaptiveCss = [
      "tokens.css",
      "base.css",
      "shell.css",
      "auth.css",
      "inbox.css",
      "ingest.css",
      "casefile.css",
      "administration.css",
      "responsive.css",
    ]
      .map((entry) => readFileSync(resolve(STYLES_DIR, entry), "utf8"))
      .join("\n");

    expect(adaptiveCss).not.toContain("#fff7f5");
    expect(adaptiveCss).not.toContain("rgba(255, 252, 246");
    expect(adaptiveCss).not.toContain("rgba(247, 243, 234");
    expect(adaptiveCss).not.toMatch(/background:\s*rgba\(255, 255, 255/);
  });

  it("retones the wordmark for dark with explicit and system selectors in parity", () => {
    const brand = readFileSync(resolve(STYLES_DIR, "brand.css"), "utf8");

    expect(brand).toContain('[data-theme="dark"] .superscriber-logo');
    expect(brand).toMatch(
      /@media \(prefers-color-scheme: dark\)[\s\S]*?:root:not\(\[data-theme="light"\]\):not\(\[data-theme="dark"\]\) \.superscriber-logo/,
    );
    expect(brand).toContain("--logo-wordmark");
  });

  it("keeps the active segment rail chip on theme tokens so dark mode stays WCAG AA", () => {
    // Literal light fills previously stranded pale dark-mode text below the
    // 4.5:1 contrast floor.
    const casefile = readFileSync(resolve(STYLES_DIR, "casefile.css"), "utf8");
    const activeChip = casefile.match(
      /\.media-transport__rail-chip\[data-active\]\s*\{([^}]*)\}/,
    );
    expect(activeChip?.[1]).toContain("background: var(--color-selected)");
    expect(activeChip?.[1]).toContain("var(--color-teal-700)");
    expect(activeChip?.[1]).not.toContain("rgba(232, 246, 239");
    expect(activeChip?.[1]).not.toContain("rgba(42, 118, 94");
  });

  it("caps standalone auth doors without resetting nested confirmation spacing", () => {
    // Both reset routes render outside the app shell and share this width cap.
    const auth = readFileSync(resolve(STYLES_DIR, "auth.css"), "utf8");
    const shell = auth.match(/\.auth-shell\s*\{([^}]*)\}/);
    expect(shell?.[1]).toContain("var(--form-max)");
    expect(shell?.[1]).toContain("margin-inline: auto");
    expect(auth).toMatch(
      /\.auth-shell__card > \.panel-inner\.stack > h1,\s*\.auth-shell__card > \.panel-inner\.stack > p\s*\{[^}]*margin: 0;/,
    );
    expect(auth).not.toMatch(/\.auth-shell__card\s+(?:h1|p)/);
    const tokens = readFileSync(resolve(STYLES_DIR, "tokens.css"), "utf8");
    expect(tokens).toMatch(/:root\s*\{[^}]*--form-max:/m);
  });

  it("keeps the account menu appearance picker styled", () => {
    const shell = readFileSync(resolve(STYLES_DIR, "shell.css"), "utf8");

    expect(shell).toContain(".account-menu__appearance");
    expect(shell).toContain(".account-menu__appearance-option");
  });

  it("stacks the pinned desktop transport above a centered transcript", () => {
    // visible-context: on >=1100px the casefile page window-scrolls - no
    // bounded shell, no nested transcript scrollport - and the media player
    // PINS in a band above the centered transcript. Symmetric scroll-padding
    // makes scrollIntoView block:"center" land the active segment on the
    // exact vertical viewport middle.
    const casefile = readFileSync(resolve(STYLES_DIR, "casefile.css"), "utf8");
    expect(casefile).not.toContain("player-clearance");
    expect(casefile).not.toContain(
      ".casefile-page:has(> .casefile-layout > .casefile-main[data-revision=\"true\"]) {",
    );
    // casefile.css holds several >=1100px media blocks (workbench,
    // banner density, summary density); the scroll targeting lives in the
    // one carrying the scroll-padding rule.
    const desktopBlocks = [
      ...casefile.matchAll(/@media \(min-width: 1100px\) \{([\s\S]*?)\n\}\n/g),
    ].map((match) => match[1]);
    const desktopBlock = desktopBlocks.find((block) =>
      block.includes("scroll-padding-block"),
    );
    expect(desktopBlock).toBeDefined();
    expect(desktopBlock).toMatch(
      /html:has\(\.casefile-page\)\s*\{\s*scroll-padding-block: var\(--action-bar-clearance/,
    );
    // Vertical workbench: the single-column main stacks the player above a
    // centered transcript. The transport's own two-column band bounds its
    // height so the transcript zone always shares the first viewport.
    expect(desktopBlock).toMatch(
      /\.casefile-main\[data-revision="true"\]\s*\{[^}]*grid-template-columns: minmax\(0, 1fr\)/,
    );
    expect(desktopBlock).toMatch(
      /\.casefile-main\[data-revision="true"\] \.media-transport\s*\{[^}]*position: sticky;\s*top: 0;[^}]*grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1fr\)/s,
    );
    expect(desktopBlock).toMatch(
      /\.casefile-main\[data-revision="true"\] \.transcript-document\s*\{[^}]*width: 100%;[^}]*max-width: var\(--work-max\);[^}]*justify-self: center/s,
    );
    expect(desktopBlock).toMatch(
      /\.media-transport__controls video\s*\{[^}]*max-height: 34vh/,
    );
    // Rest-state readability: the action-mode banner compacts into a
    // wrapped row so the first segment card stays above the fold.
    expect(casefile).toMatch(
      /@media \(min-width: 1100px\)[\s\S]*?\.casefile-page \.action-mode-banner\s*\{[^}]*display: flex/,
    );
    const baseTransport = casefile.match(/\.media-transport\s*\{([^}]*)\}/);
    expect(baseTransport?.[1]).toContain("position: static");
    // Chrome parking is banned on casefile pages at every width.
    expect(casefile).toMatch(
      /body:has\(\.casefile-page\) \.app-shell__header,[\s\S]*?\.case-header\s*\{[^}]*position: static/,
    );
    // No segment clamping ever: the editor hugs its content instead.
    const segmentEditor = casefile.match(
      /\.transcript-segment textarea\s*\{([^}]*)\}/,
    );
    expect(segmentEditor?.[1]).toContain("field-sizing: content");
    expect(segmentEditor?.[1]).not.toContain("8rem");
    expect(casefile).not.toMatch(/line-clamp/);

    const responsive = readFileSync(resolve(STYLES_DIR, "responsive.css"), "utf8");
    const windowScrollMedia = responsive.match(
      /@media \(max-width: 1099px\) \{([\s\S]*?)\n\}\n/,
    );
    // Below 1100px the transport stays viewport-pinned with its own
    // asymmetric clearance (the desktop window-scroll contract above does
    // not apply there).
    const windowTransport = windowScrollMedia?.[1].match(/\.media-transport\s*\{([^}]*)\}/);
    expect(windowTransport?.[1]).toContain("position: sticky");
    expect(windowTransport?.[1]).toContain("top: 0");
    expect(windowScrollMedia?.[1]).toContain(
      "scroll-padding-top: var(--player-clearance",
    );
    expect(windowScrollMedia?.[1]).toContain(
      "scroll-padding-bottom: var(--action-bar-clearance",
    );
    const compactVideo = windowScrollMedia?.[1].match(
      /\.media-transport__controls video\s*\{([^}]*)\}/,
    );
    expect(compactVideo?.[1]).toContain("max-height: 42vh");
    expect(compactVideo?.[1]).toContain("object-fit: contain");
    expect(windowScrollMedia?.[1]).toMatch(
      /\.media-transport__rail\s*\{[^}]*display: none/,
    );
    const compactRate = windowScrollMedia?.[1].match(
      /\.media-transport__rate-field\s*\{([^}]*)\}/,
    );
    expect(compactRate?.[1]).toContain("display: flex");
    expect(compactRate?.[1]).toContain("min-width: 0");

    const phoneMedia = responsive.match(
      /@media \(max-width: 767px\), \(max-height: 767px\) and \(pointer: coarse\) \{([\s\S]*?)\n\}/,
    );
    expect(phoneMedia?.[1]).toMatch(
      /\.media-transport__actions\s*\{[^}]*grid-template-columns: 1fr 1fr/,
    );
    expect(responsive).toContain(
      "@media (max-width: 1099px) and (max-height: 767px) and (pointer: coarse) and (orientation: landscape)",
    );
  });

  it("centers the file-input chooser row with symmetric block padding", () => {
    const base = readFileSync(resolve(STYLES_DIR, "base.css"), "utf8");

    // base.css owns the browser-layout rationale; this test pins the accepted
    // shared-rule contract.
    const rule = base.match(/input\[type="file"\]\s*\{([^}]*)\}/);
    expect(rule?.[1]).toContain("padding-block: 9px");
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
    expect(css).toContain("top: 0");
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
