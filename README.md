# ComfyUI Pocket

Use ComfyUI comfortably from your phone: a fast phone app plus the full node editor, tuned for touch.

## Screenshots

TODO: add screenshots here, e.g. `docs/screenshots/gallery.png`, `docs/screenshots/generate.png`, `docs/screenshots/canvas.png`.

## Features

- **Canvas mode on phones**: runs the *real* ComfyUI frontend smoothly on phones — panning goes from about 16 fps in the stock desktop UI to about 70 fps in Canvas mode on a mid-range Android phone. Every node and custom widget behaves exactly like on the PC.
- **Forms built automatically from your saved workflows**: Pocket reads your existing ComfyUI workflows and turns them into phone-friendly input forms, with rgthree-style group toggles to bypass or mute groups without touching the graph.
- **Gallery**: grid view, folders, favorites, search, multi-select delete, fullscreen viewer with swipe, pinch and double-tap, metadata, download/share, and Remix.
- **Queue**: live progress and previews — including jobs you started on the desktop. Cancel, interrupt or clear jobs, and see recent runs.
- **Generate**: start from a recent run, a saved workflow, a preset, or a remixed image. Prompts, seeds, steps/cfg/denoise/sampler/scheduler, size (with aspect presets), and models/LoRAs are detected automatically. Pin inputs, set batch size 1-8, save presets.
- **Sections and switches**: your workflow's groups appear as on/off toggles (like rgthree's Fast Groups Bypasser/Muter), and switch nodes show as toggles at the top of the form.
- **Text outputs**: text from nodes such as "Preview Any" (e.g. the final prompt written by a prompt-writer LLM) shows on Generate and in Queue, with a copy button.
- **Installable feel**: add the page to your phone's home screen for an app-like experience.

## Install

1. Clone the repo into your ComfyUI `custom_nodes` folder:

   ```
   git clone https://github.com/Klark61/comfyui-pocket ComfyUI/custom_nodes/comfyui-pocket
   ```

   then restart ComfyUI. (In ComfyUI-Manager you can also use "Install via Git URL" with the same URL.)
2. No extra Python dependencies — there is nothing to pip-install beyond what ComfyUI itself needs.
3. Start ComfyUI with `--listen` so your phone can reach it:

   ```
   python main.py --listen
   ```

