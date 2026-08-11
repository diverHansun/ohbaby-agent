export interface MergedMemory {
  readonly global: string;
  readonly project: string;
  readonly merged: string;
}

export interface ProjectInfo {
  readonly id: string;
  readonly rootPath: string;
}

export interface ProjectResolver {
  fromDirectory(directory: string): Promise<ProjectInfo> | ProjectInfo;
}

export interface MemoryLoader {
  load(directory: string): Promise<MergedMemory>;
}

export interface MemoryLoaderOptions {
  readonly projectResolver: ProjectResolver;
  readonly globalMemoryPath?: string;
  readonly onWarning?: (message: string, error?: unknown) => void;
}
