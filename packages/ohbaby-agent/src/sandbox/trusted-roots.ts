import path from "node:path";
import { canonicalizePathTarget } from "../utils/path-canonicalize.js";
import { containsOrEqualPath } from "./boundary.js";

export type TrustedRootKind =
  | "active-skill"
  | "external-approved"
  | "skill-output"
  | "workspace";

export interface TrustedRoot {
  readonly kind: TrustedRootKind;
  readonly path: string;
  readonly source?: string;
}

function rootKey(rootPath: string, kind: TrustedRootKind): string {
  const normalized = path.normalize(path.resolve(rootPath));
  return `${kind}:${process.platform === "win32" ? normalized.toLowerCase() : normalized}`;
}

export class TrustedRootRegistry {
  private readonly roots = new Map<string, TrustedRoot>();

  private constructor(workspaceRoot: string) {
    this.addCanonicalRoot({
      kind: "workspace",
      path: workspaceRoot,
    });
  }

  static async create(workspaceRoot: string): Promise<TrustedRootRegistry> {
    return new TrustedRootRegistry(await canonicalizePathTarget(workspaceRoot));
  }

  async add(input: {
    readonly kind: TrustedRootKind;
    readonly path: string;
    readonly source?: string;
  }): Promise<TrustedRoot> {
    const trustedRoot = this.addCanonicalRoot({
      ...input,
      path: await canonicalizePathTarget(input.path),
    });
    return trustedRoot;
  }

  contains(absolutePath: string): boolean {
    return this.snapshot().some((root) =>
      containsOrEqualPath(root.path, absolutePath),
    );
  }

  snapshot(): readonly TrustedRoot[] {
    return [...this.roots.values()];
  }

  private addCanonicalRoot(root: TrustedRoot): TrustedRoot {
    const resolved = {
      ...root,
      path: path.resolve(root.path),
    };
    this.roots.set(rootKey(resolved.path, resolved.kind), resolved);
    return resolved;
  }
}
