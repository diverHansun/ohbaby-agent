// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { downloadTextFile } from "./download-file.js";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

it.each([false, true])(
  "cleans up a UTF-8 download after activation (click fails: %s)",
  (fails) => {
    vi.useFakeTimers();
    const createObjectURL = vi.fn<(blob: Blob) => string>(
      () => "blob:export-test",
    );
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    const anchors: HTMLAnchorElement[] = [];
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(function (this: HTMLAnchorElement) {
        anchors.push(this);
        expect(this.isConnected).toBe(true);
        expect(this.download).toBe("中文.jsonl");
        expect(this.href).toBe("blob:export-test");
        expect(revokeObjectURL).not.toHaveBeenCalled();
        if (fails) throw new Error("download blocked");
      });
    const invoke = (): void => {
      downloadTextFile({
        filename: "中文.jsonl",
        mimeType: "application/x-ndjson;charset=utf-8",
        content: "中文 👋\n",
      });
    };
    if (fails) expect(invoke).toThrow("download blocked");
    else invoke();
    expect(click).toHaveBeenCalledOnce();
    const blob = createObjectURL.mock.calls[0]?.[0] as Blob | undefined;
    expect(blob?.size).toBe(new TextEncoder().encode("中文 👋\n").length);
    expect(blob?.type).toBe("application/x-ndjson;charset=utf-8");
    expect(anchors[0]?.isConnected).toBe(false);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    vi.runAllTimers();
    expect(revokeObjectURL).toHaveBeenCalledOnce();
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:export-test");
  },
);
