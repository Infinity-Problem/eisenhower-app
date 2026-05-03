# Eisenhower

A standalone Windows desktop app where the Eisenhower priority matrix *is* the entire UI. Local-first storage, time tracking per task, optional one-way sync to Google Calendar.

```
+-----------------------+-----------------------+
|        DO             |      SCHEDULE         |
|  Urgent + Important   |  Important, Not Urg.  |
+-----------------------+-----------------------+
|     DELEGATE          |       DELETE          |
|  Urgent, Not Imp.     |  Not Urg., Not Imp.   |
+-----------------------+-----------------------+
```

## Install

**Windows** — Download `Eisenhower-windows.exe` (or `Eisenhower.exe`) from the [latest release](../../releases) and double-click. No installer, no dependencies, no admin rights. Tasks live in `%APPDATA%\Eisenhower\tasks.json`.

**macOS** — Download `Eisenhower-macos.zip`, unzip, drag `Eisenhower.app` into Applications. The build is unsigned, so first launch needs a right-click → Open to bypass Gatekeeper. Tasks live in `~/Library/Application Support/Eisenhower/tasks.json`.

## Features

- Add tasks straight into a quadrant (per-quadrant input bars) or via the global input column with a date picker
- Drag tasks between quadrants
- **Adopt** a task to start a live timer; accumulated time persists per task across sessions
- Filter the matrix by Today / Tomorrow / This Week / This Month / Past Due / Done
- Battery shows completion progress for the active filter
- Two donut charts: open tasks per quadrant, time tracked per quadrant
- Optional Google Calendar sync — tasks with due dates push as all-day events titled `[QUADRANT] task text`
- Window snaps to screen edges Aero-style (drag titlebar to edge)
- Frameless, dark, keyboard-friendly

## Build from source

Requires Python 3.11+.

```bash
git clone https://github.com/Infinity-Problem/eisenhower-app
cd eisenhower-app
pip install -r requirements.txt
python launch.pyw          # run from source
build.bat                  # produce dist/Eisenhower.exe
```

## Google Calendar sync setup

The Calendar API is free, but Google requires you to create your own OAuth client (no shared client ID can be safely distributed). One-time setup:

1. Open [Google Cloud Console → Credentials](https://console.cloud.google.com/apis/credentials)
2. Create a new project, enable the Google Calendar API
3. Create an OAuth 2.0 Client ID, type **Desktop app**
4. Open the app → gear icon → Configure → paste your client ID + secret → Save → Connect

See [VERIFICATION.md](VERIFICATION.md) if you want to ship a verified build to other users.

## License

MIT — see [LICENSE](LICENSE).
