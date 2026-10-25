import {
  globalSessionRequestDirectory,
  type UiGlobalSession,
} from "ohbaby-sdk";
import type { WorkspaceScopeSummary } from "../api/daemon/wire.js";

/** Rows first shown per workspace group or Recents. */
export const GROUP_PAGE = 6;
/** Rows first shown in Pinned. */
export const PINNED_PAGE = 8;
/** Rows each Show more adds. */
export const SHOW_MORE_STEP = 20;

export type SessionActivity = "idle" | "running" | "awaiting";

export interface SidebarWorkspace {
  readonly directory: string;
  /** False when the server lists the workspace but its folder is missing. */
  readonly available: boolean;
}

export interface SidebarSessionItem {
  readonly id: string;
  readonly title: string;
  readonly workspaceDirectory: string | null;
  /** Directory of the current turn: header, live stream and approvals use it. */
  readonly workingDirectory: string;
  /** Where reopening and the next turn go; a pending move wins. */
  readonly requestDirectory: string;
  readonly updatedAt: string;
  readonly pinned: boolean;
  readonly activity: SessionActivity;
}

export type SidebarGroupKey = "pinned" | "recents" | `workspace:${string}`;

export interface SidebarGroup {
  readonly key: SidebarGroupKey;
  /** All loaded rows of the group. */
  readonly sessions: readonly SidebarSessionItem[];
  readonly visible: readonly SidebarSessionItem[];
  /** Loaded rows hidden behind Show more; never a server total. */
  readonly hiddenLoaded: number;
  /** Hidden rows exist, or more pages may hold rows for this group. */
  readonly canShowMore: boolean;
  readonly canShowLess: boolean;
}

export interface SidebarWorkspaceGroup extends SidebarGroup {
  readonly workspace: SidebarWorkspace;
}

export interface SidebarGroups {
  readonly pinned: SidebarGroup | null;
  readonly workspaces: readonly SidebarWorkspaceGroup[];
  readonly recents: SidebarGroup | null;
}

export function workspaceGroupKey(directory: string): SidebarGroupKey {
  return `workspace:${directory}`;
}

export function baseCount(key: SidebarGroupKey): number {
  return key === "pinned" ? PINNED_PAGE : GROUP_PAGE;
}

/**
 * Groups the loaded global list for the sidebar: Pinned, then workspaces in
 * server order, then Recents. Grouping follows `workspaceDirectory` only;
 * a workspace the scope list does not know gets a temporary group so no row
 * is lost. Recents includes every loaded row in server order, including pins.
 * Pinned rows are omitted only from workspace groups.
 */
export function selectSidebarGroups(input: {
  readonly workspaces: readonly WorkspaceScopeSummary[];
  readonly sessions: readonly UiGlobalSession[];
  readonly pins: Readonly<Record<string, number>>;
  readonly activity: ReadonlyMap<string, SessionActivity>;
  /** Extra rows revealed by Show more, per group key. */
  readonly extra: Readonly<Partial<Record<SidebarGroupKey, number>>>;
  readonly hasMore: boolean;
}): SidebarGroups {
  const pinned: SidebarSessionItem[] = [];
  const byWorkspace = new Map<string, SidebarSessionItem[]>();
  const recents: SidebarSessionItem[] = [];
  for (const session of input.sessions) {
    const item = toItem(session, input);
    recents.push(item);
    if (item.pinned) pinned.push(item);
    else if (item.workspaceDirectory !== null) {
      const rows = byWorkspace.get(item.workspaceDirectory) ?? [];
      rows.push(item);
      byWorkspace.set(item.workspaceDirectory, rows);
    }
  }
  pinned.sort(
    (left, right) =>
      (input.pins[right.id] ?? 0) - (input.pins[left.id] ?? 0) ||
      left.id.localeCompare(right.id),
  );
  const group = (
    key: SidebarGroupKey,
    sessions: readonly SidebarSessionItem[],
  ): SidebarGroup => {
    const extra = input.extra[key] ?? 0;
    const visible = sessions.slice(0, baseCount(key) + extra);
    const hiddenLoaded = sessions.length - visible.length;
    return {
      key,
      sessions,
      visible,
      hiddenLoaded,
      canShowMore: hiddenLoaded > 0 || input.hasMore,
      canShowLess: extra > 0,
    };
  };
  const known = new Set(
    input.workspaces.map((workspace) => workspace.directory),
  );
  const workspaces: SidebarWorkspaceGroup[] = input.workspaces.map((scope) => ({
    ...group(
      workspaceGroupKey(scope.directory),
      byWorkspace.get(scope.directory) ?? [],
    ),
    workspace: { directory: scope.directory, available: scope.available },
  }));
  for (const [directory, rows] of byWorkspace) {
    if (known.has(directory)) continue;
    workspaces.push({
      ...group(workspaceGroupKey(directory), rows),
      workspace: { directory, available: true },
    });
  }
  const anyPins = Object.keys(input.pins).length > 0;
  return {
    pinned:
      pinned.length > 0 || (anyPins && input.hasMore)
        ? group("pinned", pinned)
        : null,
    workspaces,
    recents:
      recents.length > 0 || input.hasMore ? group("recents", recents) : null,
  };
}

function toItem(
  session: UiGlobalSession,
  input: {
    readonly pins: Readonly<Record<string, number>>;
    readonly activity: ReadonlyMap<string, SessionActivity>;
  },
): SidebarSessionItem {
  return {
    id: session.id,
    title: session.title,
    workspaceDirectory: session.workspaceDirectory,
    workingDirectory: session.workingDirectory,
    requestDirectory: globalSessionRequestDirectory(session),
    updatedAt: session.updatedAt,
    pinned: Object.hasOwn(input.pins, session.id),
    activity: input.activity.get(session.id) ?? "idle",
  };
}

/** How many loaded sessions fall into `key`; Show more pages until this is enough. */
export function countGroupRows(
  key: SidebarGroupKey,
  sessions: readonly UiGlobalSession[],
  pins: Readonly<Record<string, number>>,
): number {
  if (key === "recents") return sessions.length;
  let count = 0;
  for (const session of sessions) {
    const pinned = Object.hasOwn(pins, session.id);
    const rowKey: SidebarGroupKey = pinned
      ? "pinned"
      : session.workspaceDirectory === null
        ? "recents"
        : workspaceGroupKey(session.workspaceDirectory);
    if (rowKey === key) count += 1;
  }
  return count;
}
