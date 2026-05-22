export type SkillScope = "user" | "project";

export interface SkillSearchDirectory {
  readonly path: string;
  readonly scope: SkillScope;
}

export interface SkillLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly baseDir: string;
  readonly userInvocable: boolean;
  readonly disableModelInvocation: boolean;
  readonly scope: SkillScope;
}

export interface SkillContent {
  readonly info: SkillInfo;
  readonly baseDir: string;
  readonly content: string;
  readonly files: readonly string[];
}

export interface SkillLoaderPort {
  scan(): Promise<Map<string, SkillInfo>>;
  loadContent(info: SkillInfo): Promise<SkillContent>;
}

export interface SkillRegistryPort {
  all(): Promise<readonly SkillInfo[]>;
  get(name: string): Promise<SkillInfo | undefined>;
  load(name: string): Promise<SkillContent>;
  listNames(): Promise<readonly string[]>;
  listUserInvocable(): Promise<readonly SkillInfo[]>;
  listModelInvocable(): Promise<readonly SkillInfo[]>;
  invalidate(): void;
  reload(): Promise<void>;
}
