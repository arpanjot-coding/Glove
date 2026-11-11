// SPDX-License-Identifier: MIT
import assert from 'node:assert/strict';
import { createHash, X509Certificate } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { request } from 'node:https';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { PersonalService } from '../src/personal/service.mjs';

const notification = { id: 'test_revision_1', title: 'Test sender', body: 'Synthetic message', app: 'Glove fixture', time: 42, replyable: true };

async function fixture(t) {
  const dataDir = await mkdtemp(join(tmpdir(), 'glove-personal-test-'));
  const options = { dataDir, host: '127.0.0.1', address: () => '127.0.0.1' };
  const service = new PersonalService({ ...options, port: 0 });
  let restarted;
  t.after(async () => {
    await Promise.all([service.stop(), restarted?.stop()]);
    await rm(dataDir, { recursive: true, force: true });
  });
  const qr = JSON.parse((await service.startPairing()).pairing.payload);
  const certDir = join(dataDir, 'tls');
  const ca = await readFile(join(certDir, 'root-ca.pem'));
  const leaf = new X509Certificate(await readFile(join(certDir, 'server.pem')));
  assert.equal(qr.fingerprint, createHash('sha256').update(leaf.raw).digest('hex'));

  const post = (route, secret, payload = {}, headers = {}) => new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = request(qr.url + route, {
      method: 'POST', ca, servername: 'localhost',
      headers: {
        'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
        Authorization: 'Bearer ' + secret, ...headers,
      },
    }, res => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('error', reject);
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks)) }));
    });
    req.on('error', reject);
    req.end(body);
  });
  const pair = async () => {
    const { body } = await post('/v1/pair/request', qr.token, { name: 'Test phone' });
    assert.match(body.code, /^\d{6}$/);
    assert.equal(service.snapshot().request.code, body.code);
    await service.approvePairing(service.snapshot().request.id);
    return body.ticket;
  };
  const restart = async () => {
    await service.stop();
    restarted = new PersonalService({ ...options, port: Number(new URL(qr.url).port) });
    await restarted.restore();
    return restarted;
  };
  return { service, qr, post, pair, restart, dataDir };
}

test('personal QR approval grants one Android ticket, separately from ADB and file sharing', async t => {
  const { service, qr, post } = await fixture(t);
  assert.equal((await post('/v1/pair/request', 'x'.repeat(43), { name: 'Unknown' })).status, 401);
  assert.equal((await post('/v1/pair/request', qr.token, { name: 'Browser' }, { Origin: qr.url })).status, 403);
  const { body: { ticket, code } } = await post('/v1/pair/request', qr.token, { name: 'Test phone' });
  const { id } = service.snapshot().request;
  assert.deepEqual(service.snapshot().request, { id, name: 'Test phone', code });
  assert.equal((await post('/v1/pair/status', ticket)).body.state, 'pending');
  assert.equal((await post('/v1/sync', ticket, { access: true, notifications: [notification] })).status, 401);
  await service.approvePairing(id);
  assert.equal((await post('/v1/pair/status', ticket)).body.state, 'paired');
  assert.equal((await post('/v1/pair/request', qr.token, { name: 'Replay' })).status, 401);
  assert.equal((await post('/v1/sync', ticket, { access: true, notifications: [notification] })).status, 200);
  assert.deepEqual(service.snapshot().notifications, [notification]);
  assert.doesNotMatch(JSON.stringify(service.snapshot()), new RegExp(ticket));
});

test('denial invalidates the QR and informs the waiting phone', async t => {
  const { service, qr, post } = await fixture(t);
  const { body: { ticket } } = await post('/v1/pair/request', qr.token, { name: 'Test phone' });
  await service.stopPairing();
  assert.equal((await post('/v1/pair/status', ticket)).body.state, 'denied');
  assert.equal((await post('/v1/pair/request', qr.token, { name: 'Replay' })).status, 401);
  assert.equal(service.snapshot().device, null);
});

