import { SkillNotFoundError } from "./errors.js";
import { SkillLoader } from "./loader.js";
import type {
  SkillContent,
  SkillInfo,
  SkillLoaderPort,
  SkillRegistryPort,
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

  constructor(options: SkillRegistryOptions = {}) {
    this.loader = options.loader ?? new SkillLoader();
  }

  private async getCache(): Promise<Map<string, SkillInfo>> {
    if (this.cache) {
      return this.cache;
    }
    this.loading ??= this.loader.scan();
    this.cache = await this.loading;
    this.loading = undefined;
    return this.cache;
  }

  async all(): Promise<readonly SkillInfo[]> {
    return Array.from((await this.getCache()).values()).sort(byName);
  }

  async get(name: string): Promise<SkillInfo | undefined> {
    return (await this.getCache()).get(name);
  }

  async load(name: string): Promise<SkillContent> {
    const skill = await this.get(name);
    if (!skill) {
      throw new SkillNotFoundError(name, await this.listNames());
    }
    return this.loader.loadContent(skill);
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

  invalidate(): void {
    this.cache = undefined;
    this.loading = undefined;
  }

  async reload(): Promise<void> {
    this.cache = await this.loader.scan();
    this.loading = undefined;
  }
}

export const Skill = new SkillRegistry();
