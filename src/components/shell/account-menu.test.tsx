// @vitest-environment jsdom

import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal } from "@/domain/models";
import { AccountMenu } from "./account-menu";

vi.mock("@/components/auth/logout-button", () => ({
  LogoutButton: () => <button type="button">Sign out</button>,
}));

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

const PRINCIPAL: Principal = {
  userId: "user-1",
  displayName: "Alex Example",
  email: "alex@example.com",
  role: "reviewer",
};

describe("AccountMenu appearance picker", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: createStorage(),
    });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ themePreference: "system" }), {
        status: 200,
      }),
    );
  });

  afterEach(() => {
    cleanup();
    window.localStorage.clear();
    document.documentElement.removeAttribute("data-theme");
    document.documentElement.style.colorScheme = "";
    vi.restoreAllMocks();
  });

  it("offers System, Light, and Dark as a radio group inside the menu", async () => {
    const user = userEvent.setup();
    render(<AccountMenu principal={PRINCIPAL} />);

    await user.click(screen.getByRole("button", { name: "Open account menu" }));

    const group = screen.getByRole("group", { name: "Appearance" });
    const radios = Array.from(group.querySelectorAll("input[type=radio]"));
    expect(radios).toHaveLength(3);
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "Light" })).not.toBeChecked();
    expect(screen.getByRole("radio", { name: "Dark" })).not.toBeChecked();
  });

  it("applies Dark immediately and persists the choice", async () => {
    const user = userEvent.setup();
    const fetchSpy = vi.mocked(globalThis.fetch);
    render(<AccountMenu principal={PRINCIPAL} />);

    await user.click(screen.getByRole("button", { name: "Open account menu" }));
    await user.click(screen.getByRole("radio", { name: "Dark" }));

    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(window.localStorage.getItem("superscriber.theme")).toBe("dark");
    expect(document.documentElement.getAttribute("data-theme")).toBe("dark");
    await waitFor(() => {
      const posts = fetchSpy.mock.calls.filter(
        ([, init]) => init?.method === "POST",
      );
      expect(posts).toHaveLength(1);
      expect(JSON.parse(String(posts[0]?.[1]?.body))).toEqual({
        themePreference: "dark",
      });
    });
  });

  it("reflects the boot preference until the server copy lands", async () => {
    window.localStorage.setItem("superscriber.theme", "light");
    let resolveGet!: (response: Response) => void;
    vi.mocked(globalThis.fetch).mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          resolveGet = resolve;
        }),
    );
    const user = userEvent.setup();
    render(<AccountMenu principal={PRINCIPAL} />);

    await user.click(screen.getByRole("button", { name: "Open account menu" }));

    // Pre-sync: the boot copy drives the picker.
    expect(await screen.findByRole("radio", { name: "Light" })).toBeChecked();

    // The server copy is the durable truth and corrects stale boot state.
    resolveGet(
      new Response(JSON.stringify({ themePreference: "system" }), {
        status: 200,
      }),
    );
    expect(await screen.findByRole("radio", { name: "System" })).toBeChecked();
  });
});
