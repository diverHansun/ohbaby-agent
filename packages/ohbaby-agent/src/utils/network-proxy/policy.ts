import { BlockList, isIP } from "node:net";
import type { SystemProxySettings } from "./system.js";

export interface ProxyPolicy {
  status: string;
  route: (url: URL) => string | undefined;
}

export class ProxyConfigurationError extends Error {
  readonly code = "OHBABY_PROXY_CONFIG";
}

const hostName = (host: string): string =>
  host
    .replace(/^\[|\]$/g, "")
    .toLowerCase()
    .replace(/\.$/, "");
const loopback = new BlockList();
loopback.addSubnet("127.0.0.0", 8, "ipv4");
loopback.addAddress("::1", "ipv6");
export function isLoopback(host: string): boolean {
  const normalized = hostName(host);
  return (
    normalized === "localhost" ||
    loopback.check(normalized, isIP(normalized) === 6 ? "ipv6" : "ipv4")
  );
}

export function proxyEnvironment(env: NodeJS.ProcessEnv): {
  http?: string;
  https?: string;
  bypass: string[];
  explicit: boolean;
} {
  const get = (name: string): string | undefined => {
    const lower = env[name.toLowerCase()]?.trim();
    const upper = env[name]?.trim();
    if (lower) return lower;
    if (upper) return upper;
    return undefined;
  };
  const all = get("ALL_PROXY");
  const http = get("HTTP_PROXY") ?? all;
  const https = get("HTTPS_PROXY") ?? all;
  return {
    http,
    https,
    explicit: Boolean(http ?? https),
    bypass: (get("NO_PROXY") ?? "").split(/[\s,]+/).filter(Boolean),
  };
}

function proxyUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (
      !["http:", "https:"].includes(url.protocol) ||
      !url.hostname ||
      url.pathname !== "/" ||
      url.search ||
      url.hash
    )
      throw new Error();
    return url.href;
  } catch {
    throw new ProxyConfigurationError(
      "Proxy URL must use HTTP or HTTPS with no path, query or fragment",
    );
  }
}

function bypassMatcher(value: string, system = false): (url: URL) => boolean {
  const rule = value.toLowerCase();
  if (rule === "*") return () => true;
  if (rule === "<local>")
    return (url) =>
      !hostName(url.hostname).includes(".") && !isIP(hostName(url.hostname));
  if (rule.includes("/")) {
    const parts = rule.split("/");
    if (parts.length !== 2)
      throw new ProxyConfigurationError("Invalid proxy bypass network");
    const [address = "", prefix = ""] = parts;
    const raw = hostName(address);
    // macOS stores abbreviated IPv4 networks such as 169.254/16.
    const host =
      system && /^\d+(?:\.\d+){0,2}$/.test(raw)
        ? raw
            .split(".")
            .concat(Array<string>(4 - raw.split(".").length).fill("0"))
            .join(".")
        : raw;
    const family = isIP(host);
    const length = Number(prefix);
    if (!family || !/^\d+$/.test(prefix) || length > (family === 4 ? 32 : 128))
      throw new ProxyConfigurationError("Invalid proxy bypass network");
    const block = new BlockList();
    block.addSubnet(host, length, family === 4 ? "ipv4" : "ipv6");
    return (url) =>
      block.check(
        hostName(url.hostname),
        isIP(hostName(url.hostname)) === 6 ? "ipv6" : "ipv4",
      );
  }
  const match = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(rule);
  if (!match && !isIP(rule))
    throw new ProxyConfigurationError("Invalid proxy bypass host or port");
  const host = hostName(match?.[1] ?? rule);
  const port = match?.[2];
  if (port && (Number(port) < 1 || Number(port) > 65535))
    throw new ProxyConfigurationError("Invalid proxy bypass port");
  const escaped = host
    .replace(/[|\\{}()[\]^$+?.]/g, "\\$&")
    .replace(/\*/g, ".*");
  const expression = new RegExp(`^${escaped}$`, "i");
  return (url) => {
    if (
      port &&
      port !== (url.port || (url.protocol === "https:" ? "443" : "80"))
    )
      return false;
    const target = hostName(url.hostname);
    return (
      expression.test(target) || (host.startsWith(".") && target.endsWith(host))
    );
  };
}

export function createProxyPolicy(
  env: NodeJS.ProcessEnv,
  system: SystemProxySettings,
): ProxyPolicy {
  const override = proxyEnvironment(env);
  const http = proxyUrl(override.explicit ? override.http : system.httpProxy);
  const https = proxyUrl(
    override.explicit ? override.https : system.httpsProxy,
  );
  const bypass = [
    ...override.bypass.map((rule) => bypassMatcher(rule)),
    ...(override.explicit
      ? []
      : [
          ...(system.bypass ?? []),
          ...(system.excludeSimpleHostnames ? ["<local>"] : []),
        ].map((rule) => bypassMatcher(rule, true))),
  ];
  const endpoints = [http, https]
    .filter((value): value is string => Boolean(value))
    .map((value) => new URL(value));
  const origin = override.explicit
    ? "environment proxy"
    : system.source === "system"
      ? "system settings"
      : "OS routing (system proxy discovery unavailable)";
  return {
    status: `Network: ${origin}; HTTP ${http ? "proxy" : "OS route"}, HTTPS ${https ? "proxy" : "OS route"}${override.bypass.includes("*") ? "; NO_PROXY=* bypasses all" : ""}`,
    route(url): string | undefined {
      if (isLoopback(url.hostname) || bypass.some((matches) => matches(url)))
        return undefined;
      // Axios may have already rewritten the destination to an environment proxy.
      if (endpoints.some((proxy) => proxy.origin === url.origin))
        return undefined;
      return url.protocol === "https:" ? https : http;
    },
  };
}
