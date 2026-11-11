// SPDX-License-Identifier: MIT
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { endpoint, parseDevices, parseMdnsServices, AndroidService } from '../src/desktop/android.mjs';
test('wireless addresses validate IP and port without accepting options or shell syntax', () => {
  assert.equal(endpoint(' 192.168.1.42:37123 '), '192.168.1.42:37123');
  assert.equal(endpoint('[fe80::1]:5555'), '[fe80::1]:5555');
  for (const value of ['--listen', '127.0.0.1:0', '1.2.3.999:5000', '1.2.3.4:65536', '1.2.3.4:5 & calc.exe', undefined]) assert.throws(() => endpoint(value));
});
test('device parsing recognizes real space-aligned ADB rows and preserves authorization state', () => {
  const output = [
    'List of devices attached',
    'emulator-5580          device product:sdk_gslim_x86_64 model:Google_ATD_built_for_x86_64 device:emu64x transport_id:1',
    '192.168.1.2:5555\tdevice product:p model:Pixel_9 device:x transport_id:2',
    'ABC\tunauthorized',
    '* daemon started successfully',
  ].join('\r\n');
  assert.deepEqual(parseDevices(output), [
    { serial: 'emulator-5580', status: 'device', model: 'Google ATD built for x86 64' },
    { serial: '192.168.1.2:5555', status: 'device', model: 'Pixel 9' },
    { serial: 'ABC', status: 'unauthorized', model: 'ABC' },
  ]);
});
test('missing tools and invalid pairing codes return actionable failures', async () => {
  const service = new AndroidService({ getFolder: () => '' });
  assert.equal(await service.ready(), false);
  await assert.rejects(service.refresh(), /tools folder/);
  await assert.rejects(service.pair('192.168.1.2:5555', '123;45'), /six-digit/);
  await assert.rejects(service.startQr(), /tools folder/);
  assert.equal(service.snapshot().qr.active,false);
  assert.equal(service.snapshot().qr.status,'error');
});

const pause = ms => new Promise(resolve=>setTimeout(resolve,ms));
async function until(predicate,limit=1000) {
  const deadline=Date.now()+limit;
  while (!predicate()) {if(Date.now()>deadline) throw new Error('Timed out waiting for QR state.');await pause(5);}
}
function fakeAndroid(run,options={}) {
  const service = new AndroidService({getFolder:()=> 'C:\\Glove tools',qrPollMs:10,qrTimeoutMs:1000,...options});
  service.ready = async()=>true;
  service.run = run;
  return service;
}
const credentials = service => {
  const match=service.snapshot().qr.value.match(/^WIFI:T:ADB;S:(studio-[a-f0-9]+);P:([a-f0-9]{32});;$/);
  assert.ok(match,'the QR must use the Android Studio/AOSP payload and a 32-hex password');
  return {name:match[1],secret:match[2]};
};

test('mDNS parser validates IPv4/IPv6 endpoints and accepts trailing service-type dots',()=>{
  assert.deepEqual(parseMdnsServices('List of discovered mdns services\r\nstudio-abc\t_adb-tls-pairing._tcp.\t192.168.1.4:03542\r\nadb-GUID _adb-tls-connect._tcp [2001:db8::123]:36123\ninvalid _adb-tls-pairing._tcp --argument\nlegacy _adb._tcp 192.168.1.4:5555'),[
    {name:'studio-abc',type:'_adb-tls-pairing._tcp',address:'192.168.1.4:3542'},
    {name:'adb-GUID',type:'_adb-tls-connect._tcp',address:'[2001:db8::123]:36123'},
    {name:'legacy',type:'_adb._tcp',address:'192.168.1.4:5555'},
  ]);
});

