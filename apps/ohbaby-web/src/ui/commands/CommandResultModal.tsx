import { X } from "lucide-react";
import type { ReactElement } from "react";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CommandNotice } from "../../api/daemon/wire.js";
import { ContextUsageDetails } from "../shared/ContextUsage.js";
import { MarkdownBlock } from "../shared/MarkdownBlock.js";
import {
  commandData,
  commandDataArray,
  createCommandResultModel,
  isRecord,
  outputAsJson,
  safeHelpCommands,
  statusContextWindowUsage,
  statusRows,
  type CommandResultModel,
  type CommandStatusHeader,
  type CommandStatusContext,
} from "./slashCommands.js";

export function CommandNoticeList(props: {
  readonly notices: readonly CommandNotice[];
}): ReactElement | null {
  const notices = props.notices.filter(
    (notice) => createCommandResultModel(notice) === null,
  );
  if (notices.length === 0) {
    return null;
  }
  return (
    <div className="ohb-command-notices">
      {notices.map((notice) => (
        <article
          className={`ohb-command-notice ohb-command-${notice.kind}`}
          key={notice.id}
        >
          <div className="ohb-command-label">
            <span>{notice.kind}</span>
            <span>
              {notice.path.length > 0
                ? `/${notice.path.join(" ")}`
                : notice.commandId}
            </span>
          </div>
          {notice.markdown ? (
            <MarkdownBlock text={notice.markdown} />
          ) : (
            <pre>{notice.text ?? ""}</pre>
          )}
        </article>
      ))}
    </div>
  );
}

