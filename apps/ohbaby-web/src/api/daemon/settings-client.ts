import type { UiSettingsModels, UiSettingsModelsResponse } from "ohbaby-sdk";
import type { DaemonHttpClient } from "./http.js";

/**
 * Global settings reads. improve-2 needs only the model list, so a draft can
 * tell "no default model" from "could not read" before any instance exists.
 * improve-4 extends this client with the settings page calls.
 */
export class SettingsClient {
  constructor(private readonly http: DaemonHttpClient) {}

  async getModels(
    options: { readonly signal?: AbortSignal } = {},
  ): Promise<UiSettingsModels> {
    const { ok: _ok, ...models } =
      await this.http.request<UiSettingsModelsResponse>("/v1/settings/models", {
        includeDirectory: false,
        signal: options.signal,
      });
    return models;
  }
}
