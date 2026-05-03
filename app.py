"""Eisenhower matrix todo app.

Frameless pywebview window. Local JSON storage. Single-instance via Windows mutex.
"""
from __future__ import annotations

import ctypes
import json
import os
import sys
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

# DPI awareness must happen before pywebview imports any Win32 surfaces.
if sys.platform == "win32":
    try:
        ctypes.windll.shcore.SetProcessDpiAwareness(2)
    except Exception:
        try:
            ctypes.windll.user32.SetProcessDPIAware()
        except Exception:
            pass

import webview  # noqa: E402


APP_NAME = "Eisenhower"
MUTEX_NAME = "Global\\EisenhowerMatrixV1"
WINDOW_TITLE = "Eisenhower"
WINDOW_SIZE = (1100, 800)
BG_COLOR = "#0a0e14"

QUADRANTS = {"do", "schedule", "delegate", "delete"}

GCAL_SCOPES = ["https://www.googleapis.com/auth/calendar"]

# OAuth credentials baked into the app so the user never has to paste them.
# For Desktop OAuth clients, the "secret" isn't truly confidential per Google's
# own docs — it's distributed with the client. Set both to non-None to enable
# one-click connect (the credentials section in the settings panel hides
# automatically when these are present).
BUNDLED_GCAL_CLIENT_ID: str | None = None
BUNDLED_GCAL_CLIENT_SECRET: str | None = None
DEFAULT_SETTINGS = {
    "gcal": {
        "client_id": None,
        "client_secret": None,
        "calendar_id": None,
        "calendar_summary": None,
        "connected_email": None,
        "last_sync_at": None,
    }
}


def _normalize_date(value: Any) -> str | None:
    """Accept None, '', or 'YYYY-MM-DD'. Return canonical 'YYYY-MM-DD' or None."""
    if not value:
        return None
    if not isinstance(value, str):
        return None
    s = value.strip()
    if not s:
        return None
    try:
        # Validate; raises ValueError if not parseable.
        datetime.strptime(s, "%Y-%m-%d")
    except ValueError:
        return None
    return s


def web_root() -> Path:
    """Locate the bundled web assets, whether running from source or PyInstaller onefile."""
    if getattr(sys, "frozen", False):
        base = Path(getattr(sys, "_MEIPASS", Path(sys.executable).parent))
    else:
        base = Path(__file__).resolve().parent
    return base / "web"


def data_dir() -> Path:
    """Cross-platform per-user data directory."""
    if sys.platform == "win32":
        base = os.environ.get("APPDATA") or str(Path.home() / "AppData" / "Roaming")
        d = Path(base) / APP_NAME
    elif sys.platform == "darwin":
        d = Path.home() / "Library" / "Application Support" / APP_NAME
    else:
        base = os.environ.get("XDG_CONFIG_HOME") or str(Path.home() / ".config")
        d = Path(base) / APP_NAME
    d.mkdir(parents=True, exist_ok=True)
    return d


def data_file() -> Path:
    return data_dir() / "tasks.json"


