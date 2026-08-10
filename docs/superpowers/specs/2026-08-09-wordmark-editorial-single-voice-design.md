# Superscriber Editorial Single Voice Wordmark Design

**Date:** 2026-08-09

**Status:** Approved and implemented in `8d2039f`

**Approved direction:** B - Editorial single voice, with no additional notes

## Decision source

This design adopts the completed wordmark exploration without reopening it:

- Exploration report: `/Users/molinaro/.treehouse/firstmate-7bab20/2/firstmate/data/superscriber-wordmark-directions/report.md`
- Captain decision: `/Users/molinaro/.treehouse/firstmate-7bab20/2/firstmate/data/superscriber-wordmark-directions/wordmark-direction-review-decision.md`
- Preserved reference: `/Users/molinaro/.treehouse/firstmate-7bab20/2/firstmate/data/superscriber-wordmark-directions/evidence/captain-wordmark-reference.png`

The captain selected Direction B and supplied no notes. Direction A, Direction C, and further visual exploration are not part of this work.

## Objective

Make the linked Superscriber header wordmark read as one editorial name before its internal `Super` / `scriber` split. The whole name uses the already bundled Newsreader variable face at one optical height. `Super` remains sentence case at a lighter weight, while `scriber` uses a heavier weight.

The change must preserve the product's existing mark, shell, accessibility, offline, responsive, and color contracts. It also repairs the tracked-style drift that prevents a clean build of current `main` from reproducing the established logo treatment.

## Current state and reconciled drift

`src/components/brand/superscriber-logo.tsx` still renders the complete folded-ribbon SVG and the historical `.superscriber-logo*` hooks. `src/components/shell/app-shell.tsx` still places the small logo inside a link to `/workspace`. Newsreader remains bundled and imported locally by `app/layout.tsx`.

The complete logo stylesheet introduced in `b8e38fb` was removed when `2ef883b` split `app/globals.css`, but it was not restored in any tracked stylesheet. Consequently, the component structure and established live/demo appearance disagree with a clean build from current `main`. The implementation adds the minimum dedicated tracked brand stylesheet and imports it from `app/globals.css`. The stylesheet restores the historical non-typographic logo contract and replaces only the approved wordmark typography.

No account-role or recording-lifecycle code, styles, tests, documentation, or in-flight branch work will be copied or modified.

## Visual contract

### Word construction

The existing DOM remains:

- accessible name on the wordmark container: `aria-label="Superscriber"`
- prefix span text: `Super`
- core span text: `scriber`

Both visible spans use `var(--font-display)`, which resolves to the bundled `"Newsreader Variable", serif`. There is no uppercase transform. The accessible name and visible spelling are both `Superscriber`.

### Direction B typography

The small header lockup is the primary implementation target and uses the exact selected exploration basis:

| Property | `Super` | `scriber` |
|---|---:|---:|
| Family | `var(--font-display)` | `var(--font-display)` |
| Size | `23.5px` | `23.5px` |
| Weight | `360` | `650` |
| Tracking | `-0.035em` | `-0.035em` |
| Case transform | `none` | `none` |
| Baseline | shared baseline | shared baseline |

The two spans use the exploration's `-0.03em` inter-span gap and the historical wordmark line-height of `0.94`. This produced a 122.08 by 23.08 px live wordmark in the approved comparison. These values are required in the product and must be verified optically at 1x and 2x device-pixel ratios.

The component's existing size API remains supported with one optical height at each size:

- `sm`: both spans `23.5px`, `-0.035em` tracking
- `md`: both spans `32px`, `-0.035em` tracking
- `lg`: both spans `52px`, `-0.04em` tracking, matching Direction B's enlarged inspection sample
- `lg` at the historical narrow breakpoint: both spans `35.2px`, with the historical large-lockup start alignment

No breakpoint may assign different font sizes to the two spans or alter the small header dimensions above.

### Preserved geometry

The folded-ribbon SVG markup, view box, paths, orientation, backing rectangle, and accessibility treatment remain byte-for-byte unchanged. The historical non-typographic logo geometry is restored without redesign:

- small mark: 48 by 48 px
- medium mark: 62 by 62 px
- large mark: 84 by 84 px
- small mark-to-wordmark gap: 12 px
- default mark-to-wordmark gap: 14 px
- centered lockup alignment
- existing mark shadow, wordmark wrapper, optional descriptor layout, inverse tone, and size class API
- header content row: 64 px minimum height with its existing 1 px bottom rule
- current desktop and below-960 px responsive grid behavior

The approved typography may change the wordmark's intrinsic width, but it must not change the shell's height, mark placement, responsive stacking breakpoint, page gutters, navigation, account controls, or produce a font-load layout jump. The lockup must remain on one line and must not overflow the document at supported widths or at 200 percent text zoom.

## Exact color invariants

No existing color declaration, token, alpha, foreground, accent, background, border, mark fill, focus color, or link state may change. The implementation may restore the established logo variables but may not alter their values.

### Product and header

