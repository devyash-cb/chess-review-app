#!/usr/bin/env python3
from pathlib import Path
import zipfile

ROOT = Path(__file__).resolve().parents[1]
DATASET = ROOT / "dataset"
ZIP_PATH = DATASET / "dataset.zip"

def main():
    if not DATASET.exists():
        raise SystemExit("dataset/ does not exist.")
    json_files = sorted(DATASET.glob("*to*/*.json"))
    if not json_files:
        raise SystemExit("No rating-bucket JSON files found.")
    with zipfile.ZipFile(ZIP_PATH, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=6) as zf:
        for path in json_files:
            zf.write(path, path.relative_to(DATASET))
        status = DATASET / "status.json"
        if status.exists():
            zf.write(status, "status.json")
    print(f"Created {ZIP_PATH} ({ZIP_PATH.stat().st_size / (1024**2):.1f} MiB)")

if __name__ == "__main__":
    main()
