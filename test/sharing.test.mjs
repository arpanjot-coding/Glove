// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { ShareService, MAX_UPLOAD_BYTES } from '../src/sharing/service.mjs';

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'glove-sharing-test-'));
  const receiveDir = path.join(root, 'received');
  const changes = [];
  const service = new ShareService({ receiveDir, onChange: snapshot => changes.push(snapshot) });
  t.after(async () => { await service.stop(); await rm(root, { recursive: true, force: true }); });
  const session = await service.start({ host: '127.0.0.1' });
  const base = `http://127.0.0.1:${session.port}/s/${session.token}/`;
  return { root, receiveDir, service, session, base, changes };
}

function request(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers, agent: false }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => {
        const bytes = Buffer.concat(chunks);
        resolve({ status: res.statusCode, headers: res.headers, bytes, json: () => JSON.parse(bytes.toString()) });
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

function upload(base, name, bytes) {
  return request(`${base}api/upload?name=${encodeURIComponent(name)}`, { method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(bytes.length) }, body: bytes });
}

async function eventually(predicate, message) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await predicate()) return;
    await delay(20);
  }
  assert.fail(message);
}

test('real loopback handoff lists and downloads exactly the explicitly added bytes', async t => {
  const { root, service, base, changes } = await fixture(t);
  const bytes = Buffer.from(Array.from({ length: 131_113 }, (_, i) => (i * 71) % 256));
  const selected = path.join(root, 'selected ü.bin');
  await writeFile(selected, bytes);
  const snapshot = await service.addFiles([selected, selected]);
  assert.equal(snapshot.items.length, 1, 'duplicate selections do not consume list entries');
  assert.equal(snapshot.items[0].direction, 'to-phone');
  assert.equal(snapshot.items[0].size, bytes.length);
  assert.ok(!JSON.stringify(snapshot).includes(root), 'desktop paths are not exposed over HTTP');
  const listing = await request(`${base}api/items`);
  assert.equal(listing.status, 200);
  assert.deepEqual(listing.json().items, snapshot.items);
  const file = await request(`${base}files/${snapshot.items[0].id}`);
  assert.equal(file.status, 200);
  assert.deepEqual(file.bytes, bytes);
  assert.match(file.headers['content-disposition'], /^attachment;/);
  assert.match(file.headers['content-disposition'], /filename\*=UTF-8''/);
  assert.equal(file.headers['access-control-allow-origin'], undefined);
  const head = await request(`${base}files/${snapshot.items[0].id}`, { method: 'HEAD' });
  assert.equal(head.status, 200);
  assert.equal(Number(head.headers['content-length']), bytes.length);
  assert.equal(head.bytes.length, 0);
  assert.equal(changes.at(-1).items[0].id, snapshot.items[0].id);
  assert.equal(service.remove(snapshot.items[0].id).items.length, 0);
  assert.deepEqual(await readFile(selected), bytes, 'removing a share does not delete a file');
  assert.equal((await request(`${base}files/${snapshot.items[0].id}`)).status, 404);
});

test('raw uploads preserve bytes, sanitize traversal, avoid collisions, and notify desktop', async t => {
  const { root, receiveDir, service, base, changes } = await fixture(t);
  const bytes = Buffer.from(Array.from({ length: 67_001 }, (_, i) => i % 256));
  await writeFile(path.join(receiveDir, 'photo.bin'), 'existing');
  const incoming = await upload(base, '../../outside\\photo.bin', bytes);
  assert.equal(incoming.status, 201);
  const item = incoming.json().item;
  assert.equal(item.name, 'photo (1).bin');
  assert.equal(item.direction, 'from-phone');
  assert.equal(item.size, bytes.length);
  assert.deepEqual(await readFile(path.join(receiveDir, item.name)), bytes);
  assert.equal(await readFile(path.join(receiveDir, 'photo.bin'), 'utf8'), 'existing');
  assert.deepEqual(await readdir(root), ['received']);
  assert.deepEqual((await request(`${base}files/${item.id}`)).bytes, bytes);
  assert.equal(changes.at(-1).items.at(-1).id, item.id);
  const reserved = await upload(base, 'CON.txt', Buffer.from('device-name'));
  assert.equal(reserved.status, 201);
  assert.equal(reserved.json().item.name, '_CON.txt');
  const empty = await upload(base, 'empty.txt', Buffer.alloc(0));
  assert.equal(empty.status, 201);
  assert.equal((await readFile(path.join(receiveDir, 'empty.txt'))).length, 0);
  const emoji = await upload(base, '😀'.repeat(120) + '.txt', Buffer.from('unicode'));
  assert.equal(emoji.status, 201);
  assert.ok(emoji.json().item.name.length <= 160);
  assert.ok((await readdir(receiveDir)).every(name => !name.endsWith('.part')));
  assert.equal(service.snapshot().items.length, 4);
});

