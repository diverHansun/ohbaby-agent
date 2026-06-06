export function highlightCode(code: string): string[] {
  return code.split(/\r?\n/u);
}
