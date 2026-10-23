import { Folder, FolderPlus } from "lucide-react";
import type { ReactElement } from "react";
import { LycheeMark } from "../shared/LycheeMark.js";
import { workspaceLabel } from "../workspace/workspace-labels.js";

/**
 * Empty-state heading above the composer card: the Lychee mark and the
 * project slot. In this batch the slot only names the current folder; without one it
 * offers to open a folder. The real project picker arrives in improve-2.
 */
export function DraftHero(props: {
  readonly directory: string | null;
  readonly onOpenFolder?: () => void;
}): ReactElement {
  return (
    <div className="ohb-draft-hero">
      <LycheeMark size={40} />
      {props.directory ? (
        <span className="ohb-project-slot" title={props.directory}>
          <Folder aria-hidden="true" size={14} />
          <span>{workspaceLabel(props.directory)}</span>
        </span>
      ) : (
        <button
          type="button"
          className="ohb-project-slot"
          onClick={props.onOpenFolder}
        >
          <FolderPlus aria-hidden="true" size={14} />
          <span>Open folder…</span>
        </button>
      )}
    </div>
  );
}