test('QR pairs only its exact announced service and confirms authorized auto-connection',async()=>{
  const calls=[],statuses=[];
  let service,creds,scans=0,deviceChecks=0;
  const guid='adb-TEST-QR-GUID';
  service=fakeAndroid(async args=>{
    calls.push(args);
    if(args.join(' ')==='mdns check') return 'mdns daemon version [Openscreen discovery 0.0.0]';
    if(args.join(' ')==='mdns services') {
      scans++;
      if(scans===1) return 'studio-unrelated _adb-tls-pairing._tcp 192.168.1.90:37001';
      return `${creds.name} _adb-tls-pairing._tcp. 192.168.1.42:37002`;
    }
    if(args[0]==='pair') return `Successfully paired to 192.168.1.42:37002 [guid=${guid}]`;
    if(args[0]==='devices') return `${guid}._adb-tls-connect._tcp\t${++deviceChecks===1?'unauthorized':'device'} model:Pixel_9\nUNRELATED\tdevice model:Another`;
    throw new Error('Unexpected command');
  },{onChange:()=>statuses.push(service?.snapshot().qr.status)});
  try {
    const result=await service.startQr();
    assert.equal(result.qr.active,true);
    assert.ok(result.qr.expiresAt>Date.now());
    creds=credentials(service);
    await until(()=>service.snapshot().qr.status==='connected');
    assert.deepEqual(calls.filter(args=>args[0]==='pair'),[['pair','192.168.1.42:37002',creds.secret]]);
    assert.equal(calls.filter(args=>args[0]==='connect').length,0,'ADB auto-connection should not require guessing a port');
    assert.ok(deviceChecks>=2,'unauthorized state is not a connected device');
    assert.ok(statuses.includes('pairing')&&statuses.includes('connecting'));
    assert.equal(service.snapshot().qr.value,'');
    assert.equal(service.qrSecret,null);
    assert.equal(service.snapshot().qr.active,false);
  } finally {service.stop();}
});

test('fallback connects the paired GUID separate TLS endpoint, never the pairing endpoint',async()=>{
  const calls=[];
  let service,creds,connected=false;
  const guid='adb-IPV6-GUID';
  const target='[2001:db8::42]:38123';
  service=fakeAndroid(async args=>{
    calls.push(args);
    if(args.join(' ')==='mdns check') return 'mdns daemon version [Openscreen discovery 0.0.0]';
    if(args.join(' ')==='mdns services') return `${creds.name} _adb-tls-pairing._tcp [2001:db8::42]:39123\n${guid} _adb-tls-connect._tcp ${target}\nadb-OTHER _adb-tls-connect._tcp 192.168.1.10:5555`;
    if(args[0]==='pair') return `Successfully paired to [2001:db8::42]:39123 [guid=${guid}]`;
    if(args[0]==='devices') return connected ? `${target}\tdevice model:Pixel` : 'UNRELATED\tdevice model:Other';
    if(args[0]==='connect') {connected=true;return `connected to ${target}`;}
    throw new Error('Unexpected command');
  });
  try {
    await service.startQr();creds=credentials(service);
    await until(()=>service.snapshot().qr.status==='connected');
    assert.deepEqual(calls.filter(args=>args[0]==='connect'),[['connect',target]]);
  } finally {service.stop();}
});

test('QR cancellation invalidates in-flight discovery without overlapping polls or late pairing',async()=>{
  let service,creds,release;
  const calls=[];
  service=fakeAndroid(async args=>{
    calls.push(args);
    if(args.join(' ')==='mdns check') return 'mdns daemon version [Openscreen discovery 0.0.0]';
    if(args.join(' ')==='mdns services') return new Promise(resolve=>{release=()=>resolve(`${creds.name} _adb-tls-pairing._tcp 192.168.1.42:39000`);});
    throw new Error('No command should follow cancelled discovery');
  });
  await service.startQr();creds=credentials(service);
  await until(()=>!!release);
  await pause(40);
  assert.equal(calls.filter(args=>args[0]==='mdns'&&args[1]==='services').length,1,'a pending discovery command must not overlap another poll');
  const controller=service.qrController;
  service.stopQr();
  assert.equal(controller.signal.aborted,true);
  release();
  await pause(25);
  assert.equal(calls.some(args=>args[0]==='pair'),false);
  assert.equal(service.snapshot().qr.status,'cancelled');
  assert.equal(service.snapshot().qr.value,'');
  assert.equal(service.qrTimer,null);
  assert.equal(service.qrExpiryTimer,null);
});

test('QR expires, repeated starts rotate credentials, and stopping also closes mirroring',async()=>{
  let service;
  service=fakeAndroid(async args=>args[1]==='check'?'mdns daemon version [Openscreen discovery 0.0.0]':'List of discovered mdns services',{qrTimeoutMs:65});
  await service.startQr();
  const first=service.snapshot().qr.value;
  await service.startQr();
  assert.notEqual(service.snapshot().qr.value,first);
  await until(()=>service.snapshot().qr.status==='expired');
  assert.equal(service.snapshot().qr.active,false);
  assert.equal(service.snapshot().qr.value,'');
  let killed=false;
  service.spawnMirror=()=>Object.assign(new EventEmitter(), {stderr:new EventEmitter(), kill(){ killed=true; this.emit('close', 0); }});
  service.run=async()=> 'emulator-5554 device model:Test';
  await service.start('emulator-5554');
  service.stop();
  assert.equal(killed,true);
  assert.equal(service.mirror,null);
  assert.equal(service.qrTimer,null);
  assert.equal(service.qrExpiryTimer,null);
});

