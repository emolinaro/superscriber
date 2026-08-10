import { readFileSync } from "node:fs";
import { z } from "zod";

/**
 * Management boundary evaluation (plan section 8.2).
 *
 * The deployment firewall/ingress is the primary control restricting
 * emergency routes to management networks; this evaluator is the
 * application-side defense-in-depth. Forwarding headers are trusted only
 * when the terminal hop is a configured trusted proxy, because server route
 * handlers cannot see the connection peer. Anything unverifiable fails
 * closed to zone "public".
 */

const policySchema = z
  .object({
    managementNetworks: z.array(z.string().min(1)).default([]),
    trustedProxies: z.array(z.string().min(1)).default([]),
  })
  .strict();

export type ManagementNetworkPolicy = z.infer<typeof policySchema>;

function parseIpv4(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) {
    return null;
  }
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) {
      return null;
    }
    const octet = Number(part);
    if (octet > 255) {
      return null;
    }
    value = (value << 8) + octet;
  }
  return value >>> 0;
}

function ipv4InCidr(ip: string, cidr: string): boolean | null {
  const [base, prefixRaw] = cidr.split("/");
  const prefix = Number(prefixRaw);
  const baseInt = parseIpv4(base);
  const ipInt = parseIpv4(ip);
  if (baseInt === null || ipInt === null || !Number.isInteger(prefix) || prefix < 0 || prefix > 32) {
    return null;
  }
  const mask = prefix === 0 ? 0 : (~0 << (32 - prefix)) >>> 0;
  return (baseInt & mask) === (ipInt & mask);
}

function validatePolicy(policy: ManagementNetworkPolicy, path: string) {
  for (const network of policy.managementNetworks) {
    const valid = network.includes("/")
      ? ipv4InCidr(network.split("/")[0], network) !== null
      : parseIpv4(network) !== null;
    if (!valid) {
      throw new Error(
        `Management network policy ${path}: invalid entry in managementNetworks: ${network}`,
      );
    }
  }
  for (const proxy of policy.trustedProxies) {
    if (parseIpv4(proxy) === null) {
      throw new Error(
        `Management network policy ${path}: invalid entry in trustedProxies: ${proxy}`,
      );
    }
  }
}

export function loadManagementNetworkPolicy(path: string): ManagementNetworkPolicy {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
    JSON.parse(raw); // pre-parse to distinguish unreadable vs malformed
  } catch (error) {
    throw new Error(
      `Management network policy ${path} is unreadable or not JSON (${(error as Error).message.split("\n")[0]}).`,
    );
  }

  const parsed = policySchema.safeParse(JSON.parse(raw));
  if (!parsed.success) {
    throw new Error(`Management network policy ${path} failed validation.`);
  }
  validatePolicy(parsed.data, path);
  return parsed.data;
}

type HeaderSource =
  | Headers
  | Record<string, string | string[] | undefined>;

function readForwardedFor(headers: HeaderSource): string | null {
  if (typeof (headers as Headers).get === "function") {
    return (headers as Headers).get("x-forwarded-for");
  }
  const record = headers as Record<string, string | string[] | undefined>;
  const value = record["x-forwarded-for"] ?? record["X-Forwarded-For"];
  return Array.isArray(value) ? value[0] : value ?? null;
}

export type SourceZone = "management" | "public";

/**
 * Evaluates the current request's source zone from its headers against the
 * mounted policy file. Any failure fails closed to public.
 */
export function evaluateRequestZone(headers: HeaderSource): SourceZone {
  const policyPath = process.env.SUPERSCRIBER_MANAGEMENT_NETWORKS_FILE?.trim();
  if (!policyPath) {
    return "public";
  }
  try {
    return evaluateSourceZone(headers, loadManagementNetworkPolicy(policyPath)).zone;
  } catch {
    return "public";
  }
}

/**
 * Client-IP resolution for unauthenticated rate limiting. When a
 * management-network policy is mounted, forwarding headers are honored only
 * under its trusted-proxy semantics; anything unverifiable fails closed to
 * null (one shared rate-limit bucket), so rotating XFF hops cannot bypass
 * per-IP budgets. Without a policy, the raw first XFF hop is used.
 */
export function resolveClientIp(headers: HeaderSource): string | null {
  const policyPath = process.env.SUPERSCRIBER_MANAGEMENT_NETWORKS_FILE?.trim();
  if (!policyPath) {
    return readForwardedFor(headers)?.split(",")[0]?.trim() || null;
  }
  try {
    return evaluateSourceZone(headers, loadManagementNetworkPolicy(policyPath)).clientIp;
  } catch {
    return null;
  }
}

export function evaluateSourceZone(
  headers: HeaderSource,
  policy: ManagementNetworkPolicy,
): { zone: SourceZone; clientIp: string | null } {
  const header = readForwardedFor(headers);
  if (!header || policy.trustedProxies.length === 0) {
    return { zone: "public", clientIp: null };
  }

  const hops = header
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);

  // The terminal hop must be a configured trusted proxy; otherwise the whole
  // header may be client-supplied and is untrusted.
  if (hops.length === 0 || !policy.trustedProxies.includes(hops[hops.length - 1])) {
    return { zone: "public", clientIp: null };
  }

  // Walk right-to-left past trusted proxies; the first untrusted hop is the
  // client address asserted by the outermost trusted proxy.
  let index = hops.length - 1;
  while (index >= 0 && policy.trustedProxies.includes(hops[index])) {
    index -= 1;
  }
  const clientIp = index >= 0 ? hops[index] : null;
  if (!clientIp) {
    return { zone: "public", clientIp: null };
  }

  const management = policy.managementNetworks.some((network) =>
    network.includes("/")
      ? ipv4InCidr(clientIp, network) === true
      : network === clientIp,
  );

  return { zone: management ? "management" : "public", clientIp };
}