test('wrong or expired tokens, arbitrary paths and cross-origin uploads are refused', async t => {
  const { base, session, service, receiveDir } = await fixture(t);
  const wrong = base.replace(session.token, 'a'.repeat(43));
  assert.equal((await request(wrong)).status, 404);
  assert.equal((await request(`${wrong}api/items`)).status, 404);
  assert.equal((await upload(wrong, 'denied.txt', Buffer.from('no'))).status, 404);
  assert.equal((await request(`${base}files/not-a-file-id?path=C:/Windows/win.ini`)).status, 404);
  assert.equal((await request(`${base}files/${'a'.repeat(32)}`)).status, 404);
  const crossOrigin = await request(`${base}api/upload?name=denied.txt`, { method: 'POST', body: 'no',
    headers: { Origin: 'https://example.invalid', 'Content-Type': 'application/octet-stream' } });
  assert.equal(crossOrigin.status, 403);
  assert.equal(crossOrigin.headers['access-control-allow-origin'], undefined);
  assert.deepEqual(await readdir(receiveDir), []);
  await service.stop();
  assert.deepEqual(service.snapshot(), { running: false, port: null, urls: [], items: [] });
  const restarted = await service.start({ host: '127.0.0.1', port: session.port });
  assert.notEqual(restarted.token, session.token);
  assert.equal((await request(base)).status, 404, 'old tokens stay invalid after a restart on the same port');
  assert.equal((await request(restarted.urls[0])).status, 200);
});

test('oversized declarations and unsupported encodings fail before creating any files', async t => {
  const { base, receiveDir, service } = await fixture(t);
  // Deliberately send only headers: a server must reject without buffering a huge body.
  const oversized = await request(`${base}api/upload?name=too-big.bin`, { method: 'POST',
    headers: { 'Content-Length': String(MAX_UPLOAD_BYTES + 1), 'Content-Type': 'application/octet-stream' } });
  assert.equal(oversized.status, 413);
  const encoded = await request(`${base}api/upload?name=compressed.bin`, { method: 'POST', body: 'abc',
    headers: { 'Content-Encoding': 'gzip', 'Content-Type': 'application/octet-stream' } });
  assert.equal(encoded.status, 415);
  assert.equal(service.snapshot().items.length, 0);
  assert.deepEqual(await readdir(receiveDir), []);
});

test('a disconnected upload is cleaned up without publishing a partial item', async t => {
  const { base, receiveDir, service } = await fixture(t);
  const req = http.request(`${base}api/upload?name=partial.bin`, { method: 'POST', agent: false,
    headers: { 'Content-Length': '1000000', 'Content-Type': 'application/octet-stream' } });
  req.on('error', () => {});
  req.write(Buffer.alloc(16_384, 7));
  await eventually(async () => (await readdir(receiveDir)).some(name => name.endsWith('.part')), 'temporary file was never created');
  req.destroy();
  await eventually(async () => (await readdir(receiveDir)).length === 0, 'partial upload was not removed');
  assert.equal(service.snapshot().items.length, 0);
  assert.equal((await upload(base, 'after-cancel.bin', Buffer.from('works'))).status, 201);
});

test('chunked raw-byte uploads work without a Content-Length header', async t => {
  const { base, receiveDir } = await fixture(t);
  const chunks = [Buffer.from([0, 255, 128, 1]), Buffer.alloc(77_777, 91), Buffer.from('end')];
  const response = await new Promise((resolve, reject) => {
    const req = http.request(`${base}api/upload?name=chunked.bin`, { method: 'POST', agent: false,
      headers: { 'Content-Type': 'application/octet-stream' } }, res => {
      const result = [];
      res.on('data', chunk => result.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode, result: JSON.parse(Buffer.concat(result)) }));
      res.on('error', reject);
    });
    req.on('error', reject);
    for (const chunk of chunks) req.write(chunk);
    req.end();
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await readFile(path.join(receiveDir, response.result.item.name)), Buffer.concat(chunks));
});

