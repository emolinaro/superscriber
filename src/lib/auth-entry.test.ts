import { describe, expect, it } from "vitest";
import {
  buildAuthEntryHref,
  parseAuthEntryParam,
  resolveAuthEntry,
} from "./auth-entry";

describe("parseAuthEntryParam", () => {
  it("accepts the two exact door keys", () => {
    expect(parseAuthEntryParam("signup")).toBe("signup");
    expect(parseAuthEntryParam("signin")).toBe("signin");
  });

  it("rejects anything else so the server default decides", () => {
    expect(parseAuthEntryParam(undefined)).toBeNull();
    expect(parseAuthEntryParam("")).toBeNull();
    expect(parseAuthEntryParam("SignUp")).toBeNull();
    expect(parseAuthEntryParam("sign-up")).toBeNull();
    expect(parseAuthEntryParam("signup ")).toBeNull();
    expect(parseAuthEntryParam("admin")).toBeNull();
  });
});

describe("resolveAuthEntry", () => {
  it("honours the requested entry in the provisioned steady state", () => {
    expect(
      resolveAuthEntry({
        requested: "signup",
        completedNotice: false,
        signUpSurface: "provisioned",
      }),
    ).toBe("signup");
    expect(
      resolveAuthEntry({
        requested: "signin",
        completedNotice: false,
        signUpSurface: "provisioned",
      }),
    ).toBe("signin");
  });

  it("defaults to Sign in when nothing is requested on a provisioned appliance", () => {
    expect(
      resolveAuthEntry({
        requested: null,
        completedNotice: false,
        signUpSurface: "provisioned",
      }),
    ).toBe("signin");
  });

  it("forces Sign up for first-run and recovery surfaces, ignoring the param", () => {
    for (const signUpSurface of ["first-run", "recovery", "recovery-break-glass"] as const) {
      expect(
        resolveAuthEntry({ requested: "signin", completedNotice: false, signUpSurface }),
      ).toBe("signup");
      expect(
        resolveAuthEntry({ requested: null, completedNotice: false, signUpSurface }),
      ).toBe("signup");
    }
  });

  it("forces Sign in on completion notices, overriding both the surface and the param", () => {
    for (const signUpSurface of [
      "first-run",
      "provisioned",
      "recovery",
      "recovery-break-glass",
    ] as const) {
      expect(
        resolveAuthEntry({ requested: "signup", completedNotice: true, signUpSurface }),
      ).toBe("signin");
      expect(
        resolveAuthEntry({ requested: null, completedNotice: true, signUpSurface }),
      ).toBe("signin");
    }
  });
});

describe("buildAuthEntryHref", () => {
  it("sets the entry param on the landing path", () => {
    expect(buildAuthEntryHref({}, "signup")).toBe("/?entry=signup");
    expect(buildAuthEntryHref({}, "signin")).toBe("/?entry=signin");
  });

  it("preserves return paths, notices, and other params", () => {
    expect(
      buildAuthEntryHref(
        { returnTo: "/cases", reason: "session-expired", error: "access_denied" },
        "signup",
      ),
    ).toBe("/?returnTo=%2Fcases&reason=session-expired&error=access_denied&entry=signup");
  });

  it("replaces a stale entry param instead of duplicating it", () => {
    expect(buildAuthEntryHref({ entry: "signin" }, "signup")).toBe("/?entry=signup");
  });

  it("keeps repeated params and drops undefined values", () => {
    expect(
      buildAuthEntryHref({ tag: ["a", "b"], skip: undefined, notice: "logged-out" }, "signin"),
    ).toBe("/?tag=a&tag=b&notice=logged-out&entry=signin");
  });
});