4. On the phone, open `http://<PC-IP>:8188/pocket/` (find your PC's IPv4 address with `ipconfig` on Windows or `ip addr` on Linux). Use **Add to Home screen** in the browser menu for an app-like experience.

Phones that open ComfyUI's root URL `/` are automatically redirected to `/pocket/`. Append `?desktop=1` to the URL to opt out and get the desktop UI instead.

## Requirements

- A recent ComfyUI with the new frontend (tested with ComfyUI 0.42 and frontend 1.55; older versions may work but aren't tested)
- Python 3.10+ (your ComfyUI Python)
- A modern mobile browser: Chrome on Android or Safari on iOS

## Usage

### Gallery

Grid view of your outputs with folders, favorites, and search. Multi-select to delete (files move to a node-local trash, see [Security](#security)). Tap any image for the fullscreen viewer: swipe between images, pinch or double-tap to zoom, view metadata, download, share, or **Remix** — load the image's workflow back into Generate with its settings.

### Queue

Watch the queue in real time, with progress and previews for every job — including jobs started on the desktop. Cancel, interrupt or clear jobs, and browse recent runs. Text outputs from nodes (like "Preview Any") appear here too, with a copy button.

### Generate

Build a form from a recent run, a saved workflow, a preset, or a remixed image. API-format workflow files are loaded directly; a broken workflow file shows a clear error explaining why.

- **Sections**: your workflow's groups are listed like rgthree's "Fast Groups Bypasser/Muter" node on the desktop, each with an on/off toggle that bypasses or mutes the group. Under them, "All groups" lists every group in the workflow with its own toggle, and "Advanced: single nodes" bypasses any individual node. A toggle re-converts the workflow in about a second and keeps the edits you have made. Toggles are remembered on reload, and are saved with presets and snapshots.
- **Switches**: switch nodes ("Enhance prompt?" ComfySwitchNode, Impact switches, boolean primitives) show as toggles at the top of the form.
- **Images**: LoadImage inputs show a thumbnail of the chosen image. "Choose photo" uses your phone's camera or photo library, and large or HEIC photos are converted to JPEG automatically. "Pick from my outputs" reuses a past result. LoadImageMask warns when the chosen image has no alpha channel.
- **All nodes**: a sheet lists every node, grouped the same way as the workflow, with search, every input editable, and a bypass switch per node.
- **Text outputs**: text from nodes such as "Preview Any" (for example the final prompt written by a prompt-writer LLM) shows on Generate and in Queue, with a copy button.
- **Seeds**: each seed follows its own "control after generate" setting from the workflow (randomize, fixed, increment, decrement). Your own toggle overrides it.

Detected inputs include prompts, seeds, steps/cfg/denoise/sampler/scheduler, size (with aspect presets), and models/LoRAs, including rgthree Power Lora Loader. Pin any input, set batch size 1-8, and save presets.

### Canvas mode

Canvas mode is the full ComfyUI node editor on your phone: the real ComfyUI graph with a phone layer on top, so every node and every custom widget works the same as it does on the PC.

- **Opening it**: in Generate, use the "Simple | Canvas" switch. From the workflow list, use "Open in canvas". To go back, pick "Simple" in the toolbar's ⋯ menu: it returns to the phone form and reloads the workflow, so the edits you made on the canvas show up.
- **Gestures**: two-finger pan and pinch zoom. They stay smooth because the picture is redrawn sharp when you lift your fingers. One finger works on the graph: drag a node (or a group by its title) to move it, drag from an output dot to an input dot to connect them, tap to select. Holding a finger never opens a menu by itself; use the **Menu** button in the bottom bar for the selected node's (or the canvas) menu. One finger on empty canvas does nothing by default (a tap deselects); the gear in **More > Settings** switches it to Pan or Box select and can turn on an opt-in long-press menu (settings stay on the phone, in localStorage). Tap a text box to edit it full screen.
- **Toolbar**: Add (search for a node), Delete, Bypass, Undo, Run (with a progress pill), Save, and ⋯. Save writes to the same workflow file as the PC. The ⋯ menu holds Mute, Redo, Fit view, Simple, and "Full extensions", which reloads with every extension loaded; use it if a node you add looks plain.
- **Phone tweaks stay on the phone**: canvas mode never changes your desktop ComfyUI settings. Unsaved changes survive a reload, shown as "Restored unsaved changes · Discard".
- **Speed**: to load faster, canvas mode only loads the extensions the workflow needs. See [docs/performance.md](docs/performance.md) for measurements.

### How saved workflows load

The phone loads the real ComfyUI frontend in a hidden frame once per session (about 20-30 seconds the first time). It converts the graph exactly like the desktop "Queue" button, and the result is cached as a snapshot. The desktop also auto-snapshots a saved workflow each time it is queued. You can also use File > "Send workflow to Mobile".

### Where data lives

- `user/default/comfyui-pocket/`: favorites, workflow snapshots, presets
- `custom_nodes/comfyui-pocket/data/trash/`: deleted images (auto-purged)
- `custom_nodes/comfyui-pocket/cache/thumbs/`: thumbnail cache

## Security

- ComfyUI has **no authentication**, so only use this on a trusted LAN, or behind a VPN or a reverse proxy with auth.
- **Never expose port 8188 to the internet** (no port-forwarding).
- Deleting images is soft at first: files move to a node-local trash (`data/trash`, not served by ComfyUI) and are permanently erased after 30 days (`COMFYUI_POCKET_TRASH_DAYS`).
- Live job progress is visible to any client on your LAN, as in stock ComfyUI.

## Troubleshooting

- **The phone can't connect**: allow port 8188 through your firewall (on Windows, add an inbound rule for TCP 8188), make sure ComfyUI was started with `--listen`, and check the phone is on the same Wi-Fi network as the PC.
- **The first load is slow**: the phone loads the ComfyUI frontend once per session (about 20-30 s) to convert workflows exactly like the desktop does. This is expected; subsequent opens are fast.
- **Canvas mode: a node looks plain**: some widgets come from extensions that were not loaded — open ⋯ → **Full extensions** and reload.
- **The menu on long-press is off by default**: holding a finger never opens a menu unless you enable it — see ⋯ → **Settings**.

## Testing

Run these from this folder:

```
node tests/test_fields.mjs
node tests/test_sections.mjs
node tests/test_nodes.mjs
python -m pytest tests
node tests/test_gestures.mjs
node tests/check_nodes_live.mjs          # needs ComfyUI running
node tests/check_canvas_boot.mjs         # needs ComfyUI running
node tests/check_gestures.mjs            # needs ComfyUI running
node tests/check_canvas_toolbar.mjs      # needs ComfyUI running
node tests/e2e_phone.mjs                 # needs ComfyUI running
node tests/e2e_canvas_roundtrip.mjs      # needs ComfyUI running
node tests/e2e_scenarios.mjs             # queues real GPU runs
node tests/perf_canvas.mjs --limit 500   # phone performance measurement
```

The `node tests/test_*.mjs` files and `python -m pytest tests` are unit tests and need nothing running. The browser/integration scripts (`check_*.mjs`, `e2e_*.mjs`, `perf_canvas.mjs`) need a running ComfyUI and Chrome, plus the `COMFY_ROOT`, `WF_DIR` and `CHROME` environment variables — see [tests/README.md](tests/README.md).

## Contributing

Issues and pull requests are welcome. Please run the unit tests (`node tests/test_*.mjs` and `python -m pytest tests`) before submitting.

## Credits / Third-party

This project vendors Preact, preact/hooks and htm. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT — see [LICENSE](LICENSE).
