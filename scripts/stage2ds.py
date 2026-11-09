#!/usr/bin/env python3
"""Stage2 dataset analyser for GitHub Actions.

The preflight deliberately refuses to start the 1.25M-position run unless the
Chess-API WebSocket response exposes five distinct MultiPV candidates.
"""
from __future__ import annotations
import argparse, json, os, random, re, shutil, sqlite3, subprocess, sys, time, uuid, zipfile
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import requests
import websocket

ROOT = Path("stage2ds")
DB_PATH = ROOT / "progress.sqlite"
ERROR_DIR = ROOT / "errorlogs"
DRIVE_URL = os.getenv("DRIVE_FOLDER_URL", "https://drive.google.com/drive/folders/1FEext-LcjonVRFSHeav0Kxb2xOhS70n9")
API_WS = "wss://chess-api.com/v1"
API_DEPTH = 18
API_VARIANTS = 5
API_MAX_TIME = 100
REQUEST_GAP = 0.1
BATCH_MIN, BATCH_MAX = 60, 80
PAUSE_MIN, PAUSE_MAX = 10, 40
CHECKPOINT_BATCHES = 5
EXPECTED_FILES = 125
EXPECTED_POSITIONS = 10000
SAFE_JOB_MINUTES = 320


def now():
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def require_env(name: str) -> str:
    value = os.getenv(name, "").strip()
    if not value:
        raise RuntimeError(f"Missing required GitHub secret/environment variable: {name}")
    return value


def db_open() -> sqlite3.Connection:
    ROOT.mkdir(exist_ok=True)
    con = sqlite3.connect(DB_PATH, timeout=60)
    con.row_factory = sqlite3.Row
    con.execute("PRAGMA journal_mode=WAL")
    con.execute("PRAGMA synchronous=FULL")
    con.executescript("""
    CREATE TABLE IF NOT EXISTS files(
      file_name TEXT PRIMARY KEY, dataset_id TEXT NOT NULL,
      total INTEGER NOT NULL, last_index INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending', updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS errors(
      dataset_id TEXT NOT NULL, file_name TEXT NOT NULL, position_index INTEGER NOT NULL,
      fen TEXT NOT NULL, error TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'failed',
      retry_reserved INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL,
      PRIMARY KEY(dataset_id, position_index)
    );
    CREATE TABLE IF NOT EXISTS recent(
      dataset_id TEXT NOT NULL, file_name TEXT NOT NULL, position_index INTEGER NOT NULL,
      fen TEXT NOT NULL, ca_json TEXT NOT NULL, updated_at TEXT NOT NULL,
      PRIMARY KEY(dataset_id, position_index)
    );
    CREATE TABLE IF NOT EXISTS runtime(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    """)
    con.commit()
    return con


