// SPDX-License-Identifier: MIT
import { spawn } from 'node:child_process';
import electron from 'electron';
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1'], { stdio: 'inherit' });
let desktop;
let closing = false;
const close = () => { if (closing) return; closing = true; desktop?.kill(); server.kill(); };
process.on('SIGINT', close); process.on('SIGTERM', close);
server.on('exit', () => { close(); });
for (let attempt = 0; attempt < 100; attempt++) {
  if (closing) break;
  try { if ((await fetch('http://127.0.0.1:5190')).ok) { desktop = spawn(electron, ['.'], { stdio: 'inherit', env: { ...process.env, GLOVE_DEV_URL: 'http://127.0.0.1:5190' } }); desktop.on('exit', close); break; } } catch {}
  await new Promise(resolve => setTimeout(resolve, 100));
}
if (!desktop) { close(); process.exitCode = 1; }
