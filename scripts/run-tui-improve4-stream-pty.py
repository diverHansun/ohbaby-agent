"""Run production renderTerminalUi in a PTY and verify xterm-visible cells.

Run: python3 scripts/run-tui-improve4-stream-pty.py
ANSI, phase offsets, visible-screen snapshots and reports are retained.
"""
import fcntl
import json
import os
from pathlib import Path
import pty
import select
import signal
import struct
import subprocess
import tempfile
import termios
import time

ROOT = Path(__file__).resolve().parent.parent
EVIDENCE = Path(tempfile.mkdtemp(prefix="tui-improve4-stream-pty-"))


def scenario(columns, rows, theme="dark", color="1"):
    initial_columns, initial_rows = columns, rows
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    control_read, control_write = os.pipe()
    report_read, report_write = os.pipe()
    env = {**os.environ, "TERM": "xterm-256color", "FORCE_COLOR": color,
           "OHBABY_TUI_THEME": theme, "OHBABY_TUI_NO_ANIM": "1",
           "TSX_TSCONFIG_PATH": str(ROOT / "tsconfig.base.json"),
           "TUI_REVIEW_CONTROL_FD": str(control_read), "TUI_REVIEW_REPORT_FD": str(report_write)}
    process = subprocess.Popen(["node", "--import", "tsx",
        "tests/integration/cli/fixtures/tui-improve4-stream-process.ts"], cwd=ROOT, env=env,
        stdin=slave, stdout=slave, stderr=slave, pass_fds=(control_read, report_write), start_new_session=True)
    os.close(slave)
    os.close(control_read)
    os.close(report_write)
    output, report_buffer, reports, phases = bytearray(), bytearray(), [], []
    case = f"{columns}x{rows}-{theme}-{color}"

    def drain(duration=0.18):
        until = time.monotonic() + duration
        while time.monotonic() < until:
            ready, _, _ = select.select([master, report_read], [], [], max(0, until - time.monotonic()))
            for fd in ready:
                try:
                    data = os.read(fd, 65536)
                except OSError:
                    data = b""
                if not data:
                    continue
                if fd == master:
                    output.extend(data)
                else:
                    report_buffer.extend(data)
                    while b"\n" in report_buffer:
                        line, _, rest = report_buffer.partition(b"\n")
                        report_buffer[:] = rest
                        reports.append(json.loads(line))

    def phase(name, **extra):
        phases.append({"name": name, "offset": len(output), "columns": columns, "rows": rows, **extra})

    def command(action, count=None):
        payload = {"action": action}
        if count is not None:
            payload["count"] = count
        os.write(control_write, (json.dumps(payload) + "\n").encode())
        drain()

    def key(value):
        os.write(master, value.encode())
        drain()

    try:
        deadline = time.monotonic() + 15
        while not any(item.get("ready") for item in reports) and time.monotonic() < deadline:
            drain()
        assert any(item.get("ready") for item in reports), "TUI did not become ready"
        phase("ready")
        draft = "保留草稿 👨‍👩‍👧‍👦 é"
        key(draft)
        phase("draft", draft=draft)
        for count in (30, 60):
            command("stream", count)
            phase(f"stream-{count}", newest=f"STREAM-{count - 1:03}")
        # Check old live rows before completion, not bytes later overwritten.
        key("\x1b[1;2H")
        phase("history-start")
        for index in range(8):
            key("\x06")
            phase(f"history-page-{index}")
        key("\x1b[1;2F")
        phase("latest-before-wheel", newest="STREAM-059")
        key("\x1b[<64;3;2M")
        phase("wheel-pinned")
        for count in (65, 70):
            command("stream", count)
            phase(f"wheel-stream-{count}")
        key("\x1b[1;2F")
        phase("latest-after-wheel", newest="STREAM-069")
        command("tasks")
        phase("tasks-collapsed", newest="STREAM-069")
        key("\x14")
        phase("tasks-expanded", newest="STREAM-069")
        command("stream", 75)
        phase("tasks-stream", newest="STREAM-074")
        key("\x14")
        phase("tasks-restored", newest="STREAM-074")
        phase("resize-start", resizeTo={"columns": max(40, columns - 10), "rows": rows + 4})
        columns, rows = max(40, columns - 10), rows + 4
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.killpg(process.pid, signal.SIGWINCH)
        drain(0.3)
        phase("resized", newest="STREAM-074")
        phase("resize-restore-start", resizeTo={"columns": initial_columns, "rows": initial_rows})
        columns, rows = initial_columns, initial_rows
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
        os.killpg(process.pid, signal.SIGWINCH)
        drain(0.3)
        phase("resize-restored", newest="STREAM-074")
        command("approval")
        phase("approval")
        key("\x1b[B")
        phase("approval-deny-selected")
        key("\r")
        phase("approval-resolved")
        command("complete")
        phase("complete")
        command("refresh")
        phase("refresh")
        key("\r")
        command("inspect")
        inspected = reports[-1]
        assert inspected["submitted"] == [draft], "streaming changed the saved draft"
        assert inspected["responses"] == [{"requestId": "stream-approval", "choiceId": "deny"}], "approval choice could not be selected"
        phase("draft-submitted")
        command("start-prose")
        phase("prose-start", newest="PROSE-LAST")
        key("\x1b[1;2H")
        phase("prose-history-start")
        for index in range(35):
            key("\x06")
            phase(f"prose-history-page-{index}")
        key("\x1b[1;2F")
        phase("prose-latest")
        key("\x1b[<64;3;2M")
        phase("prose-wheel-pinned")
        for count in (5, 10):
            command("prose", count)
            phase(f"prose-wheel-stream-{count}")
        key("\x1b[1;2F")
        phase("prose-follow-restored", newest="PROSE-10")
        command("complete")
        phase("prose-complete", newest="PROSE-10")
        for kind in ("table", "list"):
            command(f"start-{kind}")
            phase(f"{kind}-start")
            for count in range(6, 11):
                command(kind, count)
                phase(f"{kind}-token-{count}")
            command("complete")
            phase(f"{kind}-complete")
        command("quit")
        os.close(control_write)
        control_write = -1
        deadline = time.monotonic() + 8
        while process.poll() is None and time.monotonic() < deadline:
            drain()
        drain(0.2)
        assert process.poll() == 0, f"TUI exit: {process.poll()}"
        assert any(item.get("exited") and not item.get("raw") for item in reports), "raw mode not restored"
        phase("exited")
        return {"columns": columns, "rows": rows, "theme": theme, "color": color, "exit": process.returncode, "bytes": len(output), "case": case}
    finally:
        (EVIDENCE / f"{case}.ansi").write_bytes(output)
        (EVIDENCE / f"{case}.phases.json").write_text(json.dumps({"case": case, "initialColumns": initial_columns, "initialRows": initial_rows, "phases": phases, "reports": reports}, ensure_ascii=False, indent=2))
        if process.poll() is None:
            os.killpg(process.pid, signal.SIGTERM)
            try:
                process.wait(timeout=3)
            except subprocess.TimeoutExpired:
                os.killpg(process.pid, signal.SIGKILL)
                process.wait(timeout=3)
        for fd in (master, control_write, report_read):
            if fd >= 0:
                os.close(fd)


print(f"Evidence: {EVIDENCE}", flush=True)
results = []
for dimensions in [(80, 24), (60, 20), (80, 12)]:
    result = scenario(*dimensions, theme="light" if dimensions[1] == 12 else "dark", color="0" if dimensions[1] == 12 else "1")
    print(json.dumps(result, ensure_ascii=False), flush=True)
    results.append(result)
(EVIDENCE / "process-summary.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
subprocess.run(["node", "scripts/validate-tui-improve4-pty.mjs", str(EVIDENCE)], cwd=ROOT, check=True)