| Role | Exact value |
|---|---|
| Page bone | `#f7f3ea` |
| Paper | `#fffcf6` |
| Default ink | `#172421` |
| Unvisited link | `#163d38` |
| Visited link / rust accent | `#a64b2a` |
| Focus | `#0b6f64` |
| Header background | `rgba(255, 252, 246, 0.96)` |
| Header bottom border | `#d8d8cf` |

Global anchor thickness and offset also remain `1px` and `0.18em`. The reference crop's rust underline is a visited-link state, not a new wordmark color.

### Light logo tone

| Role | Exact value |
|---|---|
| Mark backing | `rgba(255, 252, 246, 0.74)` |
| Mark backing line | `rgba(20, 36, 33, 0.08)` |
| Primary ribbon | `#173b38` |
| Secondary ribbon | `#28544f` |
| Right fold | `#d36b3e` |
| Left fold | `#b85c37` |
| `Super` foreground | `rgba(20, 36, 33, 0.62)` |
| `scriber` foreground | `#112a28` |
| Descriptor foreground | `rgba(20, 36, 33, 0.56)` |

### Inverse logo tone

| Role | Exact value |
|---|---|
| Mark backing | `rgba(255, 250, 243, 0.08)` |
| Mark backing line | `rgba(255, 255, 255, 0.1)` |
| Primary ribbon | `#f2f7f3` |
| Secondary ribbon | `#d7e7de` |
| Right fold | `#df875c` |
| Left fold | `#c96d4a` |
| `Super` foreground | `rgba(238, 246, 242, 0.72)` |
| `scriber` foreground | `#f6fbf8` |
| Descriptor foreground | `rgba(238, 246, 242, 0.64)` |

Focused browser assertions must compare computed values for the header, brand link, both wordmark spans, SVG backing and stroke, all four ribbon/fold fills, descriptor, and focus outline. They must prove unvisited and visited link behavior without changing application source or weakening browser privacy behavior.

## Offline font contract

The implementation reuses `@fontsource-variable/newsreader` version 5.3.0 under OFL-1.1. It is already a dependency and is already imported by `app/layout.tsx`.

There will be:

- no package or lockfile change
- no new `@font-face` source
- no external URL
- no runtime font request outside the application's bundled static assets
- no change to Public Sans or IBM Plex Mono loading

Browser evidence must show `document.fonts.check(...)` succeeds for Newsreader and that the wordmark's computed family is Newsreader after `document.fonts.ready`. Network evidence must show no new font request relative to the clean task build and no font request to a non-local origin.

## Semantics and interaction invariants

The authenticated header brand remains a Next.js link to `/workspace`. It keeps normal unvisited and visited link behavior, the global visible keyboard focus treatment, and the accessible name `Superscriber`. The SVG stays `aria-hidden="true"`, so assistive technology receives one brand name rather than path or split-span noise.

No new wrapper, control, route, animation, transition, descriptor copy, or link override is introduced. Primary navigation and account-menu semantics remain untouched.

## Implementation boundary

Expected product changes are limited to:

1. a dedicated `src/styles/brand.css` containing the minimum complete `.superscriber-logo*` contract;
2. one import in `app/globals.css`, ordered after tokens/base and before shell-specific layout;
3. focused logo render/style regression tests;
4. focused browser acceptance coverage using the existing E2E and browser tooling.

The logo component and app-shell component remain unchanged. Changing SVG markup, link markup, tokens, base anchor colors, shell geometry, responsive breakpoints, font dependencies, generated release metadata, or `CHANGELOG.md` is out of scope.

## Test-first acceptance

Implementation begins with focused tests that fail against the clean task branch. Together, tests and browser evidence must detect regression in:

- Newsreader family on both spans
- weights `360` and `650`
- sentence-case `Super` and lowercase `scriber`
- shared small size `23.5px`
- small tracking `-0.035em` and inter-span gap `-0.03em`
- one shared baseline and one-line lockup
- 48 px small SVG mark and unchanged lockup/header geometry
- no horizontal document overflow and no clipped vertical content
- exact accessible name `Superscriber`, hidden SVG, and `/workspace` link semantics
- all light/inverse logo, header, focus, visited, and unvisited colors listed above
- locally loaded Newsreader with no added dependency or external font request

The browser acceptance run must use a clean task build, not the shared demo lane, and capture:

1. current clean-branch behavior before product changes;
2. approved Direction B in the live header at desktop size;
3. an enlarged inspection of the implemented wordmark;
4. desktop and narrow responsive screenshots;
5. before/after header rectangles and font-ready measurements proving no horizontal or vertical jump;
6. computed-style color output proving every listed color invariant;
7. local font and network output;
8. accessible name, keyboard focus, 200 percent text zoom, overflow, and visited/unvisited link-state results.

The clean-main style loss must be visible in baseline evidence rather than hidden. Color comparison uses the established historical/live contract recorded above because the clean-main fallback is the drift being repaired.

## Validation and completion

Before the implementation commit, run the repository's relevant formatter if one is configured, focused tests, full unit/component tests, type checking, production build, worker syntax check, focused browser/E2E coverage, full browser/E2E coverage, and repository-level validation gates. Container E2E must follow the repository's port preflight guidance.

The implementation is one isolated product-facing change. It is committed on its feature branch, then handed to the no-mistakes lifecycle with yolo off. It is never merged by this worker.
