#!/usr/bin/env python3
"""Count how often the model explores files with bash instead of native tools.

Usage:
  python3 -I tool-choice-stats.py [--db PATH] [--since YYYY-MM-DD] [--until YYYY-MM-DD]
                                  [--session ID ...] [--samples N] [--group model|agent]

"bash-explore" means a bash call whose commands are only cat/head/tail/sed -n/
ls/find/grep/rg/wc/tree/nl, with no build, test, network or write command.
"bash-packed" is a bash-explore call that chains two or more of those
commands, for example `ls x; echo ---; cat y`.
Redirections to /dev/null and 2>&1 are not counted as writes.
"native" means read/list/glob/grep calls. "--group agent" splits by agent role
and main session vs subagent. The regex is a heuristic; check
samples by hand before drawing conclusions.
"""

import argparse
import collections
import datetime
import json
import os
import re
import sqlite3

DEFAULT_DB = os.path.expanduser("~/Library/Application Support/ohbaby/ohbaby.db")
NATIVE = {"read", "list", "glob", "grep"}
EXPLORE = re.compile(
    r"(^|[;&|(\n]\s*|\bdo\s+)(cat|head|tail|sed\s+-n|ls|find|grep|rg|wc|tree|nl)\b"
)
OTHER = re.compile(
    r"(npm|pnpm|yarn|git |curl|python3? |pytest|docker|mkdir|rm |mv |cp |node |npx|pip|>|tee )"
)
HARMLESS_REDIRECT = re.compile(r"\d?>\s*/dev/null|\d>&\d")


def to_ms(day: str) -> int:
    return int(datetime.datetime.strptime(day, "%Y-%m-%d").timestamp() * 1000)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", default=DEFAULT_DB)
    parser.add_argument("--since")
    parser.add_argument("--until")
    parser.add_argument("--session", action="append", default=[])
    parser.add_argument("--samples", type=int, default=3)
    parser.add_argument("--group", choices=["model", "agent"], default="model")
    args = parser.parse_args()

    sql = (
        "select p.created_at, json_extract(p.data,'$.tool'), "
        "json_extract(p.data,'$.state.input.command'), "
        "json_extract(m.data,'$.modelId'), p.session_id, s.agent, s.parent_id "
        "from part p join message m on m.id = p.message_id "
        "join session s on s.id = p.session_id where p.type = 'tool'"
    )
    rows = sqlite3.connect(f"file:{args.db}?mode=ro", uri=True).execute(sql)

    counts = collections.defaultdict(collections.Counter)
    samples = collections.defaultdict(list)
    for created, tool, command, model, session, agent, parent in rows:
        if args.since and created < to_ms(args.since):
            continue
        if args.until and created >= to_ms(args.until):
            continue
        if args.session and session not in args.session:
            continue
        if args.group == "agent":
            model = f"{agent or '?'}|{'subagent' if parent else 'main'}"
        else:
            model = model or "?"
        if tool in NATIVE:
            counts[model]["native"] += 1
        elif tool == "bash" and command:
            if EXPLORE.search(command) and not OTHER.search(
                HARMLESS_REDIRECT.sub("", command)
            ):
                counts[model]["bash_explore"] += 1
                if len(EXPLORE.findall(command)) >= 2:
                    counts[model]["bash_packed"] += 1
                if len(samples[model]) < args.samples:
                    samples[model].append(command[:120].replace("\n", " "))
            else:
                counts[model]["bash_other"] += 1

    for model, c in sorted(counts.items(), key=lambda item: -sum(item[1].values())):
        explore_total = c["native"] + c["bash_explore"]
        ratio = c["bash_explore"] / explore_total if explore_total else 0
        print(json.dumps({"model": model, **c, "bash_explore_ratio": round(ratio, 2)}))
        for sample in samples[model]:
            print("   ", sample)


if __name__ == "__main__":
    main()
