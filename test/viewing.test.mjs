import test, {before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { connect } from 'node:net';
import { once } from 'node:events';
import vm from 'node:vm';
import {X509Certificate} from 'node:crypto';
import {ViewService} from '../src/viewing/service.mjs';
import {screenScript} from '../src/viewing/pages.mjs';

let folder,service,state;
const events = [];
function fetchLocal(url,{method='GET',headers={},body}={}) {
  return new Promise((resolve,reject) => {
    const target = new URL(url);
    const payload = body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body);
    const request = (target.protocol === 'https:' ? https : http).request(target, {
      method,
      // This test uses an isolated temporary CA; production never disables TLS verification.
      rejectUnauthorized:false,
      headers:{...(payload === undefined ? {} : {'Content-Type':'application/json','Content-Length':Buffer.byteLength(payload)}),...headers},
    }, response => {
      const chunks = [];
      response.on('data',chunk=>chunks.push(chunk));
      response.on('end',()=>resolve({status:response.statusCode,headers:response.headers,text:Buffer.concat(chunks).toString('utf8')}));
    });
    request.on('error',reject);
    request.end(payload);
  });
}
const sessionId = 'test-session-1234567890';
const offer = 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\ns=Glove test\r\nt=0 0\r\n';
const post = (route,body,extra={}) => fetchLocal(new URL(route,state.urls[0]),{method:'POST',body,headers:{Origin:new URL(state.urls[0]).origin,...extra}});

before(async()=>{
  folder = await fs.mkdtemp(path.join(os.tmpdir(),'glove-view-test-'));
  service = new ViewService({dataDir:folder,onChange:snapshot=>events.push(snapshot)});
  state = await service.start({host:'127.0.0.1'});
});
after(async()=>{
  await service?.stop();
  if (folder) await fs.rm(folder,{recursive:true,force:true});
});

test('real listeners provide explicit certificate setup and safe profile download',async()=>{
  assert.equal(state.running,true);
  assert.equal(state.connected,false);
  assert.equal(state.offer,null);
  assert.ok(state.port>0 && state.setupPort>0 && state.port!==state.setupPort);
  const setup = await fetchLocal(state.setupUrls[0]);
  assert.equal(setup.status,200);
  assert.match(setup.text,/iOS 27 or later/);
  assert.match(setup.text,/Certificate Trust Settings/);
  assert.match(setup.text,/actual downloaded certificate/);
  assert.match(setup.text,/If you cannot inspect/);
  assert.match(setup.text,/does not authenticate the downloaded profile/);
  assert.ok(setup.text.includes(state.fingerprint));
  assert.ok(setup.text.includes(state.urls[0]));
  const profile = await fetchLocal(new URL('glove.mobileconfig',state.setupUrls[0]));
  assert.equal(profile.status,200);
  assert.match(profile.headers['content-type'],/application\/x-apple-aspen-config/);
  assert.match(profile.text,/com.apple.security.root/);
  assert.doesNotMatch(profile.text,/PRIVATE KEY/);
  const der = Buffer.from(profile.text.match(/<data>([^<]+)<\/data>/)[1],'base64');
  const certificate = new X509Certificate(der);
  assert.equal(certificate.fingerprint256,state.fingerprint);
  assert.equal(certificate.ca,true);
  for (const filename of ['root-ca-key.pem','server-key.pem','root-ca.pem','server.pem']) {
    assert.equal((await fetchLocal(new URL(filename,state.setupUrls[0]))).status,404);
    assert.equal((await fetchLocal(new URL(filename,state.urls[0]))).status,404);
  }
  assert.equal((await fetchLocal(new URL('/setup/wrong/glove.mobileconfig',state.setupUrls[0]))).status,404);
  assert.equal((await fetchLocal(new URL('glove.mobileconfig',state.setupUrls[0]),{method:'POST',body:{}})).status,405);
});

