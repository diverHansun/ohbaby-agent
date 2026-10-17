import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

const MAX_NAME_ATTEMPTS = 1000;

export interface SaveExportFs {
  mkdir(directory: string, options: { recursive: true }): Promise<unknown>;
  writeFile(
    file: string,
    content: string,
    options: { encoding: "utf8"; flag: "wx" },
  ): Promise<void>;
}

const nodeFs: SaveExportFs = { mkdir, writeFile };

function isAlreadyExists(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "EEXIST"
  );
}

/** Writes without ever replacing an existing file: name.ext, name-1.ext, name-2.ext... */
export async function saveExportFile(
  input: {
    readonly directory: string;
    readonly filename: string;
    readonly content: string;
  },
  fs: SaveExportFs = nodeFs,
): Promise<string> {
  // The server suggests the name; only its basename may reach the filesystem.
  const filename = path.basename(input.filename.replaceAll("\\", "/"));
  if (filename.length === 0 || filename === "." || filename === "..") {
    throw new Error(`Invalid export file name: ${input.filename}`);
  }
  const extension = path.extname(filename);
  const stem = filename.slice(0, filename.length - extension.length);
  await fs.mkdir(input.directory, { recursive: true });
  for (let attempt = 0; attempt < MAX_NAME_ATTEMPTS; attempt += 1) {
    const candidate = path.join(
      input.directory,
      attempt === 0 ? filename : `${stem}-${String(attempt)}${extension}`,
    );
    try {
      await fs.writeFile(candidate, input.content, {
        encoding: "utf8",
        flag: "wx",
      });
      return candidate;
    } catch (error) {
      if (!isAlreadyExists(error)) throw error;
    }
  }
  throw new Error(`Could not find a free file name for ${filename}`);
}
