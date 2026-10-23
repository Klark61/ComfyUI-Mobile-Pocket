# Canvas performance: stock frontend vs Canvas mode

Measurements from `tests/perf_canvas.mjs` (headless Chrome, `--gpu`, temp profile; no product code or server setting touched).

## Method

- Chrome emulating a mid-range Android phone: 412x915 CSS px, DPR 2.625, mobile + touch, Android user agent.
- CPU throttled 4x (`Emulation.setCPUThrottlingRate 4`); stock frontend opened via `/?desktop=1`, workflows loaded with `app.loadGraphData`.
- **Workflow A**: 32 nodes, heavy. **Workflow B**: prompt-writer workflow (similar node count, fewer DOM widgets).
- Gestures: 5 s two-finger pan (±50x40 px) and 5 s pinch (finger distance 60 → 140 → 60 px), synthesized with `Input.dispatchTouchEvent` at ~60 Hz, at zoom 0.7 centred on the densest window of the graph.
- FPS = rAF rate during the gesture; "jank" = frames > 50 ms; long tasks from `PerformanceObserver`.

Caveats: run-to-run noise is about ±3 fps and ±2 s on load; only the main thread is throttled, so real-device numbers may be worse; the "no-ext" config blocks every non-core extension pack (its gesture fps is pessimistic and not comparable one-to-one); latent previews are synthesized (4 Hz 512x512 JPEG during pan), not real jobs; the spike matrix was time-capped after 14 of 16 runs (Workflow A no-ext and Workflow B previews-on are missing).

## Spike: stock frontend on the phone emulation

All rows: `--gpu`, 4x throttle. Idle fps 58-60 and idle console errors 0/s in every row.

| workflow | config | DPR / canvas px | app ready (s) | graph loaded (s) | heap MB (load -> after gestures) | DOM nodes / DOM widgets (textareas) | pan fps (p95 ms, jank) | pinch fps (p95 ms, jank) | long-task ms in pan / pinch |
|---|---|---|---|---|---|---|---|---|---|
| A | baseline (run 1) | 2.625 / 1082x2236 | 25.7 | 29.4 | 168 -> 174 | 1016 / 22 (8) | 14.7 (134, 35) | 16.2 (134, 37) | 4499 / 4503 |
| A | baseline (run 2) | 2.625 | 23.7 | 27.4 | 168 -> 177 | 1016 / 22 (8) | 17.2 (133, 39) | 17.5 (133, 38) | 4824 / 4390 |
| A | DPR 1.5 | 1.5 / 618x1278 | 24.3 | 27.8 | 168 -> 179 | 1016 / 22 | 17.9 (117, 42) | 18.4 (133, 42) | 4806 / 4389 |
| A | DPR 1 | 1 / 412x852 | 26.6 | 30.0 | 169 -> 175 | 1016 / 22 | 17.2 (125, 40) | 22.4 (108, 45) | 4860 / 4047 |
| A | low quality forced | 2.625 | 26.0 | 29.7 | 168 -> 172 | 1013 / 19 (5) | 19.6 (117, 40) | 25.7 (92, 50) | 4637 / 4143 |
| A | MinFontSizeForLOD=20 (LOD active at 0.7) | 2.625 | 26.2 | 30.0 | 169 -> 174 | 1016 / 22 | 18.2 (117, 41) | 14.1 (167, 36) | 4467 / 4621 |
| A | no-ext (all non-core extensions blocked) | 2.625 | 18.2 | 21.4 | 128 -> 132 | 694 / 22 (8) | 12.5 (167, 30) | 13.0 (167, 32) | 4396 / 4540 |
| A | previews on (synthetic) | 2.625 | 28.0 | 31.6 | 168 -> 176 | 1027 / 22 | 12.9 (150, 34) | 12.5 (150, 34) | 4361 / 4337 |
| A | **best: DPR 1.5 + low quality + no-ext** | 1.5 / 618x1373 | 14.3 | 17.4 | 128 -> 129 | 717 / 22 | 22.9 (83, 55) | 23.6 (83, 51) | 3746 / 3545 |
| A | **best: DPR 1 + low quality + no-ext** | 1 / 412x915 | 14.8 | 17.8 | 128 -> 131 | 684 / 22 | 24.3 (75, 58) | 29.0 (67, 34) | 3444 / 1656 |
| B | baseline (run 1) | 2.625 | 28.0 | 32.2 | 168 -> 174 | 1033 / 12 (2) | 12.1 (183, 30) | 11.4 (183, 29) | 4750 / 4637 |
| B | baseline (run 2) | 2.625 | 30.0 | 34.4 | 169 -> 172 | 1033 / 12 (2) | 14.4 (150, 33) | 13.3 (183, 32) | 4452 / 4608 |
| B | DPR 1.5 | 1.5 | 28.7 | 33.2 | 169 -> 176 | 1043 / 12 | 16.5 (125, 41) | 17.7 (133, 42) | 4562 / 4383 |
| B | DPR 1 | 1 | 30.5 | 34.6 | 169 -> 178 | 1044 / 12 | 23.0 (100, 46) | 27.6 (92, 39) | 4174 / 3906 |
| B | low quality forced | 2.625 | 25.3 | 29.7 | 168 -> 178 | 1044 / 12 | 18.3 (117, 40) | 19.8 (117, 41) | 4358 / 4279 |
| B | MinFontSizeForLOD=20 | 2.625 | 26.5 | 30.5 | 169 -> 172 | 1045 / 12 | 16.3 (125, 38) | 14.2 (167, 34) | 4454 / 4746 |

