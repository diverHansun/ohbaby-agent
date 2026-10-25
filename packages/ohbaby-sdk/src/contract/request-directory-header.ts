export const REQUEST_DIRECTORY_ENCODING_HEADER = "x-ohbaby-directory-encoding";
export const REQUEST_DIRECTORY_ENCODING_PERCENT_UTF8 = "percent-utf8";
export const REQUEST_DIRECTORY_HEADER = "x-ohbaby-directory";

export function requestDirectoryHeaders(
  directory: string | undefined,
): Record<string, string> {
  if (directory === undefined) {
    return {};
  }
  return {
    [REQUEST_DIRECTORY_ENCODING_HEADER]:
      REQUEST_DIRECTORY_ENCODING_PERCENT_UTF8,
    [REQUEST_DIRECTORY_HEADER]: encodeURIComponent(directory),
  };
}