test('screen page exposes supported API honestly and prevents cross-origin framing',async()=>{
  const page = await fetchLocal(state.urls[0]);
  assert.equal(page.status,200);
  assert.match(page.text,/iOS 27 or later/);
  assert.match(page.text,/Screen audio is not included/);
  assert.match(page.headers['content-security-policy'],/frame-ancestors 'none'/);
  assert.equal(page.headers['cache-control'],'no-store');
  const script = await fetchLocal(new URL('screen.js',state.urls[0]));
  assert.equal(script.status,200);
  assert.match(script.text,/getDisplayMedia\(\{video:true,audio:false\}\)/);
  assert.match(script.text,/iceServers:\[\]/);
  assert.match(script.text,/window.isSecureContext/);
  assert.doesNotThrow(()=>new vm.Script(script.text));
  assert.equal((await fetchLocal(new URL('/s/wrong/',state.urls[0]))).status,404);
  assert.equal((await fetchLocal(state.urls[0],{headers:{Host:'attacker.example:'+state.port}})).status,403);
});

test('signaling enforces token, Origin, body size, and one active session',async()=>{
  assert.equal((await fetchLocal(new URL('offer',state.urls[0]),{method:'POST',body:{sessionId,sdp:offer}})).status,403);
  assert.equal((await post('offer',{sessionId,sdp:offer},{Origin:'https://attacker.example'})).status,403);
  assert.equal((await post('offer',{sessionId:'short',sdp:offer})).status,400);
  assert.equal((await post('offer',{sessionId,sdp:'not SDP'})).status,400);
  assert.equal((await post('offer',{sessionId,sdp:'v=0'+ 'a'.repeat(270000)})).status,413);
  const response = await post('offer',{sessionId,sdp:offer});
  assert.equal(response.status,200);
  assert.deepEqual(service.snapshot().offer,{type:'offer',sdp:offer});
  assert.equal(service.snapshot().sessionId,sessionId);
  assert.equal(service.snapshot().connected,false);
  assert.equal(service.snapshot().status,'offer');
  assert.equal((await post('offer',{sessionId:'another-session-123456',sdp:offer})).status,409);
  assert.equal((await fetchLocal(new URL('answer?sessionId=wrong',state.urls[0]))).status,410);
  const pending = await fetchLocal(new URL('answer?sessionId='+sessionId,state.urls[0]));
  assert.deepEqual(JSON.parse(pending.text),{answer:null,connected:false});
  const copy = service.snapshot();
  copy.offer.sdp = 'changed externally';
  assert.equal(service.snapshot().offer.sdp,offer);
});

test('desktop answer travels to phone but does not claim video is connected',async()=>{
  await assert.rejects(service.answer({sessionId:'old-session-12345678',sdp:offer}),/no longer active/);
  await assert.rejects(service.answer({sessionId,sdp:{type:'offer',sdp:offer}}),/Invalid/);
  await service.answer({sessionId,sdp:{type:'answer',sdp:offer}});
  assert.equal(service.snapshot().connected,false);
  assert.equal(service.snapshot().status,'connecting');
  const response = await fetchLocal(new URL('answer?sessionId='+sessionId,state.urls[0]));
  assert.deepEqual(JSON.parse(response.text),{answer:{type:'answer',sdp:offer},connected:false});
  service.setConnected({sessionId:'stale-session-1234567',connected:true});
  assert.equal(service.snapshot().connected,false);
  service.setConnected({sessionId,connected:true});
  assert.equal(service.snapshot().status,'streaming');
  assert.equal(service.snapshot().connected,true);
  const stopped = await post('stop',{sessionId});
  assert.equal(stopped.status,200);
  assert.equal(service.snapshot().sessionId,null);
  assert.equal(service.snapshot().connected,false);
  assert.equal((await fetchLocal(new URL('answer?sessionId='+sessionId,state.urls[0]))).status,410);
  assert.ok(events.some(event=>event.status==='offer'));
});

test('stop closes both listeners; restart preserves CA and rotates session URLs',async()=>{
  const original = state;
  await service.stop();
  assert.equal(service.snapshot().running,false);
  await assert.rejects(fetchLocal(original.urls[0]));
  await assert.rejects(fetchLocal(original.setupUrls[0]));
  state = await service.start({host:'127.0.0.1'});
  assert.equal(state.fingerprint,original.fingerprint);
  assert.notEqual(new URL(state.urls[0]).pathname,new URL(original.urls[0]).pathname);
  assert.equal((await fetchLocal(new URL(new URL(original.urls[0]).pathname,state.urls[0]))).status,404);
  assert.match(await fs.readFile(path.join(folder,'root-ca-key.pem'),'utf8'),/PRIVATE KEY/);
});

