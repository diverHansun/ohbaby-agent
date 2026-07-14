import { ChevronLeft, ChevronRight, Folder, FolderOpen, X } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactElement } from "react";
import type {
  DirectoryPickerListResponse,
  DirectoryPickerRootsResponse,
} from "../../api/daemon/wire.js";

export interface DirectoryPickerApi {
  getDirectoryPickerRoots(): Promise<DirectoryPickerRootsResponse>;
  listDirectoryPicker(directory: string): Promise<DirectoryPickerListResponse>;
}

type PendingRequest =
  | { readonly kind: "directory"; readonly directory: string }
  | { readonly kind: "roots" }
  | undefined;

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function nextBreadcrumbs(
  breadcrumbs: readonly DirectoryPickerListResponse[],
  listing: DirectoryPickerListResponse,
): readonly DirectoryPickerListResponse[] {
  const currentIndex = breadcrumbs.findIndex(
    (item) => item.directory === listing.directory,
  );
  if (currentIndex >= 0) {
    return breadcrumbs.slice(0, currentIndex + 1);
  }
  const parentIndex = breadcrumbs.findIndex(
    (item) => item.directory === listing.parent,
  );
  return parentIndex >= 0
    ? [...breadcrumbs.slice(0, parentIndex + 1), listing]
    : [listing];
}

