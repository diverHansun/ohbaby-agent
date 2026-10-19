import { isIP } from "node:net";
import {
  getProxyConfigurationSnapshot,
  type ProxyConfigurationSnapshot,
} from "./index.js";
import {
  isLoopback,
  PROXY_ENVIRONMENT_KEYS,
  proxyEnvironment,
  proxyEnvironmentValue,
  proxyUrl,
  ProxyConfigurationError,
} from "./policy.js";

const loopback = ["localhost", "127.0.0.1", "::1", "127.0.0.0/8"];
const guidance =
  "Set explicit HTTP_PROXY / HTTPS_PROXY (with optional NO_PROXY), or choose NO_PROXY=* to bypass all proxies.";

// NO_PROXY is a client convention, not an exact system-policy transport.
// Export common rules; unsupported bypass syntax must not block process startup.
function systemBypass(rule: string): string | undefined {
  const host = rule.toLowerCase().replace(/^\[|\]$/g, "");
  const family = isIP(host);
  if (host === "localhost" || (family === 4 && isLoopback(host)))
    return undefined;
  if (family === 6) {
    const canonical = new URL(`http://[${host}]`).hostname.slice(1, -1);
    if (canonical === "::1") return undefined;
    if (canonical.startsWith("::ffff:")) {
      // curl treats dotted IPv4-mapped and hexadecimal IPv6 spellings as
      // different NO_PROXY entries. The fixed 127/8 rule does not cover them.
      const words = canonical
        .slice("::ffff:".length)
        .split(":")
        .map((word) => Number.parseInt(word, 16));
      const high = words[0] ?? 0;
      const low = words[1] ?? 0;
      const dotted = `::ffff:${[high >> 8, high & 255, low >> 8, low & 255].join(".")}`;
      return `${dotted},${canonical}`;
    }
    return canonical;
  }
  if (family === 4) return host;
  if (rule.includes("/")) {
    const networkParts = rule.split("/");
    const [address = "", prefix = ""] = networkParts;
    if (address.includes(":")) return undefined;
    const parts = address.split(".");
    const normalized = parts
      .concat(Array<string>(Math.max(0, 4 - parts.length)).fill("0"))
      .join(".");
    const bits = Number(prefix);
    if (
      networkParts.length !== 2 ||
      !isIP(normalized) ||
      !/^\d+$/.test(prefix) ||
      bits > 32
    )
      return undefined;
    const octets = normalized.split(".").map(Number);
    const network = octets
      .map((octet, index) => {
        const used = Math.max(0, Math.min(8, bits - index * 8));
        return octet & (256 - 2 ** (8 - used));
      })
      .join(".");
    return `${network}/${String(bits)}`;
  }
  const domain = host.replace(/^\*\./, ".");
  if (domain === "<local>" || domain.includes("*") || domain.includes(":"))
    return undefined;
  return domain;
}

function externalProxy(value: string | undefined): string | undefined {
  if (!value) return undefined;
  // External programs may support native schemes (e.g. socks5h) that Node does
  // not. Only the existing HTTP(S) contract is validated and normalized here.
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(value) && !/^https?:/i.test(value))
    return value;
  return proxyUrl(value);
}

/** Complete proxy key set; consumers must remove stale aliases before applying it. */
export function buildChildProxyEnvironment(
  snapshot: ProxyConfigurationSnapshot,
  overrides: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const get = (env: NodeJS.ProcessEnv, key: string): string | undefined => {
    const named = proxyEnvironmentValue(env, key);
    if (named || platform !== "win32") return named;
    return Object.entries(env)
      .find(([name, value]) => name.toUpperCase() === key && value?.trim())?.[1]
      ?.trim();
  };
  const merged = Object.fromEntries(
    PROXY_ENVIRONMENT_KEYS.map((key) => [
      key,
      get(overrides, key) ?? get(snapshot.env, key),
    ]),
  );
  const explicit = proxyEnvironment(merged);
  const nativeBypass = proxyEnvironmentValue(merged, "NO_PROXY");
  const result: NodeJS.ProcessEnv = {};
  const set = (key: string, value: string | undefined): void => {
    if (value === undefined) return;
    result[key] = value;
    if (platform !== "win32") result[key.toLowerCase()] = value;
  };
  if (
    explicit.bypass.includes("*") ||
    (!explicit.explicit && snapshot.system?.bypass?.includes("*"))
  ) {
    set("NO_PROXY", "*");
    return result;
  }
  if (!explicit.explicit && snapshot.error) {
    throw new ProxyConfigurationError(
      `${snapshot.error}. Child process proxy configuration unavailable. ${guidance}`,
    );
  }
  const system = snapshot.system;
  const http = explicit.explicit
    ? externalProxy(explicit.http)
    : proxyUrl(system?.httpProxy);
  const https = explicit.explicit
    ? externalProxy(explicit.https)
    : proxyUrl(system?.httpsProxy);
  const bypass = [...loopback];
  if (nativeBypass) bypass.push(nativeBypass);
  if (!explicit.explicit && (http || https)) {
    for (const rule of [
      ...(system?.bypass ?? []),
      ...(system?.excludeSimpleHostnames ? ["<local>"] : []),
    ]) {
      const converted = systemBypass(rule);
      if (converted) bypass.push(converted);
    }
  }
  set("HTTP_PROXY", http);
  set("HTTPS_PROXY", https);
  if (explicit.explicit) set("ALL_PROXY", externalProxy(merged.ALL_PROXY));
  set("NO_PROXY", [...new Set(bypass)].join(","));
  return result;
}

/** Ordinary env merge stays unchanged; proxy keys always come from the snapshot. */
export function mergeChildProxyEnvironment(
  base: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv = {},
  snapshot: ProxyConfigurationSnapshot = getProxyConfigurationSnapshot(),
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env = { ...base, ...overrides };
  for (const key of Object.keys(env)) {
    const managed =
      platform === "win32"
        ? PROXY_ENVIRONMENT_KEYS.some((name) => name === key.toUpperCase())
        : PROXY_ENVIRONMENT_KEYS.some(
            (name) => key === name || key === name.toLowerCase(),
          );
    if (managed) Reflect.deleteProperty(env, key);
  }
  return {
    ...env,
    ...buildChildProxyEnvironment(snapshot, overrides, platform),
  };
}
