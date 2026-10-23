# Tests

Run everything from the repo root (this folder's parent).

## Unit tests

No server needed — these run against fixtures and pure logic:

```
node tests/test_*.mjs      # JS unit tests (fields, sections, nodes, gestures, canvas prefs, storage migration)
python -m pytest tests     # Python unit tests (use your ComfyUI Python)
```

## Browser / integration checks

`check_*.mjs`, `e2e_*.mjs` and `perf_canvas.mjs` drive a real headless Chrome against a real ComfyUI. They need:

- ComfyUI running with this node installed on `http://127.0.0.1:8188`;
- Google Chrome installed on the machine running the test.

Environment variables:

| Variable | Meaning | Default |
|---|---|---|
| `COMFY_ROOT` | Your ComfyUI root folder | two folders up from this repo (`../../`) |
| `WF_DIR` | Workflows the checks load | `$COMFY_ROOT/user/default/workflows` |
| `INPUT_DIR` | ComfyUI input folder (upload checks) | `$COMFY_ROOT/input` |
| `CHROME` | Path to the Chrome executable | the standard Windows install path |

Notes:

- The checks use the sample workflows and test images in `tests/fixtures/` where possible; `WF_DIR` is only needed for the live-workflow checks.
- Run the browser checks **one at a time** — each spawns its own Chrome on a debug port and they can collide.
- `e2e_scenarios.mjs` queues **real GPU runs** on your machine (it generates actual images); budget time and VRAM accordingly.
- `perf_canvas.mjs` is the phone-performance harness; see `docs/performance.md` for what it measures.
