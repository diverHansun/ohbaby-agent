import type { UiBackendClient } from "ohbaby-sdk";
import {
  type ReactElement,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import type { SessionFilesApi } from "../../../api/daemon/session-files.js";
import { FileList } from "./FileList.js";
import { FilePreview } from "./FilePreview.js";
import { useSessionFiles } from "./use-session-files.js";

/**
 * The Files page (session-storage phase 2b): the chat's scratch folder as a
 * list, and one file's preview in the same tab, like the Subagents page. Only
 * scratch is listed; subagent reports and saved tool output stay with the
 * messages that point at them.
 */
export function FilesPage(props: {
  readonly api: SessionFilesApi;
  readonly client: UiBackendClient;
  readonly rootSessionId: string;
  readonly selectedPath?: string;
  readonly onSelect: (path: string | undefined) => void;
}): ReactElement {
  const { api, client, rootSessionId, selectedPath } = props;
  const files = useSessionFiles(api, client, rootSessionId);
  // The caller's callback may change every render; handlers read the latest one.
  const onSelectRef = useRef(props.onSelect);
  useLayoutEffect(() => {
    onSelectRef.current = props.onSelect;
  }, [props.onSelect]);
  // The file the user just left, so the list can focus its row again.
  const [returnFocus, setReturnFocus] = useState<string>();
  const list = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (selectedPath !== undefined || returnFocus === undefined) return;
    const row = [
      ...(list.current?.querySelectorAll<HTMLElement>("[data-file-path]") ??
        []),
    ].find((element) => element.dataset.filePath === returnFocus);
    // A file deleted meanwhile has no row; the list itself takes focus.
    (row ?? list.current)?.focus({ preventScroll: true });
  }, [selectedPath, returnFocus]);
  const select = useCallback((path: string): void => {
    setReturnFocus(undefined);
    onSelectRef.current(path);
  }, []);

  if (selectedPath !== undefined) {
    const entry = files.files?.find((file) => file.path === selectedPath);
    return (
      <FilePreview
        key={selectedPath}
        api={api}
        rootSessionId={rootSessionId}
        path={selectedPath}
        entry={entry}
        gone={files.files !== undefined && !files.loading && !entry}
        onMissing={files.refresh}
        onBack={() => {
          setReturnFocus(selectedPath);
          onSelectRef.current(undefined);
        }}
      />
    );
  }
  return (
    <div ref={list} className="ohb-files-page" tabIndex={-1}>
      <FileList state={files} onSelect={select} onRefresh={files.refresh} />
    </div>
  );
}