test('parallel stop and restart wait for the old listeners and return usable fresh links',async()=>{
  const original = state;
  const stopping = service.stop();
  const restarting = service.start({host:'127.0.0.1',port:state.port,setupPort:state.setupPort});
  const anotherStop = service.stop();
  const [stopped, fresh] = await Promise.all([stopping,restarting,anotherStop]);
  assert.equal(stopped.running,false);
  assert.equal(fresh.port,original.port);
  assert.notEqual(fresh.urls[0],original.urls[0]);
  assert.equal((await fetchLocal(fresh.urls[0])).status,200);
  assert.equal((await fetchLocal(fresh.setupUrls[0])).status,200);
  assert.equal((await fetchLocal(original.urls[0])).status,404);
  state = fresh;
});

test('stopping closes a phone socket that has not finished TLS negotiation', {timeout:3000}, async t=>{
  const original = state;
  const socket = connect({host:'127.0.0.1',port:state.port});
  t.after(()=>socket.destroy());
  await once(socket,'connect');
  const closed = once(socket,'close');
  await service.stop();
  await closed;
  state = await service.start({host:'127.0.0.1',port:original.port,setupPort:original.setupPort});
  assert.equal((await fetchLocal(state.urls[0])).status,200);
});

test('a stopped phone cannot claim the session with a delayed offer',async()=>{
  const cancelled = 'cancelled-offer-123456';
  await assert.rejects(service.answer({sessionId:null,sdp:offer}), /no longer active/);
  assert.equal(service.setConnected({sessionId:null,connected:true}).connected,false);
  assert.equal((await post('stop',{sessionId:cancelled})).status,410);
  assert.equal((await post('offer',{sessionId:cancelled,sdp:offer})).status,410);
  assert.equal(service.snapshot().sessionId,null);

  const next = 'fresh-phone-123456789';
  assert.equal((await post('offer',{sessionId:next,sdp:offer})).status,200);
  assert.equal((await post('stop',{sessionId:next})).status,200);
  assert.equal((await post('offer',{sessionId:next,sdp:offer})).status,410);
});

test('heartbeats renew the lease; an abandoned phone expires and a new session can connect',async()=>{
  const leaseEvents = [];
  const leased = new ViewService({dataDir:folder,leaseMs:500,onChange:snapshot=>leaseEvents.push(snapshot)});
  const leasedState = await leased.start({host:'127.0.0.1'});
  const address = leasedState.urls[0];
  const sendOffer = id=>fetchLocal(new URL('offer',address),{method:'POST',headers:{Origin:new URL(address).origin},body:{sessionId:id,sdp:offer}});
  const pause = ms=>new Promise(resolve=>setTimeout(resolve,ms));
  try {
    assert.equal((await sendOffer('abandoned-phone-12345678')).status,200);
    await leased.answer({sessionId:'abandoned-phone-12345678',sdp:offer});
    await pause(260);
    assert.equal((await fetchLocal(new URL('answer?sessionId=abandoned-phone-12345678',address))).status,200);
    await pause(260);
    assert.equal(leased.snapshot().sessionId,'abandoned-phone-12345678','answer polling must renew the lease even after the answer was delivered');
    await pause(600);
    assert.equal(leased.snapshot().sessionId,null,'the timeout must clear an abandoned session without requiring another HTTP request');
    assert.equal(leased.snapshot().connected,false);
    assert.equal(leased.snapshot().status,'waiting');
    assert.ok(leaseEvents.filter(event=>event.status==='waiting').length>=2);
    assert.equal((await sendOffer('replacement-phone-123456')).status,200);
    assert.equal((await fetchLocal(new URL('answer?sessionId=abandoned-phone-12345678',address))).status,410);
    assert.equal(leased.snapshot().sessionId,'replacement-phone-123456');
    await assert.rejects(leased.answer({sessionId:'abandoned-phone-12345678',sdp:offer}),/no longer active/);
  } finally {await leased.stop();}
  assert.equal(leased.leaseTimer,null,'shutdown must release its timer');
});

