import type {
  SessionFileContent,
  SessionFileEntry,
  SessionFilesApi,
} from "../api/daemon/session-files.js";

const minutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const REPORT = `# Session storage review

The scratch folder keeps notes, logs and reports **out of the workspace**.

## Findings

1. Reports over 50 KB are saved under \`subagents/\`.
2. Long tool output is saved under \`tool-results/\`.

| Area | Status |
| --- | --- |
| Permissions | Done |
| Files page | In review |

\`\`\`ts
const root = resolveSessionStorageRoot();
\`\`\`

> Files stay until the chat is deleted for good.
`;

const LOG = Array.from(
  { length: 60 },
  (_, index) =>
    `[${String(index).padStart(2, "0")}] vitest run packages/ohbaby-agent/src/services/session-storage.integration.test.ts — ok`,
).join("\n");

/** A gradient with a transparent spot, drawn on the fly so the checkerboard shows. */
function mockImage(): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = 640;
  canvas.height = 400;
  const context = canvas.getContext("2d");
  if (context) {
    // Brand tokens, so the mock keeps colors in the stylesheet.
    const token = (name: string): string =>
      getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    const gradient = context.createLinearGradient(0, 0, 640, 400);
    gradient.addColorStop(0, token("--brand-by"));
    gradient.addColorStop(1, token("--brand-ba"));
    context.fillStyle = gradient;
    context.fillRect(0, 0, 640, 400);
    context.clearRect(440, 60, 140, 140);
  }
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("mock image"));
    }, "image/png");
  });
}

const FILES: readonly (SessionFileEntry & {
  readonly content?: SessionFileContent;
  readonly error?: { readonly code: string; readonly status: number };
})[] = [
  {
    path: "build.log",
    size: LOG.length,
    modifiedAt: minutesAgo(3),
    content: { kind: "text", text: LOG },
  },
  {
    path: "notes/plan.txt",
    size: 412,
    modifiedAt: minutesAgo(18),
    content: {
      kind: "text",
      text: "1. Read the backend routes\n2. Add the Files page\n3. Review in the browser\n",
    },
  },
  {
    path: "reports/session-storage-review.md",
    size: REPORT.length,
    modifiedAt: minutesAgo(42),
    content: { kind: "text", text: REPORT },
  },
  {
    path: "screenshots/panel.png",
    size: 1_284_000,
    modifiedAt: minutesAgo(65),
  },
  {
    path: "archive/results.zip",
    size: 3_400_000,
    modifiedAt: minutesAgo(180),
    error: { code: "UNSUPPORTED_FILE_TYPE", status: 415 },
  },
];

/** The mock has no daemon; one chat's scratch folder is enough to preview the page. */
export const mockSessionFiles: SessionFilesApi = {
  list: () => Promise.resolve(FILES),
  read: async (_root, path) => {
    const file = FILES.find((entry) => entry.path === path);
    if (!file)
      throw Object.assign(new Error("File not found"), {
        code: "FILE_NOT_FOUND",
        status: 404,
      });
    if (file.error) throw Object.assign(new Error(file.error.code), file.error);
    if (file.content) return file.content;
    return { kind: "image", url: URL.createObjectURL(await mockImage()) };
  },
};
