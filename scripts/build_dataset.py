#!/usr/bin/env python3
"""
Streaming Lichess monthly PGN -> unique FEN candidate pools -> final JSON dataset.

Checkpoint state is stored on a separate orphan branch named dataset-checkpoints.
The checkpoint branch is force-updated with a single snapshot commit so its git
history does not grow on every checkpoint. SQLite is compressed and split into
45 MiB parts to stay below GitHub's 100 MiB per-file limit.

This script is designed for GitHub Actions. It can also be run locally, but
checkpoint push/restore requires GITHUB_TOKEN and GITHUB_REPOSITORY.
"""
from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import random
import re
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

import chess
import chess.pgn
import requests
import zstandard as zstd

ROOT = Path(__file__).resolve().parents[1]
WORK_DIR = Path(os.environ.get("DATASET_WORK_DIR", "/tmp/lichess-dataset-work"))
DB_PATH = WORK_DIR / "state.sqlite3"
OUT_DIR = ROOT / "dataset"
CHECKPOINT_BRANCH = "dataset-checkpoints"
CHUNK_BYTES = 45 * 1024 * 1024
CHECKPOINT_SECONDS = int(os.environ.get("CHECKPOINT_SECONDS", "1800"))
GAMES_PER_PROGRESS = int(os.environ.get("GAMES_PER_PROGRESS", "10000"))
MAX_MONTHS = int(os.environ.get("MAX_MONTHS", "12"))
START_MONTH = os.environ.get("START_MONTH", "2026-10")
SEED = int(os.environ.get("DATASET_RANDOM_SEED", "20261108"))

POOL_TARGETS = {"bullet": 4000, "rapid": 7000, "blitz": 9000}
FINAL_TARGETS = {"bullet": 2000, "rapid": 3500, "blitz": 4500}
CONTROL_ORDER = ("bullet", "rapid", "blitz")

stop_requested = False
POOL_COUNTS = {}
COMPLETED_BUCKETS = set()


def log(message: str) -> None:
    stamp = datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S UTC")
    print(f"[{stamp}] {message}", flush=True)


def notify(message: str) -> None:
    token = os.environ.get("TELEGRAM_BOT_TOKEN", "").strip()
    chat_id = os.environ.get("TELEGRAM_CHAT_ID", "").strip()
    if not token or not chat_id:
        return
    try:
        requests.post(
            f"https://api.telegram.org/bot{token}/sendMessage",
            data={"chat_id": chat_id, "text": message},
            timeout=20,
        ).raise_for_status()
    except Exception as exc:
        log(f"Telegram notification failed (continuing): {exc}")


def run(cmd, cwd=None, check=True, capture_output=False):
    return subprocess.run(
        cmd, cwd=cwd, check=check, text=True,
        stdout=subprocess.PIPE if capture_output else None,
        stderr=subprocess.PIPE if capture_output else None,
    )


def git_env():
    token = os.environ.get("GITHUB_TOKEN", "")
    repo = os.environ.get("GITHUB_REPOSITORY", "")
    if not token or not repo:
        return None, None
    return token, repo