def runtime_set(con, **values):
    for k, v in values.items():
        con.execute("INSERT INTO runtime(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, str(v)))
    con.commit()


def runtime_get(con, key, default=""):
    row = con.execute("SELECT value FROM runtime WHERE key=?", (key,)).fetchone()
    return row["value"] if row else default


def atomic_json(path: Path, obj: Any):
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def error_path(file_name: str) -> Path:
    return ERROR_DIR / (Path(file_name).stem + ".txt")


def append_error(file_name: str, index: int, fen: str, message: str, tag="ERROR"):
    ERROR_DIR.mkdir(parents=True, exist_ok=True)
    p = error_path(file_name)
    if not p.exists():
        p.write_text("Fen\tindex\terror\tstatus\n", encoding="utf-8")
    clean = str(message).replace("\r", " ").replace("\n", " ").replace("\t", " ")
    prefix = f"{fen}\t{index}\t"
    if any(line.startswith(prefix) and line.endswith("\t" + tag) for line in p.read_text(encoding="utf-8").splitlines()[1:]):
        return
    with p.open("a", encoding="utf-8") as f:
        f.write(f"{fen}\t{index}\t{clean}\t{tag}\n")


def telegram_call(method: str, **data):
    token = require_env("TELEGRAM_BOT_TOKEN")
    url = f"https://api.telegram.org/bot{token}/{method}"
    response = requests.post(url, data=data, timeout=30)
    response.raise_for_status()
    payload = response.json()
    if not payload.get("ok"):
        raise RuntimeError(f"Telegram {method} failed: {payload}")
    return payload["result"]


def tg_message(text: str, strict=False):
    try:
        chat_id = require_env("TELEGRAM_CHAT_ID")
        telegram_call("sendMessage", chat_id=chat_id, text=text, disable_web_page_preview=True)
    except Exception as exc:
        print(f"Telegram message warning: {exc}")
        if strict: raise


def tg_document(path: Path, caption: str, strict=False):
    try:
        chat_id = require_env("TELEGRAM_CHAT_ID")
        token = require_env("TELEGRAM_BOT_TOKEN")
        with path.open("rb") as f:
            r = requests.post(f"https://api.telegram.org/bot{token}/sendDocument",
                              data={"chat_id": chat_id, "caption": caption[:900]},
                              files={"document": (path.name, f, "text/plain")}, timeout=90)
        r.raise_for_status()
        result = r.json()
        if not result.get("ok"):
            raise RuntimeError(f"Telegram sendDocument failed: {result}")
    except Exception as exc:
        print(f"Telegram document warning: {exc}")
        if strict: raise


def status_text(con):
    current_file = runtime_get(con, "current_file", "None")
    current_index = runtime_get(con, "current_index", "-")
    state = runtime_get(con, "status", "idle")
    batch = runtime_get(con, "batch_length", "-")
    next_at = runtime_get(con, "next_batch_at", "")
    wait = "-"
    if next_at:
        try:
            wait = f"{max(0, int(float(next_at)-time.time()))} sec"
        except Exception:
            pass
    errs = con.execute("SELECT file_name,position_index,error FROM errors WHERE status IN ('failed','final_failed','retry_reserved') ORDER BY updated_at DESC LIMIT 3").fetchall()
    rec = con.execute("SELECT file_name,position_index,ca_json FROM recent ORDER BY updated_at DESC LIMIT 3").fetchall()
    progress_line = "File progress: -"
    frow = con.execute("SELECT dataset_id,total,last_index FROM files WHERE file_name=?", (current_file,)).fetchone()
    if frow:
        failed_n = con.execute("SELECT COUNT(*) n FROM errors WHERE dataset_id=? AND status IN ('failed','final_failed','retry_reserved')", (frow["dataset_id"],)).fetchone()["n"]
        done_n = int(frow["last_index"])
        progress_line = f"File progress: {done_n}/{frow['total']} checkpointed; {failed_n} failed; {max(0, frow['total']-done_n)} not yet checkpointed"
    lines = ["STAGE2DS STATUS", f"State: {state}", f"File: {current_file}", f"Position: {current_index}", progress_line, f"Batch length: {batch}", f"Next batch in: {wait}", "", "Last 3 errors:"]
    lines += [f"- {x['file_name']} #{x['position_index']}: {x['error'][:150]}" for x in errs] or ["- None"]
    lines += ["", "Last 3 analysed positions:"]
    for x in rec:
        try: moves = json.loads(x["ca_json"])
        except Exception: moves = []
        lines.append(f"- {x['file_name']} #{x['position_index']}: {', '.join(moves[:5])}")
    if not rec: lines.append("- None")
    return "\n".join(lines)


def poll_bot(con, force=False):
    if not os.getenv("TELEGRAM_BOT_TOKEN") or not os.getenv("TELEGRAM_CHAT_ID"):
        return
    last = float(runtime_get(con, "last_bot_poll", "0") or 0)
    if not force and time.time() - last < 5:
        return
    runtime_set(con, last_bot_poll=time.time())
    offset = int(runtime_get(con, "telegram_offset", "0") or 0)
    try:
        updates = telegram_call("getUpdates", offset=offset, timeout=0, allowed_updates='["message"]')
    except Exception as exc:
        print(f"Telegram polling warning: {exc}")
        return
    allowed = str(os.getenv("TELEGRAM_CHAT_ID", ""))
    for update in updates:
        runtime_set(con, telegram_offset=int(update["update_id"]) + 1)
        msg = update.get("message", {})
        chat = str(msg.get("chat", {}).get("id", ""))
        text = (msg.get("text") or "").strip().split()[0].lower() if msg.get("text") else ""
        if chat == allowed and text in ("/ping", "/status"):
            try: tg_message(status_text(con))
            except Exception as exc: print(f"Could not reply to /ping: {exc}")


def parse_rank(data: dict) -> int | None:
    for key in ("multipv", "multiPv", "rank", "variant"):
        value = data.get(key)
        if isinstance(value, int) and 1 <= value <= 5:
            return value
    debug = str(data.get("debug", ""))
    match = re.search(r"\bmultipv\s+(\d+)\b", debug, re.I)
    if match:
        n = int(match.group(1))
        if 1 <= n <= 5: return n
    return None


class ChessSocket:
    def __init__(self):
        self.ws = None
        self.connect()

    def connect(self):
        if self.ws:
            try: self.ws.close()
            except Exception: pass
        self.ws = websocket.create_connection(API_WS, timeout=3, enable_multithread=True)

    def analyse(self, fen: str) -> tuple[list[str], list[dict]]:
        task_id = uuid.uuid4().hex[:12]
        payload = {"fen": fen, "depth": API_DEPTH, "variants": API_VARIANTS,
                   "maxThinkingTime": API_MAX_TIME, "taskId": task_id}
        try:
            self.ws.send(json.dumps(payload))
        except Exception:
            self.connect(); self.ws.send(json.dumps(payload))
        found: dict[int, dict] = {}
        raw_messages = []
        best_seen = False
        last_message = time.monotonic()
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            self.ws.settimeout(0.5 if (best_seen or len(found) == 5) else 5)
            try:
                raw = self.ws.recv()
            except websocket.WebSocketTimeoutException:
                if (best_seen or len(found) == 5) and time.monotonic() - last_message >= 1.0:
                    break
                continue
            except Exception:
                self.connect()
                raise RuntimeError("Chess API WebSocket disconnected during analysis")
            try:
                message = json.loads(raw)
            except Exception:
                continue
            batch = message if isinstance(message, list) else [message]
            for item in batch:
                if not isinstance(item, dict): continue
                raw_messages.append(item)
                if item.get("taskId") not in (None, task_id): continue
                if item.get("type") == "error" or item.get("error"):
                    raise RuntimeError(str(item.get("text") or item.get("error") or item))
                rank = parse_rank(item)
                move = item.get("move")
                if item.get("type") == "bestmove":
                    best_seen = True
                    if rank is None: rank = 1
                if rank and move:
                    old = found.get(rank)
                    old_depth = int(old.get("depth") or 0) if old else -1
                    new_depth = int(item.get("depth") or 0)
                    if old is None or new_depth >= old_depth or item.get("type") == "bestmove":
                        found[rank] = item
                last_message = time.monotonic()
            if len(found) == 5 and time.monotonic() - last_message > 0.5:
                break
        ordered = [found[i] for i in range(1, 6) if i in found]
        moves = [str(x.get("move")) for x in ordered if x.get("move")]
        if len(moves) != 5 or len(set(moves)) != 5:
            # Preserve a compact diagnostic to make the preflight failure actionable.
            types = [f"{x.get('type')}:{x.get('move')}:{parse_rank(x)}" for x in raw_messages[-20:]]
            raise RuntimeError(f"API did not provide 5 distinct ranked MultiPV moves (received {len(moves)}). Recent messages: {types}")
        return moves, raw_messages

    def close(self):
        if self.ws:
            try: self.ws.close()
            except Exception: pass


def create_zip():
    ROOT.mkdir(exist_ok=True)
    # SQLite runs in WAL mode. Merge committed WAL pages before packaging the DB.
    if DB_PATH.exists():
        checkpoint_db = sqlite3.connect(DB_PATH, timeout=60)
        try:
            checkpoint_db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        finally:
            checkpoint_db.close()
    zip_path = Path("stage2ds.zip")
    if zip_path.exists(): zip_path.unlink()
    with zipfile.ZipFile(zip_path, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as z:
        for p in ROOT.rglob("*"):
            if p.is_file() and not p.name.endswith((".tmp", "-wal", "-shm")):
                z.write(p, Path(ROOT.name) / p.relative_to(ROOT))
    return zip_path


def publish_snapshot():
    zip_path = create_zip()
    repo = require_env("GITHUB_REPOSITORY")
    token = require_env("GH_TOKEN")
    env = os.environ.copy(); env["GH_TOKEN"] = token
    subprocess.run(["gh", "release", "upload", "stage2ds-latest", str(zip_path), "--clobber", "--repo", repo], check=True, env=env)
    return zip_path


def download_drive():
    temp = Path("stage2ds_download")
    if temp.exists(): shutil.rmtree(temp)
    temp.mkdir()
    subprocess.run([sys.executable, "-m", "gdown", "--folder", DRIVE_URL, "-O", str(temp)], check=True)
    files = sorted(temp.rglob("*.json"), key=lambda p: p.name.lower())
    if len(files) != EXPECTED_FILES:
        raise RuntimeError(f"Google Drive folder returned {len(files)} JSON files; expected {EXPECTED_FILES}.")
    ROOT.mkdir(exist_ok=True)
    for src in files:
        dst = ROOT / src.name
        if dst.exists(): raise RuntimeError(f"Duplicate JSON filename in Drive folder: {src.name}")
        shutil.copy2(src, dst)
    shutil.rmtree(temp)


def validate_dataset(con):
    json_files = sorted(ROOT.glob("*.json"), key=lambda p: p.name.lower())
    if len(json_files) != EXPECTED_FILES:
        raise RuntimeError(f"stage2ds contains {len(json_files)} JSON files; expected {EXPECTED_FILES}.")
    seen_ids = set()
    for path in json_files:
        obj = json.loads(path.read_text(encoding="utf-8"))
        if not isinstance(obj, dict) or not isinstance(obj.get("positions"), list):
            raise RuntimeError(f"Invalid root JSON structure: {path.name}")
        if not all(k in obj for k in ("rating_range", "dataset_id", "positions")):
            raise RuntimeError(f"Missing root fields in {path.name}")
        if len(obj["positions"]) != EXPECTED_POSITIONS:
            raise RuntimeError(f"{path.name}: expected 10,000 positions, found {len(obj['positions'])}.")
        dsid = str(obj.get("dataset_id", ""))
        if not dsid or dsid in seen_ids: raise RuntimeError(f"Missing/duplicate dataset_id in {path.name}")
        seen_ids.add(dsid)
        for i, pos in enumerate(obj["positions"], 1):
            if not isinstance(pos, dict) or not pos.get("fen") or "index" not in pos or "ca" not in pos:
                raise RuntimeError(f"Bad position structure: {path.name}, item {i}")
            if int(pos["index"]) != i or "s8" not in pos or "s2" not in pos:
                raise RuntimeError(f"Unexpected position index/fields: {path.name}, item {i}")
            if not isinstance(pos["ca"], list): raise RuntimeError(f"ca must be a list: {path.name} #{i}")
        con.execute("INSERT OR IGNORE INTO files(file_name,dataset_id,total,last_index,status,updated_at) VALUES(?,?,?,?,?,?)",
                    (path.name, dsid, len(obj["positions"]), 0, "pending", now()))
    con.commit()


def preflight():
    if ROOT.exists(): shutil.rmtree(ROOT)
    ROOT.mkdir(); ERROR_DIR.mkdir(parents=True)
    print("[1/7] Downloading the public Google Drive folder...")
    download_drive()
    con = db_open()
    print("[2/7] Validating all 125 JSON files and 1,250,000 positions...")
    validate_dataset(con)
    print("[3/7] Testing SQLite write/read...")
    con.execute("INSERT OR REPLACE INTO runtime(key,value) VALUES('preflight_test','ok')")
    con.commit()
    if con.execute("SELECT value FROM runtime WHERE key='preflight_test'").fetchone()[0] != "ok":
        raise RuntimeError("SQLite read/write test failed")
    con.execute("DELETE FROM runtime WHERE key='preflight_test'"); con.commit()
    print("[4/7] Checking Telegram credentials, polling mode and send permission...")
    require_env("TELEGRAM_CHAT_ID")
    webhook = telegram_call("getWebhookInfo")
    if webhook.get("url"):
        raise RuntimeError("Telegram bot has a webhook configured. Disable the webhook before using /ping polling.")
    tg_message("STAGE2DS PREFLIGHT: Telegram connection and message delivery are working.", strict=True)
    test_doc = Path("/tmp/stage2ds_telegram_test.txt")
    test_doc.write_text("Stage2DS Telegram document upload test passed.\n", encoding="utf-8")
    tg_document(test_doc, "Preflight document-upload test", strict=True)
    test_doc.unlink(missing_ok=True)
    print("[5/7] Testing Chess API MultiPV=5 on one sample FEN...")
    first = json.loads(sorted(ROOT.glob("*.json"), key=lambda p: p.name.lower())[0].read_text(encoding="utf-8"))
    fen = first["positions"][0]["fen"]
    sock = ChessSocket()
    try:
        moves, raw = sock.analyse(fen)
        atomic_json(ROOT / "preflight_api_sample.json", {"fen": fen, "moves": moves, "messages": raw})
    finally:
        sock.close()
    print("[6/7] Testing full-folder ZIP creation...")
    z = create_zip()
    if not z.exists() or z.stat().st_size == 0: raise RuntimeError("ZIP test failed")
    print("[7/7] Preflight passed. GitHub release write is tested by the following workflow upload step.")
    runtime_set(con, status="preflight_passed", current_file="-", current_index="-", batch_length="-", next_batch_at="")
    tg_message("STAGE2DS PREFLIGHT PASSED. All 125 files validated; SQLite, Telegram, Chess API five-variant response and ZIP creation passed. Processing will now start.")
    con.close()


def restore_json_from_errors(con, obj):
    """Keep error state in SQLite; JSON ca is authoritative for successful results."""
    return obj


def load_file(path: Path):
    return json.loads(path.read_text(encoding="utf-8"))


def save_file(path: Path, obj):
    atomic_json(path, obj)


def checkpoint(con, file_path=None, file_obj=None):
    if file_path and file_obj is not None: save_file(file_path, file_obj)
    con.commit()
    publish_snapshot()


def pause_with_poll(con, seconds: int):
    runtime_set(con, status="break", next_batch_at=time.time() + seconds)
    end = time.monotonic() + seconds
    while time.monotonic() < end:
        poll_bot(con)
        time.sleep(min(2, max(0.1, end - time.monotonic())))
    runtime_set(con, status="processing", next_batch_at="")


def complete_file(con, path: Path, obj):
    dsid = str(obj["dataset_id"])
    row = con.execute("SELECT total,last_index FROM files WHERE dataset_id=?", (dsid,)).fetchone()
    total = len(obj["positions"])
    attempted = con.execute("SELECT COUNT(*) AS n FROM errors WHERE dataset_id=?", (dsid,)).fetchone()["n"]
    last_index = row["last_index"] if row else 0
    # A file is complete when every index was either successful (<= last_index) or recorded as failed.
    failed_indexes = {r[0] for r in con.execute("SELECT position_index FROM errors WHERE dataset_id=?", (dsid,)).fetchall()}
    if last_index >= total:
        con.execute("UPDATE files SET status='completed',updated_at=? WHERE dataset_id=?", (now(), dsid)); con.commit()
        log = error_path(path.name)
        if not log.exists(): log.write_text("No errors recorded.\n", encoding="utf-8")
        tg_message(f"FILE COMPLETED: {path.name}\nPositions: {total}\nFailed: {attempted}\nSuccessful: {total-attempted}")
        tg_document(log, f"Error log for {path.name}")
        return True
    return False


def process_job(max_minutes=SAFE_JOB_MINUTES):
    con = db_open(); sock = ChessSocket()
    start = time.monotonic(); deadline = start + max_minutes * 60
    tg_message("STAGE2DS JOB STARTED: processing will continue from the latest saved checkpoint.")
    runtime_set(con, status="processing", job_started=now())
    batch_target = random.randint(BATCH_MIN, BATCH_MAX); batch_count = 0; batches_since_checkpoint = 0
    stop = False
    try:
        paths = sorted(ROOT.glob("*.json"), key=lambda p: p.name.lower())
        for path in paths:
            last_attempted_idx = 0
            obj = load_file(path); dsid = str(obj["dataset_id"]); total = len(obj["positions"])
            file_row = con.execute("SELECT last_index,status FROM files WHERE dataset_id=?", (dsid,)).fetchone()
            if file_row and file_row["status"] == "completed": continue
            tg_message(f"FILE STARTED: {path.name}")
            con.execute("UPDATE files SET status='processing',updated_at=? WHERE dataset_id=?", (now(), dsid)); con.commit()
            for pos in obj["positions"]:
                idx = int(pos["index"])
                frow = con.execute("SELECT last_index FROM files WHERE dataset_id=?", (dsid,)).fetchone()
                last_index = int(frow["last_index"] if frow else 0)
                if idx <= last_index: continue
                if time.monotonic() >= deadline - 900:
                    stop = True; break
                runtime_set(con, current_file=path.name, current_index=idx, status="processing", batch_length=batch_target)
                poll_bot(con)
                try:
                    moves, _ = sock.analyse(pos["fen"])
                    pos["ca"] = moves
                    con.execute("INSERT OR REPLACE INTO recent(dataset_id,file_name,position_index,fen,ca_json,updated_at) VALUES(?,?,?,?,?,?)",
                                (dsid, path.name, idx, pos["fen"], json.dumps(moves), now()))
                    con.execute("DELETE FROM recent WHERE rowid IN (SELECT rowid FROM recent ORDER BY updated_at DESC LIMIT -1 OFFSET 3)")
                except Exception as exc:
                    msg = str(exc)[:1000]
                    append_error(path.name, idx, pos["fen"], msg)
                    con.execute("INSERT OR REPLACE INTO errors(dataset_id,file_name,position_index,fen,error,status,retry_reserved,updated_at) VALUES(?,?,?,?,?,'failed',0,?)",
                                (dsid, path.name, idx, pos["fen"], msg, now()))
                    print(f"ERROR {path.name} #{idx}: {msg}")
                    time.sleep(3)
                last_attempted_idx = idx
                batch_count += 1
                time.sleep(REQUEST_GAP)
                if batch_count >= batch_target:
                    # Save JSON first, then advance durable file index. A crash before this
                    # point replays this batch rather than silently skipping unsaved results.
                    save_file(path, obj)
                    con.execute("UPDATE files SET last_index=?,updated_at=? WHERE dataset_id=?", (idx, now(), dsid)); con.commit()
                    batch_count = 0; batches_since_checkpoint += 1
                    if batches_since_checkpoint >= CHECKPOINT_BATCHES:
                        checkpoint(con); batches_since_checkpoint = 0
                    pause = random.randint(PAUSE_MIN, PAUSE_MAX)
                    pause_with_poll(con, pause)
                    batch_target = random.randint(BATCH_MIN, BATCH_MAX)
            if stop: break
            # Finish the tail of the file even if it is shorter than the random batch size.
            save_file(path, obj)
            last = int(obj["positions"][-1]["index"]) if obj["positions"] else 0
            con.execute("UPDATE files SET last_index=?,status='completed',updated_at=? WHERE dataset_id=?", (last, now(), dsid)); con.commit()
            log = error_path(path.name)
            if not log.exists(): log.write_text("No errors recorded.\n", encoding="utf-8")
            failed = con.execute("SELECT COUNT(*) n FROM errors WHERE dataset_id=?", (dsid,)).fetchone()["n"]
            tg_message(f"FILE COMPLETED: {path.name}\nPositions: {total}\nSuccessful: {total-failed}\nFailed: {failed}")
            tg_document(log, f"Error log for {path.name}")
            batch_count = 0
            checkpoint(con)
            pause_with_poll(con, 10)
        # Persist any partial tail before the job exits.
        if 'path' in locals() and 'obj' in locals() and batch_count:
            save_file(path, obj)
            last_idx = last_attempted_idx
            con.execute("UPDATE files SET last_index=?,updated_at=? WHERE dataset_id=?", (last_idx, now(), str(obj["dataset_id"]))); con.commit()
        runtime_set(con, status="job_checkpointing", current_index="-")
        checkpoint(con)
    finally:
        sock.close(); con.close()
    # Dispatch the next workflow run only after the latest complete folder snapshot is uploaded.
    con2 = db_open()
    remaining = con2.execute("SELECT COUNT(*) n FROM files WHERE status!='completed'").fetchone()["n"]
    con2.close()
    next_phase = "continue" if remaining else "retry"
    tg_message(f"PROCESSING JOB FINISHED. Remaining files: {remaining}. Next phase: {next_phase}.")
    dispatch(next_phase)


def retry_job(max_minutes=SAFE_JOB_MINUTES):
    con = db_open(); sock = ChessSocket()
    start = time.monotonic(); deadline = start + max_minutes * 60
    tg_message("FINAL RETRY JOB STARTED: each recorded failed position will receive at most one final retry.")
    runtime_set(con, status="final_retry", current_file="-", current_index="-")
    try:
        rows = con.execute("SELECT * FROM errors WHERE status='failed' AND retry_reserved=0 ORDER BY file_name,position_index").fetchall()
        retry_batch_target = random.randint(BATCH_MIN, BATCH_MAX)
        retry_batch_count = 0
        for row in rows:
            if time.monotonic() >= deadline - 900: break
            # Reserve the one permitted retry before sending the request.
            con.execute("UPDATE errors SET retry_reserved=1,status='retry_reserved',updated_at=? WHERE dataset_id=? AND position_index=?",
                        (now(), row["dataset_id"], row["position_index"]))
            con.commit()
            # Persist reservation so a resumed retry run will never blindly repeat it.
            publish_snapshot()
            path = ROOT / row["file_name"]
            obj = load_file(path)
            target = next(p for p in obj["positions"] if int(p["index"]) == int(row["position_index"]))
            runtime_set(con, current_file=row["file_name"], current_index=row["position_index"], status="final_retry", batch_length=retry_batch_target)
            poll_bot(con)
            try:
                moves, _ = sock.analyse(row["fen"])
                target["ca"] = moves
                append_error(row["file_name"], row["position_index"], row["fen"], "Resolved by final retry", "RESOLVED")
                con.execute("UPDATE errors SET status='resolved',error=?,updated_at=? WHERE dataset_id=? AND position_index=?",
                            ("Resolved by final retry", now(), row["dataset_id"], row["position_index"]))
            except Exception as exc:
                msg = str(exc)[:1000]
                append_error(row["file_name"], row["position_index"], row["fen"], msg, "FINAL_RETRY_FAILED")
                con.execute("UPDATE errors SET status='final_failed',error=?,updated_at=? WHERE dataset_id=? AND position_index=?",
                            (msg, now(), row["dataset_id"], row["position_index"]))
                time.sleep(3)
            save_file(path, obj); con.commit(); publish_snapshot()
            time.sleep(REQUEST_GAP)
            retry_batch_count += 1
            if retry_batch_count >= retry_batch_target:
                retry_batch_count = 0
                retry_batch_target = random.randint(BATCH_MIN, BATCH_MAX)
                pause_with_poll(con, random.randint(PAUSE_MIN, PAUSE_MAX))
        # A retry_reserved entry means the runner stopped after reserving but before recording
        # a result. Do not retry it again; preserve an explicit uncertainty record in the TXT log.
        interrupted = con.execute("SELECT file_name,position_index,fen,dataset_id FROM errors WHERE status='retry_reserved'").fetchall()
        for item in interrupted:
            message = "Retry was reserved before an interruption; not repeated to preserve the one-time retry limit"
            append_error(item["file_name"], item["position_index"], item["fen"], message, "FINAL_RETRY_FAILED")
            con.execute("UPDATE errors SET status='final_failed',error=?,updated_at=? WHERE dataset_id=? AND position_index=?",
                        (message, now(), item["dataset_id"], item["position_index"]))
        con.commit()
        for path in sorted(ROOT.glob("*.json"), key=lambda p:p.name.lower()):
            dsid = str(load_file(path).get("dataset_id", ""))
            if con.execute("SELECT 1 FROM errors WHERE dataset_id=? AND status IN ('resolved','final_failed') LIMIT 1", (dsid,)).fetchone():
                log = error_path(path.name)
                if log.exists(): tg_document(log, f"Updated final error log for {path.name}")
    finally:
        sock.close()
    con.commit()
    remaining = con.execute("SELECT COUNT(*) n FROM errors WHERE status='failed' AND retry_reserved=0").fetchone()["n"]
    con.close()
    publish_snapshot()
    if remaining:
        tg_message(f"Final retry is continuing in another run. Remaining retry candidates: {remaining}.")
        dispatch("retry")
    else:
        tg_message("STAGE2DS COMPLETE. All normal processing and the one-time final retry pass have finished. Download stage2ds.zip from the repository Releases page.")


def dispatch(phase: str):
    repo = require_env("GITHUB_REPOSITORY")
    token = require_env("GH_TOKEN")
    env = os.environ.copy(); env["GH_TOKEN"] = token
    try:
        subprocess.run(["gh", "workflow", "run", "stage2ds.yml", "--ref", os.getenv("GITHUB_REF_NAME", "main"), "-f", f"phase={phase}", "--repo", repo], check=True, env=env)
    except Exception as exc:
        try: tg_message(f"AUTOMATIC CONTINUATION FAILED: {exc}\nManually run workflow 'Stage2DS Processor' with phase={phase}.")
        except Exception: pass
        raise


def next_phase():
    con = db_open()
    remaining_files = con.execute("SELECT COUNT(*) n FROM files WHERE status!='completed'").fetchone()["n"]
    retry_left = con.execute("SELECT COUNT(*) n FROM errors WHERE status='failed' AND retry_reserved=0").fetchone()["n"]
    con.close()
    if remaining_files: print("continue")
    elif retry_left: print("retry")
    else: print("done")


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="cmd", required=True)
    sub.add_parser("preflight")
    p = sub.add_parser("process"); p.add_argument("--max-minutes", type=int, default=SAFE_JOB_MINUTES)
    r = sub.add_parser("retry"); r.add_argument("--max-minutes", type=int, default=SAFE_JOB_MINUTES)
    sub.add_parser("zip"); sub.add_parser("next-phase")
    args = parser.parse_args()
    if args.cmd == "preflight": preflight()
    elif args.cmd == "process": process_job(args.max_minutes)
    elif args.cmd == "retry": retry_job(args.max_minutes)
    elif args.cmd == "zip": print(create_zip())
    elif args.cmd == "next-phase": next_phase()

if __name__ == "__main__":
    main()
