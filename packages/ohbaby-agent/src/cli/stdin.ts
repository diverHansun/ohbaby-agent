import type { Readable } from "node:stream";

export function readStdin(stream: Readable = process.stdin): Promise<string> {
  return new Promise((resolve, reject) => {
    let content = "";
    stream.setEncoding("utf8");
    stream.on("data", (chunk: string) => {
      content += chunk;
    });
    stream.on("error", reject);
    stream.on("end", () => {
      resolve(content);
    });
  });
}

