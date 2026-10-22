import { SkillNotFoundError } from "./errors.js";
import { SkillLoader } from "./loader.js";
import type {
  SkillContent,
  SkillInfo,
  SkillLoaderPort,
  SkillRegistryPort,
  SkillResourceContent,
  SkillRegistryChangeListener,
  SkillSearchDirectory,
} from "./types.js";

export interface SkillRegistryOptions {
  readonly loader?: SkillLoaderPort;
}

function byName(left: SkillInfo, right: SkillInfo): number {
  return left.name.localeCompare(right.name);
}

export class SkillRegistry implements SkillRegistryPort {
  private readonly loader: SkillLoaderPort;
  private cache: Map<string, SkillInfo> | undefined;
  private loading: Promise<Map<string, SkillInfo>> | undefined;
  private signature: string | undefined;
  private refreshing: Promise<void> | undefined;
  private readonly listeners = new Set<SkillRegistryChangeListener>();

  constructor(options: SkillRegistryOptions = {}) {
    this.loader = options.loader ?? new SkillLoader();
  }

  private async getCache(): Promise<Map<string, SkillInfo>> {
    if (this.cache) {
      return this.cache;
    }
    this.loading ??= (async (): Promise<Map<string, SkillInfo>> => {
      this.signature = await this.loader.getSignature?.();
      return this.loader.scan();
    })();
    this.cache = await this.loading;
    this.loading = undefined;
    return this.cache;
  }

  async all(): Promise<readonly SkillInfo[]> {
    return Array.from((await this.getCache()).values()).sort(byName);
  }

  async get(name: string): Promise<SkillInfo | undefined> {
    await this.refresh();
    return (await this.getCache()).get(name);
  }

  async load(name: string): Promise<SkillContent> {
    const skill = await this.get(name);
    if (!skill) {
      throw new SkillNotFoundError(name, await this.listNames());
    }
    return this.loader.loadContent(skill);
  }

  async readResource(
    name: string,
    resourcePath: string,
  ): Promise<SkillResourceContent> {
    const skill = await this.get(name);
    if (!skill) {
      throw new SkillNotFoundError(name, await this.listNames());
    }
    if (!this.loader.readResource) {
      throw new Error("Skill loader does not support resource reads.");
    }
    return this.loader.readResource(skill, resourcePath);
  }

  async listNames(): Promise<readonly string[]> {
    return (await this.all()).map((skill) => skill.name);
  }

  async listUserInvocable(): Promise<readonly SkillInfo[]> {
    return (await this.all()).filter((skill) => skill.userInvocable);
  }

  async listModelInvocable(): Promise<readonly SkillInfo[]> {
    return (await this.all()).filter((skill) => !skill.disableModelInvocation);
  }

  registerPluginSkills(
    pluginId: string,
    directories: readonly (string | SkillSearchDirectory)[],
  ): void {
    this.loader.registerPluginSkills?.(pluginId, directories);
    this.invalidate();
    // Synchronous plugin callbacks cannot await consumers; tool refresh reports
    // its warning at the composition boundary. Explicit reloads still reject.
    void this.notifyChanged().catch(() => undefined);
  }

  deregisterPlugin(pluginId: string): void {
    this.loader.deregisterPlugin?.(pluginId);
    this.invalidate();
    void this.notifyChanged().catch(() => undefined);
  }

  onChange(listener: SkillRegistryChangeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  invalidate(): void {
    this.cache = undefined;
    this.loading = undefined;
  }

  /** Entry point for production reads; notification consumers use cached lists. */
  refresh(): Promise<void> {
    this.refreshing ??= (async (): Promise<void> => {
      const signature = await this.loader.getSignature?.();
      if (!this.cache || signature !== this.signature) await this.reload();
    })().finally(() => {
      this.refreshing = undefined;
    });
    return this.refreshing;
  }

  async reload(directories?: readonly SkillSearchDirectory[]): Promise<void> {
    if (directories) this.loader.setDirectories?.(directories);
    const signature = await this.loader.getSignature?.();
    const next = await this.loader.scan();
    const changed =
      JSON.stringify([...next.values()].sort(byName)) !==
      JSON.stringify([...(this.cache?.values() ?? [])].sort(byName));
    this.cache = next;
    this.signature = signature;
    this.loading = undefined;
    if (changed) await this.notifyChanged();
  }

  private async notifyChanged(): Promise<void> {
    await Promise.all([...this.listeners].map(async (listener) => listener()));
  }
}

export const Skill = new SkillRegistry();
