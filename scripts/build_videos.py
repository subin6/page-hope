#!/usr/bin/env python3
"""Transcode the raw arrow-rendering strips in ./videos into web-ready clips.

The raw files are MPEG-4 Part 2 (`mp4v`), which browsers do not decode, and they
carry a debug label bar plus panels we do not show on the page.  This script crops
the panels we want, re-stacks them, and encodes H.264 + VP9.

Panel boundaries below were measured from the pixels, not guessed.

Raw single-hand strip (1626x262 @ 20fps), debug label bar = top 22px, panels 240px tall.
The "force vectors" and "rest-pose" panels also carry a small baked-in caption in their
top ~28px, which SCRUB_BOX paints over in white before cropping.
    x=0    w=427  input frame
    x=427  w=240  force vectors, 0 deg
    x=667  w=240  force vectors, 180 deg
    x=907  w=240  rest-pose force
    x=1147 w=240  ours: pressure
    x=1387 w=240  ours: contact

Raw two-hand strip (2540x480 @ 20fps), no labels anywhere:
    x=0    w=760  input frame
    x=760  w=445  left hand, posed
    x=1205 w=445  right hand, posed
    x=1650 w=445  left hand, rest pose
    x=2095 w=445  right hand, rest pose

Run from the project root:  python3 scripts/build_videos.py
"""
import json
import shutil
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SRC = ROOT / "videos"
OUT_VIDEO = ROOT / "media" / "videos"
OUT_POSTER = ROOT / "media" / "posters"
OUT_THUMB = ROOT / "media" / "thumbs"

# Preferred source: the renderer's lossless PNG frame dumps. They are complete
# (the mp4 in videos/segment_018.mp4 stops 5 frames early, which would desync
# the force plot) and avoid transcoding an already-lossy mp4v. Falls back to
# videos/*.mp4 when the render outputs are not mounted.
FRAME_ROOT = Path("/data/users/subin/opentouch/outputs/infer_hawor_full_mask_all_hull")
FRAME_SINGLE = FRAME_ROOT / "center_fixed_hybrid"
FRAME_PAIR = FRAME_ROOT / "center_clip_max_hybrid_combined"
SRC_FPS = 20

# panel = (x, y, width, height) in the raw strip.
# Every offset and size is even. yuv420p subsamples chroma 2x2, so ffmpeg
# silently rounds odd crop values down — at the old 2x output scale that was
# invisible, but encoding at native size it shifted panels by a pixel.
# Nudging into a panel by one column is safe: the boundaries are white gutters.
# The contact panel is also 2 px narrower than the rest because it sits at the
# right edge of a source that is 1626 px in some renders and 1627 in others.
# Result: every clip is exactly 1144 px wide, so one CSS grid labels them all.
SINGLE = dict(input=(0, 22, 426, 240), arrows=(428, 22, 240, 240),
              rest=(908, 22, 240, 240), pressure=(1148, 22, 240, 240),
              contact=(1388, 22, 238, 240))
PAIR = dict(input=(0, 0, 760, 480), left=(760, 0, 445, 480),
            right=(1205, 0, 445, 480))

# White rectangle painted over the baked-in captions of the single-hand strip.
SCRUB_BOX = "drawbox=x=427:y=22:w=720:h=28:color=white:t=fill"

# name -> (frame dir, fallback mp4, ordered panels, panel table, scale factor)
CLIPS = {
    "gopro_20":    (FRAME_SINGLE / "gopro_20", "gopro_20.mp4",
                    ["input", "pressure", "contact", "arrows"], SINGLE, 1),
    "rashult_20":  (FRAME_SINGLE / "rashult_20", "rashult_20.mp4",
                    ["input", "pressure", "contact", "arrows"], SINGLE, 1),
    "segment_018": (FRAME_SINGLE / "segment_018", "segment_018.mp4",
                    ["input", "pressure", "contact", "arrows"], SINGLE, 1),
    "segment_037": (FRAME_SINGLE / "segment_037", "segment_037.mp4",
                    ["input", "pressure", "contact", "arrows"], SINGLE, 1),
    "video_0":     (FRAME_SINGLE / "video_0", "video_0.mp4",
                    ["input", "pressure", "contact", "arrows"], SINGLE, 1),
    "gopro_20_pair":   (FRAME_PAIR / "gopro_20_combined", "gopro_20_combined.mp4",
                        ["input", "left", "right"], PAIR, 1),
    "rashult_20_pair": (FRAME_PAIR / "rashult_20_combined", "rashult_20_combined.mp4",
                        ["input", "left", "right"], PAIR, 1),
}

# Encoded at the panels' native resolution. Upscaling before encoding only
# spends bits on interpolated pixels — the browser can enlarge for free at
# display time — and it doubled every clip. CRF is a touch tighter than it was
# at 2x, since each pixel is more visible once the browser scales it up.
X264 = ["-c:v", "libx264", "-profile:v", "high", "-crf", "20", "-preset", "slow",
        "-pix_fmt", "yuv420p", "-movflags", "+faststart", "-an"]