export function CommandResultModal(props: {
  readonly header: CommandStatusHeader;
  readonly notice: CommandNotice;
  readonly onClose: () => void;
  readonly onInsertSkill: (text: string) => void;
  readonly view: CommandStatusContext;
}): ReactElement | null {
  const model = createCommandResultModel(props.notice);
  const closeButtonRef = useRef<HTMLButtonElement | null>(null);
  useEffect(() => {
    closeButtonRef.current?.focus();
  }, [props.notice.id]);
  useEffect(() => {
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "Escape") {
        props.onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return (): void => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [props.onClose]);
  if (!model) {
    return null;
  }
  return (
    <div
      className="ohb-command-modal-layer"
      onClick={props.onClose}
      role="presentation"
    >
      <section
        aria-label={model.title}
        aria-modal="true"
        className={`ohb-command-modal ohb-command-modal-${model.variant}`}
        onClick={(event) => {
          event.stopPropagation();
        }}
        role="dialog"
      >
        <header className="ohb-command-modal-header">
          <span>{model.commandLabel}</span>
          <h2>{model.title}</h2>
          <button
            onClick={props.onClose}
            ref={closeButtonRef}
            title="Close"
            type="button"
          >
            <X size={16} />
          </button>
        </header>
        <CommandResultBody
          header={props.header}
          notice={props.notice}
          onInsertSkill={props.onInsertSkill}
          variant={model.variant}
          view={props.view}
        />
      </section>
    </div>
  );
}

function CommandResultBody(props: {
  readonly header: CommandStatusHeader;
  readonly notice: CommandNotice;
  readonly onInsertSkill: (text: string) => void;
  readonly variant: CommandResultModel["variant"];
  readonly view: CommandStatusContext;
}): ReactElement {
  const data = commandData(props.notice);
  switch (props.variant) {
    case "status":
      return (
        <StatusCommandResult
          data={data}
          header={props.header}
          view={props.view}
        />
      );
    case "help":
      return <HelpCommandResult data={data} />;
    case "mcps":
      return <McpCommandResult data={data} notice={props.notice} />;
    case "skills":
      return (
        <SkillsCommandResult
          data={data}
          key={props.notice.id}
          notice={props.notice}
          onInsertSkill={props.onInsertSkill}
        />
      );
  }
}

function StatusCommandResult(props: {
  readonly data: Record<string, unknown> | null;
  readonly header: CommandStatusHeader;
  readonly view: CommandStatusContext;
}): ReactElement {
  const usage =
    statusContextWindowUsage(props.data) ?? props.header.contextWindowUsage;
  return (
    <div className="ohb-command-modal-body">
      <div className="ohb-status-result">
        {statusRows(props.data, props.header, props.view).map((row) =>
          row.label === "context" && usage?.composition ? (
            <div className="ohb-status-context-row" key={row.label}>
              <span>{row.label}</span>
              <ContextUsageDetails usage={usage} />
            </div>
          ) : (
            <div key={row.label}>
              <span>{row.label}</span>
              <span>{row.value}</span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

function HelpCommandResult(props: {
  readonly data: Record<string, unknown> | null;
}): ReactElement {
  const commands = safeHelpCommands(props.data);
  return (
    <div className="ohb-command-modal-body ohb-help-result">
      <section>
        <h3>Shortcuts</h3>
        {[
          ["Double Esc", "Interrupt"],
          ["Shift+Tab", "Cycle mode"],
          ["Esc", "Close / Back"],
          ["Tab", "Complete /cmd"],
          ["↑ ↓", "Select command"],
        ].map(([key, label]) => (
          <div className="ohb-help-row" key={key}>
            <kbd>{key}</kbd>
            <span>{label}</span>
          </div>
        ))}
      </section>
      <section>
        <h3>Commands</h3>
        {commands.length > 0 ? (
          commands.map((command) => (
            <div className="ohb-help-command" key={String(command.id)}>
              <span>{formatCommandPath(command)}</span>
              <span>{stringField(command, "description") ?? ""}</span>
            </div>
          ))
        ) : (
          <pre>commands: none</pre>
        )}
      </section>
    </div>
  );
}

function McpCommandResult(props: {
  readonly data: Record<string, unknown> | null;
  readonly notice: CommandNotice;
}): ReactElement {
  const servers = commandDataArray(props.data, "servers");
  if (servers.length === 0) {
    return <FallbackCommandResult notice={props.notice} />;
  }
  return (
    <div className="ohb-command-modal-body">
      <div className="ohb-list-result">
        {servers.map((server, index) =>
          isRecord(server) ? (
            <div
              className={`ohb-list-row ohb-list-${stringField(server, "status") ?? "unknown"}`}
              key={`${stringField(server, "name") ?? "server"}-${String(index)}`}
            >
              <span />
              <strong>{stringField(server, "name") ?? "server"}</strong>
              <small>{stringField(server, "status") ?? "unknown"}</small>
              <em>{mcpServerMeta(server)}</em>
            </div>
          ) : null,
        )}
      </div>
    </div>
  );
}

function SkillsCommandResult(props: {
  readonly data: Record<string, unknown> | null;
  readonly notice: CommandNotice;
  readonly onInsertSkill: (text: string) => void;
}): ReactElement {
  const skills = useMemo(
    () =>
      commandDataArray(props.data, "skills").filter(
        (skill): skill is Record<string, unknown> =>
          isRecord(skill) && stringField(skill, "name") !== undefined,
      ),
    [props.data],
  );
  const [selectedIndex, setSelectedIndex] = useState(0);
  const rowRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const insertSkill = (skill: Record<string, unknown>): void => {
    const name = stringField(skill, "name");
    if (!name) {
      return;
    }
    props.onInsertSkill(`/${name} `);
  };
  useEffect(() => {
    if (skills.length === 0) {
      return;
    }
    const onKeyDown = (event: globalThis.KeyboardEvent): void => {
      if (event.key === "ArrowDown") {
        event.preventDefault();
        setSelectedIndex((index) => clampIndex(index + 1, skills.length - 1));
        return;
      }
      if (event.key === "ArrowUp") {
        event.preventDefault();
        setSelectedIndex((index) => clampIndex(index - 1, skills.length - 1));
        return;
      }
      if (event.key === "PageDown") {
        event.preventDefault();
        setSelectedIndex((index) => clampIndex(index + 5, skills.length - 1));
        return;
      }
      if (event.key === "PageUp") {
        event.preventDefault();
        setSelectedIndex((index) => clampIndex(index - 5, skills.length - 1));
        return;
      }
      if (event.key === "Tab" || event.key === "Enter") {
        event.preventDefault();
        insertSkill(skills[clampIndex(selectedIndex, skills.length - 1)]);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return (): void => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [props.onInsertSkill, selectedIndex, skills]);
  const clampedIndex =
    skills.length === 0 ? 0 : clampIndex(selectedIndex, skills.length - 1);
  const selectedRowKey = `${stringField(skills[clampedIndex] ?? {}, "name") ?? "skill"}-${String(clampedIndex)}`;
  useLayoutEffect(() => {
    if (skills.length > 0) {
      rowRefs.current[clampedIndex]?.scrollIntoView?.({ block: "nearest" });
    }
  }, [clampedIndex, selectedRowKey, skills.length]);
  if (skills.length === 0) {
    return <FallbackCommandResult notice={props.notice} />;
  }
  return (
    <div className="ohb-command-modal-body">
      <div className="ohb-list-result">
        {skills.map((skill, index) => {
          const selected = index === clampedIndex;
          return (
            <button
              aria-selected={selected}
              className={`ohb-list-row ohb-list-skill ${
                selected ? "ohb-list-selected" : ""
              }`}
              key={`${stringField(skill, "name") ?? "skill"}-${String(index)}`}
              onClick={() => {
                insertSkill(skill);
              }}
              onMouseEnter={() => {
                setSelectedIndex(index);
              }}
              ref={(row) => {
                rowRefs.current[index] = row;
              }}
              type="button"
            >
              <strong>/{stringField(skill, "name") ?? "skill"}</strong>
              <span>{stringField(skill, "description") ?? ""}</span>
              <small>
                {[stringField(skill, "scope"), stringField(skill, "source")]
                  .filter((value): value is string => value !== undefined)
                  .join(" · ") || "skill"}
              </small>
            </button>
          );
        })}
      </div>
    </div>
  );
}

function FallbackCommandResult(props: {
  readonly notice: CommandNotice;
}): ReactElement {
  return (
    <div className="ohb-command-modal-body">
      <pre>{outputAsJson(props.notice.output)}</pre>
    </div>
  );
}

function formatCommandPath(command: Record<string, unknown>): string {
  const path = Array.isArray(command.path)
    ? command.path.filter(
        (segment): segment is string => typeof segment === "string",
      )
    : [];
  return path.length > 0 ? `/${path.join(" ")}` : `/${String(command.id)}`;
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function mcpServerMeta(server: Record<string, unknown>): string {
  const error = stringField(server, "error");
  if (error) {
    return error;
  }
  const toolCount = server.toolCount;
  return typeof toolCount === "number"
    ? `${String(toolCount)} ${toolCount === 1 ? "tool" : "tools"}`
    : "";
}

function clampIndex(index: number, maxIndex: number): number {
  return Math.max(0, Math.min(index, maxIndex));
}
