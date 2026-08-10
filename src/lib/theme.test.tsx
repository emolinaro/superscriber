// @vitest-environment jsdom

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyThemeToDocument,
  readBootTheme,
  useThemePreference,
} from "./theme";

const STORAGE_KEY = "superscriber.theme";

// jsdom in this repo ships no localStorage (opaque origin); tests install a
// Map-backed stub like the ingest flow suite does.
function createStorage() {
  const store = new Map<string, string>();
  return {
    getItem: vi.fn((key: string) => store.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => {
      store.set(key, value);
    }),
    removeItem: vi.fn((key: string) => {
      store.delete(key);
    }),
    clear: vi.fn(() => {
      store.clear();
    }),
  };
}

beforeEach(() => {
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: createStorage(),
  });
});

function Probe() {
  const { theme, setTheme } = useThemePreference();
  return (
    <div>
      <output data-testid="theme">{theme}</output>
      <button type="button" onClick={() => setTheme("dark")}>
        pick-dark
      </button>
      <button type="button" onClick={() => setTheme("light")}>
        pick-light
      </button>
      <button type="button" onClick={() => setTheme("system")}>
        pick-system
      </button>
    </div>
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("readBootTheme", () => {
  afterEach(() => {
    window.localStorage.clear();
  });

  it("returns system when nothing is stored", () => {
    expect(readBootTheme()).toBe("system");
  });

  it("returns stored explicit choices only", () => {
    window.localStorage.setItem(STORAGE_KEY, "dark");
    expect(readBootTheme()).toBe("dark");
    window.localStorage.setItem(STORAGE_KEY, "light");
    expect(readBootTheme()).toBe("light");
    window.localStorage.setItem(STORAGE_KEY, "system");
    expect(readBootTheme()).toBe("system");
    window.localStorage.setItem(STORAGE_KEY, "solarized");
    expect(readBootTheme()).toBe("system");
  });
});

describe("applyThemeToDocument", () => {
  afterEach(() => {
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  it("sets data-theme and color-scheme for explicit choices", () => {
    applyThemeToDocument("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(document.documentElement.style.colorScheme).toBe("dark");

    applyThemeToDocument("light");
    expect(document.documentElement.getAttribute("data-theme")).toBe("light");
    expect(document.documentElement.style.colorScheme).toBe("light");
  });

  it("removes data-theme for system so the media query decides", () => {
    applyThemeToDocument("dark");
    applyThemeToDocument("system");
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(document.documentElement.style.colorScheme).toBe("");
  });
});

describe("useThemePreference", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
  });

  it("boots from localStorage before the server sync lands", async () => {
    window.localStorage.setItem(STORAGE_KEY, "dark");
    const get = deferred<Response>();
    vi.spyOn(globalThis, "fetch").mockImplementation(
      () => get.promise as Promise<Response>,
    );

    render(<Probe />);
    expect(await screen.findByTestId("theme")).toHaveTextContent("dark");

    get.resolve(
      new Response(JSON.stringify({ themePreference: "system" }), {
        status: 200,
      }),
    );
  });

  it("seeds a fresh device from the server copy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ themePreference: "dark" }), {
        status: 200,
      }),
    );

    render(<Probe />);
    expect(await screen.findByTestId("theme")).toHaveTextContent("dark");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });

  it("persists choices to localStorage, the document, and the server", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ themePreference: "system" }), {
        status: 200,
      }),
    );

    render(<Probe />);
    expect((await screen.findByTestId("theme")).textContent).toBe("system");

    await act(async () => {
      screen.getByRole("button", { name: "pick-dark" }).click();
    });

    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    const post = fetchSpy.mock.calls
      .map((call) => call[1])
      .find((init) => init?.method === "POST");
    expect(post).toBeDefined();
    expect(JSON.parse(String(post?.body))).toEqual({
      themePreference: "dark",
    });

    await act(async () => {
      screen.getByRole("button", { name: "pick-system" }).click();
    });
    expect(document.documentElement.hasAttribute("data-theme")).toBe(false);
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("system");
  });

  it("keeps and re-POSTs a stored local choice the server never saw", async () => {
    // An earlier setTheme POST failed offline; the stale server copy must
    // not stomp the local choice on the next mount, and the hook re-POSTs
    // the local choice so the server self-heals.
    window.localStorage.setItem(STORAGE_KEY, "dark");
    applyThemeToDocument(readBootTheme());
    const get = deferred<Response>();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        if (init?.method === "POST") {
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        void input;
        return get.promise as Promise<Response>;
      });

    render(<Probe />);
    expect(await screen.findByTestId("theme")).toHaveTextContent("dark");

    await act(async () => {
      get.resolve(
        new Response(JSON.stringify({ themePreference: "light" }), {
          status: 200,
        }),
      );
    });

    expect((await screen.findByTestId("theme")).textContent).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");
    const repost = fetchSpy.mock.calls
      .map((call) => call[1])
      .find((init) => init?.method === "POST");
    expect(repost).toBeDefined();
    expect(JSON.parse(String(repost?.body))).toEqual({
      themePreference: "dark",
    });
  });

  it("keeps a local choice made while the server sync was in flight", async () => {
    const get = deferred<Response>();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((input, init) => {
        if (init?.method === "POST") {
          return Promise.resolve(new Response("{}", { status: 200 }));
        }
        void input;
        return get.promise as Promise<Response>;
      });
    void fetchSpy;

    render(<Probe />);
    await act(async () => {
      screen.getByRole("button", { name: "pick-dark" }).click();
    });
    await act(async () => {
      get.resolve(
        new Response(JSON.stringify({ themePreference: "light" }), {
          status: 200,
        }),
      );
    });

    expect((await screen.findByTestId("theme")).textContent).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
  });
});
