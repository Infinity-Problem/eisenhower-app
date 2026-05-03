"""One-shot importer: pull todos from Monday + Obsidian vault into the matrix.

Run: python import_todos.py

De-duplicates by source: each task has a `source` field of the form
{"kind": "monday" | "obsidian", "id": str} so re-running this script will skip
items already imported.

Quadrant mapping:
  - Monday Eisenhower column → matches our quadrants directly.
  - Vault items default to "schedule" (queued, not urgent today).

The script touches the real tasks.json (no env override) so it should be run
with the desktop app NOT running.
"""
from __future__ import annotations

import json
import re
import sys
import uuid
from datetime import datetime
from pathlib import Path

# Reuse the app's data_dir + schema rather than reimplementing.
sys.path.insert(0, str(Path(__file__).resolve().parent))
from app import data_file, _normalize_date  # noqa: E402


VAULT_ROOT = Path(r"C:\Users\Super\Documents\Vibe Coding\Jarvis\Obsidian\Jarvis")
PROJECT_ROADMAPS = [
    "01 Projects/ESCPE Visuals/Roadmap.md",
    "01 Projects/Live Ambient/Roadmap.md",
    "01 Projects/Jarvis UI/Roadmap.md",
    "01 Projects/Song Visuals/Roadmap.md",
]

EISENHOWER_TO_QUADRANT = {
    "Do (Q1)": "do",
    "Schedule (Q2)": "schedule",
    "Delegate (Q3)": "delegate",
    "Eliminate (Q4)": "delete",
}

# Pre-fetched Monday data (filtered: status != Done). Captured from the MCP call
# during this session. Single-shot import — re-running re-fetches via a fresh
# script if needed.
MONDAY_ITEMS = [
    {"id": "11742513413", "name": "Therapy", "due": "2026-04-28", "eisen": "Schedule (Q2)", "status": "Not started"},
    {"id": "11742517350", "name": "SweatHauz — sauna + cold plunge", "due": "2026-04-28", "eisen": "Schedule (Q2)", "status": "Not started"},
    {"id": "11790422515", "name": "Harvest the Innovation Pinterest board into a vault mood board", "due": "2026-04-23", "eisen": "Schedule (Q2)", "status": "Not started"},
    {"id": "11790422565", "name": "Draft the Innovation treatment v0", "due": "2026-04-30", "eisen": "Schedule (Q2)", "status": "Not started"},
    {"id": "11790432353", "name": "Decide the Innovation pipeline (DaVinci share vs custom)", "due": "2026-05-07", "eisen": "Schedule (Q2)", "status": "Not started"},
    {"id": "11790311033", "name": "Build the Innovation shot list v0 against the song timeline", "due": "2026-05-14", "eisen": "Schedule (Q2)", "status": "Not started"},
    {"id": "11790389337", "name": "Resolve the three open Innovation questions (format, pipeline, live layer)", "due": "2026-05-21", "eisen": "Schedule (Q2)", "status": "Not started"},
    {"id": "11796440390", "name": "working on website", "due": "2026-04-20", "eisen": "Schedule (Q2)", "status": "Stuck"},
    {"id": "11834437879", "name": "make 3 more visuals", "due": "2026-04-23", "eisen": "Schedule (Q2)", "status": None},
    {"id": "11904991211", "name": "download chatdsp", "due": "2026-05-04", "eisen": None, "status": "Not started"},
    {"id": "11907877328", "name": "Contact MODA to pay premium immediately (auto-pay disabled)", "due": "2026-05-02", "eisen": "Do (Q1)", "status": "Not started"},
    {"id": "11907878282", "name": "Get a new drone", "due": "2026-05-02", "eisen": "Schedule (Q2)", "status": "Not started"},
    {"id": "11907878514", "name": "Follow up with merch company — production is slacking, need to ship", "due": "2026-05-04", "eisen": "Do (Q1)", "status": "Not started"},
    {"id": "11907768114", "name": "Work on song visuals", "due": "2026-05-02", "eisen": "Schedule (Q2)", "status": "Not started"},
]


