import http from "node:http";
import https from "node:https";
import axios from "axios";
import { getGlobalDispatcher, setGlobalDispatcher } from "undici";
import {
  createProxyPolicy,
  isLoopback,
  proxyEnvironment,
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

let installed = false;

/** Explicit CLI-owned installation; importing ohbaby-agent never changes globals. */
export async function installSystemProxy(
  options: SystemProxyOptions = {},
): Promise<SystemProxyInstallation> {
  if (installed) throw new Error("System proxy transport is already installed");
  installed = true;
  const sourceEnv = options.env ?? process.env;
  // Read named properties before copying: process.env is case-insensitive on
  // Windows, whereas a spread into an ordinary object would lose that behavior.
  const env = Object.fromEntries(
    ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY"].flatMap((name) =>
      [name, name.toLowerCase()].map((key) => [key, sourceEnv[key]]),
    ),
  );
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
    try {
      const settings: SystemProxySettings = proxyEnvironment(env).explicit
        ? { source: "unavailable" }
        : await read();
      policy = createProxyPolicy(env, settings);
      nextFingerprint = JSON.stringify([proxyEnvironment(env), settings]);
    } catch (error) {
      // Readers sanitize their own errors; untrusted injected errors stay private.
      const detail =
        error instanceof ProxyConfigurationError ||
        error instanceof SystemProxyReadError
          ? error.message
          : "System proxy configuration is unavailable or unsupported";
      policy = {
        status: `Network: blocked; ${detail}`,
        route(url): string | undefined {
          if (isLoopback(url.hostname)) return undefined;
          throw new ProxyConfigurationError(detail);
        },
      };
      nextFingerprint = policy.status;
    }
    if (disposed || nextFingerprint === fingerprint) return;
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
      installed = false;
      return Promise.resolve();
    },
  };
}
