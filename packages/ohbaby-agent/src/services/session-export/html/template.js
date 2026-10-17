(() => {
  "use strict";

  function escapeHtml(value) {
    return String(value).replace(
      /[&<>"']/g,
      (character) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[character],
    );
  }

  // Decode entities once, then escape the accepted URL again for its attribute.
  // Otherwise entities such as &#x61; or &colon; can hide executable schemes.
  const parser = new DOMParser();

  // DOMParser yields an inert document: nothing in it runs or loads, and its
  // nodes are only adopted after every value was escaped by this viewer.
  function setHtml(target, html) {
    const parsed = parser.parseFromString(`<body>${html}`, "text/html");
    target.replaceChildren(...parsed.body.childNodes);
  }

  function safeLink(value) {
    const escaped = value.replace(/</g, "&lt;").replace(/>/g, "&gt;");
    const url = (
      parser.parseFromString(escaped, "text/html").body.textContent ?? ""
    )
      .replace(/[\u0000-\u001f\u007f-\u009f]/g, "")
      .trim();
    const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(url);
    if (scheme && !/^(https?|mailto)$/i.test(scheme[1])) return undefined;
    return url.replace(/ /g, "%20");
  }

  const markdown = new marked.Marked({
    gfm: true,
    breaks: true,
    tokenizer: {
      html() {
        return undefined;
      },
      tag() {
        return undefined;
      },
    },
    renderer: {
      html({ text }) {
        return escapeHtml(text);
      },
      link({ href, title, tokens }) {
        const label = this.parser.parseInline(tokens);
        const url = safeLink(href);
        if (url === undefined) return label;
        const titleAttribute = title ? ` title="${escapeHtml(title)}"` : "";
        return `<a href="${escapeHtml(url)}" rel="noopener noreferrer"${titleAttribute}>${label}</a>`;
      },
      image({ text }) {
        return escapeHtml(text);
      },
    },
  });

  // ---- Formatting -------------------------------------------------------

  const dayFormat = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
  const timeFormat = new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const fullFormat = new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });

  function parseDate(iso) {
    const date = new Date(iso);
    return Number.isNaN(date.getTime()) ? undefined : date;
  }

  // The machine-readable original stays in datetime/title; only the label is localized.
  function timeElement(iso, format) {
    const date = parseDate(iso);
    const label = date ? format.format(date) : String(iso);
    return `<time datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${escapeHtml(label)}</time>`;
  }

  function formatDuration(fromIso, toIso) {
    const from = parseDate(fromIso);
    const to = parseDate(toIso);
    if (!from || !to) return undefined;
    const seconds = (to.getTime() - from.getTime()) / 1000;
    if (!Number.isFinite(seconds) || seconds < 0) return undefined;
    // Round once at the displayed precision, then decompose, so carries never
    // surface as non-canonical units such as "60 s" or "60 m".
    const tenths = Math.round(seconds * 10) / 10;
    if (tenths < 10) return `${tenths.toFixed(1)} s`;
    const total = Math.round(seconds);
    if (total < 60) return `${total} s`;
    if (total < 3600)
      return `${Math.floor(total / 60)} m ${String(total % 60).padStart(2, "0")} s`;
    const minutes = Math.round(seconds / 60);
    return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, "0")} m`;
  }

  function formatCount(value) {
    return typeof value === "number" && Number.isFinite(value)
      ? value.toLocaleString("en-US")
      : String(value);
  }

  // Routine outcomes add noise; anything unusual is shown and the alarming
  // ones receive the alert tone so they remain recognisable at a glance.
  const ROUTINE_FINISH = new Set([
    "stop",
    "end_turn",
    "tool-calls",
    "tool_calls",
    "tool_use",
  ]);
  const ALERT_STATES = new Set([
    "error",
    "aborted",
    "abort",
    "failed",
    "interrupted",
    "length",
    "content-filter",
    "content_filter",
  ]);

  function state(label, tone) {
    const resolved =
      tone ??
      (label === "running" || label === "pending"
        ? "active"
        : ALERT_STATES.has(label)
          ? "alert"
          : "neutral");
    return `<span class="state state-${resolved}">${escapeHtml(label)}</span>`;
  }

  // ---- Tool output ------------------------------------------------------

  function toolText(output) {
    const image =
      /!\[([^\]\r\n]*)\]\((data:image\/(?:png|jpeg|gif|webp);base64,([A-Za-z0-9+/]*={0,2}))\)/g;
    let rendered = "";
    let offset = 0;
    for (const match of output.matchAll(image)) {
      const encoded = match[3];
      // Canonical base64 also rejects bad padding, truncated and empty payloads.
      if (!encoded || encoded.length % 4 !== 0) continue;
      try {
        if (btoa(atob(encoded)) !== encoded) continue;
      } catch {
        continue;
      }
      rendered += escapeHtml(output.slice(offset, match.index));
      rendered += `<img src="${escapeHtml(match[2])}" alt="${escapeHtml(match[1])}" loading="lazy">`;
      offset = match.index + match[0].length;
    }
    return rendered + escapeHtml(output.slice(offset));
  }

  function renderOutput(output) {
    const lines = output.split("\n");
    if (lines.length <= 20)
      return `<pre class="tool-output"><code>${toolText(output)}</code></pre>`;
    return `<div class="tool-output"><pre class="tool-output-preview"><code>${toolText(lines.slice(0, 20).join("\n"))}</code></pre><details class="tool-output-more"><summary>${lines.length - 20} more lines</summary><pre><code>${toolText(lines.slice(20).join("\n"))}</code></pre></details></div>`;
  }

  // A one-line cue for the collapsed tool row. The complete input is always
  // rendered inside the disclosure, so this is purely a reading aid.
  const HINT_KEYS = [
    "command",
    "cmd",
    "file_path",
    "filePath",
    "path",
    "pattern",
    "query",
    "url",
    "description",
    "prompt",
    "name",
  ];
  function toolHint(input) {
    if (!input || typeof input !== "object") return "";
    for (const key of HINT_KEYS) {
      const value = input[key];
      if (typeof value === "string" && value.trim())
        return value.replace(/\s+/g, " ").trim().slice(0, 240);
    }
    return "";
  }

  // ---- Parts ------------------------------------------------------------

  function renderPart(part) {
    let content;
    switch (part.type) {
      case "text":
        content = `<div class="markdown">${markdown.parse(part.text)}</div>`;
        break;
      case "reasoning": {
        const ending =
          part.endReason && part.endReason !== "normal"
            ? state(part.endReason)
            : "";
        content = `<details class="reasoning"><summary><span class="summary-title">Reasoning</span>${ending}</summary><pre><code>${escapeHtml(part.text)}</code></pre></details>`;
        break;
      }
      case "tool": {
        const hint = toolHint(part.input);
        const status =
          part.status && part.status !== "completed" ? state(part.status) : "";
        const output =
          part.output === undefined
            ? ""
            : `<div class="part-label">Output</div>${renderOutput(part.output)}`;
        const error =
          part.error === undefined
            ? ""
            : `<div class="part-label">Error</div><pre class="error"><code>${escapeHtml(part.error)}</code></pre>`;
        content = `<details class="tool"><summary><span class="tool-name">${escapeHtml(part.tool)}</span>${hint ? `<span class="tool-hint">${escapeHtml(hint)}</span>` : ""}${status}</summary><div class="tool-body"><div class="part-label">Input</div><pre><code>${escapeHtml(JSON.stringify(part.input, null, 2))}</code></pre>${output}${error}<div class="call-id">Call ID <span>${escapeHtml(part.callId)}</span></div></div></details>`;
        break;
      }
      default:
        content = "";
    }
    if (!part.compacted) return `<div class="part">${content}</div>`;
    return `<div class="part compacted"><span class="part-label" title="Kept in the export; no longer part of the model context">Compacted</span>${content}</div>`;
  }

  // ---- Messages ---------------------------------------------------------

  function roleClass(role) {
    return (
      String(role)
        .replace(/[^a-z-]/gi, "")
        .toLowerCase() || "unknown"
    );
  }

  let previousDay;

  function renderMessage(message) {
    const created = parseDate(message.time.created);
    const day = created ? dayFormat.format(created) : undefined;
    const showDay = day !== undefined && day !== previousDay;
    if (day !== undefined) previousDay = day;

    const model = message.model
      ? [message.model.providerId, message.model.modelId]
          .filter(Boolean)
          .join("/")
      : "";
    const duration = message.time.completed
      ? formatDuration(message.time.created, message.time.completed)
      : undefined;

    const states = [];
    if (message.status && message.status !== "completed")
      states.push(state(message.status));
    if (message.kind && message.kind !== "compaction-summary")
      states.push(state(message.kind));
    if (message.runtimeInput)
      states.push(state(message.runtimeInput.replace(/[-_]/g, " "), "neutral"));
    if (
      message.finish &&
      !ROUTINE_FINISH.has(message.finish) &&
      message.finish !== message.status
    )
      states.push(state(message.finish));

    const meta = `<div class="message-meta"><span class="role">${escapeHtml(message.role)}</span>${showDay ? `<span class="meta-day">${escapeHtml(day)}</span>` : ""}<span class="meta-time">${timeElement(message.time.created, timeFormat)}${duration ? `<span class="meta-duration" title="Completed ${escapeHtml(message.time.completed)}">${escapeHtml(duration)}</span>` : ""}</span>${model ? `<span class="meta-model">${escapeHtml(model)}</span>` : ""}${states.length ? `<span class="meta-states">${states.join("")}</span>` : ""}</div>`;

    const error = message.error
      ? `<div class="message-error" role="note"><span class="error-name">${escapeHtml(message.error.name)}</span>${message.error.message === undefined ? "" : `<span class="error-text">${escapeHtml(message.error.message)}</span>`}</div>`
      : "";
    const parts = message.parts.map(renderPart).join("");
    const summary = message.kind === "compaction-summary";
    const content = summary
      ? `<details class="compaction-summary"><summary><span class="summary-title">Compaction summary</span><span class="summary-note">Earlier context condensed here</span></summary><div class="summary-body">${parts}</div></details>`
      : parts;

    const alert =
      message.status === "error" ||
      message.status === "aborted" ||
      message.error !== undefined;
    const classes = [
      "message",
      `role-${roleClass(message.role)}`,
      summary ? "interlude" : "",
      alert ? "has-alert" : "",
      message.status === "running" ? "is-running" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `<article class="${classes}">${meta}<div class="message-body">${error}${content}</div></article>`;
  }

  // ---- Header -----------------------------------------------------------

  function renderHeader(header) {
    const session = header.session;
    const stats = header.stats;
    const tokens = stats.tokens;
    const coverage = stats.usageCoverage;
    const partial = coverage.unknown > 0;
    const stat = (label, value, note) =>
      `<div class="stat"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}${note ? `<span class="stat-note">${escapeHtml(note)}</span>` : ""}</dd></div>`;
    const tokenStats = tokens
      ? stat("Input tokens", formatCount(tokens.input)) +
        stat("Output tokens", formatCount(tokens.output)) +
        (tokens.reasoning === undefined
          ? ""
          : stat("Reasoning tokens", formatCount(tokens.reasoning))) +
        stat(
          "Total tokens",
          formatCount(tokens.total),
          partial ? "known usage only" : undefined,
        )
      : stat("Tokens", "Unknown");
    const fact = (label, value, className = "") =>
      `<dt>${escapeHtml(label)}</dt><dd${className ? ` class="${className}"` : ""}>${value}</dd>`;
    const models = stats.models.length ? stats.models.join(", ") : "Unknown";
    const title = session.title || "Untitled session";
    return `<p class="eyebrow">Session export</p><h1>${escapeHtml(title)}</h1><p class="lede">Exported ${timeElement(header.exportedAt, fullFormat)} <span aria-hidden="true">·</span> ${escapeHtml(header.app.name)} ${escapeHtml(header.app.version)}</p><dl class="stats">${stat("Messages", formatCount(stats.messageCount))}${tokenStats}${stat("Usage coverage", `${coverage.known} known · ${coverage.unknown} unknown`)}</dl><details class="session-details"><summary><span class="summary-title">Session details</span></summary><dl class="facts">${fact("Session", escapeHtml(session.id), "mono")}${fact("Status", escapeHtml(session.status))}${fact("Project", escapeHtml(session.projectRoot), "mono")}${fact("Agent", escapeHtml(session.agent))}${fact("Models", escapeHtml(models))}${fact("Created", timeElement(session.createdAt, fullFormat))}${fact("Updated", timeElement(session.updatedAt, fullFormat))}${fact("Exported", timeElement(header.exportedAt, fullFormat))}</dl></details>`;
  }

  // ---- Boot -------------------------------------------------------------

  let session;
  try {
    const bytes = Uint8Array.from(
      atob(document.getElementById("session-data").textContent.trim()),
      (character) => character.charCodeAt(0),
    );
    session = JSON.parse(new TextDecoder("utf-8").decode(bytes));
  } catch {
    document.getElementById("messages").textContent =
      "The embedded conversation could not be read. The file may be incomplete or damaged.";
    return;
  }
  // Every interpolated value above passes through escapeHtml or the hardened
  // Markdown renderer; render.unit.test.ts executes the final page against XSS input.
  document.title = `${session.header.session.title || "Untitled session"} · ohbaby`;
  setHtml(
    document.getElementById("session-header"),
    renderHeader(session.header),
  );
  setHtml(
    document.getElementById("messages"),
    session.messages.map(renderMessage).join(""),
  );

  // Printing must include text hidden by native disclosures. Restore their state
  // afterwards so printing does not change the reader's place in the conversation.
  let closedBeforePrint = [];
  window.addEventListener("beforeprint", () => {
    closedBeforePrint = [...document.querySelectorAll("details:not([open])")];
    for (const details of closedBeforePrint) details.open = true;
  });
  window.addEventListener("afterprint", () => {
    for (const details of closedBeforePrint) details.open = false;
    closedBeforePrint = [];
  });
})();
