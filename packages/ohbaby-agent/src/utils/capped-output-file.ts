import fs from "node:fs";
import path from "node:path";

/** 10 MiB, including any incompleteness marker. */
export const TOOL_OUTPUT_MAX_BYTES = 10 * 1024 * 1024;
const SIZE_MARKER = Buffer.from(
  "\n\n... [output truncated: 10 MiB file limit reached]\n",
);
const INCOMPLETE_MARKER = Buffer.from(
  "\n\n... [output incomplete: stdio capture ended early]\n",
);

export type OutputFileSnapshot =
  | { readonly status: "unavailable" }
  | {
      readonly status: "full" | "in-progress";
      readonly path: string;
      readonly sizeBytes: number;
    }
  | {
      readonly status: "partial";
      readonly path: string;
      readonly sizeBytes: number;
      readonly reason: "size-limit" | "stdio-incomplete";
    };

/** Synchronous bounded writes: no pending chunk queue or asynchronous flush race. */
export class CappedOutputFile {
  private fd?: number;
  private sizeBytes = 0;
  private state: OutputFileSnapshot["status"] = "unavailable";
  private reason: "size-limit" | "stdio-incomplete" = "stdio-incomplete";

  constructor(private readonly filePath?: string) {
    if (!filePath) return;
    try {
      const directory = path.dirname(filePath);
      if (
        !fs.lstatSync(directory).isDirectory() ||
        fs.realpathSync(directory) !== directory
      )
        throw new Error("Output directory is redirected");
      // Exclusive creation never follows or overwrites an existing file/symlink.
      this.fd = fs.openSync(filePath, "wx+", 0o600);
      this.state = "in-progress";
    } catch {
      this.fail();
    }
  }

  append(chunk: unknown): void {
    if (this.fd === undefined) return;
    try {
      const bytes = Buffer.isBuffer(chunk)
        ? chunk
        : Buffer.from(String(chunk), "utf8");
      const remaining = TOOL_OUTPUT_MAX_BYTES - this.sizeBytes;
      this.write(bytes.subarray(0, remaining));
      if (bytes.length > remaining) {
        this.markPartial(SIZE_MARKER, "size-limit");
        this.close();
      }
    } catch {
      this.fail();
    }
  }

  finish(complete: boolean): void {
    if (this.fd === undefined) return;
    try {
      if (complete) this.state = "full";
      else this.markPartial(INCOMPLETE_MARKER, "stdio-incomplete");
      this.close();
    } catch {
      this.fail();
    }
  }

  snapshot(incomplete = false): OutputFileSnapshot {
    if (this.state === "unavailable" || !this.filePath)
      return { status: "unavailable" };
    const details = { path: this.filePath, sizeBytes: this.sizeBytes };
    if (
      this.state === "partial" ||
      (incomplete && this.state === "in-progress")
    )
      return { ...details, status: "partial", reason: this.reason };
    return { ...details, status: this.state };
  }

  private write(bytes: Buffer): void {
    if (this.fd === undefined) return;
    let offset = 0;
    while (offset < bytes.length) {
      const written = fs.writeSync(
        this.fd,
        bytes,
        offset,
        bytes.length - offset,
        this.sizeBytes,
      );
      if (written <= 0) throw new Error("Output file write made no progress");
      this.sizeBytes += written;
      offset += written;
    }
  }

  private markPartial(
    marker: Buffer,
    reason: "size-limit" | "stdio-incomplete",
  ): void {
    if (this.fd === undefined) return;
    const limit = TOOL_OUTPUT_MAX_BYTES - marker.length;
    let end = Math.min(this.sizeBytes, limit);
    if (end > 0) {
      // A prefix may end inside a character, including after an abandoned chunk.
      // Inspect at most four trailing bytes without decoding/re-encoding the log.
      const start = Math.max(0, end - 4);
      const boundary = Buffer.alloc(end - start);
      const read = fs.readSync(this.fd, boundary, 0, boundary.length, start);
      if (read !== boundary.length)
        throw new Error("Output file boundary could not be read");
      let lead = boundary.length - 1;
      while (lead > 0 && (boundary[lead] & 0xc0) === 0x80) lead--;
      const first = boundary[lead];
      const characterBytes =
        first >= 0xf0 ? 4 : first >= 0xe0 ? 3 : first >= 0xc0 ? 2 : 1;
      if (characterBytes > boundary.length - lead) end = start + lead;
    }
    if (end < this.sizeBytes) {
      fs.ftruncateSync(this.fd, end);
      this.sizeBytes = end;
    }
    this.write(marker);
    this.reason = reason;
    this.state = "partial";
  }

  private close(): void {
    const fd = this.fd;
    this.fd = undefined;
    if (fd !== undefined) fs.closeSync(fd);
  }

  private fail(): void {
    this.state = "unavailable";
    try {
      this.close();
    } catch {
      /* The file is never advertised after an I/O failure. */
    }
  }
}

export function outputFileNotice(file: OutputFileSnapshot): string {
  switch (file.status) {
    case "full":
      return `Full output (${String(file.sizeBytes)} bytes) saved to ${file.path}. Use read or grep to inspect it.`;
    case "in-progress":
      return `Output captured so far: ${file.path}. Capture is still in progress; the file is incomplete.`;
    case "partial":
      return `Partial output saved to ${file.path} (${file.reason === "size-limit" ? "10 MiB file limit reached" : "stdio capture is incomplete"}). Use read or grep to inspect it.`;
    case "unavailable":
      return "Full output could not be saved; only the displayed output is available.";
  }
}
