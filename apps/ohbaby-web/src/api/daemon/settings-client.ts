import type {
  UiSettingsAboutResponse,
  UiSettingsGlobalMcpServer,
  UiSettingsMcpServer,
  UiSettingsModelCreate,
  UiSettingsModelPatch,
  UiSettingsModelProbeResponse,
  UiSettingsModels,
  UiSettingsSearch,
  UiSettingsSearchUpdate,
  UiSettingsSkill,
} from "ohbaby-sdk";
import { createDaemonHttpClient, type DaemonHttpClient } from "./http.js";
import type { OhbabyBootstrapConfig } from "./wire.js";

export type SettingsAbout = Omit<UiSettingsAboutResponse, "ok">;

/**
 * Settings reads and writes (06 §1.3). Global calls carry no directory
 * header; MCP status and Skills are instance reads at `directory`. Writes
 * return the section's new state, which replaces the cache.
 */
export interface SettingsApi {
  getModels(signal?: AbortSignal): Promise<UiSettingsModels>;
  createModel(input: UiSettingsModelCreate): Promise<UiSettingsModels>;
  updateModel(
    id: string,
    patch: UiSettingsModelPatch,
  ): Promise<UiSettingsModels>;
  selectModel(id: string): Promise<UiSettingsModels>;
  deleteModel(id: string): Promise<UiSettingsModels>;
  deleteProvider(provider: string): Promise<UiSettingsModels>;
  /** Detects the entry's reasoning again; the result is also saved on the entry. */
  probeModel(id: string): Promise<UiSettingsModelProbeResponse["reasoning"]>;
  getSearch(signal?: AbortSignal): Promise<UiSettingsSearch>;
  updateSearch(patch: UiSettingsSearchUpdate): Promise<UiSettingsSearch>;
  getMcpServers(
    signal?: AbortSignal,
  ): Promise<readonly UiSettingsGlobalMcpServer[]>;
  getAbout(signal?: AbortSignal): Promise<SettingsAbout>;
  getMcpStatus(
    directory: string,
    signal?: AbortSignal,
  ): Promise<readonly UiSettingsMcpServer[]>;
  getSkills(
    directory: string,
    signal?: AbortSignal,
  ): Promise<readonly UiSettingsSkill[]>;
}

/** Drops the transport's `ok` flag so callers hold plain settings state. */
function body<T extends { readonly ok: true }>({
  ok: _ok,
  ...rest
}: T): Omit<T, "ok"> {
  return rest;
}

export class SettingsClient implements SettingsApi {
  private readonly global: DaemonHttpClient;
  private readonly scoped = new Map<string, DaemonHttpClient>();

  constructor(
    private readonly config: OhbabyBootstrapConfig,
    private readonly fetchImpl?: typeof fetch,
  ) {
    this.global = createDaemonHttpClient(
      { ...config, directory: undefined },
      fetchImpl,
    );
  }

  async getModels(signal?: AbortSignal): Promise<UiSettingsModels> {
    return body(
      await this.global.request<UiSettingsModels & { ok: true }>(
        "/v1/settings/models",
        { includeDirectory: false, signal },
      ),
    );
  }

  createModel(input: UiSettingsModelCreate): Promise<UiSettingsModels> {
    return this.modelWrite("/v1/settings/models/profiles", "POST", input);
  }

  updateModel(
    id: string,
    patch: UiSettingsModelPatch,
  ): Promise<UiSettingsModels> {
    return this.modelWrite(
      `/v1/settings/models/profiles/${encodeURIComponent(id)}`,
      "PATCH",
      patch,
    );
  }

  selectModel(id: string): Promise<UiSettingsModels> {
    return this.modelWrite("/v1/settings/models/active", "POST", { id });
  }

  deleteModel(id: string): Promise<UiSettingsModels> {
    return this.modelWrite(
      `/v1/settings/models/profiles/${encodeURIComponent(id)}`,
      "DELETE",
    );
  }

  deleteProvider(provider: string): Promise<UiSettingsModels> {
    return this.modelWrite(
      `/v1/settings/models/providers/${encodeURIComponent(provider)}`,
      "DELETE",
    );
  }

  async probeModel(
    id: string,
  ): Promise<UiSettingsModelProbeResponse["reasoning"]> {
    const response = await this.global.request<UiSettingsModelProbeResponse>(
      "/v1/settings/models/probe",
      { body: { id }, includeDirectory: false, method: "POST" },
    );
    return response.reasoning;
  }

  async getSearch(signal?: AbortSignal): Promise<UiSettingsSearch> {
    return body(
      await this.global.request<UiSettingsSearch & { ok: true }>(
        "/v1/settings/search",
        { includeDirectory: false, signal },
      ),
    );
  }

  async updateSearch(patch: UiSettingsSearchUpdate): Promise<UiSettingsSearch> {
    return body(
      await this.global.request<UiSettingsSearch & { ok: true }>(
        "/v1/settings/search",
        { body: patch, includeDirectory: false, method: "PUT" },
      ),
    );
  }

  async getMcpServers(
    signal?: AbortSignal,
  ): Promise<readonly UiSettingsGlobalMcpServer[]> {
    const response = await this.global.request<{
      readonly servers: readonly UiSettingsGlobalMcpServer[];
    }>("/v1/settings/mcp/servers", { includeDirectory: false, signal });
    return response.servers;
  }

  async getAbout(signal?: AbortSignal): Promise<SettingsAbout> {
    return body(
      await this.global.request<UiSettingsAboutResponse>("/v1/settings/about", {
        includeDirectory: false,
        signal,
      }),
    );
  }

  async getMcpStatus(
    directory: string,
    signal?: AbortSignal,
  ): Promise<readonly UiSettingsMcpServer[]> {
    const response = await this.at(directory).request<{
      readonly servers: readonly UiSettingsMcpServer[];
    }>("/v1/settings/mcp/status", { signal });
    return response.servers;
  }

  async getSkills(
    directory: string,
    signal?: AbortSignal,
  ): Promise<readonly UiSettingsSkill[]> {
    const response = await this.at(directory).request<{
      readonly skills: readonly UiSettingsSkill[];
    }>("/v1/settings/skills", { signal });
    return response.skills;
  }

  private async modelWrite(
    path: string,
    method: "DELETE" | "PATCH" | "POST",
    payload?: unknown,
  ): Promise<UiSettingsModels> {
    return body(
      await this.global.request<UiSettingsModels & { ok: true }>(path, {
        ...(payload === undefined ? {} : { body: payload }),
        includeDirectory: false,
        method,
      }),
    );
  }

  /** Instance reads need only the directory header, not a registered client. */
  private at(directory: string): DaemonHttpClient {
    let http = this.scoped.get(directory);
    if (!http) {
      http = createDaemonHttpClient(
        { ...this.config, directory },
        this.fetchImpl,
      );
      this.scoped.set(directory, http);
    }
    return http;
  }
}
