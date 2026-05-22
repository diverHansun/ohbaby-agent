export type SkillScope = "user" | "project";

export type SkillSource =
  | "project-native"
  | "user-native"
  | "claude-compatible"
  | "agents-compatible"
  | "codex-home"
  | "plugin";

export interface SkillSearchDirectory {
  readonly path: string;
  readonly scope: SkillScope;
  readonly source?: SkillSource;
  readonly priority?: number;
  readonly pluginId?: string;
}

export interface SkillLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

export type SkillRegistryChangeListener = () => void | Promise<void>;

export interface SkillInfo {
  readonly name: string;
  readonly description: string;
  readonly location: string;
  readonly baseDir: string;
  readonly allowedTools: readonly string[];
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly license?: string;
  readonly metadata: Readonly<Record<string, unknown>>;
  readonly pluginId?: string;
  readonly source: SkillSource;
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

export interface SkillResourceContent {
  readonly info: SkillInfo;
  readonly baseDir: string;
  readonly path: string;
  readonly content: string;
}

export interface SkillLoaderPort {
  scan(): Promise<Map<string, SkillInfo>>;
  loadContent(info: SkillInfo): Promise<SkillContent>;
  readResource?(
    info: SkillInfo,
    resourcePath: string,
  ): Promise<SkillResourceContent>;
  registerPluginSkills?(
    pluginId: string,
    directories: readonly (string | SkillSearchDirectory)[],
  ): void;
  deregisterPlugin?(pluginId: string): void;
}

export interface SkillRegistryPort {
  all(): Promise<readonly SkillInfo[]>;
  get(name: string): Promise<SkillInfo | undefined>;
  load(name: string): Promise<SkillContent>;
  readResource(
    name: string,
    resourcePath: string,
  ): Promise<SkillResourceContent>;
  listNames(): Promise<readonly string[]>;
  listUserInvocable(): Promise<readonly SkillInfo[]>;
  listModelInvocable(): Promise<readonly SkillInfo[]>;
  registerPluginSkills(
    pluginId: string,
    directories: readonly (string | SkillSearchDirectory)[],
  ): void;
  deregisterPlugin(pluginId: string): void;
  onChange(listener: SkillRegistryChangeListener): () => void;
  invalidate(): void;
  reload(): Promise<void>;
}
