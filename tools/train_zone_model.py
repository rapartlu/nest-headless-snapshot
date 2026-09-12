#!/usr/bin/env python3
"""Multi-class zone state model (nest_headless #26): the linear template
matcher of train_door_model.py, with one score per label instead of a
positive/negative pair.

Input: <labels>/<label>/*.jpg - crops of the zone (as the add-on cuts them),
one folder per state, e.g. open / vent / closed. Features are the same as
the binary trainer's: per-image standardised grey crop minus the reference
scene (the median of --ref-label, default "closed" when present, else the
largest class), with the same augmentation. Model: multinomial logistic
regression (scikit-learn) on standardised features. Output JSON is read by
app/classifier.js:
    {labels: [...], weights: [[...] per label], bias: [...], mean, std,
     reference, per_image_norm, subcrop, width, height, trained, samples,
     loo_acc, holdout_acc}

Usage:
    python3 train_zone_model.py --labels <dir> --out <config>/nest_models/<camera>__<zone>.json [--loo] [--min 5] [--C 0.5]
"""

import argparse, json, sys
from datetime import date
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import train_door_model as tdm  # noqa: E402


def features_for(files, aug_to, refz):
    base = [tdm.load_gray(f) for f in files]
    per = max(1, int(np.ceil(aug_to / max(1, len(base)))))
    imgs = []
    for b in base:
        imgs.append(b)
        imgs.extend(tdm.augment(b, per))
    return np.stack([(tdm.standardize(i) - refz).ravel() for i in imgs])


def fit(Xz, y, C):
    from sklearn.linear_model import LogisticRegression
    clf = LogisticRegression(C=C, max_iter=3000, class_weight="balanced")
    clf.fit(Xz, y)
    return clf


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--labels", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--min", type=int, default=5, help="minimum originals per label")
    ap.add_argument("--aug", type=int, default=300, help="augmented set size per label")
    ap.add_argument("--C", type=float, default=0.5, help="inverse ridge strength")
    ap.add_argument("--ref-label", default=None)
    ap.add_argument("--subcrop", default="0,0,1,1")
    ap.add_argument("--exclude", default="")
    ap.add_argument("--loo", action="store_true", help="leave-one-out over the original frames (slow but honest)")
    args = ap.parse_args()
    tdm.SUBCROP = tuple(float(v) for v in args.subcrop.split(","))
    tdm.EXCLUDE.update(n for n in args.exclude.split(",") if n)
    root = Path(args.labels)
    labels = sorted(p.name for p in root.iterdir() if p.is_dir() and not p.name.startswith("."))
    files = {lab: tdm.jpegs(root / lab) for lab in labels}
    labels = [lab for lab in labels if files[lab]]
    counts = {lab: len(files[lab]) for lab in labels}
    thin = [lab for lab in labels if counts[lab] < args.min]
    if len(labels) < 2 or thin:
        sys.exit(f"need at least {args.min} originals for every label; have {counts}")
    ref_label = args.ref_label or ("closed" if "closed" in labels else max(labels, key=lambda l: counts[l]))
    refz = np.median(np.stack([tdm.standardize(tdm.load_gray(f)) for f in files[ref_label]]), axis=0)

    def dataset(exclude=None):
        Xs, ys = [], []
        for i, lab in enumerate(labels):
            fl = [f for f in files[lab] if f != exclude]
            if not fl:
                continue
            Xs.append(features_for(fl, args.aug, refz)); ys.append(np.full(len(Xs[-1]), i))
        return np.vstack(Xs), np.concatenate(ys)

    X, y = dataset()
    mean, std = X.mean(axis=0), X.std(axis=0) + 1e-6
    Xz = (X - mean) / std
    rng = np.random.default_rng(42)
    idx = rng.permutation(len(Xz)); Xz, y = Xz[idx], y[idx]
    ntest = max(2, len(Xz) // 5)
    clf = fit(Xz[ntest:], y[ntest:], args.C)
    te_acc = float((clf.predict(Xz[:ntest]) == y[:ntest]).mean())
    print(f"holdout acc {te_acc:.3f} over augmented frames ({dict(zip(*np.unique(y[:ntest], return_counts=True)))})")

    loo_acc = None
    if args.loo:
        results = []
        for i, lab in enumerate(labels):
            for f in files[lab]:
                Xl, yl = dataset(exclude=f)
                m_, s_ = Xl.mean(axis=0), Xl.std(axis=0) + 1e-6
                c_ = fit((Xl - m_) / s_, yl, args.C)
                x = ((tdm.standardize(tdm.load_gray(f)) - refz).ravel() - m_) / s_
                p = c_.predict_proba(x[None, :])[0]
                results.append((lab, labels[int(np.argmax(p))], float(p.max()), f.name))
        ok = sum(1 for t, pr, _, _ in results if t == pr)
        loo_acc = ok / max(1, len(results))
        print(f"leave-one-out over {len(results)} originals: acc {loo_acc:.3f}")
        for t, pr, p, n in results:
            print(f"  {t:7} -> {pr:7} {p:.2f} {n}{'' if t == pr else '   <-- wrong'}")

    clf = fit(Xz, y, args.C)   # final model on everything
    W = clf.coef_ if len(labels) > 2 else np.vstack([-clf.coef_[0] / 2, clf.coef_[0] / 2])
    B = clf.intercept_ if len(labels) > 2 else np.array([-clf.intercept_[0] / 2, clf.intercept_[0] / 2])
    order = list(clf.classes_) if len(labels) > 2 else [0, 1]
    model = {
        "labels": [labels[int(k)] for k in order], "width": tdm.W, "height": tdm.H, "subcrop": list(tdm.SUBCROP),
        "reference": [round(float(v), 4) for v in refz.ravel()], "per_image_norm": True,
        "mean": [round(float(v), 5) for v in mean], "std": [round(float(v), 5) for v in std],
        "weights": [[round(float(v), 5) for v in row] for row in W], "bias": [round(float(v), 5) for v in B],
        "trained": str(date.today()), "samples": counts, "ref_label": ref_label,
        "holdout_acc": round(te_acc, 4), "loo_acc": None if loo_acc is None else round(float(loo_acc), 4),
    }
    Path(args.out).write_text(json.dumps(model))
    print(f"wrote {args.out}: labels {model['labels']} from {counts}")


if __name__ == "__main__":
    main()