def restore_checkpoint() -> None:
    token, repo = git_env()
    if not token or not repo:
        log("No GitHub credentials found; starting without remote checkpoint.")
        return
    tmp = Path(tempfile.mkdtemp(prefix="lichess-checkpoint-restore-"))
    url = f"https://x-access-token:{token}@github.com/{repo}.git"
    try:
        result = subprocess.run(
            ["git", "clone", "--depth", "1", "--branch", CHECKPOINT_BRANCH, url, str(tmp)],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )
        if result.returncode != 0:
            log("No existing checkpoint branch found; starting fresh.")
            return
        manifest = tmp / "checkpoint.json"
        if not manifest.exists():
            log("Checkpoint branch exists but has no manifest; starting fresh.")
            return
        parts = sorted(tmp.glob("state.sqlite3.zst.part*"))
        if not parts:
            log("Checkpoint manifest found but database parts are missing; starting fresh.")
            return
        WORK_DIR.mkdir(parents=True, exist_ok=True)
        compressed = WORK_DIR / "restore.sqlite3.zst"
        with compressed.open("wb") as out:
            for part in parts:
                with part.open("rb") as src:
                    shutil.copyfileobj(src, out)
        dctx = zstd.ZstdDecompressor()
        with compressed.open("rb") as src, DB_PATH.open("wb") as dst:
            dctx.copy_stream(src, dst)
        compressed.unlink(missing_ok=True)
        log(f"Restored checkpoint database ({DB_PATH.stat().st_size / (1024**2):.1f} MiB).")
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def save_checkpoint(conn: sqlite3.Connection, reason: str) -> None:
    token, repo = git_env()
    if not token or not repo:
        log(f"Checkpoint skipped (no GitHub credentials): {reason}")
        return
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    conn.commit()
    conn.execute("PRAGMA wal_checkpoint(FULL)")
    snapshot = WORK_DIR / "snapshot.sqlite3"
    if snapshot.exists():
        snapshot.unlink()
    dst = sqlite3.connect(snapshot)
    conn.backup(dst)
    dst.close()

    upload = Path(tempfile.mkdtemp(prefix="lichess-checkpoint-upload-"))
    try:
        cctx = zstd.ZstdCompressor(level=6)
        compressed = upload / "state.sqlite3.zst"
        with snapshot.open("rb") as src, compressed.open("wb") as out:
            cctx.copy_stream(src, out)

        part_names = []
        with compressed.open("rb") as src:
            idx = 0
            while True:
                chunk = src.read(CHUNK_BYTES)
                if not chunk:
                    break
                name = f"state.sqlite3.zst.part{idx:03d}"
                (upload / name).write_bytes(chunk)
                part_names.append(name)
                idx += 1

        state = {
            "schema": 1,
            "reason": reason,
            "saved_utc": datetime.utcnow().isoformat(timespec="seconds") + "Z",
            "database_bytes": snapshot.stat().st_size,
            "compressed_bytes": compressed.stat().st_size,
            "parts": part_names,
            "start_month": START_MONTH,
            "max_months": MAX_MONTHS,
            "seed": SEED,
        }
        (upload / "checkpoint.json").write_text(json.dumps(state, indent=2), encoding="utf-8")

        git_url = f"https://x-access-token:{token}@github.com/{repo}.git"
        run(["git", "init", "-b", "snapshot"], cwd=upload)
        run(["git", "config", "user.name", "github-actions[bot]"], cwd=upload)
        run(["git", "config", "user.email", "41898282+github-actions[bot]@users.noreply.github.com"], cwd=upload)
        run(["git", "remote", "add", "origin", git_url], cwd=upload)
        run(["git", "add", "checkpoint.json"] + part_names, cwd=upload)
        run(["git", "commit", "-m", f"Checkpoint: {reason}"], cwd=upload)
        run(["git", "push", "--force", "origin", f"HEAD:refs/heads/{CHECKPOINT_BRANCH}"], cwd=upload)
        log(f"Checkpoint pushed to {CHECKPOINT_BRANCH}: {reason}")
    except subprocess.CalledProcessError as exc:
        stderr = getattr(exc, "stderr", None)
        log(f"WARNING: checkpoint push failed: {stderr or exc}")
        raise
    finally:
        snapshot.unlink(missing_ok=True)
        shutil.rmtree(upload, ignore_errors=True)