# -pix_fmt yuv420p is not optional. The source is a PNG sequence, so without it
# libvpx picks a 4:4:4 format and emits VP9 Profile 1, which many browsers and
# most hardware decoders refuse. Profile 0 is the one that plays everywhere.
VP9 = ["-c:v", "libvpx-vp9", "-crf", "32", "-b:v", "0", "-row-mt", "1",
       "-pix_fmt", "yuv420p", "-an"]


def build_filter(panels, table, scale, scrub=None):
    parts, labels = [], []
    src = "0:v"
    if scrub:
        parts.append(f"[0:v]{scrub}[clean]")
        src = "clean"
    parts.append(f"[{src}]split={len(panels)}" + "".join(f"[s{i}]" for i in range(len(panels))))
    for i, key in enumerate(panels):
        x, y, w, h = table[key]
        tag = f"p{i}"
        parts.append(f"[s{i}]crop={w}:{h}:{x}:{y}[{tag}]")
        labels.append(f"[{tag}]")
    chain = ";".join(parts) + ";" + "".join(labels) + f"hstack=inputs={len(panels)}[s]"
    if scale != 1:
        chain += f";[s]scale=iw*{scale}:ih*{scale}:flags=lanczos[out]"
    else:
        chain += ";[s]null[out]"
    return chain


def probe(path):
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-select_streams", "v:0",
         "-show_entries", "stream=width,height,nb_frames,r_frame_rate",
         "-show_entries", "format=duration", "-of", "json", str(path)],
        check=True, capture_output=True, text=True).stdout
    d = json.loads(out)
    s = d["streams"][0]
    num, den = s["r_frame_rate"].split("/")
    return dict(width=s["width"], height=s["height"],
                fps=round(int(num) / int(den), 3),
                frames=int(s.get("nb_frames", 0)),
                duration=round(float(d["format"]["duration"]), 3))


def main():
    for tool in ("ffmpeg", "ffprobe"):
        if not shutil.which(tool):
            raise SystemExit(f"{tool} not found")
    OUT_VIDEO.mkdir(parents=True, exist_ok=True)
    OUT_POSTER.mkdir(parents=True, exist_ok=True)
    OUT_THUMB.mkdir(parents=True, exist_ok=True)

    manifest = {}
    for name, (frame_dir, fname, panels, table, scale) in CLIPS.items():
        if frame_dir.is_dir() and any(frame_dir.glob("*.png")):
            src_args = ["-framerate", str(SRC_FPS), "-i", str(frame_dir / "%05d.png")]
            origin = f"frames:{frame_dir.name}"
        elif (SRC / fname).exists():
            src_args = ["-i", str(SRC / fname)]
            origin = f"mp4:{fname}"
        else:
            print(f"  !! no source for {name} ({frame_dir} or {SRC / fname})")
            continue
        vf = build_filter(panels, table, scale,
                          SCRUB_BOX if table is SINGLE else None)
        mp4 = OUT_VIDEO / f"{name}.mp4"
        webm = OUT_VIDEO / f"{name}.webm"
        poster = OUT_POSTER / f"{name}.jpg"
        thumb = OUT_THUMB / f"{name}.jpg"

        subprocess.run(["ffmpeg", "-y", "-v", "error", *src_args,
                        "-filter_complex", vf, "-map", "[out]", *X264, str(mp4)], check=True)
        subprocess.run(["ffmpeg", "-y", "-v", "error", *src_args,
                        "-filter_complex", vf, "-map", "[out]", *VP9, str(webm)], check=True)
        subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", str(mp4),
                        "-frames:v", "1", "-q:v", "4", "-update", "1", str(poster)], check=True)
        # The clip strips render these ~130 px wide. Serving the full composite
        # there costs ~50 KB per thumbnail for something the size of a stamp, so
        # crop to the input panel and scale it down.
        ix, iy, iw, ih = table["input"]
        subprocess.run(["ffmpeg", "-y", "-v", "error", *src_args, "-frames:v", "1",
                        "-vf", f"crop={iw}:{ih}:{ix}:{iy},scale=264:-2",
                        "-q:v", "6", "-update", "1", str(thumb)], check=True)

        # VP9 does not always win: on the wide white-background pair strips it
        # comes out bigger than H.264. Keep it only when it actually saves
        # bytes — the page lists <source> children, so a missing webm just
        # falls through to the mp4.
        if webm.stat().st_size >= mp4.stat().st_size:
            webm.unlink()

        info = probe(mp4)
        info["panels"] = panels
        info["source"] = origin
        info["webm"] = webm.exists()
        info["thumb"] = round(thumb.stat().st_size / 1024, 1)
        manifest[name] = info
        print(f"  {name:18s} {info['width']}x{info['height']} "
              f"{info['frames']:4d}f  mp4 {mp4.stat().st_size/1024:6.0f} KB  "
              f"webm {webm.stat().st_size/1024:6.0f} KB  {origin}"
              if webm.exists() else
              f"  {name:18s} {info['width']}x{info['height']} "
              f"{info['frames']:4d}f  mp4 {mp4.stat().st_size/1024:6.0f} KB  "
              f"webm dropped (bigger)  {origin}")

    (OUT_VIDEO / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")


if __name__ == "__main__":
    main()
