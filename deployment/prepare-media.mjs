// SPDX-License-Identifier: AGPL-3.0-only
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const deployment = dirname(fileURLToPath(import.meta.url));
const repo = resolve(deployment, '..');
const pins = JSON.parse(readFileSync(resolve(deployment, 'media-pins.json')));
for (const media of pins) {
  execFileSync('git', ['submodule', 'update', '--init', '--', media.path], {cwd: repo, stdio:'inherit', windowsHide:true});
  const actual = execFileSync('git', ['-C', media.path, 'rev-parse', 'HEAD'], {cwd:repo, encoding:'utf8', windowsHide:true}).trim();
  if (actual !== media.pin) throw Error('Media pin mismatch: ' + media.path);
  const overlay = resolve(repo, media.overlay);
  if (existsSync(overlay)) cpSync(overlay, resolve(repo, media.path), {recursive:true});
  console.log(media.version + ' ' + media.kind + ': pinned media and fork overrides ready');
}
