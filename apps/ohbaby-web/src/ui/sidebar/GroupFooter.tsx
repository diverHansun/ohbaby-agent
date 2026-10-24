import type { ReactElement } from "react";
import type { SidebarGroup } from "../../store/sidebar-groups.js";
import { Spinner } from "../shared/Spinner.js";

/**
 * Show more / Show less under a group. The number counts loaded rows still
 * folded away; with only unloaded pages left it reads `Show more` alone, so
 * it never poses as a server total (06 §3.1).
 */
export function GroupFooter(props: {
  readonly group: SidebarGroup;
  readonly loading: boolean;
  readonly onMore: () => void;
  readonly onLess: () => void;
}): ReactElement | null {
  const { group } = props;
  if (!group.canShowMore && !group.canShowLess) return null;
  return (
    <div className="ohb-group-footer">
      {props.loading ? (
        <span className="ohb-group-more is-loading">
          <Spinner size={11} label="Loading more chats" />
        </span>
      ) : group.canShowMore ? (
        <button type="button" className="ohb-group-more" onClick={props.onMore}>
          {group.hiddenLoaded > 0
            ? `Show more · ${String(group.hiddenLoaded)}`
            : "Show more"}
        </button>
      ) : null}
      {group.canShowLess ? (
        <button type="button" className="ohb-group-more" onClick={props.onLess}>
          Show less
        </button>
      ) : null}
    </div>
  );
}
