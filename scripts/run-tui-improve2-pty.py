"""Exercise the real Ink process through a local PTY; no model or real approval.

Run: python3 scripts/run-tui-improve2-pty.py
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
EVIDENCE = Path(tempfile.mkdtemp(prefix="tui-improve2-pty-"))


def scenario(columns, rows):
    master, slave = pty.openpty()
    fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", rows, columns, 0, 0))
    control_read, control_write = os.pipe()
    report_read, report_write = os.pipe()
    env = {**os.environ, "TERM": "xterm-256color", "FORCE_COLOR": "1", "OHBABY_TUI_NO_ANIM": "1",
           "TSX_TSCONFIG_PATH": str(ROOT / "tsconfig.base.json"), "TUI_REVIEW_CONTROL_FD": str(control_read), "TUI_REVIEW_REPORT_FD": str(report_write)}
    process = subprocess.Popen(["node", "--import", "tsx",
        "tests/integration/cli/fixtures/tui-improve2-process.ts"], cwd=ROOT, env=env,
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
        # Existing Tasks navigation must reach every item without changing Ctrl+T.
        for _ in range(20):
            key("\x1b\x1b[6~")
        assert b"END-TASK-20" in output, "last task is unreachable"
        draft = "\n".join(f"draft {i} 中文 👨‍👩‍👧‍👦 é" for i in range(200))
        key("\x1b[200~" + draft + "\x1b[201~")
        command("no-deny")
        key("\x1b")
        command("inspect")
        assert reports[-1]["responses"] == [], "Esc approved a no-deny request"
        key("\r")
        command("approval")
        for _ in range(50):
            key("\x1b[6~")
        assert b"END-APPROVAL-45" in output, "last approval line is unreachable"
        key("\x1b")
        command("inspect")
        assert reports[-1]["responses"] == [{"requestId": "no-deny", "choiceId": "allow"}, {"requestId": "long", "choiceId": "deny"}]
        assert b"draft 199" in output, "draft was lost across approval"
        assert output.count(b"\x1b[3J") == 0, "ordinary interaction cleared scrollback"
        # Resize through the actual OS PTY; then exercise stopped Tasks readback.
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack("HHHH", 20, 60, 0, 0))
        os.killpg(process.pid, signal.SIGWINCH)
        drain()
        command("stop")
        key("\x14")
        assert b"Stopped" in output, "stopped Tasks cannot be reviewed"
        key("\r")
        command("inspect")
        assert reports[-1]["submitted"] == [draft], "full draft changed through paste, approvals or resize"
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
        result = {"columns": columns, "rows": rows, "exit": process.returncode, "bytes": len(output),
                  "scrollbackClears": output.count(b"\x1b[3J"), "reports": [{**item, "submitted": [f"{len(text)} chars" for text in item["submitted"]]} if "submitted" in item else item for item in reports], "passed": True}
        print(json.dumps(result, ensure_ascii=False), flush=True)
        return result
    finally:
        (EVIDENCE / f"{columns}x{rows}.ansi").write_bytes(output)
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
results = [scenario(columns, rows) for columns, rows in [(120, 40), (80, 24), (60, 20), (80, 12)]]
(EVIDENCE / "summary.json").write_text(json.dumps(results, ensure_ascii=False, indent=2))
