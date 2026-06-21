import {
  createOhbabyWebRuntime,
  type OhbabyWebRuntime,
} from "./api/daemon/client.js";
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
  return config;
}

try {
  const runtime = createOhbabyWebRuntime(readBootstrapConfig());
  window.__OHBABY_WEB__ = runtime;
  mountOhbabyWebApp(runtime);
  runtime.ready
    .then(() => {
      window.dispatchEvent(
        new CustomEvent("ohbaby:web-ready", { detail: runtime }),
      );
    })
    .catch((error: unknown) => {
      window.dispatchEvent(
        new CustomEvent("ohbaby:web-error", { detail: error }),
      );
    });
} catch (error) {
  mountBootstrapError(error);
  window.dispatchEvent(new CustomEvent("ohbaby:web-error", { detail: error }));
}
