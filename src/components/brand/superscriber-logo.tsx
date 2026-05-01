type SuperscriberLogoProps = {
  tone?: "light" | "inverse";
  size?: "sm" | "md" | "lg";
  showDescriptor?: boolean;
  className?: string;
};

function classNames(values: Array<string | false | null | undefined>) {
  return values.filter(Boolean).join(" ");
}

export function SuperscriberLogo({
  tone = "light",
  size = "md",
  showDescriptor = false,
  className,
}: SuperscriberLogoProps) {
  return (
    <div
      className={classNames([
        "superscriber-logo",
        `superscriber-logo-${tone}`,
        `superscriber-logo-${size}`,
        className,
      ])}
    >
      <div className="superscriber-logo-lockup">
        <svg
          aria-hidden="true"
          className="superscriber-logo-mark"
          viewBox="0 0 64 64"
        >
          <rect
            className="superscriber-logo-mark-backing"
            height="56"
            rx="18"
            width="56"
            x="4"
            y="4"
          />
          <g transform="translate(0 64) scale(1 -1)">
            <path
              className="superscriber-logo-ribbon superscriber-logo-ribbon-primary"
              d="M15 15H38L49 24H26L15 15Z"
            />
            <path
              className="superscriber-logo-fold superscriber-logo-fold-right"
              d="M38 15L49 24L42 29L31 20L38 15Z"
            />
            <path
              className="superscriber-logo-ribbon superscriber-logo-ribbon-secondary"
              d="M26 28H49L38 37H15L26 28Z"
            />
            <path
              className="superscriber-logo-fold superscriber-logo-fold-left"
              d="M26 28L15 37L22 42L33 33L26 28Z"
            />
            <path
              className="superscriber-logo-ribbon superscriber-logo-ribbon-primary"
              d="M15 41H38L49 50H26L15 41Z"
            />
            <path
              className="superscriber-logo-fold superscriber-logo-fold-right"
              d="M38 41L49 50L42 55L31 46L38 41Z"
            />
          </g>
        </svg>

        <div className="superscriber-logo-wordmark">
          <div className="superscriber-logo-name" aria-label="Superscriber">
            <span className="superscriber-logo-name-prefix">Super</span>
            <span className="superscriber-logo-name-core">scriber</span>
          </div>
          {showDescriptor ? (
            <p className="superscriber-logo-descriptor">
              Governed transcription appliance
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}
