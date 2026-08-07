# HOPE — project page

Project page for **HOPE: Hand-Object Pressure Estimation from Monocular Videos**.

🔗 **[Project page](https://subin6.github.io/page-hope/)** · **[arXiv](https://arxiv.org/abs/2608.06192)**

HOPE predicts per-vertex contact and pressure on the MANO hand mesh from monocular RGB
video. The page carries the paper's figures and tables, result clips on in-the-wild
footage, and an interactive explorer that plays the input video, an orbitable hand
carrying the per-vertex field, and a plot of force aggregated over hand regions off one
shared timeline.

## Running it locally

```bash
python3 scripts/serve.py 8000        # then open http://localhost:8000
```

Use this rather than `python3 -m http.server`: the stdlib server ignores `Range` and
answers with `200` and the whole file, so video playback and seeking break. `serve.py`
adds `206` support, gzip, and HTTP/1.1 keep-alive. GitHub Pages handles all of this
natively, so the deployed page needs none of it.

## Layout

```
index.html               the whole page
static/css/index.css     stylesheet (no framework); the palette is one block at the top
static/js/index.js       clip switching, lazy playback, reveal-on-scroll
static/js/explore.js     interactive explorer: hand renderer + force plot
static/images/           figures from the paper (WebP, 1x + 2x)
media/videos/            result clips (H.264 + VP9)
media/posters/           video posters
media/thumbs/            clip-strip thumbnails
media/force/             per-clip force arrays driving the explorer
scripts/                 preview server and asset build scripts
```

No build step and no framework. The hand in the explorer is drawn with a
painter's-algorithm renderer on a 2D canvas rather than a WebGL library: 1538 faces sort
and fill well inside a frame, and it keeps the page dependency-free.

## Citation

```bibtex
@article{jeon2026hope,
  title   = {HOPE: Hand-Object Pressure Estimation from Monocular Videos},
  author  = {Jeon, Subin and Kim, Byungjun and Joo, Hanbyul},
  journal = {arXiv preprint arXiv:2608.06192},
  year    = {2026}
}
```

Page template adapted from the [Nerfies](https://github.com/nerfies/nerfies.github.io)
project page, licensed under [CC BY-SA 4.0](http://creativecommons.org/licenses/by-sa/4.0/).
