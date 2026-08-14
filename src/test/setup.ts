import "@testing-library/jest-dom/vitest";

// jsdom does not implement these browser APIs; provide inert defaults so
// component tests can render code paths that consult them. Individual tests
// override with spies when they need to assert on them.
if (typeof window !== "undefined" && typeof window.matchMedia !== "function") {
  window.matchMedia = ((query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as typeof window.matchMedia;
}

if (
  typeof window !== "undefined" &&
  typeof window.HTMLElement.prototype.scrollIntoView !== "function"
) {
  window.HTMLElement.prototype.scrollIntoView = () => {};
}

if (
  typeof window !== "undefined" &&
  typeof window.HTMLElement.prototype.scrollTo !== "function"
) {
  window.HTMLElement.prototype.scrollTo = () => {};
}
