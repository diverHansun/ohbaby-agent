import DOMPurify from "dompurify";
import { marked } from "marked";
import type { ReactElement } from "react";

export function MarkdownBlock(props: { readonly text: string }): ReactElement {
  const html = DOMPurify.sanitize(marked.parse(props.text, { async: false }));
  return (
    <div className="ohb-markdown" dangerouslySetInnerHTML={{ __html: html }} />
  );
}
