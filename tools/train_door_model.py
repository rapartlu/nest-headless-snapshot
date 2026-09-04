#!/usr/bin/env python3
"""Train the tiny door-state classifier for the nest_headless add-on.

Input: two directories of door-zone crop JPEGs (as archived by the add-on's
samples_dir option):
    --pos  crops with the cupboard door OPEN/ajar
    --neg  crops with it CLOSED

Model: logistic regression over a 64x96 grayscale resize — a learned template
matcher. Trained with augmentation (brightness/contrast/gamma/noise/shift) so
it tolerates lighting drift; retrain any time with more samples (night/IR
frames especially) by re-running this script — the add-on hot-reloads the
JSON on mtime change, no rebuild needed.

Output: nest_models/<camera>.json to copy to /config/nest_models/ on the NAS.

Usage:
    python3 train_door_model.py \
        --pos samples/open --neg samples/closed \
        --out downstairs_hallway_camera.json --label door_open
"""

import argparse, json, sys
from datetime import date
from pathlib import Path

import numpy as np

try:
    from PIL import Image
except ImportError:
    sys.exit("needs Pillow: pip3 install Pillow")

W, H = 80, 120
RNG = np.random.default_rng(42)
# Model's view within the archived crop (relative x0,y0,x1,y1): biased away
# from the kitchen doorway at the left of the crop, whose own door — when
# half-closed — otherwise mimics the cupboard's ajar edge (the 12:40/12:50Z
# false positives on 2026-08-28).
SUBCROP = (0.0, 0.0, 1.0, 0.90)   # the cupboard default; --subcrop 0,0,1,1 for a whole zone crop


def load_gray(path):
    img = Image.open(path).convert("L")
    x0, y0, x1, y1 = SUBCROP
    img = img.crop((int(x0 * img.width), int(y0 * img.height),
                    int(x1 * img.width), int(y1 * img.height)))
    img = img.resize((W, H), Image.BILINEAR)
    return np.asarray(img, dtype=np.float64) / 255.0


