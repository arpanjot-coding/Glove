// SPDX-License-Identifier: MIT
import { realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { parseArgs } from 'node:util';
import { createAdbRunner, createAndroidTools } from './android-tools.mjs';
import { serveMcp } from './protocol.mjs';

const usage = 'Usage: node src/mcp/main.mjs --adb <absolute adb.exe path> [--adb-port <port>] [--device <serial>] [--allow-input]';

try {
  const { values } = parseArgs({
    options: {
      adb: { type: 'string' },
      'adb-port': { type: 'string', default: '5037' },
      device: { type: 'string' },
      'allow-input': { type: 'boolean' },
      help: { type: 'boolean', short: 'h' }
    }
  });
  if (values.help) {
    console.log(usage);
  } else {
    const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
    if (!values.adb || !isAbsolute(values.adb) || basename(values.adb).toLowerCase() !== executable) {
      throw new Error('Set --adb to the absolute path of the official Android platform-tools executable.');
    }
    const port = Number(values['adb-port']);
    if (!/^\d{1,5}$/.test(values['adb-port']) || port < 1 || port > 65535) {
      throw new Error('Set --adb-port to a loopback port number between 1 and 65535.');
    }
    const adb = await realpath(values.adb).catch(() => null);
    if (!adb || !(await stat(adb).catch(() => null))?.isFile()) throw new Error('The configured ADB executable was not found.');
    const tools = createAndroidTools({ run: createAdbRunner(adb, port), device: values.device, allowInput: values['allow-input'] });
    // A client that exits while receiving a screenshot closes the output pipe.
    // Stop work promptly instead of raising an unhandled stream error.
    process.stdout.on('error', () => process.stdin.destroy());
    await serveMcp({ input: process.stdin, output: process.stdout, tools, version: '0.1.0' });
  }
} catch (error) {
  console.error('Glove MCP: ' + error.message + '\n' + usage);
  process.exitCode = 1;
}