export function DirectoryPickerDialog(props: {
  readonly directoryPicker: DirectoryPickerApi;
  readonly onClose: () => void;
  readonly onSelect: (directory: string) => Promise<void>;
}): ReactElement {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  const requestVersion = useRef(0);
  const lastRequest = useRef<PendingRequest>(undefined);
  const selectingRef = useRef(false);
  const [breadcrumbs, setBreadcrumbs] = useState<
    readonly DirectoryPickerListResponse[]
  >([]);
  const [error, setError] = useState<string | null>(null);
  const [listing, setListing] = useState<DirectoryPickerListResponse>();
  const [loading, setLoading] = useState(false);
  const [roots, setRoots] = useState<DirectoryPickerRootsResponse["roots"]>([]);
  const [selecting, setSelecting] = useState(false);

  const loadRoots = useCallback(async (): Promise<void> => {
    const version = requestVersion.current + 1;
    requestVersion.current = version;
    lastRequest.current = { kind: "roots" };
    setBreadcrumbs([]);
    setError(null);
    setListing(undefined);
    setLoading(true);
    try {
      const response = await props.directoryPicker.getDirectoryPickerRoots();
      if (requestVersion.current === version) {
        setRoots(response.roots);
      }
    } catch (cause) {
      if (requestVersion.current === version) {
        setError(errorMessage(cause));
      }
    } finally {
      if (requestVersion.current === version) {
        setLoading(false);
      }
    }
  }, [props.directoryPicker]);

  const loadDirectory = useCallback(
    async (directory: string): Promise<void> => {
      const version = requestVersion.current + 1;
      requestVersion.current = version;
      lastRequest.current = { directory, kind: "directory" };
      setError(null);
      setLoading(true);
      try {
        const response =
          await props.directoryPicker.listDirectoryPicker(directory);
        if (requestVersion.current === version) {
          setListing(response);
          setBreadcrumbs((current) => nextBreadcrumbs(current, response));
        }
      } catch (cause) {
        if (requestVersion.current === version) {
          setError(errorMessage(cause));
        }
      } finally {
        if (requestVersion.current === version) {
          setLoading(false);
        }
      }
    },
    [props.directoryPicker],
  );
  const requestClose = useCallback((): void => {
    if (!selecting) {
      props.onClose();
    }
  }, [props.onClose, selecting]);

  useEffect(() => {
    void loadRoots();
    return (): void => {
      requestVersion.current += 1;
    };
  }, [loadRoots]);
  useEffect(() => {
    closeButtonRef.current?.focus();
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        requestClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return (): void => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [requestClose]);

  const retry = useCallback((): void => {
    const request = lastRequest.current;
    if (request?.kind === "roots") {
      void loadRoots();
    } else if (request?.kind === "directory") {
      void loadDirectory(request.directory);
    }
  }, [loadDirectory, loadRoots]);
  const selectCurrentDirectory = useCallback(async (): Promise<void> => {
    if (!listing || selectingRef.current) {
      return;
    }
    selectingRef.current = true;
    setSelecting(true);
    try {
      await props.onSelect(listing.directory);
    } finally {
      selectingRef.current = false;
      setSelecting(false);
    }
  }, [listing, props]);

  return (
    <div
      className="ohb-directory-picker-layer"
      onClick={requestClose}
      role="presentation"
    >
      <section
        aria-label="Open project"
        aria-modal="true"
        className="ohb-directory-picker-dialog"
        onClick={(event) => {
          event.stopPropagation();
        }}
        role="dialog"
      >
        <header className="ohb-directory-picker-header">
          <span>
            <FolderOpen size={16} />
          </span>
          <h2>Open project</h2>
          <button
            aria-label="Close directory picker"
            disabled={selecting}
            onClick={requestClose}
            ref={closeButtonRef}
            title="Close directory picker"
            type="button"
          >
            <X size={16} />
          </button>
        </header>
        <div className="ohb-directory-picker-body">
          {error ? (
            <div className="ohb-directory-picker-error" role="alert">
              <p>{error}</p>
              <button disabled={loading} onClick={retry} type="button">
                Retry
              </button>
            </div>
          ) : null}
          {listing ? (
            <>
              <nav
                aria-label="Directory breadcrumb"
                className="ohb-directory-picker-breadcrumb"
              >
                <button
                  disabled={loading || selecting}
                  onClick={() => void loadRoots()}
                  type="button"
                >
                  Locations
                </button>
                {breadcrumbs.map((item) => (
                  <span key={item.directory}>
                    <ChevronRight size={14} />
                    <button
                      disabled={loading || selecting}
                      onClick={() => void loadDirectory(item.directory)}
                      type="button"
                    >
                      {item.directory}
                    </button>
                  </span>
                ))}
              </nav>
              {listing.parent ? (
                <button
                  className="ohb-directory-picker-back"
                  disabled={loading || selecting}
                  onClick={() => void loadDirectory(listing.parent ?? "")}
                  type="button"
                >
                  <ChevronLeft size={16} /> Back
                </button>
              ) : null}
              <DirectoryEntries
                disabled={loading || selecting}
                entries={listing.children}
                onOpen={(directory) => void loadDirectory(directory)}
              />
            </>
          ) : (
            <DirectoryRoots
              disabled={loading || selecting}
              onOpen={(directory) => void loadDirectory(directory)}
              roots={roots}
            />
          )}
          {loading ? (
            <p className="ohb-directory-picker-status">Loading…</p>
          ) : null}
        </div>
        <footer className="ohb-directory-picker-actions">
          <button disabled={selecting} onClick={requestClose} type="button">
            Cancel
          </button>
          {listing ? (
            <button
              disabled={loading || selecting}
              onClick={() => void selectCurrentDirectory()}
              type="button"
            >
              {selecting ? "Opening…" : "Choose this folder"}
            </button>
          ) : null}
        </footer>
      </section>
    </div>
  );
}

function DirectoryRoots(props: {
  readonly disabled: boolean;
  readonly onOpen: (directory: string) => void;
  readonly roots: DirectoryPickerRootsResponse["roots"];
}): ReactElement {
  if (props.roots.length === 0 && !props.disabled) {
    return (
      <p className="ohb-directory-picker-status">
        No accessible locations found.
      </p>
    );
  }
  return (
    <div className="ohb-directory-picker-list">
      {props.roots.map((root) => (
        <button
          disabled={props.disabled}
          key={root.directory}
          onClick={() => {
            props.onOpen(root.directory);
          }}
          type="button"
        >
          <Folder size={16} />
          <span>{root.name}</span>
          <ChevronRight size={16} />
        </button>
      ))}
    </div>
  );
}

function DirectoryEntries(props: {
  readonly disabled: boolean;
  readonly entries: DirectoryPickerListResponse["children"];
  readonly onOpen: (directory: string) => void;
}): ReactElement {
  if (props.entries.length === 0) {
    return <p className="ohb-directory-picker-status">This folder is empty.</p>;
  }
  return (
    <div className="ohb-directory-picker-list">
      {props.entries.map((entry) => (
        <button
          disabled={props.disabled}
          key={entry.directory}
          onClick={() => {
            props.onOpen(entry.directory);
          }}
          type="button"
        >
          <Folder size={16} />
          <span>{entry.name}</span>
          <ChevronRight size={16} />
        </button>
      ))}
    </div>
  );
}
