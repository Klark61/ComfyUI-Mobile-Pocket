// Shared paths + helpers for the browser test scripts (nothing here depends on one particular machine).
//   COMFY_ROOT   the ComfyUI folder; default: two levels above this repo (<ComfyUI>/custom_nodes/<repo>), override with env COMFY_ROOT
//   WF_DIR       default <COMFY_ROOT>/user/default/workflows   (env WF_DIR)
//   INPUT_DIR    default <COMFY_ROOT>/input                    (env INPUT_DIR)
//   CHROME       env CHROME, else the first existing common install path for the OS; throws a clear message when none is found
//   installFixture(name)  copies tests/fixtures/<name>.json into WF_DIR under a unique temp name and removes it again on exit
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const FIXTURE_DIR = path.join(REPO_DIR, 'tests', 'fixtures');
export const COMFY_ROOT = path.resolve(process.env.COMFY_ROOT || path.resolve(REPO_DIR, '../..'));
export const WF_DIR = process.env.WF_DIR || path.join(COMFY_ROOT, 'user', 'default', 'workflows');
export const INPUT_DIR = process.env.INPUT_DIR || path.join(COMFY_ROOT, 'input');
export const SETTINGS_FILE = path.join(COMFY_ROOT, 'user', 'default', 'comfy.settings.json');

function chromeCandidates() {
  const e = process.env;
  if (process.platform === 'win32') {
    const roots = [e.PROGRAMFILES, e['PROGRAMFILES(X86)'], e.LOCALAPPDATA].filter(Boolean);
    return roots.flatMap((r) => [
      path.join(r, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(r, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      path.join(r, 'Chromium', 'Application', 'chrome.exe'),
    ]);
  }
  if (process.platform === 'darwin') {
    return ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'];
  }
  const dirs = (e.PATH || '').split(path.delimiter).filter(Boolean);
  const names = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser', 'microsoft-edge'];
  return [...dirs.flatMap((d) => names.map((n) => path.join(d, n))), '/usr/bin/google-chrome', '/usr/bin/chromium', '/snap/bin/chromium'];
}
export function findChrome() {
  if (process.env.CHROME) {
    if (!fs.existsSync(process.env.CHROME)) throw new Error(`CHROME is set to "${process.env.CHROME}" but that file does not exist.`);
    return process.env.CHROME;
  }
  const hit = chromeCandidates().find((p) => fs.existsSync(p));
  if (!hit) throw new Error('No Chrome/Chromium/Edge found. Install one or set the CHROME environment variable to its executable path.');
  return hit;
}
let _chrome;
/** Resolved lazily so scripts that never open a browser do not need one. */
export const chromePath = () => (_chrome ||= findChrome());

// ---- fixtures: installed into WF_DIR with a unique name, removed again when the process exits (also via process.exit and Ctrl-C)
const installed = new Set();
let hooked = false;
function removeAll() { for (const f of installed) { try { fs.rmSync(f, { force: true }); } catch {} } installed.clear(); }
function hook() {
  if (hooked) return; hooked = true;
  process.on('exit', removeAll);
  for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => { removeAll(); process.exit(130); });
}
/** Copy tests/fixtures/<name>.json to WF_DIR as "_pocket_test_<pid>_<name>.json". Returns the file name (what ?path= and the workflow list use). */
export function installFixture(name) {
  const src = path.join(FIXTURE_DIR, name.endsWith('.json') ? name : name + '.json');
  if (!fs.existsSync(src)) throw new Error('missing fixture ' + src);
  fs.mkdirSync(WF_DIR, { recursive: true });
  const file = `_pocket_test_${process.pid}_${path.basename(src)}`;
  const dst = path.join(WF_DIR, file);
  fs.copyFileSync(src, dst);
  installed.add(dst); hook();
  return file;
}
export function removeInstalled(file) { const dst = path.join(WF_DIR, file); installed.delete(dst); try { fs.rmSync(dst, { force: true }); } catch {} }
/**
 * Workflow list for a script: names given with --wf (comma separated, real files in WF_DIR) or else the given fixtures, installed as temp copies.
 * Prints a note when the defaults are used.
 */
export function workflowsFor(wfArg, defaultFixtures) {
  if (wfArg) return wfArg.split(',').map((s) => s.trim()).filter(Boolean);
  console.error(`note: no --wf given, using the synthetic fixture(s) ${defaultFixtures.join(', ')} (pass --wf <file in ${WF_DIR}> to use your own workflows)`);
  return defaultFixtures.map(installFixture);
}
