export type StorageKey = readonly string[];

export interface Storage {
  readText(key: StorageKey): Promise<string>;
  writeText(key: StorageKey, content: string): Promise<void>;
  readBytes(key: StorageKey): Promise<Uint8Array>;
  writeBytes(key: StorageKey, content: Uint8Array): Promise<void>;
  readJson<T>(key: StorageKey): Promise<T>;
  writeJson(key: StorageKey, value: unknown): Promise<void>;
  updateJson<T>(key: StorageKey, fn: (draft: T) => void): Promise<T>;
  exists(key: StorageKey): Promise<boolean>;
  remove(key: StorageKey): Promise<void>;
  list(prefix: StorageKey): Promise<StorageKey[]>;
}

export interface StorageOptions {
  readonly rootDir?: string;
  readonly caseInsensitivePaths?: boolean;
  readonly writeFile?: (
    path: string,
    data: string | Uint8Array,
  ) => Promise<void>;
}
