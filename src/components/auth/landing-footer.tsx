import { SOURCE_REPOSITORY_URL } from "@/lib/site-links";

/**
 * Quiet, factual footer for the public auth landing: names the source and
 * governance home, and - only when the operator configured
 * `SUPERSCRIBER_DOCS_URL` - the hosted user guide. Both links open in a new
 * tab with `noopener noreferrer`, carry a visible external mark, and their
 * accessible names state the destination.
 */
function docsGuideDisplayText(docsUrl: string): string {
  try {
    const parsed = new URL(docsUrl);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.host}${path}`;
  } catch {
    return docsUrl;
  }
}

export function LandingFooter({ docsGuideUrl }: { docsGuideUrl: string | null }) {
  return (
    <footer className="auth-footer">
      <p className="auth-footer__line">
        Source &amp; governance:{" "}
        <a
          className="auth-footer__link"
          href={SOURCE_REPOSITORY_URL}
          target="_blank"
          rel="noopener noreferrer"
        >
          github.com/emolinaro/superscriber
          <span aria-hidden="true" className="auth-footer__external-mark">
            {" ↗"}
          </span>{" "}
          <span className="sr-only">(opens in a new tab)</span>
        </a>
      </p>
      {docsGuideUrl ? (
        <p className="auth-footer__line">
          User guide:{" "}
          <a
            className="auth-footer__link"
            href={docsGuideUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {docsGuideDisplayText(docsGuideUrl)}
            <span aria-hidden="true" className="auth-footer__external-mark">
              {" ↗"}
            </span>{" "}
            <span className="sr-only">(opens in a new tab)</span>
          </a>
        </p>
      ) : null}
    </footer>
  );
}
