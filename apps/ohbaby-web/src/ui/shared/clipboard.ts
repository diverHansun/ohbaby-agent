/**
 * Writes text to the clipboard and says whether it worked. `navigator.clipboard`
 * exists only in secure contexts, so a daemon opened over plain `http://` on
 * the LAN falls back to a hidden textarea and `execCommand("copy")`.
 */
export async function writeClipboard(text: string): Promise<boolean> {
  const clipboard = (navigator as Partial<Navigator>).clipboard;
  if (clipboard?.writeText) {
    try {
      await clipboard.writeText(text);
      return true;
    } catch {
      // Denied or unavailable here; try the selection fallback.
    }
  }
  return copyThroughSelection(text);
}

function copyThroughSelection(text: string): boolean {
  const previous =
    document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
  const area = document.createElement("textarea");
  area.value = text;
  // Not readonly: iOS Safari selects nothing in a readonly textarea.
  area.style.fontSize = "16px"; // keeps iOS from zooming on focus
  area.style.position = "fixed";
  area.style.top = "0";
  area.style.left = "0";
  area.style.opacity = "0";
  document.body.append(area);
  // `copy` takes the focused selection, so the textarea needs focus first.
  area.focus({ preventScroll: true });
  area.select();
  area.setSelectionRange(0, text.length);
  let copied = false;
  try {
    // Deprecated, but the only copy path outside secure contexts.
    // eslint-disable-next-line @typescript-eslint/no-deprecated
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    area.remove();
    previous?.focus({ preventScroll: true });
  }
  return copied;
}
