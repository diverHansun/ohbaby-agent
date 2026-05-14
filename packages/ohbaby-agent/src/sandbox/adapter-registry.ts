import { SandboxAdapterError } from "./errors.js";
import type {
  SandboxAdapter,
  SandboxAdapterId,
} from "./types.js";

export class AdapterRegistry {
  private readonly adapters = new Map<SandboxAdapterId, SandboxAdapter>();

  register(adapter: SandboxAdapter): void {
    if (this.adapters.has(adapter.id)) {
      throw new SandboxAdapterError(
        `Sandbox adapter already registered: ${adapter.id}`,
        { adapterId: adapter.id },
      );
    }
    this.adapters.set(adapter.id, adapter);
  }

  get(adapterId: SandboxAdapterId): SandboxAdapter | undefined {
    return this.adapters.get(adapterId);
  }
}
