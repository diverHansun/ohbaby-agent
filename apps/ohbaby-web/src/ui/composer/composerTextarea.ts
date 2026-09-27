export interface ComposerTextareaFitOptions {
  readonly lineHeight: number;
  readonly maxLines: number;
}

export function fitComposerTextarea(
  textarea: HTMLTextAreaElement,
  options: ComposerTextareaFitOptions,
): void {
  const maxHeight = options.lineHeight * options.maxLines;
  textarea.style.height = "0px";
  const contentHeight = Math.max(textarea.scrollHeight, options.lineHeight);
  const fittedHeight = Math.min(contentHeight, maxHeight);
  textarea.style.height = `${String(fittedHeight)}px`;
  textarea.style.overflowY = contentHeight > maxHeight ? "auto" : "hidden";
}
