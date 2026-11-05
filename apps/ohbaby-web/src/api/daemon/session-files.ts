/** One regular file in the chat's scratch folder, as the daemon lists it. */
export interface SessionFileEntry {
  /** Relative to scratch, `/`-separated. */
  readonly path: string;
  readonly size: number;
  /** ISO timestamp. */
  readonly modifiedAt: string;
}

/** What one file read returns; other kinds come back as a coded error. */
export type SessionFileContent =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "image"; readonly url: string };

/**
 * The Files page's reads of the root session's scratch folder (session-storage
 * dfd-interface §2.5). Only the root goes in; the client adds the binding.
 * An image result holds an object URL the caller must revoke.
 */
export interface SessionFilesApi {
  list(
    rootSessionId: string,
    signal?: AbortSignal,
  ): Promise<readonly SessionFileEntry[]>;
  read(
    rootSessionId: string,
    path: string,
    signal?: AbortSignal,
  ): Promise<SessionFileContent>;
}

/** Turns a content response into what the page shows: text, or an image URL. */
export async function sessionFileContent(
  response: Response,
): Promise<SessionFileContent> {
  const type = response.headers.get("content-type") ?? "";
  if (type.startsWith("image/"))
    return {
      kind: "image",
      url: URL.createObjectURL(await response.blob()),
    };
  return { kind: "text", text: await response.text() };
}