test('Personal shutdown closes sockets still negotiating TLS', { timeout: 2500 }, async t => {
  const { service, qr } = await fixture(t);
  const socket = connect(Number(new URL(qr.url).port), '127.0.0.1');
  t.after(() => socket.destroy());
  await new Promise((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  const closed = new Promise(resolve => socket.once('close', resolve));
  await service.stopPairing();
  await closed;
});

test('concurrent pairing operations cannot revive a canceled code or approve another phone', async t => {
  const { service, qr, post } = await fixture(t);
  const repeated = await Promise.all([service.startPairing(), service.startPairing()]);
  assert.ok(repeated.every(state => state.pairing.payload === JSON.stringify(qr)));
  const { body: first } = await post('/v1/pair/request', qr.token, { name: 'First phone' });
  const firstId = service.snapshot().request.id;
  const [, next] = await Promise.all([service.stopPairing(firstId), service.startPairing()]);
  const nextQr = JSON.parse(next.pairing.payload);
  assert.notEqual(nextQr.token, qr.token);
  const { body: second } = await post('/v1/pair/request', nextQr.token, { name: 'Second phone' });
  await assert.rejects(service.approvePairing(firstId), /expired/);
  await assert.rejects(service.stopPairing(firstId), /expired/);
  assert.equal((await post('/v1/pair/revoke', first.ticket)).status, 200);
  assert.equal((await post('/v1/pair/status', second.ticket)).body.state, 'pending');
  assert.equal((await post('/v1/pair/revoke', second.ticket)).body.state, 'denied');
  assert.equal(service.snapshot().request, null);
});

test('forgetting from the phone revokes its credential and clears queued Windows replies', async t => {
  const { service, post, pair, dataDir } = await fixture(t);
  const ticket = await pair();
  const payload = { access: true, notifications: [notification] };
  await post('/v1/sync', ticket, payload);
  service.sendReply(notification.id, 'Pending reply');
  assert.equal((await post('/v1/pair/revoke', ticket)).body.state, 'denied');
  assert.equal(service.snapshot().device, null);
  assert.equal(service.snapshot().reply, null);
  assert.deepEqual(service.snapshot().notifications, []);
  assert.equal((await post('/v1/sync', ticket, payload)).status, 401);
  await assert.rejects(readFile(join(dataDir, 'device.json')), { code: 'ENOENT' });
});

test('personal quick replies are sent once to the current action and report submission', async t => {
  const { service, post, pair } = await fixture(t);
  const ticket = await pair();
  const payload = { access: true, notifications: [notification] };
  await post('/v1/sync', ticket, payload);
  assert.throws(() => service.sendReply('missing', 'Test'), /no longer available/);
  assert.throws(() => service.sendReply(notification.id, ' '), /Enter a reply/);
  const { reply } = service.sendReply(notification.id, 'Test response');
  assert.equal(reply.status, 'pending');
  assert.throws(() => service.sendReply(notification.id, 'Duplicate'), /Wait for the current reply/);
  assert.deepEqual((await post('/v1/sync', ticket, payload)).body.command, {
    id: reply.id, notificationId: notification.id, text: 'Test response',
  });
  assert.equal((await post('/v1/sync', ticket, payload)).body.command, null);
  await post('/v1/sync', ticket, { ...payload, result: { id: reply.id, status: 'submitted' } });
  assert.equal(service.snapshot().reply.status, 'submitted');
  service.sendReply(notification.id, 'Stale reply');
  assert.equal((await post('/v1/sync', ticket, { access: true, notifications: [] })).body.command, null);
  assert.equal(service.snapshot().reply.status, 'expired');
});

test('locking and pausing clear content, discard queued replies, and survive restart when paused', async t => {
  const { service, post, pair, restart, dataDir } = await fixture(t);
  const ticket = await pair();
  const payload = { access: true, notifications: [notification] };
  await post('/v1/sync', ticket, payload);
  service.sendReply(notification.id, 'Must not be sent');
  service.setLocked(true);
  assert.deepEqual(service.snapshot().notifications, []);
  assert.deepEqual((await post('/v1/sync', ticket, payload)).body, { command: null, paused: true });
  service.setLocked(false);
  await service.setPaused(true);
  const saved = await readFile(join(dataDir, 'device.json'), 'utf8');
  assert.equal(JSON.parse(saved).paused, true);
  assert.equal(saved.includes(ticket) || saved.includes(notification.body), false);
  const reopened = await restart();
  assert.equal(reopened.snapshot().paused, true);
  assert.equal((await post('/v1/sync', ticket, payload)).body.paused, true);
  assert.deepEqual(reopened.snapshot().notifications, []);
  await reopened.setPaused(false);
  await post('/v1/sync', ticket, payload);
  await post('/v1/sync', ticket, { access: false, notifications: [] });
  assert.deepEqual(reopened.snapshot().notifications, []);
  await reopened.forget();
  assert.equal(reopened.snapshot().device, null);
  const freshQr = JSON.parse((await reopened.startPairing()).pairing.payload);
  assert.notEqual(freshQr.token, ticket);
  assert.equal((await post('/v1/sync', ticket, payload)).status, 401);
});
