"""Exercise the real Ink process through a local PTY; no model or real approval.

Run: python3 scripts/run-tui-improve3-pty.py
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
EVIDENCE = Path(tempfile.mkdtemp(prefix="tui-improve3-pty-"))


def scenario(columns, rows, theme="dark", color="1"):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    control_read, control_write = os.pipe()
    report_read, report_write = os.pipe()
    env = {**os.environ, "TERM": "xterm-256color", "FORCE_COLOR": color, "OHBABY_TUI_THEME": theme, "OHBABY_TUI_NO_ANIM": "1",
           "TSX_TSCONFIG_PATH": str(ROOT / "tsconfig.base.json"), "TUI_REVIEW_CONTROL_FD": str(control_read), "TUI_REVIEW_REPORT_FD": str(report_write)}
    process = subprocess.Popen(["node", "--import", "tsx",
        "tests/integration/cli/fixtures/tui-improve3-process.ts"], cwd=ROOT, env=env,
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
        assert b"SHELL-0-300" in output, "compact shell tail missing"
        assert b"SHELL-0-001" not in output, "compact shell output was not bounded"
        assert b"READ-BODY-ONLY-EXPANDED" not in output, "read body is not compact"
        assert b"EXIT-FAILURE-REASON" in output, "failure reason missing"
        assert b"MARKDOWN-END" in output
        draft = "保留草稿 👨‍👩‍👧‍👦 é"
        key(draft)
        before = len(output)
        clears = output.count(b"\x1b[3J")
        toggle_started = time.monotonic()
        key("\x0f")
        deadline = time.monotonic() + 10
        while b"SHELL-0-001" not in output[before:] and time.monotonic() < deadline:
            drain()
        expansion_ms = round((time.monotonic() - toggle_started) * 1000)
        expanded = bytes(output[before:])
        assert output.count(b"\x1b[3J") == clears + 1, "toggle must rebuild exactly once"
        assert b"SHELL-0-001" in expanded and b"READ-BODY-ONLY-EXPANDED" in expanded
        assert expanded.index(b"SHELL-0-001") < expanded.index(b"READ-BODY-ONLY-EXPANDED") < expanded.index(b"MARKDOWN-END")
        assert b"NEW-LINE-30" in expanded
        assert b"@@ -8,3 +8,3 @@" in expanded
        before = len(output)
        command("refresh")
        command("refresh")
        drain(0.5)
        assert b"SHELL-0-001" not in output[before:], "unchanged history reprinted"
        assert output.count(b"\x1b[3J") == clears + 1
        command("late")
        assert b"LATE-FIRST" in output, "new result ignored expanded mode"
        command("approval")
        before = len(output)
        key("\x0f")
        assert b"\x1b[3J" not in output[before:], "approval did not own input"
        key("\x1b")
        command("inspect")
        assert reports[-1]["responses"] == [{"requestId":"review-approval","choiceId":"deny"}]
        before = len(output)
        key("\x0f")
        deadline = time.monotonic() + 10
        while b"SHELL-0-300" not in output[before:] and time.monotonic() < deadline:
            drain()
        compact = bytes(output[before:])
        assert compact.count(b"\x1b[3J") == 1
        assert b"SHELL-0-001" not in compact and b"SHELL-0-300" in compact
        command("correction")
        assert b"CORRECTED-END" in output, "late correction frozen"
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 60, 0, 0))
        os.killpg(process.pid, signal.SIGWINCH)
        drain()
        key("\r")
        command("inspect")
        assert reports[-1]["submitted"] == [draft], "draft changed across modes and approval"
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
        result = {"columns": columns, "rows": rows, "theme": theme, "color": color, "expansionMs": expansion_ms, "exit": process.returncode, "bytes": len(output),
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
results += [scenario(80, 24, "light", "1"), scenario(60, 20, "dark", "0")]
(EVIDENCE / "summary.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
