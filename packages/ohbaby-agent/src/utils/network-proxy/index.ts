import http from "node:http";
import https from "node:https";
import axios from "axios";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import {
  createProxyPolicy,
  isLoopback,
  proxyEnvironment,
  readProxyEnvironment,
  ProxyConfigurationError,
  type ProxyPolicy,
} from "./policy.js";
import {
  readSystemProxy,
  SystemProxyReadError,
  type SystemProxySettings,
} from "./system.js";
import {
  FetchRouter,
  createNodeRouter,
  TransportGeneration,
} from "./transport.js";

export interface SystemProxyOptions {
  onStatus?: (message: string) => void;
  env?: NodeJS.ProcessEnv;
  readSystem?: () => Promise<SystemProxySettings>;
  pollIntervalMs?: number;
}
export interface SystemProxyInstallation {
  dispose(): Promise<void>;
}

export interface ProxyConfigurationSnapshot {
  readonly env: Readonly<NodeJS.ProcessEnv>;
  readonly system?: Readonly<SystemProxySettings>;
  readonly error?: string;
}

let installed = false;
let configurationSnapshot: ProxyConfigurationSnapshot | undefined;

/** Only an explicit installation discovers system settings. */
export function getProxyConfigurationSnapshot(): ProxyConfigurationSnapshot {
  return (
    configurationSnapshot ??
    Object.freeze({ env: Object.freeze(readProxyEnvironment(process.env)) })
  );
}

function snapshot(
  env: NodeJS.ProcessEnv,
  system?: SystemProxySettings,
  error?: string,
): ProxyConfigurationSnapshot {
  return Object.freeze({
    env,
    ...(system
      ? {
          system: Object.freeze({
            ...system,
            ...(system.bypass
              ? { bypass: Object.freeze([...system.bypass]) }
              : {}),
          }),
        }
      : {}),
    ...(error ? { error } : {}),
  });
}

/** Explicit CLI-owned installation; importing ohbaby-agent never changes globals. */
export async function installSystemProxy(
  options: SystemProxyOptions = {},
): Promise<SystemProxyInstallation> {
  if (installed) throw new Error("System proxy transport is already installed");
  installed = true;
  const sourceEnv = options.env ?? process.env;
  // Read named properties before copying: process.env is case-insensitive on
  // Windows, whereas a spread into an ordinary object would lose that behavior.
  const env = Object.freeze(readProxyEnvironment(sourceEnv));
  const read = options.readSystem ?? readSystemProxy;
  const previous = {
    http: http.globalAgent,
    https: https.globalAgent,
    fetch: getGlobalDispatcher(),
  };
  let current: TransportGeneration | undefined;
  let fingerprint = "";
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const notify = (status: string): void => {
    try {
      options.onStatus?.(status);
    } catch {
      /* Diagnostics must not change routing. */
    }
  };
  const refresh = async (): Promise<void> => {
    let policy: ProxyPolicy;
    let nextFingerprint: string;
    let nextSnapshot: ProxyConfigurationSnapshot;
    let settings: SystemProxySettings | undefined;
    try {
      settings = proxyEnvironment(env).explicit
        ? { source: "unavailable" }
        : await read();
      nextSnapshot = snapshot(env, settings);
      policy = createProxyPolicy(env, settings);
      nextFingerprint = JSON.stringify([proxyEnvironment(env), settings]);
    } catch (error) {
      // Readers sanitize their own errors; untrusted injected errors stay private.
      const detail =
        error instanceof ProxyConfigurationError ||
        error instanceof SystemProxyReadError
          ? error.message
          : "System proxy configuration is unavailable or unsupported";
      nextSnapshot = snapshot(env, settings, settings ? undefined : detail);
      policy = {
        status: `Network: blocked; ${detail}`,
        route(url): string | undefined {
          if (isLoopback(url.hostname)) return undefined;
          throw new ProxyConfigurationError(detail);
        },
      };
      nextFingerprint = policy.status;
    }
    if (disposed) return;
    configurationSnapshot = nextSnapshot;
    if (nextFingerprint === fingerprint) return;
    const old = current;
    current = new TransportGeneration(policy);
    fingerprint = nextFingerprint;
    old?.retire();
    notify(policy.status);
  };
  await refresh();
  const getCurrent = (): TransportGeneration => {
    if (!current) throw new Error("Network transport is not initialized");
    return current;
  };
  const fetchRouter = new FetchRouter(getCurrent);
  const httpRouter = createNodeRouter(getCurrent, false);
  const httpsRouter = createNodeRouter(getCurrent, true);
  setGlobalDispatcher(fetchRouter);
  http.globalAgent = httpRouter;
  https.globalAgent = httpsRouter;
  // Tavily uses this Axios instance. Disable only Axios's automatic env rewrite,
  // so the original URL reaches the shared router (including loopback/CIDR).
  // Explicit Axios proxy configs are untouched; custom agents retain ownership.
  // Keep the Axios dependency range aligned with Tavily so both share an instance.
  const axiosInterceptor = axios.interceptors.request.use(
    (config) => {
      if (config.proxy !== undefined) return config;
      config.proxy = false;
      return config;
    },
    undefined,
    { synchronous: true },
  );
  // Serialized polling avoids overlapping OS commands and does no request-path IO.
  const schedule = (): void => {
    if (disposed) return;
    timer = setTimeout(() => {
      void refresh().finally(schedule);
    }, options.pollIntervalMs ?? 5000);
    timer.unref();
  };
  schedule();
  return {
    dispose(): Promise<void> {
      if (disposed) return Promise.resolve();
      disposed = true;
      clearTimeout(timer);
      axios.interceptors.request.eject(axiosInterceptor);
      if (getGlobalDispatcher() === fetchRouter)
        setGlobalDispatcher(previous.fetch);
      if (http.globalAgent === httpRouter) http.globalAgent = previous.http;
      if (https.globalAgent === httpsRouter) https.globalAgent = previous.https;
      current?.retire();
      configurationSnapshot = undefined;
      installed = false;
      return Promise.resolve();
    },
  };
}