def augment(img, n):
    """Yield n augmented variants of a HxW [0,1] grayscale image."""
    out = []
    for _ in range(n):
        a = img.copy()
        # modest registration tolerance (+-2px, 3% scale). Bigger invariance
        # was tried on 2026-08-29 after the camera got nudged and it wrecked
        # the linear template (open min fell to 0.0): this model is pinned to
        # one camera position by design - a real bump needs fresh samples and
        # a retrain, not augmentation.
        sc = RNG.uniform(0.97, 1.03)
        if abs(sc - 1.0) > 0.005:
            from PIL import Image as _I
            hh, ww = a.shape
            im = _I.fromarray((a * 255).astype("uint8"))
            nw, nh = max(2, int(ww * sc)), max(2, int(hh * sc))
            im = im.resize((nw, nh), _I.BILINEAR)
            if sc >= 1.0:
                l, t = (nw - ww) // 2, (nh - hh) // 2
                im = im.crop((l, t, l + ww, t + hh))
            else:
                canvas = _I.new("L", (ww, hh), int(a.mean() * 255))
                canvas.paste(im, ((ww - nw) // 2, (hh - nh) // 2))
                im = canvas
            a = np.asarray(im, dtype=np.float64) / 255.0
        dx, dy = RNG.integers(-2, 3), RNG.integers(-2, 3)
        a = np.roll(a, (dy, dx), axis=(0, 1))
        # brightness / contrast / gamma
        a = np.clip((a - 0.5) * RNG.uniform(0.7, 1.3) + 0.5 + RNG.uniform(-0.15, 0.15), 0, 1)
        a = np.power(a, RNG.uniform(0.7, 1.4))
        # sensor noise
        a = np.clip(a + RNG.normal(0, RNG.uniform(0.005, 0.03), a.shape), 0, 1)
        out.append(a)
    return out


def standardize(img):
    return (img - img.mean()) / (img.std() + 1e-6)


EXCLUDE = set()   # basenames to skip (labelled both ways, or known bad)


def jpegs(dirpath):
    return [f for f in sorted(Path(dirpath).glob("*.jpg")) + sorted(Path(dirpath).glob("*.jpeg")) if f.name not in EXCLUDE]


def load_model_json(path):
    """A saved model, ready for score_files()."""
    m = json.loads(Path(path).read_text())
    return (m, np.array(m["reference"]).reshape(m["height"], m["width"]),
            np.array(m["mean"]), np.array(m["std"]), np.array(m["weights"]), float(m["bias"]))


def score_files(M, files):
    """Score frames with a saved model exactly as the add-on does: per-image
    standardise, subtract the reference, normalise, logistic. Used to compare a
    model already in place against a fresh one on the same unseen frames (#22)."""
    m, refz, mean, std, w, b = M
    global SUBCROP
    keep, SUBCROP = SUBCROP, tuple(m["subcrop"])
    try:
        out = []
        for f in files:
            z = standardize(load_gray(f))
            x = ((z - refz).ravel() - mean) / std
            out.append(float(1 / (1 + np.exp(-np.clip(x @ w + b, -30, 30)))))
    finally:
        SUBCROP = keep
    return out


def balanced(pairs):
    """(open recall, closed recall, balanced) from [(cls, p), ...]."""
    po = [p for c, p in pairs if c == 1]
    pc = [p for c, p in pairs if c == 0]
    o = sum(1 for p in po if p >= 0.5) / max(1, len(po))
    c = sum(1 for p in pc if p < 0.5) / max(1, len(pc))
    return o, c, (o + c) / 2


def fit(Xz, y, epochs, l2):
    """Class-balanced logistic regression, full-batch gradient descent."""
    w = np.zeros(Xz.shape[1])
    b = 0.0
    pos_w = len(y) / (2 * max(1, y.sum()))
    neg_w = len(y) / (2 * max(1, (1 - y).sum()))
    sw = np.where(y == 1, pos_w, neg_w)
    lr = 0.5
    for _ in range(epochs):
        p = 1 / (1 + np.exp(-np.clip(Xz @ w + b, -30, 30)))
        g = (sw * (p - y))
        w -= lr * (Xz.T @ g / len(y) + l2 * w)
        b -= lr * g.mean()
    return w, b


def build_set(dirpath, aug_to, refz):
    files = dirpath if isinstance(dirpath, list) else jpegs(dirpath)
    if not files:
        sys.exit(f"no jpegs in {dirpath}")
    base = [load_gray(f) for f in files]
    per = max(1, int(np.ceil(aug_to / len(base))))
    imgs = []
    for b in base:
        imgs.append(b)
        imgs.extend(augment(b, per))
    # feature = per-image-standardized frame minus the standardized reference
    # closed scene: the residual LOCATION carries the signal, robust to lighting
    return np.stack([(standardize(i) - refz).ravel() for i in imgs]), len(files)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pos", required=True)
    ap.add_argument("--neg", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--label", default="door_open")
    ap.add_argument("--aug", type=int, default=400, help="augmented set size per class")
    ap.add_argument("--epochs", type=int, default=300)
    ap.add_argument("--l2", type=float, default=1e-3)
    ap.add_argument("--ref-dir", default=None,
                    help="dir whose median forms the closed-scene reference "
                         "(default: --neg). Pin this to ONE lighting regime - "
                         "mixing day+evening frames into the median shifts the "
                         "reference and broke real-frame accuracy on 2026-08-29.")
    ap.add_argument("--subcrop", default=None,
                    help="x0,y0,x1,y1 view within the crop (default 0,0,1,0.9 for the "
                         "cupboard; use 0,0,1,1 for a whole zone crop)")
    ap.add_argument("--loo-out", default=None, help="write the per-frame leave-one-out results as JSON")
    ap.add_argument("--loo", action="store_true",
                    help="leave-one-out check over the ORIGINAL images (the holdout split "
                         "above sees augmented copies of the same frames, so it flatters)")
    ap.add_argument("--exclude", default="", help="comma-separated basenames to skip")
    args = ap.parse_args()
    global SUBCROP
    EXCLUDE.update(n for n in args.exclude.split(",") if n)
    if args.subcrop:
        SUBCROP = tuple(float(v) for v in args.subcrop.split(","))
        if len(SUBCROP) != 4:
            sys.exit("--subcrop needs x0,y0,x1,y1")

    ref_dir = args.ref_dir or args.neg
    ref_files = sorted(Path(ref_dir).glob("*.jpg")) + sorted(Path(ref_dir).glob("*.jpeg"))
    if not ref_files:
        sys.exit(f"no jpegs in ref dir {ref_dir}")
    refz = np.median(np.stack([standardize(load_gray(f)) for f in ref_files]), axis=0)
    Xp, npos = build_set(args.pos, args.aug, refz)
    Xn, nneg = build_set(args.neg, args.aug, refz)
    X = np.vstack([Xp, Xn])
    y = np.concatenate([np.ones(len(Xp)), np.zeros(len(Xn))])

    # normalise
    mean, std = X.mean(axis=0), X.std(axis=0) + 1e-6
    Xz = (X - mean) / std

    # held-out split (stratified by class, 20%)
    idx = RNG.permutation(len(Xz))
    Xz, y = Xz[idx], y[idx]
    ntest = max(2, len(Xz) // 5)
    Xtr, ytr, Xte, yte = Xz[ntest:], y[ntest:], Xz[:ntest], y[:ntest]

    w, b = fit(Xtr, ytr, args.epochs, args.l2)

    # Leave-one-out over the ORIGINAL frames: each is scored by a model that
    # never saw it or its augmentations. The honest number with few samples.
    loo_acc = None
    if args.loo:
        pos_files, neg_files = jpegs(args.pos), jpegs(args.neg)
        results = []
        for cls, files, others in ((1, pos_files, neg_files), (0, neg_files, pos_files)):
            for i, f in enumerate(files):
                keep = files[:i] + files[i + 1:]
                if not keep or not others:
                    continue
                Xa, _ = build_set(keep, max(20, args.aug // 2), refz)
                Xb, _ = build_set(others, max(20, args.aug // 2), refz)
                Xl = np.vstack([Xa, Xb])
                yl = np.concatenate([np.full(len(Xa), float(cls)), np.full(len(Xb), float(1 - cls))])
                m_, s_ = Xl.mean(axis=0), Xl.std(axis=0) + 1e-6
                w_, b_ = fit((Xl - m_) / s_, yl, max(100, args.epochs // 2), args.l2)
                x = ((standardize(load_gray(f)) - refz).ravel() - m_) / s_
                p = 1 / (1 + np.exp(-np.clip(x @ w_ + b_, -30, 30)))
                results.append((cls, float(p), f.name))
        ok = sum(1 for c, p, _ in results if (p >= 0.5) == (c == 1))
        loo_acc = ok / max(1, len(results))
        # With one open frame per fifteen closed, plain accuracy flatters a
        # model that always answers "closed" (#22): report each class's recall
        # and their mean, which is what the zone's usefulness rests on.
        po = [p for c, p, _ in results if c == 1]
        pc = [p for c, p, _ in results if c == 0]
        loo_open = sum(1 for p in po if p >= 0.5) / max(1, len(po))
        loo_closed = sum(1 for p in pc if p < 0.5) / max(1, len(pc))
        loo_bal = (loo_open + loo_closed) / 2
        print(f"leave-one-out over {len(results)} originals: acc {loo_acc:.3f} "
              f"(open recall {loo_open:.3f} on {len(po)}, closed recall {loo_closed:.3f} on {len(pc)}, balanced {loo_bal:.3f})")
        for c, p, n in results:
            print(f"  {'open  ' if c else 'closed'} {p:.2f} {n}{'' if (p >= 0.5) == (c == 1) else '   <-- wrong'}")
        if args.loo_out:
            Path(args.loo_out).write_text(json.dumps([{"name": n, "cls": c, "p": p} for c, p, n in results]))

    def acc(Xs, ys):
        p = 1 / (1 + np.exp(-np.clip(Xs @ w + b, -30, 30)))
        return ((p >= 0.5) == ys).mean(), p

    tr_acc, _ = acc(Xtr, ytr)
    te_acc, pte = acc(Xte, yte)
    pos_scores = pte[yte == 1]
    neg_scores = pte[yte == 0]
    print(f"train acc {tr_acc:.3f} | holdout acc {te_acc:.3f} "
          f"({int(yte.sum())} pos / {int((1-yte).sum())} neg)")
    if len(pos_scores) and len(neg_scores):
        print(f"holdout score ranges: open {pos_scores.min():.2f}-{pos_scores.max():.2f}, "
              f"closed {neg_scores.min():.2f}-{neg_scores.max():.2f}")

    model = {
        "label": args.label, "width": W, "height": H, "subcrop": list(SUBCROP),
        "reference": [round(float(v), 4) for v in refz.ravel()], "per_image_norm": True,
        "mean": [round(v, 5) for v in mean], "std": [round(v, 5) for v in std],
        "weights": [round(v, 5) for v in w], "bias": round(float(b), 5),
        "threshold": 0.5, "trained": str(date.today()),
        "samples": {"pos": npos, "neg": nneg},
        "holdout_acc": round(float(te_acc), 4),
        "loo_acc": None if loo_acc is None else round(float(loo_acc), 4),
        "loo_open_recall": None if loo_acc is None else round(float(loo_open), 4),
        "loo_closed_recall": None if loo_acc is None else round(float(loo_closed), 4),
        "loo_balanced": None if loo_acc is None else round(float(loo_bal), 4),
    }
    Path(args.out).write_text(json.dumps(model))
    print(f"wrote {args.out} ({Path(args.out).stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