def init_db() -> sqlite3.Connection:
    WORK_DIR.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(DB_PATH)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA temp_store=FILE")
    conn.execute("PRAGMA cache_size=-50000")
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS seen_fen (
            position_key TEXT PRIMARY KEY
        );
        CREATE TABLE IF NOT EXISTS pools (
            rating_bucket INTEGER NOT NULL,
            control TEXT NOT NULL,
            position_key TEXT NOT NULL,
            fen TEXT NOT NULL,
            PRIMARY KEY (rating_bucket, control, position_key)
        );
        CREATE INDEX IF NOT EXISTS idx_pools_bucket_control
            ON pools(rating_bucket, control);
        CREATE TABLE IF NOT EXISTS completed (
            rating_bucket INTEGER PRIMARY KEY,
            completed_at TEXT NOT NULL
        );
    """)
    conn.commit()

    global POOL_COUNTS, COMPLETED_BUCKETS
    POOL_COUNTS = {
        (int(bucket), control): int(count)
        for bucket, control, count in conn.execute(
            "SELECT rating_bucket, control, COUNT(*) FROM pools GROUP BY rating_bucket, control"
        )
    }
    COMPLETED_BUCKETS = {
        int(row[0]) for row in conn.execute("SELECT rating_bucket FROM completed")
    }
    return conn


def get_meta_int(conn, key, default=0):
    row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return int(row[0]) if row else default


def set_meta(conn, key, value):
    conn.execute(
        "INSERT INTO meta(key,value) VALUES(?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, str(value)),
    )


def month_sequence(start: str, count: int):
    year, month = map(int, start.split("-"))
    for _ in range(count):
        yield f"{year:04d}-{month:02d}"
        month -= 1
        if month == 0:
            year -= 1
            month = 12


def month_url(month: str) -> str:
    return f"https://database.lichess.org/standard/lichess_db_standard_rated_{month}.pgn.zst"


def rating_bucket(avg_rating: float):
    if avg_rating < 500 or avg_rating > 2000:
        return None
    if avg_rating == 2000:
        return 1990
    return int(avg_rating // 10) * 10


def classify_control(headers):
    event = headers.get("Event", "").lower()
    if "ultra" in event or "classical" in event:
        return None
    for name in CONTROL_ORDER:
        if name in event:
            return name

    tc = headers.get("TimeControl", "")
    match = re.fullmatch(r"(\d+)\+(\d+)", tc.strip())
    if not match:
        return None
    base, inc = map(int, match.groups())
    estimated = base + 40 * inc
    if estimated < 180:
        return "bullet"
    if estimated < 480:
        return "blitz"
    if estimated < 1500:
        return "rapid"
    return None


def non_pawn_material(board: chess.Board) -> int:
    values = {
        chess.QUEEN: 9, chess.ROOK: 5,
        chess.BISHOP: 3, chess.KNIGHT: 3,
    }
    total = 0
    for piece_type, value in values.items():
        total += len(board.pieces(piece_type, chess.WHITE)) * value
        total += len(board.pieces(piece_type, chess.BLACK)) * value
    return total


def position_key(fen: str) -> str:
    # Ignore move counters so the same chess position cannot enter twice.
    canonical = " ".join(fen.split()[:4])
    return hashlib.sha256(canonical.encode("ascii")).hexdigest()


def pool_count(conn, bucket, control):
    return POOL_COUNTS.get((bucket, control), 0)


def bucket_complete(conn, bucket):
    if bucket in COMPLETED_BUCKETS:
        return True
    return all(pool_count(conn, bucket, c) >= POOL_TARGETS[c] for c in CONTROL_ORDER)


def all_complete(conn):
    return len(COMPLETED_BUCKETS) >= 150 or all(
        bucket_complete(conn, b) for b in range(500, 2000, 10)
    )


def insert_position(conn, bucket, control, fen):
    if pool_count(conn, bucket, control) >= POOL_TARGETS[control]:
        return False
    key = position_key(fen)
    try:
        conn.execute("INSERT INTO seen_fen(position_key) VALUES(?)", (key,))
    except sqlite3.IntegrityError:
        return False
    conn.execute(
        "INSERT INTO pools(rating_bucket,control,position_key,fen) VALUES(?,?,?,?)",
        (bucket, control, key, fen),
    )
    POOL_COUNTS[(bucket, control)] = pool_count(conn, bucket, control) + 1
    return True


def finalize_bucket(conn, bucket):
    if conn.execute("SELECT 1 FROM completed WHERE rating_bucket=?", (bucket,)).fetchone():
        return
    if not bucket_complete(conn, bucket):
        return

    rng = random.Random(SEED + bucket)
    positions = []
    for control in CONTROL_ORDER:
        rows = conn.execute(
            "SELECT fen FROM pools WHERE rating_bucket=? AND control=?",
            (bucket, control),
        ).fetchall()
        candidates = [r[0] for r in rows]
        chosen = rng.sample(candidates, FINAL_TARGETS[control])
        positions.extend(chosen)

    rng.shuffle(positions)
    data = {
        "rating_range": f"{bucket}-{bucket + 10}",
        "dataset_id": f"{rng.randrange(10**7, 10**8):08d}",
        "positions": [
            {"index": i + 1, "fen": fen, "ca": [], "s8": "", "s2": ""}
            for i, fen in enumerate(positions)
        ],
    }
    folder = OUT_DIR / f"{(bucket // 100) * 100}to{(bucket // 100) * 100 + 100}"
    folder.mkdir(parents=True, exist_ok=True)
    target = folder / f"{bucket}to{bucket + 10}.json"
    temp = target.with_suffix(".json.tmp")
    temp.write_text(json.dumps(data, separators=(",", ":")), encoding="utf-8")
    temp.replace(target)
    conn.execute(
        "INSERT OR REPLACE INTO completed(rating_bucket,completed_at) VALUES(?,?)",
        (bucket, datetime.utcnow().isoformat(timespec="seconds") + "Z"),
    )
    COMPLETED_BUCKETS.add(bucket)
    conn.commit()
    log(f"Completed rating bucket {bucket}-{bucket+10}: 10,000 final FENs.")
    notify(f"✅ Dataset bucket complete: {bucket}-{bucket+10} (10,000 FENs)")


def process_month(conn, month):
    global stop_requested
    url = month_url(month)
    saved_games = get_meta_int(conn, f"games:{month}", 0)
    done = get_meta_int(conn, f"month_done:{month}", 0)
    if done:
        log(f"{month} already marked complete; skipping.")
        return

    log(f"Streaming {month}: {url}")
    notify(f"▶️ Dataset build: processing Lichess {month}")
    last_checkpoint = time.time()
    games_seen = 0
    games_added = 0
    response = requests.get(url, stream=True, timeout=(30, 180))
    response.raise_for_status()
    response.raw.decode_content = False
    reader = zstd.ZstdDecompressor().stream_reader(response.raw)
    text_stream = io.TextIOWrapper(reader, encoding="utf-8", errors="replace", newline="")

    try:
        while True:
            game = chess.pgn.read_game(text_stream)
            if game is None:
                break
            games_seen += 1

            # Sequential zstd has no cheap arbitrary seek. Replay PGN headers to
            # the last saved game, but do not regenerate positions for those games.
            if games_seen <= saved_games:
                continue

            headers = game.headers
            try:
                white = int(headers.get("WhiteElo", "0"))
                black = int(headers.get("BlackElo", "0"))
            except (TypeError, ValueError):
                continue
            avg = (white + black) / 2
            bucket = rating_bucket(avg)
            if bucket is None or bucket_complete(conn, bucket):
                continue
            control = classify_control(headers)
            if control is None or pool_count(conn, bucket, control) >= POOL_TARGETS[control]:
                continue

            board = game.board()
            ply = 0
            for move in game.mainline_moves():
                board.push(move)
                ply += 1
                if ply <= 10:
                    continue
                if non_pawn_material(board) <= 10:
                    continue
                fen = board.fen(en_passant="legal")
                try:
                    checked = chess.Board(fen)
                    if not checked.is_valid():
                        continue
                except ValueError:
                    continue
                if insert_position(conn, bucket, control, fen):
                    games_added += 1
                    if bucket_complete(conn, bucket):
                        finalize_bucket(conn, bucket)

            if games_seen % GAMES_PER_PROGRESS == 0:
                conn.commit()
                set_meta(conn, f"games:{month}", games_seen)
                conn.commit()
                log(
                    f"{month}: {games_seen:,} games read; "
                    f"{games_added:,} new candidates inserted."
                )
                if games_seen % (GAMES_PER_PROGRESS * 5) == 0:
                    notify(f"📊 {month}: {games_seen:,} games scanned; {games_added:,} candidates added.")

            if time.time() - last_checkpoint >= CHECKPOINT_SECONDS:
                set_meta(conn, f"games:{month}", games_seen)
                conn.commit()
                save_checkpoint(conn, f"{month} after {games_seen} games")
                last_checkpoint = time.time()

            if stop_requested:
                set_meta(conn, f"games:{month}", games_seen)
                conn.commit()
                save_checkpoint(conn, f"graceful stop at {month}, game {games_seen}")
                log("Stop requested; checkpoint saved.")
                return

            if all_complete(conn):
                break

    finally:
        try:
            text_stream.close()
        except Exception:
            pass
        response.close()

    set_meta(conn, f"games:{month}", games_seen)
    set_meta(conn, f"month_done:{month}", 1)
    conn.commit()
    log(f"Finished {month}: {games_seen:,} games read in this pass; {games_added:,} new candidates.")
    save_checkpoint(conn, f"finished month {month}")
    notify(f"🏁 Finished scanning Lichess {month}.")


def write_status(conn):
    summary = {}
    for bucket in range(500, 2000, 10):
        if bucket_complete(conn, bucket):
            state = "complete"
        else:
            state = {
                c: pool_count(conn, bucket, c)
                for c in CONTROL_ORDER
            }
        summary[f"{bucket}-{bucket+10}"] = state
    status = {
        "updated_utc": datetime.utcnow().isoformat(timespec="seconds") + "Z",
        "complete_buckets": conn.execute("SELECT COUNT(*) FROM completed").fetchone()[0],
        "target_buckets": 150,
        "months": {
            key.split(":", 1)[1]: int(value)
            for key, value in conn.execute("SELECT key,value FROM meta WHERE key LIKE 'month_done:%'")
        },
        "buckets": summary,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "status.json").write_text(json.dumps(status, indent=2), encoding="utf-8")


def signal_handler(signum, frame):
    global stop_requested
    stop_requested = True
    log(f"Received signal {signum}; will checkpoint after current game.")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--fresh", action="store_true", help="Ignore any restored checkpoint and start from zero.")
    args = parser.parse_args()

    signal.signal(signal.SIGTERM, signal_handler)
    signal.signal(signal.SIGINT, signal_handler)

    if args.fresh and DB_PATH.exists():
        DB_PATH.unlink()
        for suffix in ("-wal", "-shm"):
            Path(str(DB_PATH) + suffix).unlink(missing_ok=True)

    restore_checkpoint()
    conn = init_db()

    notify("🚀 Lichess FEN dataset builder started.")
    log("Target: 150 rating buckets × 10,000 final FENs = 1,500,000 positions.")
    log("Candidate pools per bucket: Bullet 4,000; Rapid 7,000; Blitz 9,000.")
    log("Global deduplication is applied before a candidate enters a pool.")

    for month in month_sequence(START_MONTH, MAX_MONTHS):
        if all_complete(conn):
            break
        process_month(conn, month)
        if stop_requested:
            break

    for bucket in range(500, 2000, 10):
        finalize_bucket(conn, bucket)
    write_status(conn)
    conn.commit()

    completed = conn.execute("SELECT COUNT(*) FROM completed").fetchone()[0]
    log(f"Run ended. Completed buckets: {completed}/150.")
    if completed == 150:
        notify("🎉 All 1,500,000 FEN positions are ready. Packaging dataset.zip.")
    else:
        notify(f"⏸️ Build paused/insufficient data: {completed}/150 buckets complete. Re-run to resume.")
    save_checkpoint(conn, "end of workflow run")
    conn.close()


if __name__ == "__main__":
    main()
