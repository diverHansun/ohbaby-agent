export type VcsType = "git";

export interface ProjectInfo {
  readonly id: string;
  readonly rootPath: string;
  readonly vcs?: VcsType;
}

export const GLOBAL_PROJECT_ID = "global";
