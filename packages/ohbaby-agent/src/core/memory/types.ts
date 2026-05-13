import type { BusInstance } from "../../bus/index.js";

export type MemoryScope = "global" | "project";

export interface MergedMemory {
  readonly global: string;
  readonly project: string;
  readonly merged: string;
}

export interface MemoryEntry {
  readonly index: number;
  readonly timestamp: string;
  readonly text: string;
}

export interface AddMemoryInput {
  readonly scope: MemoryScope;
  readonly fact: string;
  readonly directory?: string;
}

export interface UpdateMemoryInput {
  readonly scope: MemoryScope;
  readonly directory?: string;
  readonly index: number;
  readonly newText: string;
}

export interface RemoveMemoryInput {
  readonly scope: MemoryScope;
  readonly directory?: string;
  readonly index: number;
}

export interface ProjectInfo {
  readonly id: string;
  readonly rootPath: string;
}

export interface ProjectResolver {
  fromDirectory(directory: string): Promise<ProjectInfo> | ProjectInfo;
}

export interface MemoryManager {
  load(directory: string): Promise<MergedMemory>;
  add(input: AddMemoryInput): Promise<void>;
  update(input: UpdateMemoryInput): Promise<void>;
  remove(input: RemoveMemoryInput): Promise<void>;
  listEntries(scope: MemoryScope, directory?: string): Promise<MemoryEntry[]>;
  refresh(directory: string): Promise<MergedMemory>;
}

export interface MemoryManagerOptions {
  readonly bus: BusInstance;
  readonly projectResolver: ProjectResolver;
  readonly globalMemoryPath?: string;
  readonly now?: () => Date;
  readonly onWarning?: (message: string, error?: unknown) => void;
}

export interface MemoryToolDefinition {
  readonly name: string;
  readonly category: "memory";
  readonly operationType: "read" | "write";
  readonly description: string;
  readonly parametersJsonSchema: Record<string, unknown>;
}
