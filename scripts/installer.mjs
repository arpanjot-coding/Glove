// SPDX-License-Identifier: MIT
import { spawnSync } from 'node:child_process';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const release = resolve('release');
const packageDir = join(release, 'Glove-win32-x64');
const manifest = join(release, 'glove-uninstall-files.nsh');
const setup = join(release, 'Glove-Setup-x64.exe');
const compiler = process.env.GLOVE_MAKENSIS || 'makensis.exe';
const { version } = JSON.parse(await readFile('package.json', 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Use a three-part Windows product version.');
const escape = value => value.replaceAll('$', '$$$$').replaceAll('"', '$\\"');

async function uninstallEntries(directory, relative = '') {
  const entries = [];
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.name.toLowerCase() === 'debug.log') continue;
    const name = relative ? join(relative, item.name) : item.name;
    const destination = `"$INSTDIR\\${escape(name)}"`;
    if (item.isDirectory()) {
      entries.push(...await uninstallEntries(join(directory, item.name), name), `RMDir ${destination}`);
    } else if (item.isFile()) {
      entries.push(`Delete ${destination}`);
    } else {
      throw new Error(`Unexpected entry in portable app: ${name}`);
    }
  }
  return entries;
}

await writeFile(manifest, (await uninstallEntries(packageDir)).join('\r\n') + '\r\n');
const result = spawnSync(compiler, [
  '/V3', `/DGLOVE_PACKAGE=${escape(packageDir)}`, `/DGLOVE_SETUP=${escape(setup)}`,
  `/DGLOVE_UNINSTALL_FILES=${escape(manifest)}`, `/DGLOVE_VERSION=${version}`,
  resolve('scripts/glove.nsi'),
], { stdio: 'inherit' });
if (result.error) throw new Error('Install the NSIS 3.13 compiler or set GLOVE_MAKENSIS to its makensis.exe path.', { cause: result.error });
if (result.status !== 0) process.exit(result.status || 1);
console.log(setup);