test('mirroring has one start in flight and cannot open a screen after Stop', async () => {
  const response = Promise.withResolvers();
  let opened = 0;
  const service = fakeAndroid(() => response.promise, { spawnMirror: () => { opened++; } });
  const start = service.start('emulator-5554');
  await assert.rejects(service.start('emulator-5556'), /already opening or open/);
  service.stop();
  response.resolve('emulator-5554 device model:Test');
  await assert.rejects(start, /opening the Android screen was cancelled/i);
  assert.equal(opened, 0);
  assert.equal(service.snapshot().mirroring, false);
});

test('mirroring waits for the old process to close and uses the selected ADB executable', async () => {
  const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter(), kill() {} });
  const service = fakeAndroid(async () => 'emulator-5554 device model:Test', {
    spawnMirror: (_file, args, options) => {
      assert.deepEqual(args.slice(0, 2), ['--serial', 'emulator-5554']);
      assert.match(options.env.ADB, /Glove tools[/\\]adb\.exe$/);
      return child;
    }
  });
  await service.start('emulator-5554');
  service.stop();
  await assert.rejects(service.start('emulator-5554'), /already opening or open/);
  child.emit('close', 0);
  assert.equal(service.snapshot().mirroring, false);
});

test('an old device refresh cannot overwrite a newer result or a changed tools folder', async () => {
  const first = Promise.withResolvers();
  const second = Promise.withResolvers();
  const third = Promise.withResolvers();
  const responses = [first, second, third];
  let folder = 'C:\\Glove tools';
  const service = fakeAndroid(() => responses.shift().promise, { getFolder: () => folder });
  const older = service.refresh();
  const newer = service.refresh();
  second.resolve('emulator-5556 device model:New');
  await newer;
  first.resolve('emulator-5554 device model:Old');
  assert.equal((await older)[0].serial, 'emulator-5556');
  const fromOldFolder = service.refresh();
  folder = 'C:\\Other tools';
  service.toolsChanged();
  third.resolve('emulator-5556 device model:New');
  await assert.rejects(fromOldFolder, /tools folder changed/);
  assert.deepEqual(service.snapshot().devices, []);
});

test('a failed manual ADB pair never returns the six-digit code', async () => {
  const service = fakeAndroid(async () => { throw new Error('adb pair exited unsuccessfully with 123456'); });
  await assert.rejects(service.pair('192.168.1.2:5555', '123456'), error =>
    /Pairing failed/.test(error.message) && !error.message.includes('123456'));
});

test('pair errors and missing discovery never expose QR credentials',async()=>{
  let service,creds;
  service=fakeAndroid(async args=>{
    if(args.join(' ')==='mdns check') return 'mdns daemon version [Openscreen discovery 0.0.0]';
    if(args.join(' ')==='mdns services') return `${creds.name} _adb-tls-pairing._tcp 192.168.1.42:39000`;
    throw new Error(`Command failed: adb pair 192.168.1.42:39000 ${creds.secret}`);
  });
  await service.startQr();creds=credentials(service);
  await until(()=>service.snapshot().qr.status==='error');
  assert.ok(!JSON.stringify(service.snapshot()).includes(creds.secret));
  assert.match(service.snapshot().qr.error,/Generate|generate/);
  service.stop();
  const unavailable=fakeAndroid(async()=> 'ERROR: mdns discovery unavailable');
  await assert.rejects(unavailable.startQr(),/discovery is unavailable/);
  assert.equal(unavailable.snapshot().qr.status,'error');
  assert.equal(unavailable.snapshot().qr.value,'');
  unavailable.stop();
});

test('successful pairing without an online device remains unconnected and explains manual fallback',async()=>{
  let service,creds;
  service=fakeAndroid(async args=>{
    if(args.join(' ')==='mdns check') return 'mdns daemon version [Openscreen discovery 0.0.0]';
    if(args.join(' ')==='mdns services') return `${creds.name} _adb-tls-pairing._tcp 192.168.1.42:39000`;
    if(args[0]==='pair') return 'Successfully paired to 192.168.1.42:39000 [guid=adb-NOT-ONLINE]';
    if(args[0]==='devices') return 'UNRELATED\tdevice model:Other';
    throw new Error('No connection port was advertised');
  },{qrTimeoutMs:100});
  await service.startQr();creds=credentials(service);
  await until(()=>service.snapshot().qr.status==='error');
  assert.match(service.snapshot().qr.error,/main Wireless debugging screen, not the pairing port/);
  assert.equal(service.snapshot().qr.active,false);
  service.stop();
});