def acquire_single_instance() -> bool:
    """Return True if we are the only instance running."""
    if sys.platform == "win32":
        kernel32 = ctypes.windll.kernel32
        handle = kernel32.CreateMutexW(None, False, MUTEX_NAME)
        last_error = kernel32.GetLastError()
        ERROR_ALREADY_EXISTS = 183
        if last_error == ERROR_ALREADY_EXISTS:
            if handle:
                kernel32.CloseHandle(handle)
            return False
        # Intentionally leak the handle for the lifetime of the process.
        return True

    # POSIX (macOS / Linux): fcntl exclusive lock on a file in the data dir.
    # The fp is intentionally leaked for the process lifetime.
    try:
        import fcntl  # noqa: PLC0415
        lock_path = data_dir() / ".singleton.lock"
        fp = open(lock_path, "w")  # noqa: SIM115
        try:
            fcntl.flock(fp.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            fp.close()
            return False
        return True
    except Exception:
        # If we can't even attempt the lock, assume single-instance and proceed.
        return True


class Api:
    """Methods callable from JS via window.pywebview.api.<method>(...)."""

    def __init__(self) -> None:
        self._state = self._load()

    # ----- persistence -----

    def _load(self) -> dict[str, Any]:
        f = data_file()
        if not f.exists():
            return self._fresh_state()
        try:
            with f.open("r", encoding="utf-8") as fh:
                data = json.load(fh)
            if not isinstance(data, dict) or "tasks" not in data:
                return self._fresh_state()
            data.setdefault("adoption", None)
            data.setdefault("settings", {})
            data["settings"].setdefault("gcal", dict(DEFAULT_SETTINGS["gcal"]))
            for k, v in DEFAULT_SETTINGS["gcal"].items():
                data["settings"]["gcal"].setdefault(k, v)
            for t in data["tasks"]:
                t.setdefault("time_spent_seconds", 0)
                t.setdefault("due_date", None)
                t.setdefault("archived", False)
                t.setdefault("archived_at", None)
                t.setdefault("gcal_event_id", None)
                t.setdefault("source", None)
            return data
        except (json.JSONDecodeError, OSError):
            return self._fresh_state()

    def _fresh_state(self) -> dict[str, Any]:
        return {
            "tasks": [],
            "adoption": None,
            "settings": {"gcal": dict(DEFAULT_SETTINGS["gcal"])},
        }

    def _save(self) -> None:
        tmp = data_file().with_suffix(".json.tmp")
        with tmp.open("w", encoding="utf-8") as fh:
            json.dump(self._state, fh, indent=2)
        tmp.replace(data_file())

    # ----- task API -----

    def get_tasks(self) -> list[dict[str, Any]]:
        return list(self._state["tasks"])

    def add_task(self, text: str, quadrant: str, due_date: str | None = None) -> dict[str, Any]:
        text = (text or "").strip()
        if not text:
            raise ValueError("text required")
        if quadrant not in QUADRANTS:
            raise ValueError(f"bad quadrant: {quadrant}")
        task = {
            "id": uuid.uuid4().hex,
            "text": text,
            "quadrant": quadrant,
            "completed": False,
            "created_at": datetime.now().isoformat(timespec="seconds"),
            "completed_at": None,
            "due_date": _normalize_date(due_date),
            "time_spent_seconds": 0,
            "archived": False,
            "archived_at": None,
            "gcal_event_id": None,
            "source": None,
        }
        self._state["tasks"].append(task)
        self._save()
        return task

    def update_task(self, task_id: str, patch: dict[str, Any]) -> dict[str, Any]:
        task = self._find(task_id)
        if "text" in patch:
            text = (patch["text"] or "").strip()
            if text:
                task["text"] = text
        if "quadrant" in patch:
            q = patch["quadrant"]
            if q in QUADRANTS:
                task["quadrant"] = q
        if "completed" in patch:
            done = bool(patch["completed"])
            task["completed"] = done
            task["completed_at"] = (
                datetime.now().isoformat(timespec="seconds") if done else None
            )
            if done and self._is_adopted(task["id"]):
                self._release_internal()
        if "due_date" in patch:
            task["due_date"] = _normalize_date(patch["due_date"])
        self._save()
        return task

    def delete_task(self, task_id: str) -> bool:
        if self._is_adopted(task_id):
            # Drop adoption first so we don't leave a dangling pointer.
            self._state["adoption"] = None
        before = len(self._state["tasks"])
        self._state["tasks"] = [t for t in self._state["tasks"] if t["id"] != task_id]
        changed = len(self._state["tasks"]) != before
        if changed:
            self._save()
        return changed

    def archive_completed(self) -> int:
        """Move all completed-but-not-archived tasks into the archive."""
        a = self._state.get("adoption")
        if a:
            try:
                t = self._find(a["task_id"])
                if t["completed"]:
                    self._state["adoption"] = None
            except KeyError:
                self._state["adoption"] = None
        moved = 0
        now = datetime.now().isoformat(timespec="seconds")
        for t in self._state["tasks"]:
            if t.get("completed") and not t.get("archived"):
                t["archived"] = True
                t["archived_at"] = now
                moved += 1
        if moved:
            self._save()
        return moved

    def unarchive_task(self, task_id: str) -> dict[str, Any]:
        """Pull a task back out of the archive."""
        task = self._find(task_id)
        task["archived"] = False
        task["archived_at"] = None
        self._save()
        return task

    # ----- adoption / time tracking -----

    def adopt_task(self, task_id: str) -> dict[str, Any] | None:
        # Validate before mutating.
        self._find(task_id)
        self._release_internal()
        self._state["adoption"] = {
            "task_id": task_id,
            "started_at": datetime.now().isoformat(timespec="seconds"),
        }
        self._save()
        return self._adoption_payload()

    def release_task(self) -> None:
        if not self._state.get("adoption"):
            return
        self._release_internal()
        self._save()

    def get_adoption_state(self) -> dict[str, Any] | None:
        return self._adoption_payload()

    def _is_adopted(self, task_id: str) -> bool:
        a = self._state.get("adoption")
        return bool(a and a.get("task_id") == task_id)

    def _release_internal(self) -> None:
        a = self._state.get("adoption")
        if not a:
            return
        try:
            task = self._find(a["task_id"])
            started = datetime.fromisoformat(a["started_at"])
            elapsed = max(0, int((datetime.now() - started).total_seconds()))
            task["time_spent_seconds"] = task.get("time_spent_seconds", 0) + elapsed
        except (KeyError, ValueError):
            pass
        self._state["adoption"] = None

    def _adoption_payload(self) -> dict[str, Any] | None:
        a = self._state.get("adoption")
        if not a:
            return None
        try:
            task = self._find(a["task_id"])
        except KeyError:
            self._state["adoption"] = None
            self._save()
            return None
        try:
            started_ms = int(datetime.fromisoformat(a["started_at"]).timestamp() * 1000)
        except ValueError:
            started_ms = int(datetime.now().timestamp() * 1000)
        return {
            "task_id": task["id"],
            "task_text": task["text"],
            "started_at_ms": started_ms,
            "base_seconds": int(task.get("time_spent_seconds", 0)),
            "now_ms": int(datetime.now().timestamp() * 1000),
        }

    # ----- window controls -----

    def minimize(self) -> None:
        for w in webview.windows:
            try:
                w.minimize()
            except Exception:
                pass

    def close(self) -> None:
        for w in webview.windows:
            try:
                w.destroy()
            except Exception:
                pass

    def toggle_fullscreen(self) -> None:
        for w in webview.windows:
            try:
                w.toggle_fullscreen()
            except Exception:
                pass

    def start_window_drag(self) -> None:
        """Hand the drag off to Windows so Aero Snap (drag to edge) works.

        WM_NCLBUTTONDOWN doesn't work for us because by the time the JS bridge
        call lands, the mouse capture is owned by the WebView2 content process,
        not us. WM_SYSCOMMAND with SC_MOVE | HTCAPTION asks Windows to start
        its own modal move loop directly — no capture handoff required, and
        Aero Snap works because it's the same loop the OS uses for native
        title-bar drags.
        """
        if sys.platform != "win32":
            return
        try:
            user32 = ctypes.windll.user32
            hwnd = self._hwnd()
            if not hwnd:
                return
            WM_SYSCOMMAND = 0x0112
            SC_MOVE = 0xF010
            HTCAPTION = 0x0002
            # SendMessage blocks until the modal move loop ends (user releases
            # the mouse). That's fine — bridge runs on a worker thread.
            user32.SendMessageW(hwnd, WM_SYSCOMMAND, SC_MOVE | HTCAPTION, 0)
        except Exception:
            pass

    def _hwnd(self) -> int:
        """Find the top-level window owned by this process with our title.

        pywebview's `window.native` isn't reliable across backends, so we
        enumerate top-level windows for the current PID and match by title.
        Cached after first successful lookup.
        """
        if not webview.windows:
            return 0
        cached = getattr(self, "_cached_hwnd", 0)
        if cached and ctypes.windll.user32.IsWindow(cached):
            return cached

        user32 = ctypes.windll.user32
        kernel32 = ctypes.windll.kernel32
        pid = kernel32.GetCurrentProcessId()
        found = [0]

        EnumWindowsProc = ctypes.WINFUNCTYPE(
            ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p
        )

        def _enum(hwnd, _lparam):
            owner_pid = ctypes.c_ulong()
            user32.GetWindowThreadProcessId(hwnd, ctypes.byref(owner_pid))
            if owner_pid.value != pid:
                return True
            if not user32.IsWindowVisible(hwnd):
                return True
            length = user32.GetWindowTextLengthW(hwnd)
            if length <= 0:
                return True
            buf = ctypes.create_unicode_buffer(length + 1)
            user32.GetWindowTextW(hwnd, buf, length + 1)
            if buf.value == WINDOW_TITLE:
                found[0] = hwnd
                return False
            return True

        try:
            user32.EnumWindows(EnumWindowsProc(_enum), 0)
        except Exception:
            return 0

        if found[0]:
            self._cached_hwnd = found[0]
        return found[0]

    def get_window_geometry(self) -> dict[str, int] | None:
        if not webview.windows:
            return None
        w = webview.windows[0]
        try:
            return {"x": int(w.x), "y": int(w.y), "width": int(w.width), "height": int(w.height)}
        except Exception:
            return None

    def resize_window(self, width: float, height: float) -> None:
        if not webview.windows:
            return
        w = webview.windows[0]
        try:
            w.resize(max(700, int(width)), max(500, int(height)))
        except Exception:
            pass

    def move_window(self, x: float, y: float) -> None:
        if not webview.windows:
            return
        w = webview.windows[0]
        try:
            w.move(int(x), int(y))
        except Exception:
            pass

    def set_window_geometry(self, x: float, y: float, width: float, height: float) -> None:
        if not webview.windows:
            return
        w = webview.windows[0]
        new_w = max(700, int(width))
        new_h = max(500, int(height))
        try:
            w.resize(new_w, new_h)
            w.move(int(x), int(y))
        except Exception:
            pass

    def maximize_window(self) -> None:
        if not webview.windows:
            return
        try:
            webview.windows[0].maximize()
        except Exception:
            pass

    def restore_window(self) -> None:
        if not webview.windows:
            return
        try:
            webview.windows[0].restore()
        except Exception:
            pass

    # ----- Google Calendar sync -----

    def _gcal_token_file(self) -> Path:
        return data_dir() / "gcal_token.json"

    def _import_gcal(self):
        """Lazy import the google libraries. Returns (mod_dict, error_str)."""
        try:
            from google_auth_oauthlib.flow import InstalledAppFlow
            from googleapiclient.discovery import build
            from google.oauth2.credentials import Credentials
            from google.auth.transport.requests import Request
            return {
                "InstalledAppFlow": InstalledAppFlow,
                "build": build,
                "Credentials": Credentials,
                "Request": Request,
            }, None
        except ImportError as e:
            return None, str(e)

    def _gcal_settings(self) -> dict[str, Any]:
        return self._state["settings"]["gcal"]

    def _load_gcal_creds(self):
        libs, err = self._import_gcal()
        if libs is None:
            return None, f"google libraries not installed: {err}"
        f = self._gcal_token_file()
        if not f.exists():
            return None, "no saved token"
        try:
            creds = libs["Credentials"].from_authorized_user_file(str(f), GCAL_SCOPES)
        except Exception as e:
            return None, f"failed to load token: {e}"
        if not creds.valid:
            if creds.expired and creds.refresh_token:
                try:
                    creds.refresh(libs["Request"]())
                    f.write_text(creds.to_json(), encoding="utf-8")
                except Exception as e:
                    return None, f"token refresh failed: {e}"
            else:
                return None, "token invalid; reconnect"
        return creds, None

    def _effective_gcal_creds(self) -> tuple[str | None, str | None]:
        """Bundled creds win; otherwise fall back to whatever the user pasted."""
        if BUNDLED_GCAL_CLIENT_ID and BUNDLED_GCAL_CLIENT_SECRET:
            return BUNDLED_GCAL_CLIENT_ID, BUNDLED_GCAL_CLIENT_SECRET
        s = self._gcal_settings()
        return s.get("client_id"), s.get("client_secret")

    def get_gcal_status(self) -> dict[str, Any]:
        libs, err = self._import_gcal()
        s = self._gcal_settings()
        token_exists = self._gcal_token_file().exists()
        cid, csec = self._effective_gcal_creds()
        return {
            "libraries_installed": libs is not None,
            "library_error": err,
            "has_credentials": bool(cid and csec),
            "credentials_bundled": bool(BUNDLED_GCAL_CLIENT_ID and BUNDLED_GCAL_CLIENT_SECRET),
            "connected": bool(s.get("connected_email") and token_exists),
            "email": s.get("connected_email"),
            "calendar_id": s.get("calendar_id"),
            "calendar_summary": s.get("calendar_summary"),
            "last_sync_at": s.get("last_sync_at"),
        }

    def gcal_set_credentials(self, client_id: str, client_secret: str) -> dict[str, Any]:
        s = self._gcal_settings()
        s["client_id"] = (client_id or "").strip() or None
        s["client_secret"] = (client_secret or "").strip() or None
        self._save()
        return self.get_gcal_status()

    def gcal_connect(self) -> dict[str, Any]:
        libs, err = self._import_gcal()
        if libs is None:
            raise RuntimeError(f"google libraries not installed: {err}")
        cid, csec = self._effective_gcal_creds()
        if not cid or not csec:
            raise RuntimeError("set client_id and client_secret first")

        client_config = {
            "installed": {
                "client_id": cid,
                "client_secret": csec,
                "auth_uri": "https://accounts.google.com/o/oauth2/auth",
                "token_uri": "https://oauth2.googleapis.com/token",
                "redirect_uris": ["http://localhost"],
            }
        }
        flow = libs["InstalledAppFlow"].from_client_config(client_config, GCAL_SCOPES)
        creds = flow.run_local_server(port=0, open_browser=True, prompt="consent")
        self._gcal_token_file().write_text(creds.to_json(), encoding="utf-8")

        service = libs["build"]("calendar", "v3", credentials=creds, cache_discovery=False)
        primary = service.calendars().get(calendarId="primary").execute()
        s["connected_email"] = primary.get("id", "connected")
        if not s.get("calendar_id"):
            s["calendar_id"] = "primary"
            s["calendar_summary"] = primary.get("summary", "Primary")
        self._save()
        return self.get_gcal_status()

    def gcal_disconnect(self) -> dict[str, Any]:
        s = self._gcal_settings()
        s["connected_email"] = None
        s["last_sync_at"] = None
        try:
            f = self._gcal_token_file()
            if f.exists():
                f.unlink()
        except Exception:
            pass
        # Drop our event-id pointers so a future sync starts fresh.
        for t in self._state["tasks"]:
            t["gcal_event_id"] = None
        self._save()
        return self.get_gcal_status()

    def gcal_list_calendars(self) -> list[dict[str, Any]]:
        libs, _ = self._import_gcal()
        if libs is None:
            raise RuntimeError("google libraries not installed")
        creds, err = self._load_gcal_creds()
        if creds is None:
            raise RuntimeError(f"not connected: {err}")
        service = libs["build"]("calendar", "v3", credentials=creds, cache_discovery=False)
        result = service.calendarList().list().execute()
        items = result.get("items", [])
        return [
            {
                "id": i["id"],
                "summary": i.get("summary", i["id"]),
                "primary": bool(i.get("primary")),
                "access_role": i.get("accessRole", ""),
            }
            for i in items
        ]

    def gcal_set_calendar(self, calendar_id: str, calendar_summary: str | None = None) -> dict[str, Any]:
        s = self._gcal_settings()
        s["calendar_id"] = calendar_id or "primary"
        s["calendar_summary"] = calendar_summary
        self._save()
        return self.get_gcal_status()

    def gcal_sync_now(self) -> dict[str, Any]:
        libs, _ = self._import_gcal()
        if libs is None:
            raise RuntimeError("google libraries not installed")
        creds, err = self._load_gcal_creds()
        if creds is None:
            raise RuntimeError(f"not connected: {err}")

        s = self._gcal_settings()
        cal_id = s.get("calendar_id") or "primary"
        service = libs["build"]("calendar", "v3", credentials=creds, cache_discovery=False)

        created = updated = deleted = errors = 0
        error_messages: list[str] = []

        for task in self._state["tasks"]:
            try:
                ev_id = task.get("gcal_event_id")
                # A task gets an event iff it's not archived AND has a due date.
                should_have_event = (
                    not task.get("archived")
                    and bool(task.get("due_date"))
                )

                if not should_have_event:
                    if ev_id:
                        try:
                            service.events().delete(calendarId=cal_id, eventId=ev_id).execute()
                            deleted += 1
                        except Exception as ex:
                            msg = str(ex)
                            if "404" in msg or "410" in msg or "deleted" in msg.lower():
                                # Already gone; that's fine.
                                pass
                            else:
                                errors += 1
                                error_messages.append(f"delete '{task['text']}': {ex}")
                        task["gcal_event_id"] = None
                    continue

                prefix = "✓ " if task.get("completed") else ""
                quad = (task.get("quadrant") or "").upper()
                body = {
                    "summary": f"{prefix}[{quad}] {task['text']}",
                    "start": {"date": task["due_date"]},
                    "end": {"date": task["due_date"]},
                    "description": "Synced from Eisenhower matrix.",
                    "extendedProperties": {
                        "private": {"eisenhower_task_id": task["id"]}
                    },
                }

                if ev_id:
                    try:
                        service.events().update(
                            calendarId=cal_id, eventId=ev_id, body=body
                        ).execute()
                        updated += 1
                    except Exception as ex:
                        msg = str(ex)
                        if "404" in msg or "410" in msg:
                            ev = service.events().insert(calendarId=cal_id, body=body).execute()
                            task["gcal_event_id"] = ev["id"]
                            created += 1
                        else:
                            errors += 1
                            error_messages.append(f"update '{task['text']}': {ex}")
                else:
                    ev = service.events().insert(calendarId=cal_id, body=body).execute()
                    task["gcal_event_id"] = ev["id"]
                    created += 1
            except Exception as ex:
                errors += 1
                error_messages.append(f"{task.get('text', '?')}: {ex}")

        s["last_sync_at"] = datetime.now().isoformat(timespec="seconds")
        self._save()
        return {
            "created": created,
            "updated": updated,
            "deleted": deleted,
            "errors": errors,
            "error_messages": error_messages[:5],
            "last_sync_at": s["last_sync_at"],
        }

    def open_external_url(self, url: str) -> None:
        try:
            import webbrowser
            webbrowser.open(url)
        except Exception:
            pass

    def get_monitor_work_area(self) -> dict[str, int] | None:
        """Return the work area (screen minus taskbar) of the monitor under our window."""
        if sys.platform != "win32":
            return None
        try:
            user32 = ctypes.windll.user32
            hwnd = self._hwnd()
            if not hwnd:
                return None
            MONITOR_DEFAULTTONEAREST = 2
            monitor = user32.MonitorFromWindow(hwnd, MONITOR_DEFAULTTONEAREST)

            class RECT(ctypes.Structure):
                _fields_ = [
                    ("left", ctypes.c_long),
                    ("top", ctypes.c_long),
                    ("right", ctypes.c_long),
                    ("bottom", ctypes.c_long),
                ]

            class MONITORINFO(ctypes.Structure):
                _fields_ = [
                    ("cbSize", ctypes.c_ulong),
                    ("rcMonitor", RECT),
                    ("rcWork", RECT),
                    ("dwFlags", ctypes.c_ulong),
                ]

            info = MONITORINFO()
            info.cbSize = ctypes.sizeof(MONITORINFO)
            user32.GetMonitorInfoW(monitor, ctypes.byref(info))
            return {
                "x": int(info.rcWork.left),
                "y": int(info.rcWork.top),
                "width": int(info.rcWork.right - info.rcWork.left),
                "height": int(info.rcWork.bottom - info.rcWork.top),
            }
        except Exception:
            return None

    def _find(self, task_id: str) -> dict[str, Any]:
        for t in self._state["tasks"]:
            if t["id"] == task_id:
                return t
        raise KeyError(task_id)


def main() -> None:
    if not acquire_single_instance():
        # Already running. Quietly bail.
        return

    api = Api()
    index = web_root() / "index.html"
    webview.create_window(
        title=WINDOW_TITLE,
        url=str(index),
        js_api=api,
        width=WINDOW_SIZE[0],
        height=WINDOW_SIZE[1],
        min_size=(700, 500),
        frameless=True,
        easy_drag=False,
        background_color=BG_COLOR,
        text_select=True,
    )
    webview.start()


if __name__ == "__main__":
    main()