test('concurrent upload slots and request rates are bounded', async t => {
  const { base, receiveDir, service } = await fixture(t);
  const pending = [];
  for (let i = 0; i < 3; i++) {
    const req = http.request(`${base}api/upload?name=pending-${i}.bin`, { method: 'POST', agent: false,
      headers: { 'Content-Length': '1000000', 'Content-Type': 'application/octet-stream' } });
    req.on('error', () => {});
    req.write('not-finished');
    pending.push(req);
  }
  await eventually(async () => (await readdir(receiveDir)).length === 3, 'concurrent uploads did not start');
  assert.equal((await upload(base, 'fourth.bin', Buffer.from('no'))).status, 429);
  pending.forEach(req => req.destroy());
  await eventually(async () => (await readdir(receiveDir)).length === 0, 'concurrent temporary files were not removed');
  let limited = false;
  for (let i = 0; i < 85; i++) {
    const response = await request(`${base}api/items`);
    if (response.status === 429) { limited = true; assert.equal(response.headers['retry-after'], '3'); break; }
    assert.equal(response.status, 200);
  }
  assert.equal(limited, true, 'requests must be rate-limited');
  assert.equal(service.snapshot().items.length, 0);
});

test('stopping during an upload closes the connection and waits for partial-file cleanup', async t => {
  const { base, receiveDir, service } = await fixture(t);
  const req = http.request(`${base}api/upload?name=stopped.bin`, { method: 'POST', agent: false,
    headers: { 'Content-Length': '1000000', 'Content-Type': 'application/octet-stream' } });
  req.on('error', () => {});
  req.write(Buffer.alloc(16_384));
  await eventually(async () => (await readdir(receiveDir)).length > 0, 'upload did not start');
  await service.stop();
  assert.deepEqual(await readdir(receiveDir), []);
  assert.equal(service.snapshot().running, false);
  assert.equal(service.snapshot().items.length, 0);
  req.destroy();
});

test('phone document is self-contained, responsive, and protected by a nonce policy', async t => {
  const { base } = await fixture(t);
  const page = await request(base);
  assert.equal(page.status, 200);
  assert.match(page.headers['content-security-policy'], /script-src 'nonce-/);
  assert.equal(page.headers['referrer-policy'], 'no-referrer');
  assert.equal(page.headers['x-frame-options'], 'DENY');
  const html = page.bytes.toString();
  assert.match(html, /name="viewport"/);
  assert.match(html, /type="file" multiple/);
  assert.match(html, /fetch\(endpoint/);
  assert.match(html, /HTTP connection is not encrypted/);
  assert.doesNotMatch(html, /<script[^>]+src=/i);
  const short = await request(base.slice(0, -1));
  assert.equal(short.status, 308);
  assert.equal(short.headers.location, new URL(base).pathname);
});

test('selections are validated as a batch and file-count limits reject before filesystem work', async t => {
  const { root, service } = await fixture(t);
  await writeFile(path.join(root, 'ok.txt'), 'ok');
  await mkdir(path.join(root, 'directory'));
  await assert.rejects(service.addFiles([path.join(root, 'ok.txt'), path.join(root, 'directory')]), /regular files/);
  assert.equal(service.snapshot().items.length, 0);
  await assert.rejects(service.addFiles(Array(501).fill(path.join(root, 'missing'))), /500 files/);
  assert.equal(service.snapshot().items.length, 0);
});

test('receive folder changes are validated between sessions and new uploads use only the new folder', async t => {
  const { root, receiveDir, service, base } = await fixture(t);
  const newDirectory = path.join(root, 'new-destination');
  await mkdir(newDirectory);
  await assert.rejects(service.setReceiveDir(newDirectory), /Stop file sharing/);
  assert.equal((await upload(base, 'before.txt', Buffer.from('original destination'))).status, 201);
  await service.stop();
  await assert.rejects(service.setReceiveDir(''), /receive folder is required/);
  await assert.rejects(service.setReceiveDir(path.join(receiveDir, 'before.txt')), /must be a directory/);
  await assert.rejects(service.setReceiveDir(path.join(root, 'missing')), { code: 'ENOENT' });

  const starting = service.start({ host: '127.0.0.1' });
  await assert.rejects(service.setReceiveDir(newDirectory), /Stop file sharing/);
  await starting;
  const stopping = service.stop();
  await assert.rejects(service.setReceiveDir(newDirectory), /Stop file sharing/);
  await stopping;

  await service.setReceiveDir(newDirectory);
  const restarted = await service.start({ host: '127.0.0.1' });
  const incoming = await upload(restarted.urls[0], 'after.txt', Buffer.from('new destination'));
  assert.equal(incoming.status, 201);
  assert.deepEqual(await readdir(receiveDir), ['before.txt']);
  assert.deepEqual(await readdir(newDirectory), ['after.txt']);
  assert.equal(await readFile(path.join(newDirectory, 'after.txt'), 'utf8'), 'new destination');
  assert.equal(await readFile(path.join(receiveDir, 'before.txt'), 'utf8'), 'original destination');
});
