"""Exercise the real Ink process through a local PTY; no model or real approval.

Run: python3 scripts/run-tui-improve4-stream-pty.py
Raw output is stored in the printed temporary evidence directory.
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
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    control_read, control_write = os.pipe()
    report_read, report_write = os.pipe()
    env = {**os.environ, "TERM": "xterm-256color", "FORCE_COLOR": color, "OHBABY_TUI_THEME": theme, "OHBABY_TUI_NO_ANIM": "1",
           "TSX_TSCONFIG_PATH": str(ROOT / "tsconfig.base.json"), "TUI_REVIEW_CONTROL_FD": str(control_read), "TUI_REVIEW_REPORT_FD": str(report_write)}
    process = subprocess.Popen(["node", "--import", "tsx",
        "tests/integration/cli/fixtures/tui-improve4-stream-process.ts"], cwd=ROOT, env=env,
        stdin=slave, stdout=slave, stderr=slave, pass_fds=(control_read, report_write), start_new_session=True)
    os.close(slave)
    os.close(control_read)
    os.close(report_write)
    output, report_buffer, reports = bytearray(), bytearray(), []

    def drain(duration=0.16):
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

    def command(action):
        os.write(control_write, (json.dumps({"action": action}) + "\n").encode())
        drain()

    def key(value):
        os.write(master, value.encode())
        drain()

    try:
        deadline = time.monotonic() + 15
        while not any(item.get("ready") for item in reports) and time.monotonic() < deadline:
            drain()
        assert any(item.get("ready") for item in reports), "TUI did not become ready"
        draft = "保留草稿 👨‍👩‍👧‍👦 é"
        key(draft)
        baseline = len(output)
        for count in (30, 60, 90, 120):
            os.write(control_write, (json.dumps({"action": "stream", "count": count}) + "\n").encode())
            drain(0.22)
            assert b"STREAM-000" in output[baseline:], "live prefix did not reach scrollback"
            assert f"STREAM-{count - 1:03}".encode() in output[baseline:], "live tail is missing"
        command("approval")
        assert b"STREAM-APPROVAL" in output
        key("\x1b")
        command("complete")
        settled = len(output)
        command("refresh")
        command("refresh")
        assert b"STREAM-" not in output[settled:], "equivalent snapshot reprinted live text"
        stream_output = output[baseline:]
        assert stream_output.count(b"STREAM-000") == 1, "first streamed row was duplicated"
        assert b"\x1b[3J" not in stream_output, "ordinary streaming cleared scrollback"
        assert b"\x1b[2J" not in stream_output, "ordinary streaming cleared the screen"
        key("\r")
        command("inspect")
        assert reports[-1]["submitted"] == [draft], "streaming changed the draft"
        assert reports[-1]["responses"] == [{"requestId": "stream-approval", "choiceId": "deny"}]
        for kind in ("table", "list"):
            command(f"start-{kind}")
            assert f"{kind.upper()}00".encode() in output
            before_reflow = len(output)
            for count in range(6, 11):
                os.write(control_write, (json.dumps({"action": kind, "count": count}) + "\n").encode())
                drain()
            assert b"\x1b[3J" not in output[before_reflow:], f"{kind} reflow cleared every token"
            assert b"\x1b[2J" not in output[before_reflow:]
            before_complete = len(output)
            command("complete")
            completion = output[before_complete:]
            assert completion.count(b"\x1b[3J") == 1, f"{kind} must reconcile once on completion"
            assert f"{kind.upper()}00".encode() in completion and f"{kind.upper()}19".encode() in completion
            assert b"xxxxxxxxxx" in completion
        command("quit")
        os.close(control_write)
        control_write = -1
        deadline = time.monotonic() + 8
        while process.poll() is None and time.monotonic() < deadline:
            drain()
        assert process.poll() == 0, f"TUI exit: {process.poll()}"
        assert any(item.get("exited") and not item.get("raw") for item in reports), "raw mode not restored"
        assert b"\x1b[?25h" in output, "cursor not restored"
        assert b"INTERNAL_OBSERVATION_DO_NOT_DISPLAY" not in output
        assert b"Option:" not in output, "approval duplicates its actionable choices"
        result = {"columns": columns, "rows": rows, "theme": theme, "color": color, "exit": process.returncode, "bytes": len(output),
                  "scrollbackClears": output.count(b"\x1b[3J"), "reports": [{**item, "submitted": [f"{len(text)} chars" for text in item["submitted"]]} if "submitted" in item else item for item in reports], "passed": True}
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return result
    finally:
        (EVIDENCE / f"{columns}x{rows}-{theme}-{color}.ansi").write_bytes(output)
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
results = [scenario(columns, rows) for columns, rows in [(120, 40), (80, 24), (60, 20)]]
results += [scenario(80, 12, "light", "0")]
(EVIDENCE / "summary.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
