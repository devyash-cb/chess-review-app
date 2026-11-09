# Stage2DS workflow setup

This workflow is designed for `devyash-cb/lichess-puzzle-extractor`.

## What it does

- The first `start` run downloads the public Drive folder and checks all 125 JSON files (10,000 positions each).
- A preflight job tests Google Drive access, JSON structure, SQLite read/write, Telegram message/document delivery, Chess-API WebSocket MultiPV output, ZIP creation, and GitHub Release upload.
- Processing is strictly sequential. It requests `variants=5`, `depth=18`, and `maxThinkingTime=100`, waits at least 100 ms after each response, uses random batches of 60–80 positions, and pauses 10–40 seconds between batches.
- Each processing run stops after its safe time budget (320 minutes) and dispatches the next workflow run. The GitHub job timeout is 350 minutes, leaving a safety margin below the six-hour limit.
- Full `stage2ds.zip` snapshots are uploaded to the single rolling Release asset `stage2ds-latest`. This avoids accumulating dozens of duplicate full-folder artifacts. The latest ZIP always contains the complete `stage2ds/` folder.
- `stage2ds/progress.sqlite` stores per-file checkpoints, errors, runtime status, Telegram polling offset, and the last three successful analyses.
- `stage2ds/errorlogs/<filename>.txt` records `Fen`, `index`, `error`, and status. The log is sent to Telegram when a file finishes and is updated after final retries.
- Once all files are processed, a final retry phase attempts each failed position at most once.

## Required repository secrets

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

1. `TELEGRAM_BOT_TOKEN` — the token from BotFather.
2. `TELEGRAM_CHAT_ID` — the chat ID where notifications should be delivered. Start the bot and send it `/start` before running preflight.

The workflow uses the automatic `GITHUB_TOKEN`; it needs `contents: write` to update the Release asset and `actions: write` to dispatch the next run. These permissions are declared in the workflow.

## Start

Open **Actions → Stage2DS Processor → Run workflow** and select `start`.

Do not start a second `start` run while one is already running. The pipeline continues itself automatically.

If automatic continuation fails, manually run the same workflow with:

- `continue` to resume normal processing from the latest snapshot.
- `retry` to resume the one-time final retry phase.

## Telegram `/ping`

Send `/ping` to the configured bot. It reports the current file, current position, file progress, processing/break status, batch length, time until the next batch, the last three errors, and the last three analysed positions with their five moves.

The bot is polled by the active GitHub runner. It will not respond while no workflow run is active.

## Output and privacy

Download `stage2ds.zip` from the repository's **Releases → Stage2DS latest complete folder** release. It contains:

```text
stage2ds/
├── progress.sqlite
├── *.json
├── preflight_api_sample.json
└── errorlogs/
    └── *.txt
```

The repository is public, so the rolling Release asset and its dataset contents are public too. Never put Telegram tokens in the repository or in the ZIP.

## Important MultiPV safeguard

The official Chess-API documentation says `variants` can be set up to 5, but its documented `continuationArr` is a sequence of moves in one principal variation, not five alternative first moves. The preflight therefore requires five distinct, ranked MultiPV candidate messages. If the API does not expose five ranked candidates through its WebSocket response, preflight stops and does not begin the 1.25-million-position run. It deliberately does not mistake the first five plies of one line for five best moves.

`ca` is stored as an array of five UCI move strings in rank order. Existing `s8` and `s2` fields are left unchanged.
