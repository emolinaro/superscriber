export function appendQueryMessages(
  pathname: string,
  messages: Partial<Record<"notice" | "error", string>>,
) {
  const url = new URL(pathname, "http://localhost");

  if (messages.notice) {
    url.searchParams.set("notice", messages.notice);
  }
  if (messages.error) {
    url.searchParams.set("error", messages.error);
  }

  return `${url.pathname}${url.search}${url.hash}`;
}
