/** Saves text through the browser's own download flow (the daemon API needs a bearer token, so no direct link). */
export function downloadTextFile(file: {
  readonly filename: string;
  readonly mimeType: string;
  readonly content: string;
}): void {
  const url = URL.createObjectURL(
    new Blob([file.content], { type: file.mimeType }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = file.filename;
  link.style.display = "none";
  document.body.append(link);
  try {
    link.click();
  } finally {
    link.remove();
    // Revoke after the click has been dispatched; some browsers read the URL asynchronously.
    window.setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 0);
  }
}
