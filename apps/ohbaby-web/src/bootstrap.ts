import { createOhbabyWebRuntime, type OhbabyWebRuntime } from "./runtime.js";
import type { OhbabyBootstrapConfig } from "./api/daemon/wire.js";
import { mountBootstrapError, mountOhbabyWebApp } from "./ui/App.js";
import "./ui/styles.css";

declare global {
  interface Window {
    __OHBABY__?: OhbabyBootstrapConfig;
    __OHBABY_WEB__?: OhbabyWebRuntime;
  }
}

function readBootstrapConfig(): OhbabyBootstrapConfig {
  const config = window.__OHBABY__;
  if (!config) {
    throw new Error("Missing window.__OHBABY__ daemon bootstrap config");
  }
  if (!config.token || !config.clientId) {
    throw new Error("Incomplete window.__OHBABY__ daemon bootstrap config");
  }
  const hintedDirectory = new URLSearchParams(
    window.location.hash.replace(/^#/, ""),
  ).get("directory");
  const hintedSession = new URLSearchParams(
    window.location.hash.replace(/^#/, ""),
  ).get("session");
  const directory = hintedDirectory?.trim();
  return {
    ...config,
    ...(directory ? { directory } : { directory: undefined }),
    ...(hintedSession
      ? {
          startupIntent: {
            ...config.startupIntent,
            resumeSessionId: hintedSession,
          },
        }
      : {}),
  };
}

// `vite dev` only: `?mock=<scenario>` renders a fixed state without a daemon
// (06 §5). Production builds drop this branch and the dev module.
async function createRuntime(): Promise<OhbabyWebRuntime> {
  if (import.meta.env.DEV) {
    const scenario = new URLSearchParams(window.location.search).get("mock");
    if (scenario) {
      const { createMockRuntime } = await import("./dev/mock-runtime.js");
      return createMockRuntime(scenario);
    }
  }
  return createOhbabyWebRuntime(readBootstrapConfig());
}

createRuntime()
  .then(async (runtime) => {
    window.__OHBABY_WEB__ = runtime;
    await runtime.ready;
    mountOhbabyWebApp(runtime);
    window.dispatchEvent(
      new CustomEvent("ohbaby:web-ready", { detail: runtime }),
    );
  })
  .catch((error: unknown) => {
    mountBootstrapError(error);
    window.dispatchEvent(
      new CustomEvent("ohbaby:web-error", { detail: error }),
    );
  });