def make_task(*, text: str, quadrant: str, due_date: str | None, source: dict, completed: bool = False) -> dict:
    now = datetime.now().isoformat(timespec="seconds")
    return {
        "id": uuid.uuid4().hex,
        "text": text,
        "quadrant": quadrant,
        "completed": completed,
        "created_at": now,
        "completed_at": None,
        "due_date": _normalize_date(due_date),
        "time_spent_seconds": 0,
        "archived": False,
        "archived_at": None,
        "gcal_event_id": None,
        "source": source,
    }


def from_monday() -> list[dict]:
    out = []
    for m in MONDAY_ITEMS:
        quad = EISENHOWER_TO_QUADRANT.get(m["eisen"] or "", "schedule")
        out.append(
            make_task(
                text=m["name"],
                quadrant=quad,
                due_date=m["due"],
                source={"kind": "monday", "id": m["id"]},
            )
        )
    return out


# Match: optional weekday prefix, M/D, em-dash, then the rest as text.
SONG_DATE_RE = re.compile(
    r"^(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun)?\s*(\d{1,2})/(\d{1,2})\s*[—–-]\s*(.+)$"
)


def parse_song_visuals_line(text: str) -> tuple[str, str | None]:
    """Pull a date out of 'Mon 4/20 — Healing — 100 — 12A' if present."""
    m = SONG_DATE_RE.match(text)
    if not m:
        return text, None
    month, day, rest = m.group(1), m.group(2), m.group(3)
    try:
        # Year inferred from current year — Song Visuals roadmap is 2026 work.
        year = 2026
        d = datetime(year, int(month), int(day))
        return rest.strip(), d.strftime("%Y-%m-%d")
    except ValueError:
        return text, None


def from_vault() -> list[dict]:
    out = []
    pattern = re.compile(r"^\s*-\s*\[\s\]\s+(.+?)\s*$")
    for rel in PROJECT_ROADMAPS:
        path = VAULT_ROOT / rel
        if not path.exists():
            continue
        project_name = Path(rel).parent.name
        with path.open("r", encoding="utf-8") as fh:
            for lineno, raw in enumerate(fh, start=1):
                m = pattern.match(raw)
                if not m:
                    continue
                text = m.group(1).strip()
                due = None
                if project_name == "Song Visuals":
                    text, due = parse_song_visuals_line(text)
                source = {
                    "kind": "obsidian",
                    "id": f"{rel}:{lineno}",
                    "project": project_name,
                }
                out.append(
                    make_task(
                        text=f"[{project_name}] {text}",
                        quadrant="schedule",
                        due_date=due,
                        source=source,
                    )
                )
    return out


def source_key(src: dict | None) -> str | None:
    if not src:
        return None
    return f"{src.get('kind')}::{src.get('id')}"


def main() -> int:
    df = data_file()
    if df.exists():
        with df.open("r", encoding="utf-8") as fh:
            data = json.load(fh)
    else:
        data = {"tasks": [], "adoption": None, "settings": {"gcal": {}}}

    existing_keys = {source_key(t.get("source")) for t in data.get("tasks", [])}
    existing_keys.discard(None)

    incoming = from_monday() + from_vault()

    new_items = []
    for t in incoming:
        k = source_key(t["source"])
        if k in existing_keys:
            continue
        new_items.append(t)
        existing_keys.add(k)

    data.setdefault("tasks", []).extend(new_items)

    df.parent.mkdir(parents=True, exist_ok=True)
    tmp = df.with_suffix(".json.tmp")
    with tmp.open("w", encoding="utf-8") as fh:
        json.dump(data, fh, indent=2)
    tmp.replace(df)

    by_q = {"do": 0, "schedule": 0, "delegate": 0, "delete": 0}
    by_kind = {"monday": 0, "obsidian": 0}
    for t in new_items:
        by_q[t["quadrant"]] = by_q.get(t["quadrant"], 0) + 1
        by_kind[t["source"]["kind"]] = by_kind.get(t["source"]["kind"], 0) + 1

    print(f"Imported {len(new_items)} new task(s).")
    print(f"  By kind:    monday={by_kind['monday']}, obsidian={by_kind['obsidian']}")
    print(f"  By quadrant: do={by_q['do']}, schedule={by_q['schedule']}, "
          f"delegate={by_q['delegate']}, delete={by_q['delete']}")
    print(f"  Tasks file: {df}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