function browserFixture({deferAnswer=false,deferOffer=false}={}) {
  const elements = Object.fromEntries(['status','start','stop','preview'].map(id=>[id,{disabled:true,hidden:true}]));
  const handlers = new Map();
  const timers = new Map();
  const requests = [];
  const peers = [];
  let timerId = 0, releaseAnswer, releaseOffer;
  const track = {onended:null,stopped:false,stop(){this.stopped=true;}};
  const stream = {getVideoTracks:()=>[track],getTracks:()=>[track]};
  class Peer {
    constructor(){this.iceGatheringState='complete';this.remoteDescription=null;this.applied=0;peers.push(this);}
    addTrack(){}
    async createOffer(){return {type:'offer',sdp:offer};}
    async setLocalDescription(description){this.localDescription=description;}
    async setRemoteDescription(description){this.remoteDescription=description;this.applied++;}
    close(){this.closed=true;}
  }
  const ok = value=>({ok:true,json:async()=>value});
  const context = {
    document:{getElementById:id=>elements[id]},
    location:{pathname:'/s/browser-test-token/'},
    navigator:{mediaDevices:{getDisplayMedia:()=>Promise.resolve(stream)}},
    window:{isSecureContext:true,addEventListener:(event,handler)=>handlers.set(event,handler)},
    RTCPeerConnection:Peer,
    crypto:{randomUUID:()=> 'browser-test-session-12345'},
    AbortSignal,performance,
    setTimeout:(callback,delay)=>{const id=++timerId;timers.set(id,{callback,delay});return id;},
    clearTimeout:id=>timers.delete(id),
    fetch:async(url,options)=>{
      requests.push({url,options});
      if (deferOffer && url.endsWith('/offer')) return new Promise(resolve=>{releaseOffer=()=>resolve(ok({accepted:true}));});
      if(url.includes('answer?')) {
        if(deferAnswer) return new Promise(resolve=>{releaseAnswer=()=>resolve(ok({answer:{type:'answer',sdp:offer}}));});
        return ok({answer:{type:'answer',sdp:offer}});
      }
      return ok({accepted:true});
    },
  };
  vm.runInNewContext(screenScript,context);
  return {elements,handlers,timers,requests,peers,track,releaseAnswer:()=>releaseAnswer(),releaseOffer:()=>releaseOffer()};
}
const flushBrowser = ()=>new Promise(resolve=>setImmediate(resolve));

test('phone applies the answer once, keeps heartbeating, and sends JSON keepalive on page close',async()=>{
  const browser = browserFixture();
  await browser.elements.start.onclick();
  await flushBrowser();
  assert.equal(browser.peers[0].applied,1);
  const [timerId,timer] = [...browser.timers.entries()][0];
  assert.equal(timer.delay,2000);
  browser.timers.delete(timerId);
  await timer.callback();
  await flushBrowser();
  assert.equal(browser.peers[0].applied,1,'a heartbeat must not apply the same remote description again');
  browser.handlers.get('pagehide')();
  const closeRequest = browser.requests.find(request=>request.options?.keepalive);
  assert.ok(closeRequest.url.endsWith('/stop'));
  assert.equal(closeRequest.options.method,'POST');
  assert.equal(closeRequest.options.headers['Content-Type'],'application/json');
  assert.equal(JSON.parse(closeRequest.options.body).sessionId,'browser-test-session-12345');
  assert.equal(browser.track.stopped,true);
  assert.equal(browser.peers[0].closed,true);
  assert.equal(browser.timers.size,0);
});

test('an answer that arrives after page close cannot revive the closed capture',async()=>{
  const browser = browserFixture({deferAnswer:true});
  await browser.elements.start.onclick();
  await flushBrowser();
  browser.handlers.get('pagehide')();
  browser.releaseAnswer();
  await flushBrowser();
  assert.equal(browser.peers[0].applied,0);
  assert.equal(browser.timers.size,0);
  assert.equal(browser.elements.preview.srcObject,null);
  assert.equal(browser.elements.status.textContent,'Screen sharing stopped.');
});

test('stopping during the offer keeps the phone stopped after the response arrives',async()=>{
  const browser = browserFixture({deferOffer:true});
  const starting = browser.elements.start.onclick();
  await flushBrowser();
  assert.ok(browser.requests.some(request=>request.url.endsWith('/offer')));
  browser.elements.stop.onclick();
  browser.releaseOffer();
  await starting;
  assert.ok(browser.requests.some(request=>request.url.endsWith('/stop')));
  assert.ok(!browser.requests.some(request=>request.url.includes('answer?')));
  assert.equal(browser.elements.status.textContent,'Screen sharing stopped.');
  assert.equal(browser.track.stopped,true);
  assert.equal(browser.elements.start.disabled,false);
});
