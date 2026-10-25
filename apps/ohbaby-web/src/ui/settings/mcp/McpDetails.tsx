import type { ReactElement, ReactNode } from "react";
import {
  mcpStatusText,
  transportLabel,
  type McpServerRow,
} from "./mcp-rows.js";

/**
 * Read-only detail of one global MCP server, expanded under its row
 * (05 McpDetails): its config, the actual connection and its tools. Optional
 * fields without a value are left out; env and header values never reach the
 * page, only their names. No save, toggle or reconnect (D25).
 */
export function McpDetails(props: {
  readonly row: McpServerRow;
}): ReactElement {
  const { config, live } = props.row;
  const lines: [string, ReactNode][] = [
    ["Transport", transportLabel(config.transport)],
  ];
  if (config.command !== undefined)
    lines.push([
      "Command",
      <code key="command" className="ohb-mcp-code">
        {config.command}
      </code>,
    ]);
  if (config.args && config.args.length > 0)
    lines.push([
      "Args",
      <span key="args" className="ohb-mcp-lines">
        {config.args.map((arg, index) => (
          <code key={index} className="ohb-mcp-code">
            {arg}
          </code>
        ))}
      </span>,
    ]);
  if (config.url !== undefined)
    lines.push([
      "URL",
      <code key="url" className="ohb-mcp-code">
        {config.url}
      </code>,
    ]);
  if (config.envKeys.length > 0)
    lines.push(["Environment", names(config.envKeys)]);
  if (config.headerKeys.length > 0)
    lines.push(["Headers", names(config.headerKeys)]);
  if (config.cwd !== undefined)
    lines.push([
      "Start in",
      <code key="cwd" className="ohb-mcp-code">
        {config.cwd}
      </code>,
    ]);
  lines.push(["Timeout (ms)", String(config.timeout)]);
  lines.push(["Trust", config.trust ? "Trusted" : "Not trusted"]);
  if (config.includeTools && config.includeTools.length > 0)
    lines.push(["Include tools", names(config.includeTools)]);
  if (config.excludeTools && config.excludeTools.length > 0)
    lines.push(["Exclude tools", names(config.excludeTools)]);
  lines.push(["Status", statusLabel(props.row)]);
  if (live?.error)
    lines.push([
      "Reason",
      <span key="reason" className="ohb-mcp-error">
        {live.error}
      </span>,
    ]);

  return (
    <div className="ohb-mcp-details">
      <dl className="ohb-mcp-config">
        {lines.map(([label, value]) => (
          <div key={label} className="ohb-mcp-config-row">
            <dt>{label}</dt>
            <dd>{value}</dd>
          </div>
        ))}
      </dl>
      {live && live.tools.length > 0 ? (
        <div className="ohb-mcp-tools">
          <h4>Tools</h4>
          <ul>
            {live.tools.map((tool) => (
              <li key={tool.name}>
                <code className="ohb-mcp-code">{tool.mcpToolName}</code>
                {tool.description ? <span>{tool.description}</span> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  );
}

function names(values: readonly string[]): ReactElement {
  return (
    <span className="ohb-mcp-lines">
      {values.map((value) => (
        <code key={value} className="ohb-mcp-code">
          {value}
        </code>
      ))}
    </span>
  );
}

function statusLabel(row: McpServerRow): string {
  switch (row.status) {
    case "connected":
      return `Connected · ${mcpStatusText(row)}`;
    case "failed":
      return "Failed";
    case "off":
      return "Off in the config";
    case "not-connected":
      return "Not connected";
    case "unknown":
      return "—";
  }
}
