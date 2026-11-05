import { RotateCw } from "lucide-react";
import type { ReactElement } from "react";
import type { SessionFileEntry } from "../../../api/daemon/session-files.js";
import { IconButton } from "../../shared/IconButton.js";
import { readableError } from "../../shared/error-text.js";
import { useDelayed } from "../../shared/use-delayed.js";
import { useMinuteClock } from "../../shared/use-minute-clock.js";
import { relativeTime } from "../../sidebar/relative-time.js";
import { fileIcon, formatFileSize, splitFilePath } from "./file-format.js";
import type { SessionFilesState } from "./use-session-files.js";

function FileRow(props: {
  readonly file: SessionFileEntry;
  readonly now: number;
  readonly onSelect: (path: string) => void;
}): ReactElement {
  const { file } = props;
  const { name, folder } = splitFilePath(file.path);
  const Icon = fileIcon(name);
  return (
    <li>
      <button
        type="button"
        className="ohb-file-row"
        data-file-path={file.path}
        title={file.path}
        onClick={() => {
          props.onSelect(file.path);
        }}
      >
        <Icon aria-hidden="true" size={15} className="ohb-file-row-icon" />
        <span className="ohb-file-row-name">
          <span>{name}</span>
          {folder ? <small>{folder}</small> : null}
        </span>
        <span className="ohb-file-row-meta">
          {formatFileSize(file.size)}
          <span aria-hidden="true">·</span>
          {relativeTime(file.modifiedAt, props.now)}
        </span>
      </button>
    </li>
  );
}

/**
 * The scratch folder as one flat list, in the server's path order: agents
 * write a handful of files, so a tree would only add clicks.
 */
export function FileList(props: {
  readonly state: SessionFilesState;
  readonly onSelect: (path: string) => void;
  readonly onRefresh: () => void;
}): ReactElement {
  const { files, loading, error } = props.state;
  const now = useMinuteClock();
  const showLoading = useDelayed(loading && !files, 300);
  return (
    <div className="ohb-files">
      <header className="ohb-files-header">
        <h2>
          Scratch
          {files && files.length > 0 ? (
            <span className="ohb-files-count">{files.length}</span>
          ) : null}
        </h2>
        <IconButton
          label="Refresh files"
          className={loading && files ? "is-spinning" : undefined}
          onClick={props.onRefresh}
        >
          <RotateCw aria-hidden="true" size={14} />
        </IconButton>
      </header>
      <div className="ohb-files-body">
        {error ? (
          <p className="ohb-side-notice" role="alert">
            {readableError(error)}{" "}
            <button type="button" onClick={props.onRefresh}>
              Retry
            </button>
          </p>
        ) : null}
        {showLoading && !error ? (
          <p className="ohb-side-notice" role="status">
            Loading…
          </p>
        ) : null}
        {files?.length === 0 ? (
          <div className="ohb-files-empty">
            <p>No files yet</p>
            <p>
              Notes, logs and reports the agent saves for this chat show up
              here. They stay out of your workspace.
            </p>
          </div>
        ) : null}
        {files && files.length > 0 ? (
          <ul className="ohb-files-list">
            {files.map((file) => (
              <FileRow
                key={file.path}
                file={file}
                now={now}
                onSelect={props.onSelect}
              />
            ))}
          </ul>
        ) : null}
      </div>
    </div>
  );
}
