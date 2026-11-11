// SPDX-License-Identifier: MIT
import { readFile, writeFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
const lock = JSON.parse(await readFile('package-lock.json', 'utf8'));
const rows = [], notices = [];
for (const [location, metadata] of Object.entries(lock.packages)) {
  if (!location || metadata.dev || metadata.devOptional) continue;
  const manifest = JSON.parse(await readFile(path.join(location, 'package.json'), 'utf8'));
  const selected = manifest.name === 'node-forge' ? 'BSD-3-Clause' : metadata.license || manifest.license || 'SEE LICENSE';
  rows.push({ name: manifest.name, version: manifest.version, license: selected });
  const files = (await readdir(location)).filter(name => /^(?:licen[cs]e|copying|notice)(?:[._-]|$)/i.test(name));
  const texts = [];
  for (const file of files) { const filename = path.join(location, file); if ((await stat(filename)).isFile()) texts.push(`File: ${file}\n${await readFile(filename, 'utf8')}`); }
  if (!texts.length && manifest.name === '@fluentui/react-icons') texts.push('Source: https://github.com/microsoft/fluentui-system-icons/blob/main/LICENSE\n' + await readFile('third-party/fluent-system-icons-LICENSE.txt', 'utf8'));
  if (!texts.length) throw new Error(`No license notice found for ${manifest.name}`);
  notices.push(`${manifest.name} ${manifest.version}\nSelected license: ${selected}\n${texts.join('\n\n')}`);
}
rows.sort((a,b) => a.name.localeCompare(b.name));
await writeFile('docs/dependency-licenses.json', JSON.stringify(rows, null, 2) + '\n');
await writeFile('THIRD-PARTY-NOTICES.txt', 'Glove original application code is MIT.\nDependencies retain their own licenses. node-forge is used under its BSD-3-Clause option.\nElectron and Chromium license notices are included beside Glove.exe in the Windows distribution.\nAndroid adb/scrcpy tools are not bundled; install official releases separately with their notices.\n\n' + notices.join('\n\n' + '='.repeat(72) + '\n\n'));
console.log(`Recorded ${rows.length} production dependencies and their license texts.`);
