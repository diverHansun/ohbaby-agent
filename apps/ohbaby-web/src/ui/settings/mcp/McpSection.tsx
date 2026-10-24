import { ChevronRight } from "lucide-react";
import type { ReactElement } from "react";
import { useState } from "react";
import type { SettingsLayer } from "../../../runtime/settings-layer.js";
import { SettingsRow } from "../../shared/SettingsRow.js";
import { Spinner } from "../../shared/Spinner.js";
import { useDelayed } from "../../shared/use-delayed.js";
import { SectionHeader, SectionStatus } from "../SectionFrame.js";
import { useSettingsResource } from "../useSettingsResource.js";
import { McpDetails } from "./McpDetails.js";
import { mcpStatusText, mergeMcpRows } from "./mcp-rows.js";

/**
 * MCP: the global servers with the connected instance's actual state
 * (04 §2.6). Rows expand into read-only detail. Refresh only rereads the
 * config and the status; changes to the config go through ohbaby (D25).
 */
export function McpSection(props: {
  readonly settings: SettingsLayer;
  readonly visible: boolean;
}): ReactElement {
  const servers = useSettingsResource(
    props.settings,
    "mcpServers",
    props.visible,
  );
  const status = useSettingsResource(
    props.settings,
    "mcpStatus",
    props.visible,
  );
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [refreshing, setRefreshing] = useState(false);
  const statusPending = status.data === undefined && status.status !== "error";
  const statusLoading = useDelayed(statusPending, 300);
  const rows = servers.data
    ? mergeMcpRows(
        servers.data,
        status.status === "error" ? undefined : status.data,
      )
    : [];

  const refresh = (): void => {
    setRefreshing(true);
    void Promise.all([servers.reload(), status.reload()]).finally(() => {
      setRefreshing(false);
    });
  };

  return (
    <section className="ohb-settings-section" aria-label="MCP">
      <SectionHeader
        title="MCP"
        action={
          <button
            type="button"
            className="ohb-text-button"
            aria-busy={refreshing}
            disabled={refreshing}
            onClick={refresh}
          >
            {refreshing ? <Spinner size={12} /> : null}
            Refresh
          </button>
        }
      />
      <SectionStatus
        resource={servers}
        failure="Couldn't read the MCP config."
        empty={servers.data?.length === 0 ? "No MCP servers." : undefined}
      />
      {servers.data && servers.data.length > 0 && status.status === "error" ? (
        <SectionStatus
          resource={status}
          failure="Couldn't read the connection status."
        />
      ) : null}
      {rows.map((row) => {
        const open = expanded.has(row.name);
        return (
          <div key={row.name} className="ohb-settings-row-wrap">
            <SettingsRow
              expanded={open}
              label={
                <span className="ohb-settings-disclosure">
                  <ChevronRight
                    aria-hidden="true"
                    size={13}
                    className={`ohb-settings-disclosure-chevron${open ? " is-open" : ""}`}
                  />
                  {row.name}
                </span>
              }
              value={
                // The status column stays empty while the first read runs.
                row.status === "unknown" && statusPending ? (
                  statusLoading ? (
                    <Spinner size={12} label="Reading status" />
                  ) : undefined
                ) : (
                  <span
                    className={
                      row.status === "failed" ? "ohb-mcp-failed" : undefined
                    }
                  >
                    {mcpStatusText(row)}
                  </span>
                )
              }
              onClick={() => {
                setExpanded((current) => {
                  const next = new Set(current);
                  if (next.has(row.name)) next.delete(row.name);
                  else next.add(row.name);
                  return next;
                });
              }}
            />
            {open ? <McpDetails row={row} /> : null}
          </div>
        );
      })}
    </section>
  );
}
