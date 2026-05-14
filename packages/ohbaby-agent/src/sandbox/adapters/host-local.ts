import fs from "node:fs/promises";
import path from "node:path";
import { SandboxAdapterError } from "../errors.js";
import type {
  CommandContext,
  CommandContextOptions,
  SandboxAdapter,
  SandboxAdapterHandle,
  SandboxCapabilities,
  SandboxCreateOptions,
} from "../types.js";

const HOST_LOCAL_CAPABILITIES: SandboxCapabilities = {
  canExecCommands: true,
  isolation: "none",
  readOnly: false,
  supportsGit: false,
};

export class HostLocalAdapter implements SandboxAdapter {
  readonly id = "host-local";

  getCapabilities(): SandboxCapabilities {
    return HOST_LOCAL_CAPABILITIES;
  }

  async create(options: SandboxCreateOptions): Promise<SandboxAdapterHandle> {
    const workdir = path.resolve(options.workdir);
    try {
      const stats = await fs.stat(workdir);
      if (!stats.isDirectory()) {
        throw new SandboxAdapterError("Host-local workdir is not a directory", {
          sessionId: options.sessionId,
          workdir,
        });
      }
    } catch (error) {
      if (error instanceof SandboxAdapterError) {
        throw error;
      }
      throw new SandboxAdapterError("Host-local workdir is unavailable", {
        cause: error,
        sessionId: options.sessionId,
        workdir,
      });
    }

    return {
      metadata: { sessionId: options.sessionId },
      workdir,
    };
  }

  destroy(): Promise<void> {
    return Promise.resolve();
  }

  resolveCommandContext(
    handle: SandboxAdapterHandle,
    _options?: CommandContextOptions,
  ): CommandContext {
    return {
      cwd: handle.workdir,
      kind: this.id,
    };
  }
}
