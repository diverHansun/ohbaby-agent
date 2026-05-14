import {
  fromDirectory,
  getProjectRoot,
  isGitProject,
} from "./project-manager.js";
import { GLOBAL_PROJECT_ID } from "./types.js";

export type { ProjectInfo, VcsType } from "./types.js";
export { GLOBAL_PROJECT_ID } from "./types.js";
export { fromDirectory, getProjectRoot, isGitProject };

export const Project = {
  GLOBAL_PROJECT_ID,
  fromDirectory,
  getProjectRoot,
  isGitProject,
} as const;
