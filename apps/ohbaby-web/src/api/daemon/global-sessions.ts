import type {
  UiGlobalSession,
  UiGlobalSessionPage,
  UiGlobalSessionStatus,
  UiSessionDeleteResult,
  UiSessionSearchPage,
} from "ohbaby-sdk";
import type { DaemonHttpClient } from "./http.js";

/**
 * The cross-workspace session catalog. Every call goes out without a
 * directory header; the `http` client passed in must be the global one.
 */
export class GlobalSessionsClient {
  constructor(private readonly http: DaemonHttpClient) {}

  /** One page of root sessions, newest first; active ones unless `status` says otherwise. */
  async listSessions(
    input: {
      readonly cursor?: string;
      readonly limit?: number;
      readonly signal?: AbortSignal;
      readonly status?: UiGlobalSessionStatus;
    } = {},
  ): Promise<UiGlobalSessionPage> {
    const query = pageQuery(input);
    if (input.status !== undefined) query.set("status", input.status);
    const { ok: _ok, ...page } = await this.http.request<
      UiGlobalSessionPage & { readonly ok: true }
    >(`/v1/sessions?${query}`, {
      includeDirectory: false,
      signal: input.signal,
    });
    return page;
  }

  async searchSessions(input: {
    readonly query: string;
    readonly cursor?: string;
    readonly limit?: number;
    readonly signal?: AbortSignal;
  }): Promise<UiSessionSearchPage> {
    const query = pageQuery(input);
    query.set("q", input.query);
    const { ok: _ok, ...page } = await this.http.request<
      UiSessionSearchPage & { readonly ok: true }
    >(`/v1/sessions/search?${query}`, {
      includeDirectory: false,
      signal: input.signal,
    });
    return page;
  }

  /** A directory assigns the workspace; null removes the session from its workspace. */
  async moveSession(
    sessionId: string,
    workspaceDirectory: string | null,
  ): Promise<UiGlobalSession> {
    const response = await this.http.request<{
      readonly ok: true;
      readonly session: UiGlobalSession;
    }>(`/v1/sessions/${encodeURIComponent(sessionId)}/workspace`, {
      body: { workspaceDirectory },
      includeDirectory: false,
      method: "POST",
    });
    return response.session;
  }

  /** Back to its workspace if that folder still exists, else to Recents. */
  async unarchiveSession(sessionId: string): Promise<UiGlobalSession> {
    const response = await this.http.request<{
      readonly ok: true;
      readonly session: UiGlobalSession;
    }>(`/v1/sessions/${encodeURIComponent(sessionId)}/unarchive`, {
      includeDirectory: false,
      method: "POST",
    });
    return response.session;
  }

  /** Permanently deletes an archived root session and its subagent sessions. */
  async deleteSession(sessionId: string): Promise<UiSessionDeleteResult> {
    const { ok: _ok, ...result } = await this.http.request<
      UiSessionDeleteResult & { readonly ok: true }
    >(`/v1/sessions/${encodeURIComponent(sessionId)}`, {
      includeDirectory: false,
      method: "DELETE",
    });
    return result;
  }
}

function pageQuery(input: {
  readonly cursor?: string;
  readonly limit?: number;
}): URLSearchParams {
  const query = new URLSearchParams();
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  return query;
}
