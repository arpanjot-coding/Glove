// SPDX-License-Identifier: MIT
import { packager } from '@electron/packager';
import { spawnSync } from 'node:child_process';
import { copyFile, stat } from 'node:fs/promises';
for (const script of ['scripts/brand.mjs', 'scripts/licenses.mjs']) { const result = spawnSync(process.execPath, [script], { stdio: 'inherit' }); if (result.status !== 0) process.exit(result.status || 1); }
const companionApk = 'android/out/Glove-Companion.apk';
const hasCompanion = await stat(companionApk).then(file => file.isFile()).catch(() => false);
const output = await packager({
  dir: '.', out: 'release', name: 'Glove', executableName: 'Glove',
  platform: 'win32', arch: 'x64', icon: 'assets/glove.ico',
  appCopyright: 'Copyright 2026 Glove contributors',
  overwrite: true, asar: true, prune: false,
  extraResource: ['src/mcp', 'skills/glove-mobile-qa', ...(hasCompanion ? [companionApk] : [])],
  ignore: [
    /^\/(?:android|release|test|docs|site|skills|scripts|third-party|\.github|\.git)(?:\/|$)/,
    /^\/src\/(?:ui|mcp)(?:\/|$)/,
    /^\/vite.config.mjs$/, /^\/tsconfig.json$/,
    // Vite bundles the renderer's dependencies. Only the certificate provider
    // is imported by the desktop runtime.
    /^\/node_modules\/(?!node-forge(?:\/|$))/,
    /^\/node_modules\/node-forge\/(?:dist|flash)(?:\/|$)/
  ]
});
for (const destination of output) {
  await copyFile('LICENSE', `${destination}/LICENSE.glove.txt`);
  await copyFile('THIRD-PARTY-NOTICES.txt', `${destination}/THIRD-PARTY-NOTICES.txt`);
  await copyFile('START HERE.txt', `${destination}/START HERE.txt`);
  await copyFile('docs/MCP.md', `${destination}/MCP.md`);
}
console.log(output.join('\n'));
