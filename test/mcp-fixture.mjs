// SPDX-License-Identifier: MIT
// Test-only Android runner for real MCP stdio transport checks.
import { setTimeout } from 'node:timers/promises';
import { createAndroidTools } from '../src/mcp/android-tools.mjs';
import { serveMcp } from '../src/mcp/protocol.mjs';

const mode = process.argv[2] ?? 'list';
const serial = '192.0.2.12:37123';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5eUAAAAASUVORK5CYII=', 'base64');
let transport = 8;

async function run(args, { signal }) {
  if (args.join(' ') === 'devices -l') {
    return Buffer.from([
      'List of devices attached',
      serial + '\tdevice product:test model:Fixture_Phone transport_id:' + transport,
      'emulator-5554\tdevice model:Test_Emulator',
      'ignored\tunauthorized model:Private',
      'disconnected\toffline',
      ''
    ].join('\n'));
  }
  if (args.join(' ') === '-t ' + transport + ' exec-out screencap -p') {
    if (mode === 'slow') await setTimeout(5000, undefined, { signal });
    if (mode === 'reconnect' && transport === 8) transport = 9;
    return png;
  }
  if ([
    'shell input tap 0 0',
    'shell input swipe 0 0 0 0 300',
    'shell input keyevent 4'
  ].some(command => args.join(' ') === '-t ' + transport + ' ' + command)) {
    return Buffer.alloc(0);
  }
  throw new Error('Unexpected ADB invocation in the test fixture.');
}

const tools = createAndroidTools({ run, device: mode === 'list' ? undefined : serial, allowInput: mode === 'input' || mode === 'reconnect' });
await serveMcp({ input: process.stdin, output: process.stdout, tools, version: '0.1.0-test' });
