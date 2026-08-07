#!/usr/bin/env python3
"""Turn the exported inference arrays into web-loadable force data.

Input:  data/npz/<clip>.npz, written by
          python scripts/infer_hawor_sample.py \
              --sample-root <root> --samples <clip ...> \
              --mode center --arrows all --dry-run --export-npz <dir>
        in /data/users/subin/opentouch.

Output: media/force/<clip>.json   subregion force time series + bin layout
        media/force/<clip>.bin    posed vertices, per-vertex force/contact,
                                  arrow directions (typed arrays)
        media/force/mano.json     MANO face indices, shared by every clip

The JSON is small enough to fetch for every clip up front (it drives the time
plot). The .bin is ~1 MB per clip and only fetched when a viewer asks for it.

Everything is quantised to types JavaScript has natively: there is no
Float16Array in browsers, so vertices and directions become Int16 with an
explicit scale factor rather than staying fp16.
"""
import json
from pathlib import Path

import numpy as np

ROOT = Path(__file__).resolve().parent.parent
NPZ_DIR = ROOT / "data" / "npz"
OUT = ROOT / "media" / "force"

# Parent region -> ordered subregions, mirroring REGION_TO_SUBREGIONS in
# opentouch/src/opentouch/region_mapping.py. Order is proximal-to-distal so the
# legend reads thumb..pinky, palm last.
REGIONS = [
    ("thumb",  ["thumb-tip", "thumb-mid", "thumb-base"]),
    ("index",  ["index-tip", "index-mid", "index-base"]),
    ("middle", ["middle-tip", "middle-mid", "middle-base"]),
    ("ring",   ["ring-tip", "ring-mid", "ring-base"]),
    ("pinky",  ["pinky-tip", "pinky-mid", "pinky-base"]),
    ("palm",   ["palm-left", "palm-mid", "palm-right"]),
]

VERT_RANGE = 0.15   # metres; posed vertices are centred, so |v| stays well inside


def quantise(a, scale, dtype=np.int16):
    lo, hi = np.iinfo(dtype).min, np.iinfo(dtype).max
    return np.clip(np.round(a / scale), lo, hi).astype(dtype)


def convert(npz_path: Path, buf_parts: list) -> dict:
    d = np.load(npz_path, allow_pickle=True)
    names = [str(n) for n in d["sub_names"]]
    T = int(d["sub_force"].shape[0])
    fps = int(d["fps"])

    sub = d["sub_force"].astype(np.float32)              # [T, S]
    index_of = {n: i for i, n in enumerate(names)}
    missing = [n for _, subs in REGIONS for n in subs if n not in index_of]
    if missing:
        raise SystemExit(
            f"{npz_path.name}: missing subregions {missing}. "
            "Re-export with --arrows all (finger-only omits the palm)."
        )

    # Reorder columns into the legend order, so the client can slice a region
    # as a contiguous run of three and never needs the name table to plot.
    order = [index_of[n] for _, subs in REGIONS for n in subs]
    sub = sub[:, order]
    ordered_names = [n for _, subs in REGIONS for n in subs]

    verts = d["verts_local"].astype(np.float32)          # [T, 778, 3] m
    force = d["force_pred"].astype(np.float32)           # [T, 778] kPa
    contact = d["contact_prob"].astype(np.float32)       # [T, 778]
    arrow_dir = d["arrow_dir"].astype(np.float32)[:, order]  # [T, S, 3] unit
    center_idx = d["center_vert_idx"].astype(np.int32)[order]  # [S] arrow origins

    force_max = float(force.max()) if force.size else 1.0
    vert_scale = VERT_RANGE / 32767.0

    # Byte layout, little-endian, in this order. Int16 needs 2-byte alignment;
    # T*778 is always even, so the Uint8 blocks never break it.
    blocks = [
        quantise(verts, vert_scale).reshape(-1),
        np.clip(np.round(force / max(force_max, 1e-9) * 255), 0, 255).astype(np.uint8).reshape(-1),
        np.clip(np.round(contact * 255), 0, 255).astype(np.uint8).reshape(-1),
        quantise(arrow_dir, 1.0 / 32767.0).reshape(-1),
    ]
    offsets, cursor = [], 0
    for b in blocks:
        offsets.append(cursor)
        cursor += b.nbytes
    buf_parts.append(b"".join(b.tobytes() for b in blocks))

    return dict(
        frames=T,
        fps=fps,
        duration=round(T / fps, 4),
        vertices=int(verts.shape[1]),
        subregions=ordered_names,
        centerVertIdx=[int(i) for i in center_idx],
        regions=[{"name": r, "subregions": subs} for r, subs in REGIONS],
        # sum of predicted vertex-level force over each subregion — the same
        # quantity the rendered arrows encode, so it is an aggregate, not kPa
        subForce=[[round(float(x), 4) for x in row] for row in sub],
        subForceMax=round(float(sub.max()), 4),
        forceMax=round(force_max, 5),
        vertScale=vert_scale,
        buffer=dict(
            verts=dict(offset=offsets[0], type="Int16", shape=[T, int(verts.shape[1]), 3]),
            force=dict(offset=offsets[1], type="Uint8", shape=[T, int(verts.shape[1])]),
            contact=dict(offset=offsets[2], type="Uint8", shape=[T, int(verts.shape[1])]),
            arrowDir=dict(offset=offsets[3], type="Int16", shape=[T, len(ordered_names), 3]),
            bytes=cursor,
        ),
    )


def main() -> None:
    if not NPZ_DIR.is_dir():
        raise SystemExit(f"no {NPZ_DIR} — run the --export-npz step first")
    OUT.mkdir(parents=True, exist_ok=True)

    faces = None
    for npz_path in sorted(NPZ_DIR.glob("*.npz")):
        parts: list = []
        meta = convert(npz_path, parts)
        clip = npz_path.stem
        (OUT / f"{clip}.bin").write_bytes(parts[0])
        (OUT / f"{clip}.json").write_text(json.dumps(meta, separators=(",", ":")) + "\n")
        if faces is None:
            faces = np.load(npz_path)["faces"].astype(np.int32)
        print(f"  {clip:14s} {meta['frames']:4d} frames  "
              f"json {(OUT / f'{clip}.json').stat().st_size/1024:6.1f} KB  "
              f"bin {(OUT / f'{clip}.bin').stat().st_size/1024:7.1f} KB")

    if faces is not None:
        (OUT / "mano.json").write_text(
            json.dumps({"faces": faces.reshape(-1).tolist()}, separators=(",", ":")) + "\n"
        )
        print(f"  mano.json      {faces.shape[0]} faces  "
              f"{(OUT / 'mano.json').stat().st_size/1024:.1f} KB")


if __name__ == "__main__":
    main()
