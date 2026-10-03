import { homedir } from "node:os";
import type {
  UiCurrentModelConfig,
  UiPermissionState,
  UiReasoningConfig,
} from "ohbaby-sdk";
import { visibleWidth } from "../../render/wrap.js";

const segments = new Intl.Segmenter(undefined, { granularity: "grapheme" });

export function sameFooterModel(
  a: UiCurrentModelConfig | null | undefined,
  b: UiCurrentModelConfig | null | undefined,
): boolean {
  if (!a || !b) return false;
  return (
    a.provider === b.provider &&
    a.model === b.model &&
    a.baseUrl === b.baseUrl &&
    a.interfaceProvider === b.interfaceProvider
  );
}

export function footerEffort(
  model: UiCurrentModelConfig | null | undefined,
  preference?: UiReasoningConfig | null,
): string {
  const view = model?.reasoning;
  if (view?.status !== "identified" || view.stale) return "unknown";
  if (view.mode === "none") return "n/a";
  const resolve = (choice?: UiReasoningConfig | null): string | undefined => {
    if (!choice) return undefined;
    if (choice.enabled === false)
      return view.supportsDisabled ? "off" : undefined;
    if (view.mode === "binary")
      return choice.effort === undefined && choice.enabled === true
        ? "on"
        : undefined;
    if (
      view.mode === "effort" &&
      choice.effort &&
      view.efforts.includes(choice.effort)
    )
      return choice.effort;
    return undefined;
  };
  return resolve(preference) ?? resolve(view.default) ?? "unknown";
}

export function formatFooterRows(input: {
  readonly width: number;
  readonly projectRoot?: string;
  readonly model?: UiCurrentModelConfig | null;
  readonly reasoning?: UiReasoningConfig | null;
  readonly permission?: UiPermissionState;
  readonly usage?: string;
}): readonly [string, string] {
  const width = Math.max(1, Math.floor(input.width));
  const home = homedir();
  const path = input.projectRoot?.trim();
  const project = !path
    ? "unknown"
    : path === home
      ? "~"
      : path.startsWith(`${home}/`)
        ? `~${path.slice(home.length)}`
        : path;
  const permission = input.permission
    ? `${input.permission.mode}/${input.permission.level}`
    : "unknown";
  const effort = footerEffort(input.model, input.reasoning);
  return [
    pair(project, permission, width, true),
    pair(
      `${input.model?.model.trim() ? input.model.model : "unknown"} · ${effort}`,
      input.usage?.trim() ? input.usage : "—",
      width,
      false,
      ` · ${effort}`,
    ),
  ];
}

function pair(
  left: string,
  right: string,
  width: number,
  middle: boolean,
  suffix = "",
): string {
  const clean = (value: string): string => value.replace(/[\r\n\t]/gu, " ");
  right = clip(clean(right), width);
  const remaining = Math.max(0, width - visibleWidth(right) - 1);
  left = clean(left);
  if (visibleWidth(left) > remaining) {
    if (suffix && visibleWidth(suffix) < remaining) {
      left =
        clip(left.slice(0, -suffix.length), remaining - visibleWidth(suffix)) +
        suffix;
    } else if (middle && remaining > 3) {
      const prefixWidth = Math.ceil((remaining - 1) / 2);
      const suffixWidth = remaining - prefixWidth - 1;
      let tail = "";
      for (const { segment: char } of Array.from(
        segments.segment(left),
      ).reverse()) {
        if (visibleWidth(char + tail) > suffixWidth) break;
        tail = char + tail;
      }
      left = clip(left, prefixWidth, false) + "…" + tail;
    } else left = clip(left, remaining);
  }
  return (
    left +
    " ".repeat(Math.max(0, width - visibleWidth(left) - visibleWidth(right))) +
    right
  );
}

function clip(value: string, width: number, ellipsis = true): string {
  if (width <= 0) return "";
  if (visibleWidth(value) <= width) return value;
  const limit = ellipsis ? width - 1 : width;
  let text = "";
  for (const { segment } of segments.segment(value)) {
    if (visibleWidth(text + segment) > limit) break;
    text += segment;
  }
  return text + (ellipsis ? "…" : "");
}
