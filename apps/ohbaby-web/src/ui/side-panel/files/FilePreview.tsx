import { ChevronLeft, Download } from "lucide-react";
import {
  type ReactElement,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type {
  SessionFileContent,
  SessionFileEntry,
  SessionFilesApi,
} from "../../../api/daemon/session-files.js";
import { isDaemonRequestError } from "../../../api/daemon/http.js";
import { CopyButton } from "../../shared/CopyButton.js";
import { IconButton } from "../../shared/IconButton.js";
import { MarkdownBlock } from "../../shared/MarkdownBlock.js";
import { downloadTextFile } from "../../shared/download-file.js";
import { readableError } from "../../shared/error-text.js";
import { useDelayed } from "../../shared/use-delayed.js";
import { useMinuteClock } from "../../shared/use-minute-clock.js";
import { relativeTime } from "../../sidebar/relative-time.js";
import {
  fileIcon,
  formatFileSize,
  isMarkdown,
  splitFilePath,
} from "./file-format.js";

type ReadState =
  | { readonly status: "loading" }
  | { readonly status: "ready"; readonly content: SessionFileContent }
  | {
      readonly status: "failed";
      readonly code?: string;
      readonly message: string;
    };

/**
 * Counts the reads one preview needs: the first, then one per change of the
 * list's size and time for the file. The list arriving after the preview
 * opened (or losing the file) is not a change, so it costs no extra read.
 */
function useReadKey(version: string | undefined): number {
  const [key, setKey] = useState(0);
  const seen = useRef(version);
  useEffect(() => {
    if (version === undefined) return;
    if (seen.current !== undefined && seen.current !== version)
      setKey((value) => value + 1);
    seen.current = version;
  }, [version]);
  return key;
}

/** Reads one file again whenever `readKey` changes. */
function useFileContent(
  api: SessionFilesApi,
  rootSessionId: string,
  path: string,
  readKey: number,
): ReadState {
  const [state, setState] = useState<ReadState>({ status: "loading" });
  useEffect(() => {
    const controller = new AbortController();
    let url: string | undefined;
    setState((previous) =>
      // A re-read keeps old text on screen instead of flashing Loading; an old
      // image's URL is revoked below, so it cannot stay.
      previous.status === "ready" && previous.content.kind === "text"
        ? previous
        : { status: "loading" },
    );
    api.read(rootSessionId, path, controller.signal).then(
      (content) => {
        if (content.kind === "image") url = content.url;
        if (controller.signal.aborted) {
          if (url) URL.revokeObjectURL(url);
          return;
        }
        setState({ status: "ready", content });
      },
      (error: unknown) => {
        if (controller.signal.aborted) return;
        setState({
          status: "failed",
          code: isDaemonRequestError(error) ? error.code : undefined,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return (): void => {
      controller.abort();
      if (url) URL.revokeObjectURL(url);
    };
  }, [api, rootSessionId, path, readKey]);
  return state;
}

function downloadImage(url: string, filename: string): void {
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.style.display = "none";
  document.body.append(link);
  link.click();
  link.remove();
}

/** Plain text with a line-number gutter; numbers are CSS, so copying skips them. */
function TextBody(props: { readonly text: string }): ReactElement {
  if (props.text.length === 0)
    return <p className="ohb-file-note">This file is empty.</p>;
  const lines = props.text.endsWith("\n")
    ? props.text.slice(0, -1).split("\n")
    : props.text.split("\n");
  return (
    <pre className="ohb-file-text">
      <code>
        {lines.map((line, index) => (
          <span key={index} className="ohb-file-line">
            {line}
            {"\n"}
          </span>
        ))}
      </code>
    </pre>
  );
}

/** Why there is nothing to show, with the file's name and size kept in view. */
function Unavailable(props: {
  readonly entry?: SessionFileEntry;
  readonly name: string;
  readonly title: string;
  readonly detail?: string;
  readonly action?: { readonly label: string; readonly onClick: () => void };
}): ReactElement {
  const Icon = fileIcon(props.name);
  return (
    <div className="ohb-file-unavailable">
      <span className="ohb-file-unavailable-icon" aria-hidden="true">
        <Icon size={20} />
      </span>
      <p className="ohb-file-unavailable-title">{props.title}</p>
      <p>
        {props.detail ??
          (props.entry
            ? `${props.name} · ${formatFileSize(props.entry.size)}`
            : props.name)}
      </p>
      {props.action ? (
        <button
          type="button"
          className="ohb-file-unavailable-action"
          onClick={props.action.onClick}
        >
          {props.action.label}
        </button>
      ) : null}
    </div>
  );
}

/**
 * One scratch file in the Files tab: back, name and facts, then the content.
 * Markdown renders by default with its source a toggle away (opencode, ZCode);
 * images fit the panel; anything else says why it cannot be shown.
 */
export function FilePreview(props: {
  readonly api: SessionFilesApi;
  readonly rootSessionId: string;
  readonly path: string;
  /** The list's row for this path; absent before the list loads or once it is gone. */
  readonly entry?: SessionFileEntry;
  /** A loaded list no longer has this path. */
  readonly gone: boolean;
  readonly onBack: () => void;
  /** The read found no file, so the list behind it is out of date. */
  readonly onMissing: () => void;
}): ReactElement {
  const { name, folder } = splitFilePath(props.path);
  const [attempt, setAttempt] = useState(0);
  const changes = useReadKey(
    props.entry
      ? `${String(props.entry.size)}:${props.entry.modifiedAt}`
      : undefined,
  );
  const state = useFileContent(
    props.api,
    props.rootSessionId,
    props.path,
    changes + attempt,
  );
  const missing = state.status === "failed" && state.code === "FILE_NOT_FOUND";
  const { onMissing } = props;
  useEffect(() => {
    if (missing) onMissing();
  }, [missing, onMissing]);
  const markdown = isMarkdown(name);
  const [source, setSource] = useState(false);
  const now = useMinuteClock();
  const heading = useRef<HTMLHeadingElement>(null);
  useLayoutEffect(() => {
    heading.current?.focus({ preventScroll: true });
  }, []);
  const showLoading = useDelayed(state.status === "loading", 300);
  const content = state.status === "ready" ? state.content : undefined;
  const facts = [
    folder,
    props.entry ? formatFileSize(props.entry.size) : "",
    props.entry ? relativeTime(props.entry.modifiedAt, now) : "",
  ].filter((part) => part.length > 0);

  let body: ReactElement | null = null;
  if (props.gone || missing)
    body = (
      <Unavailable
        name={name}
        title="This file is no longer here"
        detail="It was moved or deleted from the scratch folder."
        action={{ label: "Back to files", onClick: props.onBack }}
      />
    );
  else if (state.status === "failed" && state.code === "UNSUPPORTED_FILE_TYPE")
    body = (
      <Unavailable
        entry={props.entry}
        name={name}
        title="No preview for this file type"
      />
    );
  else if (state.status === "failed" && state.code === "FILE_TOO_LARGE")
    body = (
      <Unavailable
        entry={props.entry}
        name={name}
        title="Too large to preview"
        detail="Text previews stop at 1 MB and images at 10 MB."
      />
    );
  else if (state.status === "failed")
    body = (
      <Unavailable
        name={name}
        title="Couldn't open this file"
        detail={readableError(state.message)}
        action={{
          label: "Try again",
          onClick: () => {
            setAttempt((value) => value + 1);
          },
        }}
      />
    );
  else if (content?.kind === "image")
    body = (
      <div className="ohb-file-image">
        <img src={content.url} alt={name} />
      </div>
    );
  else if (content?.kind === "text")
    body =
      markdown && !source && content.text.length > 0 ? (
        <div className="ohb-file-markdown">
          <MarkdownBlock text={content.text} />
        </div>
      ) : (
        <TextBody text={content.text} />
      );
  else if (showLoading)
    body = (
      <p className="ohb-side-notice" role="status">
        Loading…
      </p>
    );

  return (
    <div className="ohb-file-preview">
      <header className="ohb-file-preview-header">
        <IconButton label="Back to files" onClick={props.onBack}>
          <ChevronLeft aria-hidden="true" size={16} />
        </IconButton>
        <div className="ohb-file-preview-title">
          <h2 ref={heading} tabIndex={-1} title={props.path}>
            {name}
          </h2>
          {facts.length > 0 ? <p>{facts.join(" · ")}</p> : null}
        </div>
        {markdown && content?.kind === "text" ? (
          <div
            className="ohb-file-mode"
            role="group"
            aria-label="Markdown view"
          >
            <button
              type="button"
              aria-pressed={!source}
              onClick={() => {
                setSource(false);
              }}
            >
              Preview
            </button>
            <button
              type="button"
              aria-pressed={source}
              onClick={() => {
                setSource(true);
              }}
            >
              Source
            </button>
          </div>
        ) : null}
        {content?.kind === "text" ? (
          <CopyButton label="Copy contents" text={content.text} />
        ) : null}
        {content ? (
          <IconButton
            label="Download"
            onClick={() => {
              if (content.kind === "image") downloadImage(content.url, name);
              else
                downloadTextFile({
                  filename: name,
                  mimeType: "text/plain;charset=utf-8",
                  content: content.text,
                });
            }}
          >
            <Download aria-hidden="true" size={14} />
          </IconButton>
        ) : null}
      </header>
      <div className="ohb-file-preview-body">{body}</div>
    </div>
  );
}
