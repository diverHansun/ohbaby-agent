/** Normalization belongs to paste/text events; keyboard Return bypasses this. */
export function createInputStream(): {
  push: (text: string) => string;
  reset: () => void;
  pendingCR: () => boolean;
} {
  let trailingCR = false;
  let highSurrogate = "";
  return {
    pendingCR: () => trailingCR,
    reset: (): void => {
      trailingCR = false;
      highSurrogate = "";
    },
    push: (chunk): string => {
      let text = highSurrogate + chunk;
      highSurrogate = "";
      if (trailingCR && text.startsWith("\n")) text = text.slice(1);
      trailingCR = text.endsWith("\r");
      text = text.replace(/\r\n?/gu, "\n");
      if (/[\uD800-\uDBFF]$/u.test(text)) {
        highSurrogate = text.slice(-1);
        text = text.slice(0, -1);
      }
      // Preserve valid pairs and replace invalid completed input without ever
      // putting isolated UTF-16 surrogates into editor state.
      return text.replace(
        /[\uD800-\uDBFF][\uDC00-\uDFFF]|[\uD800-\uDFFF]/g,
        (part) => (part.length === 2 ? part : "�"),
      );
    },
  };
}
