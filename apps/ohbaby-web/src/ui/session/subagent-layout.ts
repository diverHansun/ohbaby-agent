/** Child geometry follows the existing composer without changing root layout. */
export function subagentSheetGeometry(
  content: Pick<DOMRect, "left" | "right" | "bottom" | "width">,
  composer: Pick<DOMRect, "left" | "top" | "width">,
  headerBottom: number,
  narrow: boolean,
): { left: number; width: number; bottom: number; height: number } {
  const gutter = narrow ? 14 : 24;
  const width = Math.max(
    0,
    Math.min(800, composer.width, content.width - 2 * gutter),
  );
  const left =
    Math.min(
      Math.max(composer.left, content.left + gutter),
      content.right - gutter - width,
    ) - content.left;
  return {
    left,
    width,
    bottom: Math.max(0, content.bottom - composer.top) + 10,
    height: Math.min(680, Math.max(0, composer.top - headerBottom - 10) * 0.64),
  };
}