Headline (Workflow A): baseline ~16 fps pan / ~17 fps pinch, 24-26 s to app ready, ~28 s to graph loaded, 168 MB heap -> best combo (DPR 1 + low quality + no extensions) 24 fps pan / 29 fps pinch, 14.8 s ready, 17.8 s loaded, 128 MB heap. Even the best combo stays far below 60 fps: the main thread is still busy ~70% of the gesture.

Mitigation ranking by effect on gestures (Workflow A, vs ~16 baseline): low quality +3..+9 fps, DPR cap +1..+6 (Workflow B: +9 pan, +14 pinch at DPR 1), no-ext 0 or negative on gestures but halves load and -40 MB heap / -320 DOM nodes, previews (synthetic) about -3 fps (within noise, plausible real cost).

## Top costs (ranked)

Source: a CPU profile of a pan (inclusive times, 4x throttle) + a probe counting canvas calls per frame.

1. **A full-canvas JS redraw every frame.** One `draw()` costs ~100 ms throttled (~25 ms on desktop), which alone caps pan at ~10 fps. Per frame with ~13 visible nodes: ~4500 `fill`, ~3000 `fillText`, ~2400 `measureText`, ~1700 `stroke`, ~1700 `save`. The front-canvas draw is ~1990 of 2440 ms of JS in the profile; node drawing ~890 ms (widgets 330), links in the back canvas ~410 ms.
2. **Blitting and rasterising a huge backing store.** The 1082x2236 canvas (DPR 2.625, 2.4 Mpx) is copied with `drawImage` ~1000 ms (41% of renderFrame) and native `(program)` time is ~5000 of 8100 ms. Dropping DPR to 1 gave +9 pan / +14 pinch fps on Workflow B, +0 / +6 on Workflow A (noisy). High DPR also lowers the LOD threshold, so full-detail drawing continues down to ~35% zoom.
3. **Frontend-framework reactivity and DOM widgets inside the frame loop.** Vue flush/get/isRef paths ~590 ms inclusive, `getBoundingClientRect` ~115 ms (DOM-widget positioning), ~20 DOM widgets / 8 textareas repositioned during pan. Low quality dropped the Workflow A widget count 22 -> 19.
4. **Extensions: load time and memory, not gestures.** Hundreds of extension registrations across the tested install: +7-12 s to app ready (23-30 s vs 14-18 s with extensions blocked), +40 MB heap, +320 DOM nodes. Several extensions wrap the per-frame draw functions, but their self time is small. Per-pack cost was not measured.
5. **Per-frame colour conversion + GC**: link rendering recomputes colours every frame (~190 ms), cached text measuring ~60 ms, GC ~50 ms. Latent previews (synthetic) add roughly -3 fps while sampling.

Touch findings: gestures themselves work (one-finger link drags, pinch zoom, two-finger pan, tap-select all behave as with a mouse), but on a 412 px viewport the sidebars, property panel, monitor overlays, manager toasts and toolbars leave only 46-54% of sampled screen points on the canvas, so unmitigated users see "drags do nothing".

## Canvas mode vs baseline (final)

`node tests/perf_canvas.mjs --gpu --only baseline,canvas --limit 500`. `baseline` = `/?desktop=1`; `canvas` = `/pocket/canvas?path=...` with the phone gesture compositor installed (canvas backing store capped at DPR 1.25). In the canvas rows the headless rAF cap (~70) is the ceiling.

| Workflow | Config | App ready (ms) | Graph loaded (ms) | Heap (MB) | Canvas visible | Pan fps | Pinch fps | Backing store |
|---|---|---|---|---|---|---|---|---|
| A | baseline | 23858 | 27018 | 168 | 59% | 16.7 | 15.6 | 1082x2236 |
| A | canvas | 16605 | 18478 | 144 | 86% | 69.6 | 71.9 | 515x1124 |
| B | baseline | 24068 | 27656 | 168 | 67% | 20.3 | 21.6 | 1082x2236 |
| B | canvas | 17003 | 19379 | 144 | 86% | 69.0 | 71.9 | 515x1124 |

Canvas mode: ready ~7 s sooner, graph ~8 s sooner, -24 MB heap, canvas visible 86% (target >= 85%), gestures ~4x faster than the baseline (~16-20 fps -> ~70 fps).
