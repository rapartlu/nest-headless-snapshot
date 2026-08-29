#!/usr/bin/env python3
"""Train the tiny understairs-door classifier for the nest_headless add-on.

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
SUBCROP = (0.0, 0.0, 1.0, 0.90)


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


def build_set(dirpath, aug_to, refz):
    files = sorted(Path(dirpath).glob("*.jpg")) + sorted(Path(dirpath).glob("*.jpeg"))
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
    args = ap.parse_args()

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

    # class-balanced logistic regression, full-batch gradient descent
    w = np.zeros(Xtr.shape[1])
    b = 0.0
    pos_w = len(ytr) / (2 * max(1, ytr.sum()))
    neg_w = len(ytr) / (2 * max(1, (1 - ytr).sum()))
    sw = np.where(ytr == 1, pos_w, neg_w)
    lr = 0.5
    for _ in range(args.epochs):
        p = 1 / (1 + np.exp(-np.clip(Xtr @ w + b, -30, 30)))
        g = (sw * (p - ytr))
        w -= lr * (Xtr.T @ g / len(ytr) + args.l2 * w)
        b -= lr * g.mean()

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
    }
    Path(args.out).write_text(json.dumps(model))
    print(f"wrote {args.out} ({Path(args.out).stat().st_size // 1024} KB)")


if __name__ == "__main__":
    main()
