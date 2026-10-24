/**
 * An API key edit (06 §2.2): keep the saved key, clear it, or replace it.
 * Clearing and running without a key are the same thing on the server.
 */
export type SecretChange = "keep" | "clear" | { readonly replace: string };

/** The `apiKey` request field for a change; `undefined` means leave it out. */
export function secretPatch(change: SecretChange): string | undefined {
  if (change === "keep") return undefined;
  if (change === "clear") return "";
  return change.replace;
}

/** A replacement still empty in its field is not a change yet. */
export function secretChanged(change: SecretChange): boolean {
  return change === "clear" || (change !== "keep" && change.replace !== "");
}
