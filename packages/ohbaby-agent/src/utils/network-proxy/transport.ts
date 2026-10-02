import http from "node:http";
import https from "node:https";
import type { Socket } from "node:net";
import { Agent as RoutingAgent, type AgentConnectOpts } from "agent-base";
import { HttpsProxyAgent } from "https-proxy-agent";
import { Agent, Dispatcher, ProxyAgent } from "undici";
import type { ProxyPolicy } from "./policy.js";

// The libraries own pooling and CONNECT/TLS. This layer only chooses the route.
export class TransportGeneration {
  private readonly directFetch = new Agent();
  private readonly directHttp = new http.Agent({
    keepAlive: true,
    proxyEnv: {},
  });
  private readonly directHttps = new https.Agent({
    keepAlive: true,
    proxyEnv: {},
  });
  private readonly fetchProxies = new Map<string, ProxyAgent>();
  private readonly nodeProxies = new Map<string, HttpsProxyAgent<string>>();
  constructor(readonly policy: ProxyPolicy) {}

  dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    const proxy = this.policy.route(new URL(String(options.origin)));
    if (!proxy) return this.directFetch.dispatch(options, handler);
    let agent = this.fetchProxies.get(proxy);
    if (!agent) {
      agent = new ProxyAgent(proxy);
      this.fetchProxies.set(proxy, agent);
    }
    return agent.dispatch(options, handler);
  }

  nodeAgent(url: URL): http.Agent {
    const proxy = this.policy.route(url);
    if (!proxy)
      return url.protocol === "https:" ? this.directHttps : this.directHttp;
    let agent = this.nodeProxies.get(proxy);
    if (!agent) {
      agent = new HttpsProxyAgent(proxy, { keepAlive: true });
      this.nodeProxies.set(proxy, agent);
    }
    return agent;
  }

  retire(): void {
    // Graceful close drains in-flight fetch streams; no request is replayed.
    for (const dispatcher of [this.directFetch, ...this.fetchProxies.values()])
      void dispatcher.close().catch(() => undefined);
    for (const agent of [
      this.directHttp,
      this.directHttps,
      ...this.nodeProxies.values(),
    ]) {
      // Node Agent.destroy() also kills active streams. Retire idle sockets now,
      // and let active sockets close when released by their existing requests.
      agent.on("free", (socket: Socket) => socket.destroy());
      for (const sockets of Object.values(agent.freeSockets))
        for (const socket of sockets ?? []) socket.destroy();
    }
  }
}

export class FetchRouter extends Dispatcher {
  constructor(private readonly current: () => TransportGeneration) {
    super();
  }
  override dispatch(
    options: Dispatcher.DispatchOptions,
    handler: Dispatcher.DispatchHandler,
  ): boolean {
    return this.current().dispatch(options, handler);
  }
}

// Node creates `new globalAgent.constructor()` for agent:false. The bound
// constructor preserves the protocol and route without relying on arguments.
export function createNodeRouter(
  current: () => TransportGeneration,
  secure: boolean,
): RoutingAgent {
  class NodeRouter extends RoutingAgent {
    constructor() {
      super();
      this.protocol = secure ? "https:" : "http:";
      this.defaultPort = secure ? 443 : 80;
    }
    override connect(
      _request: http.ClientRequest,
      options: AgentConnectOpts,
    ): http.Agent {
      const host = options.host ?? "localhost";
      const hostname =
        host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
      return current().nodeAgent(
        new URL(
          `${options.secureEndpoint ? "https" : "http"}://${hostname}:${String(options.port)}`,
        ),
      );
    }
  }
  return new NodeRouter();
}
