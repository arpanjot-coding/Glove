// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createAndroidTools } from '../src/mcp/android-tools.mjs';

const fixture = fileURLToPath(new URL('./mcp-fixture.mjs', import.meta.url));
const cli = fileURLToPath(new URL('../src/mcp/main.mjs', import.meta.url));
const parameters = {
  protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'glove-test', version: '1' }
};

function connectFixture(t, mode) {
  const child = spawn(process.execPath, [fixture, mode], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const closed = once(child, 'close');
  child.stdin.on('error', () => {});
  const messages = new Map();
  let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => {
    const message = JSON.parse(line);
    assert.equal(message.jsonrpc, '2.0');
    const pending = messages.get(message.id);
    assert.ok(pending, 'response must match a pending request');
    messages.delete(message.id);
    pending.resolve(message);
  });
  t.after(async () => {
    child.stdin.end();
    const timer = setTimeout(() => child.kill(), 1000);
    try {
      const [code] = await closed;
      assert.equal(code, 0, 'fixture exits cleanly when its MCP client disconnects');
    } finally {
      clearTimeout(timer);
      lines.close();
    }
  });
  const send = message => child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n');
  function request(method, params) {
    const requestId = ++id;
    const pending = Promise.withResolvers();
    messages.set(requestId, pending);
    send({ id: requestId, method, params });
    return { id: requestId, result: pending.promise };
  }
  async function initialize(protocolVersion = parameters.protocolVersion) {
    const response = await request('initialize', { ...parameters, protocolVersion }).result;
    send({ method: 'notifications/initialized' });
    return response.result;
  }
  return { send, request, initialize, call: (name, args = {}) => request('tools/call', { name, arguments: args }).result };
}

test('MCP discovery lists authorized devices and withholds screen tools until a device is selected', { timeout: 5000 }, async t => {
  const client = connectFixture(t, 'list');
  assert.equal((await client.request('tools/list').result).error.code, -32002);
  const hello = await client.initialize('2024-11-05');
  assert.equal(hello.protocolVersion, '2024-11-05');
  assert.deepEqual(hello.capabilities, { tools: {} });
  const listing = await client.request('tools/list').result;
  assert.deepEqual(listing.result.tools.map(tool => tool.name), ['android_list_devices']);
  const devices = (await client.call('android_list_devices')).result.structuredContent.devices;
  assert.deepEqual(devices, [
    { serial: '192.0.2.12:37123', model: 'Fixture Phone', connection: 'wireless' },
    { serial: 'emulator-5554', model: 'Test Emulator', connection: 'emulator' }
  ]);
  assert.equal((await client.call('android_screenshot')).error.code, -32602);
});

test('MCP returns a screenshot for its bound device and rejects requests to change the target', { timeout: 5000 }, async t => {
  const client = connectFixture(t, 'bound');
  assert.equal((await client.initialize('2999-01-01')).protocolVersion, parameters.protocolVersion);
  assert.deepEqual((await client.request('tools/list').result).result.tools.map(tool => tool.name), ['android_list_devices', 'android_screenshot']);
  const devices = (await client.call('android_list_devices')).result.structuredContent.devices;
  assert.equal(devices.length, 1);
  assert.equal(devices[0].serial, '192.0.2.12:37123');
  assert.equal((await client.call('android_screenshot', { device: 'emulator-5554' })).result.isError, true);
  assert.equal((await client.call('android_tap', { x: 0, y: 0 })).error.code, -32602);
  const response = await client.call('android_screenshot');
  const image = response.result.content[0];
  assert.equal(image.type, 'image');
  assert.equal(image.mimeType, 'image/png');
  assert.equal(Buffer.from(image.data, 'base64').toString('ascii', 1, 4), 'PNG');
});

test('explicit UI input accepts bounded gestures only after a fresh screenshot', { timeout: 5000 }, async t => {
  const client = connectFixture(t, 'input');
  await client.initialize();
  assert.equal((await client.call('android_tap', { x: 0, y: 0 })).result.isError, true);
  assert.equal((await client.call('android_tap', { x: '0; echo nope', y: 0 })).result.isError, true);
  assert.equal((await client.call('android_tap', { x: 0, y: 0, command: 'shell' })).result.isError, true);
  await client.call('android_screenshot');
  assert.equal((await client.call('android_tap', { x: 1, y: 0 })).result.isError, true);
  assert.match((await client.call('android_tap', { x: 0, y: 0 })).result.content[0].text, /^Tap sent/);
  assert.equal((await client.call('android_tap', { x: 0, y: 0 })).result.isError, true);
  await client.call('android_screenshot');
  assert.equal((await client.call('android_swipe', { x1: 0, y1: 0, x2: 0, y2: 0, durationMs: 2000 })).result.isError, true);
  assert.match((await client.call('android_swipe', { x1: 0, y1: 0, x2: 0, y2: 0 })).result.content[0].text, /^Swipe sent/);
  assert.match((await client.call('android_back')).result.content[0].text, /^Back sent/);
});

test('MCP rejects overlapping operations and remains responsive during cancellation', { timeout: 5000 }, async t => {
  const client = connectFixture(t, 'slow');
  await client.initialize();
  const screenshot = client.request('tools/call', { name: 'android_screenshot' });
  assert.match((await client.call('android_list_devices')).result.content[0].text, /in progress/);
  client.send({ method: 'notifications/cancelled', params: { requestId: screenshot.id } });
  assert.deepEqual((await client.request('ping').result).result, {});
  assert.equal((await client.call('android_list_devices')).result.structuredContent.devices.length, 1);
});

test('a reconnected Android transport needs a new screenshot before receiving a tap', { timeout: 5000 }, async t => {
  const client = connectFixture(t, 'reconnect');
  await client.initialize();
  assert.equal((await client.call('android_screenshot')).result.content[0].type, 'image');
  const stale = await client.call('android_tap', { x: 0, y: 0 });
  assert.match(stale.result.content[0].text, /connection or screenshot changed/);
  assert.match((await client.call('android_tap', { x: 0, y: 0 })).result.content[0].text, /fresh screenshot/);
  await client.call('android_screenshot');
  assert.match((await client.call('android_tap', { x: 0, y: 0 })).result.content[0].text, /^Tap sent/);
});

test('a screenshot cancelled before its runner settles cannot authorize a tap', async () => {
  const controller = new AbortController();
  const tools = createAndroidTools({
    device: 'emulator-5554',
    allowInput: true,
    async run(args) {
      if (args[0] === 'devices') return Buffer.from('emulator-5554 device transport_id:8');
      controller.abort();
      return Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5eUAAAAASUVORK5CYII=', 'base64');
    }
  });
  await assert.rejects(tools.get('android_screenshot').call({}, controller.signal), { name: 'AbortError' });
  await assert.rejects(tools.get('android_tap').call({ x: 0, y: 0 }), /fresh screenshot/);
});

test('MCP CLI rejects an invalid ADB path or port before producing protocol output', { timeout: 5000 }, async () => {
  const executable = process.platform === 'win32' ? 'adb.exe' : 'adb';
  for (const [args, error] of [
    [['--adb', executable], /absolute path/],
    [['--adb', resolve(executable), '--adb-port', '65536'], /between 1 and 65535/]
  ]) {
    const child = spawn(process.execPath, [cli, ...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', value => { stdout += value; });
    child.stderr.on('data', value => { stderr += value; });
    const [code] = await once(child, 'close');
    assert.equal(code, 1);
    assert.equal(stdout, '');
    assert.match(stderr, error);
  }
});
