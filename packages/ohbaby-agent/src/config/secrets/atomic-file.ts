import fs from "node:fs/promises";
import path from "node:path";

export async function writeFileAtomically(
  filePath: string,
  content: string,
): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${String(process.pid)}-${String(Date.now())}`;
  await fs.writeFile(tempPath, content, "utf-8");
  await fs.rename(tempPath, filePath);
}
