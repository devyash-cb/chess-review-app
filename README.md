# Lichess FEN Dataset Builder

This repository workflow streams Lichess monthly rated standard PGN archives,
collects globally unique chess positions, fills candidate pools, randomly
selects the final positions, and writes rating-bucket JSON files.

## Dataset target

- Rating average: 500 through 2000.
- Bucket width: 10 rating points; 150 buckets.
- Final output per bucket: 10,000 FENs.
- Total target: 1,500,000 FENs.
- Candidate pools per bucket: Bullet 4,000; Rapid 7,000; Blitz 9,000.
- Final selection per bucket: Bullet 2,000; Rapid 3,500; Blitz 4,500.
- First 10 plies are ignored.
- Positions with non-pawn, non-king material value <= 10 are ignored.
- The same board position (first four FEN fields) is globally unique.

## Files

- `scripts/build_dataset.py`: streaming collector, SQLite pools, checkpointing.
- `scripts/package_dataset.py`: creates `dataset/dataset.zip`.
- `.github/workflows/build-dataset.yml`: manual and daily scheduled workflow.

## One-time GitHub setup

1. Open repository **Settings → Actions → General**.
2. Under Workflow permissions, enable **Read and write permissions**.
3. Save.
4. Open **Settings → Secrets and variables → Actions → New repository secret**.
5. Add:
   - `TELEGRAM_BOT_TOKEN` = token from BotFather.
   - `TELEGRAM_CHAT_ID` = your Telegram chat ID.
6. Do not put either secret in code or commit it.

`GITHUB_TOKEN` is supplied automatically by GitHub Actions. The workflow uses
it to force-update a separate `dataset-checkpoints` branch with a compressed
SQLite snapshot. That branch is deliberately rewritten as a single snapshot
commit to avoid accumulating every large database version in git history.

## Run

1. Open **Actions**.
2. Select **Build Lichess FEN Dataset**.
3. Press **Run workflow**.
4. Leave `fresh` set to `false` for normal runs/resumes.

The workflow also runs daily at 01:17 UTC. Each run restores the latest
checkpoint, then continues scanning the current month and earlier months.

## Important resume detail

Lichess `.pgn.zst` files are streamed sequentially. A standard compressed
stream cannot jump directly to an arbitrary saved game number. On resume the
workflow decompresses and reads PGN games from the beginning of the current
month until it reaches the saved game count; it skips position generation for
those already-processed games. The SQLite candidate pools and global dedup
index are restored, so the dataset is not rebuilt from scratch.

A checkpoint is pushed approximately every 30 minutes and at month completion.
If a runner is forcibly terminated between checkpoints, work since the last
checkpoint may be replayed.

## Output

```text
dataset/
  dataset.zip
  status.json
  500to600/
    500to510.json
    ...
  600to700/
    ...
  ...
  1900to2000/
```

Each bucket JSON has:
- `rating_range`
- `dataset_id`
- `positions[]` with `index`, `fen`, `ca`, `s8`, `s2`

`ca`, `s8`, and `s2` are intentionally empty placeholders.

## Classification and sampling notes

The script first uses the Lichess PGN `Event` header when it contains Bullet,
Blitz, or Rapid. If that header is unavailable, it estimates category from
`TimeControl` using base time + 40 increments. The fallback thresholds are
under 180 seconds for Bullet, under 480 for Blitz, and under 1500 for Rapid.
Classical and ultraBullet are excluded.

A FEN's first occurrence wins: if the same board position is encountered
again later, it is rejected globally, even if the later game has a different
rating or time control. This makes uniqueness deterministic and prevents a
duplicate from consuming another pool slot. The first-seen policy can affect
which rating/time-control pool receives a position.

The final selection is deterministic for a given set of candidate pools and
seed (`DATASET_RANDOM_SEED`). Change the seed only if you intentionally want a
different sample.

## Honest limitations

- A GitHub-hosted job has a finite runtime. This workflow stops at the runner
  time limit and resumes on the next scheduled/manual run.
- The SQLite checkpoint can become large. It is compressed and split into
  sub-100-MiB files, but GitHub repository storage and Actions bandwidth still
  apply.
- The full 1.5-million-position build has not been run end-to-end in this
  template. Run it and inspect the first progress/checkpoint before relying on
  its final output.
- `dataset.zip` is generated from JSON files that exist at the time packaging
  runs; incomplete buckets are not represented as final 10,000-position files.
