# Stage2DS workflow setup

This workflow is intended for the `devyash-cb/chess-review-app` repository.

## What changed

- Drive downloads are stored in the repository-root folder `stage2dstempstorage/`.
- The workflow restores that folder from the rolling GitHub Release asset `stage2dstempstorage.zip` before each `start` run.
- Each of the 125 JSON files is downloaded separately. A file is skipped only if it parses as JSON and contains exactly 10,000 positions.
- If a file is incomplete, it is downloaded again. Partial `.part` downloads are retained for gdown's resume support.
- Three consecutive per-file download errors stop that download pass. The workflow still packages and uploads all successful downloads before ending as failed.
- Rerun the workflow with phase `start`. Previously completed files are validated and skipped; only missing/incomplete files are downloaded.
- The folder `stage2dstempstorage/` is not deleted by the script. GitHub-hosted runners are temporary, so the Release asset is what preserves it between separate workflow runs.
- Once all 125 downloads are complete, the preflight job copies them into `stage2ds/` and runs the original validation, SQLite, Telegram, Chess API MultiPV and ZIP checks.
- The normal `stage2ds.zip` processing snapshot remains separate from `stage2dstempstorage.zip`.

## Required repository secrets

In GitHub: **Settings → Secrets and variables → Actions → New repository secret**.

1. `TELEGRAM_BOT_TOKEN` — the token from BotFather.
2. `TELEGRAM_CHAT_ID` — the chat ID where notifications should be delivered. Start the bot and send it `/start` before running preflight.

The workflow uses the automatic `GITHUB_TOKEN`; it needs `contents: write` to update Release assets and `actions: write` to dispatch the next run. These permissions are declared in the workflow.

## Start and resume downloads

Open **Actions → Stage2DS Processor → Run workflow** and select `start`.

If Drive returns three consecutive download errors:
1. Let the run finish its cache-upload step.
2. Run the workflow again with phase `start`.
3. It restores `stage2dstempstorage.zip`, skips already-complete files and tries the missing files again.

Do not delete the `stage2dstempstorage.zip` Release asset if you want to retain the download progress. Do not run two starts simultaneously.

Once all downloads and preflight checks pass, processing starts automatically. The processing workflow continues itself automatically. If automatic continuation fails, manually run:
- `continue` to resume normal processing from the latest processing snapshot.
- `retry` only if you intentionally need to resume the final one-time retry phase.

## Telegram `/ping`

Send `/ping` or `/status` to the configured bot while any active Stage2DS job is running. A background poller is started in the download, preflight, processing and final-retry jobs, so the command is not limited to the position-processing stage.

During Drive download it reports the file being downloaded, completed-file count and consecutive-error count. During processing it reports the current file, position, progress, batch and recent results/errors.

The bot cannot respond between workflow runs because GitHub Actions runners are temporary and no polling process is active then.

## Output

Download `stage2ds.zip` from the repository's **Releases → Stage2DS latest complete folder** release. It contains the processing dataset, progress database, preflight sample and error logs.

The same Release also contains `stage2dstempstorage.zip`, the persistent source-download cache. Keep this asset if you may need to rerun the download/preflight phase.

Never put Telegram tokens in the repository or either ZIP. If the repository is public, Release assets are public too.

## MultiPV safeguard

The preflight requires five distinct, ranked MultiPV candidate messages. It does not mistake the first five plies of one principal variation for five alternative root moves. If the API does not expose five ranked candidates, preflight stops before the 1.25-million-position analysis begins.
