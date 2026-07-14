export const WORKSPACE_DIRECTORY_ENCODING_HEADER =
  "x-ohbaby-directory-encoding";
export const WORKSPACE_DIRECTORY_ENCODING_PERCENT_UTF8 = "percent-utf8";
export const WORKSPACE_DIRECTORY_HEADER = "x-ohbaby-directory";

export function workspaceDirectoryHeaders(
  directory: string | undefined,
): Record<string, string> {
  if (directory === undefined) {
    return {};
  }
  return {
    [WORKSPACE_DIRECTORY_ENCODING_HEADER]:
      WORKSPACE_DIRECTORY_ENCODING_PERCENT_UTF8,
    [WORKSPACE_DIRECTORY_HEADER]: encodeURIComponent(directory),
  };
}
