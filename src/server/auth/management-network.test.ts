import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  evaluateSourceZone,
  loadManagementNetworkPolicy,
  resolveClientIp,
} from "@/server/auth/management-network";

describe("management network policy", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "superscriber-mgmtnet-"));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  });

  function writePolicy(contents: unknown) {
    const path = join(dir, "management-networks.json");
    writeFileSync(path, typeof contents === "string" ? contents : JSON.stringify(contents));
    return path;
  }

  const POLICY_PATH = () =>
    writePolicy({
      managementNetworks: ["10.10.0.0/16", "192.168.50.7"],
      trustedProxies: ["10.10.0.2"],
    });

  it("evaluates the client through trusted proxies only", () => {
    const policy = loadManagementNetworkPolicy(POLICY_PATH());

    // Direct chain: trusted proxy appended the client address.
    const management = evaluateSourceZone(
      { "x-forwarded-for": "10.10.4.9, 10.10.0.2" },
      policy,
    );
    expect(management).toEqual({ zone: "management", clientIp: "10.10.4.9" });

    // Public client through the same trusted proxy.
    expect(
      evaluateSourceZone({ "x-forwarded-for": "203.0.113.9, 10.10.0.2" }, policy),
    ).toEqual({ zone: "public", clientIp: "203.0.113.9" });
  });

  it("never trusts a forwarding header when no trusted proxy is the terminal hop", () => {
    const policy = loadManagementNetworkPolicy(POLICY_PATH());

    // Spoofable header without a trusted proxy terminal hop.
    expect(evaluateSourceZone({ "x-forwarded-for": "10.10.4.9" }, policy)).toEqual({
      zone: "public",
      clientIp: null,
    });

    // Terminal hop is not the configured proxy.
    expect(
      evaluateSourceZone({ "x-forwarded-for": "10.10.4.9, 172.16.0.9" }, policy),
    ).toEqual({ zone: "public", clientIp: null });

    // No header at all: source unverifiable, fail closed.
    expect(evaluateSourceZone({}, policy)).toEqual({ zone: "public", clientIp: null });
  });

  it("matches exact management IPs in addition to CIDRs", () => {
    const policy = loadManagementNetworkPolicy(POLICY_PATH());
    expect(
      evaluateSourceZone({ "x-forwarded-for": "192.168.50.7, 10.10.0.2" }, policy),
    ).toEqual({ zone: "management", clientIp: "192.168.50.7" });
    expect(
      evaluateSourceZone({ "x-forwarded-for": "192.168.50.8, 10.10.0.2" }, policy),
    ).toEqual({ zone: "public", clientIp: "192.168.50.8" });
  });

  it("resolves rate-limit client IPs under trusted-proxy semantics", () => {
    expect(resolveClientIp({ "x-forwarded-for": "203.0.113.9, 10.10.0.2" })).toBe(
      "203.0.113.9",
    );
    expect(resolveClientIp({})).toBeNull();

    vi.stubEnv("SUPERSCRIBER_MANAGEMENT_NETWORKS_FILE", POLICY_PATH());
    expect(resolveClientIp({ "x-forwarded-for": "203.0.113.9, 10.10.0.2" })).toBe(
      "203.0.113.9",
    );
    // With a policy mounted, an untrusted header fails closed to one shared
    // rate-limit bucket instead of trusting the spoofable first hop.
    expect(resolveClientIp({ "x-forwarded-for": "10.10.4.9" })).toBeNull();
  });

  it("rejects malformed policy files and unknown CIDRs", () => {
    expect(() => loadManagementNetworkPolicy(writePolicy("{no json"))).toThrow(/policy/i);
    expect(() =>
      loadManagementNetworkPolicy(
        writePolicy({ managementNetworks: ["999.1.1.1/8"], trustedProxies: [] }),
      ),
    ).toThrow(/managementNetworks/);
  });
});
