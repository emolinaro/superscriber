/**
 * Quiet, factual outbound links rendered on the app surface.
 *
 * The source link always points at the public repository; it is the
 * project's permanent home and needs no configuration.
 *
 * `SUPERSCRIBER_DOCS_URL` is the opt-in switch for the hosted user-guide
 * link. The GitHub Pages guide (https://emolinaro.github.io/superscriber/)
 * is not live yet (docs PR unmerged, Pages workflow disabled), so the
 * switch stays hidden-until-configured: when unset (or set to anything that
 * is not an http(s) URL) the footer renders nothing for the guide and
 * leaves no dead link; once the guide is published, an operator sets e.g.
 *
 *   SUPERSCRIBER_DOCS_URL=https://emolinaro.github.io/superscriber/
 *
 * and the guide link renders next to the source link. See the Container
 * Runtime section of README.md for the operator-facing note.
 */
export const SOURCE_REPOSITORY_URL = "https://github.com/emolinaro/superscriber";

export function getDocsGuideUrl(
  env: Record<string, string | undefined> = process.env,
): string | null {
  const raw = env.SUPERSCRIBER_DOCS_URL?.trim();
  if (!raw) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return null;
  }

  return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
}
