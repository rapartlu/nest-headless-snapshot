#!/usr/bin/env python3
"""Retrain per-zone state models from labelled crops, on a schedule.

A brain (or a person) keeps labelled zone crops in
    <labels-root>/<camera>__<zone>/{open,closed}/<any>.jpg
(`pos`/`neg` also accepted). For every such directory this script trains the
linear template matcher (train_door_model.py, --subcrop 0,0,1,1) into
    <models-dir>/<camera>__<zone>.json
whenever the label counts have changed since the last run and each class has
at least --min images, and records what it did in
    <models-dir>/.<camera>__<zone>.trained.json
The add-on hot-loads the JSON on mtime change and starts posting
nest_headless_zone_state for that zone; an .onnx of the same name outranks it.

Usage (a nightly launchd/cron job):
    python3 retrain_zones.py --labels-root /path/to/training --models-dir /config/nest_models [--min 5] [--force]
"""

import argparse, json, subprocess, sys, time
from pathlib import Path

HERE = Path(__file__).resolve().parent


def count(d):
    return len(list(d.glob("*.jpg"))) + len(list(d.glob("*.jpeg")))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels-root", required=True)
    ap.add_argument("--models-dir", required=True)
    ap.add_argument("--min", type=int, default=5, help="minimum images per class")
    ap.add_argument("--force", action="store_true")
    ap.add_argument("--python", default=sys.executable)
    ap.add_argument("--l2", type=float, default=3e-2, help="ridge strength for the trainer (the cupboard model used 1e-3; zones with few samples do better softer)")
    args = ap.parse_args()
    root, models = Path(args.labels_root), Path(args.models_dir)
    if not root.is_dir():
        sys.exit(f"no labels root {root}")
    models.mkdir(parents=True, exist_ok=True)
    done = 0
    for d in sorted(p for p in root.iterdir() if p.is_dir() and "__" in p.name):
        if d.name.endswith("__cats"):
            continue   # cats are enrolled through /identity/cat, not trained here
        # three or more label folders: a multi-class model (open / vent / closed ...) via train_zone_model.py
        classes = sorted(p for p in d.iterdir() if p.is_dir() and not p.name.startswith("."))
        if len(classes) >= 3:
            counts = {p.name: count(p) for p in classes}
            stamp = models / f".{d.name}.trained.json"
            prev = {}
            try:
                prev = json.loads(stamp.read_text())
            except Exception:  # noqa: BLE001
                pass
            thin = {k: v for k, v in counts.items() if v < args.min}
            if thin:
                print(f"{d.name}: {counts} - waiting for at least {args.min} in {', '.join(thin)}")
                continue
            out = models / f"{d.name}.json"
            if not args.force and out.exists() and prev.get("counts") == counts:
                print(f"{d.name}: unchanged {counts}, trained {prev.get('trained')}")
                continue
            print(f"{d.name}: training {len(classes)} states {counts}")
            r = subprocess.run([args.python, str(HERE / "train_zone_model.py"), "--labels", str(d), "--out", str(out) + ".tmp",
                                "--min", str(args.min), "--loo", "--C", str(1 / max(args.l2, 1e-6) / 100)], capture_output=True, text=True)
            print(r.stdout.strip())
            if r.returncode != 0:
                print(r.stderr.strip())
                continue
            Path(str(out) + ".tmp").replace(out)
            try:
                m = json.loads(out.read_text())
            except Exception:  # noqa: BLE001
                m = {}
            stamp.write_text(json.dumps({"counts": counts, "labels": m.get("labels"), "trained": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                         "holdout_acc": m.get("holdout_acc"), "loo_acc": m.get("loo_acc")}))
            done += 1
            continue
        pos = d / "open" if (d / "open").is_dir() else d / "pos"
        neg = d / "closed" if (d / "closed").is_dir() else d / "neg"
        if not pos.is_dir() or not neg.is_dir():
            continue
        # a frame labelled both ways teaches nothing: skip it and say so
        names = lambda p: {f.name for f in list(p.glob("*.jpg")) + list(p.glob("*.jpeg"))}  # noqa: E731
        conflicts = sorted(names(pos) & names(neg))
        if conflicts:
            print(f"{d.name}: {len(conflicts)} file(s) labelled both open and closed, skipped: {', '.join(conflicts[:6])}")
        npos, nneg = count(pos) - len(conflicts), count(neg) - len(conflicts)
        stamp = models / f".{d.name}.trained.json"
        prev = {}
        try:
            prev = json.loads(stamp.read_text())
        except Exception:  # noqa: BLE001
            pass
        if npos < args.min or nneg < args.min:
            print(f"{d.name}: {npos} open / {nneg} closed - waiting for at least {args.min} each")
            continue
        out = models / f"{d.name}.json"
        if not args.force and out.exists() and prev.get("open") == npos and prev.get("closed") == nneg:
            print(f"{d.name}: unchanged ({npos}/{nneg}), trained {prev.get('trained')}")
            continue
        zone = d.name.split("__", 1)[1]
        cmd = [args.python, str(HERE / "train_door_model.py"), "--pos", str(pos), "--neg", str(neg),
               "--out", str(out) + ".tmp", "--label", zone, "--subcrop", "0,0,1,1", "--loo", "--l2", str(args.l2)]
        if conflicts:
            cmd += ["--exclude", ",".join(conflicts)]
        print(f"{d.name}: training on {npos} open / {nneg} closed")
        r = subprocess.run(cmd, capture_output=True, text=True)
        print(r.stdout.strip())
        if r.returncode != 0:
            print(r.stderr.strip())
            continue
        Path(str(out) + ".tmp").replace(out)
        try:
            m = json.loads(out.read_text())
        except Exception:  # noqa: BLE001
            m = {}
        stamp.write_text(json.dumps({"open": npos, "closed": nneg, "trained": time.strftime("%Y-%m-%dT%H:%M:%S"),
                                     "holdout_acc": m.get("holdout_acc"), "loo_acc": m.get("loo_acc")}))
        done += 1
    print(f"retrained {done} model(s)")


if __name__ == "__main__":
    main()
