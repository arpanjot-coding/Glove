// Original Glove code. MIT licensed.
const escape = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;'}[c]));
const style = `:root{color-scheme:light;font:16px system-ui,sans-serif;color:#17262c;background:#f4f6fa}body{max-width:620px;margin:30px auto;padding:0 22px;line-height:1.55}h1{font-size:30px;letter-spacing:-1px}h2{font-size:20px}a{color:#2563eb}button,.button{display:inline-block;border:0;border-radius:12px;padding:14px 20px;background:#2563eb;color:white;font:600 17px system-ui;text-decoration:none;cursor:pointer;margin:8px 8px 8px 0}button:disabled{opacity:.5;cursor:default}.secondary{background:#edf2ff;color:#254b91}.card{background:white;padding:22px;border:1px solid #e1e6ef;border-radius:20px;margin:20px 0}.muted{color:#52646b}.fingerprint{font:12px ui-monospace,monospace;overflow-wrap:anywhere}li{margin:12px 0}video{width:100%;max-height:45vh;background:#182528;border-radius:10px}#status{font-weight:600}code{overflow-wrap:anywhere}`;
const layout = (title, content, script = '') => `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escape(title)} · Glove</title><style>${style}</style></head><body>${content}${script}</body></html>`;

export function setupPage({secureUrl, profilePath, fingerprint, rootName}) {
  return layout('Set up screen viewing', `<p class="muted">GLOVE · LOCAL SCREEN VIEWING</p>
<h1>View your iPhone on this computer.</h1>
<p>Screen viewing uses Safari on <strong>iOS 27 or later</strong>. This setup makes a secure connection to this computer over your local Wi-Fi. It does not install an iPhone app.</p>
<div class="card"><h2>Verify the downloaded certificate before trusting it</h2>
<p><strong>This setup page uses HTTP. Someone on the network could alter the page or its download. The fingerprint written on this web page does not authenticate the downloaded profile.</strong></p>
<ol>
<li>Keep the certificate SHA-256 fingerprint visible in the <strong>Glove desktop app on your computer</strong>. Use that desktop value as the trusted reference.</li>
<li><a class="button" href="${escape(profilePath)}">Download certificate profile</a><p>Allow the download, then open Settings → General → VPN &amp; Device Management (or Profile Downloaded) and select the pending Glove profile. <strong>Do not install it yet.</strong></p></li>
<li>Open the pending profile's <strong>certificate details</strong> (look for More Details and the certificate entry), then find <strong>Fingerprints → SHA-256</strong>. Compare every hexadecimal digit of the <strong>actual downloaded certificate</strong> with the Glove desktop value. Spaces and colons may differ.</li>
<li><strong>If you cannot inspect that actual certificate's SHA-256 fingerprint, or any digit differs, stop. Cancel the profile and do not install it or enable full trust.</strong> Matching names or matching text on this web page are insufficient.</li>
<li>Only after the actual certificate matches the desktop fingerprint, install the profile. Open Settings → General → About → Certificate Trust Settings and enable full trust for the verified Glove certificate.</li>
<li>Return to Safari and open the secure screen page below. It must load without a certificate warning.</li>
</ol><a class="button" href="${escape(secureUrl)}">Open secure screen page</a>
<p class="muted">Reference shown by this HTTP service; verify against the desktop app directly:</p><p class="fingerprint">${escape(fingerprint)}</p><p>Certificate name: <strong>${escape(rootName)}</strong></p></div>
<p>The profile trusts a local certificate authority created by this Glove installation. Its private key stays on this computer. Install it only on a computer you trust. To undo this setup, remove the Glove profile in VPN &amp; Device Management.</p>
<p class="muted">Keep both devices on the same Wi-Fi. If Safari requests local network access, allow it for this session. iOS 26 and earlier require a native companion or another receiver; this version cannot capture their screens.</p>
<p><a href="https://support.apple.com/en-us/102390">Apple: Trust manually installed certificate profiles</a></p><p class="muted">Secure page: <code>${escape(secureUrl)}</code></p>`);
}

export function screenPage({scriptPath}) {
  return layout('Share your screen', `<p class="muted">GLOVE · LOCAL SCREEN VIEWING</p><h1>Share your iPhone screen.</h1><p>In Safari on iOS 27 or later, tap Start and choose the screen in Apple's sharing picker. The Glove desktop app displays the live video. Screen audio is not included.</p><div class="card"><p id="status" role="status" aria-live="polite">Checking screen sharing support…</p><button id="start" disabled>Start screen sharing</button><button id="stop" class="secondary" disabled>Stop</button><video id="preview" autoplay muted playsinline hidden></video></div><p>Keep both devices on the same Wi-Fi. You choose what to share each time and can stop at any time. If sharing stops when leaving Safari or locking the phone, return here and restart.</p><p class="muted">A trusted HTTPS connection is required. Complete the certificate setup first. This browser method does not use AirPlay or provide remote touch control.</p><script src="${escape(scriptPath)}" defer></script>`);
}

export const screenScript = `
(() => {
  const status = document.getElementById('status');
  const start = document.getElementById('start');
  const stop = document.getElementById('stop');
  const preview = document.getElementById('preview');
  const base = location.pathname.replace(/\\/?$/, '/');
  let peer, stream, sessionId, stopped = true, timeout, finishIce, generation = 0, canStart = false;
  let stopRequest = Promise.resolve();
  const show = text => status.textContent = text;
  const request = async (route, body, keepalive = false) => {
    const options = {cache:'no-store', signal:AbortSignal.timeout(8000)};
    if (body !== undefined) Object.assign(options, {method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body),keepalive});
    const response = await fetch(base + route, options);
    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(error.error || 'Connection failed (' + response.status + ').');
    }
    return response.json();
  };
  function end(message, keepalive = false) {
    generation++;
    stopped = true;
    clearTimeout(timeout);
    if (sessionId) stopRequest = request('stop', {sessionId}, keepalive).catch(() => {});
    finishIce?.();
    const oldStream = stream;
    stream = undefined;
    peer?.close(); peer = undefined;
    oldStream?.getTracks().forEach(track => {track.onended = null; track.stop();});
    preview.srcObject = null; preview.hidden = true;
    stop.disabled = true; start.disabled = !canStart;
    sessionId = undefined;
    show(message);
  }
  function waitForIce(pc) {
    if (pc.iceGatheringState === 'complete') return Promise.resolve();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Local network discovery timed out. Please restart sharing.')), 15000);
      function finish(error) {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', change);
        finishIce = undefined;
        if (error) reject(error); else resolve();
      }
      function change() {if (pc.iceGatheringState === 'complete') finish();}
      finishIce = finish;
      pc.addEventListener('icegatheringstatechange', change);
      change();
    });
  }
  async function poll(id, pc, startedAt) {
    if (stopped || sessionId !== id) return;
    try {
      const result = await request('answer?sessionId=' + encodeURIComponent(id));
      if (stopped || sessionId !== id || peer !== pc) return;
      if (result.answer && !pc.remoteDescription) {
        await pc.setRemoteDescription(result.answer);
        if (stopped || sessionId !== id || peer !== pc) return;
        show('Connecting live video over your local network…');
      }
      if (!pc.remoteDescription && performance.now() - startedAt > 60000) throw new Error('The desktop did not answer. Open Glove and try again.');
      // Polling remains active after the answer as the session heartbeat. A
      // closed tab or lost network then releases the desktop session lease.
      timeout = setTimeout(() => poll(id, pc, startedAt), pc.remoteDescription ? 2000 : 700);
    } catch (error) {if (!stopped && sessionId === id) end(error.message);}
  }
  start.onclick = async () => {
    const run = ++generation;
    start.disabled = true; stop.disabled = false; stopped = false;
    show('Choose your screen in the system sharing picker…');
    try {
      // This call must stay directly within the user gesture, before any await.
      const capture = navigator.mediaDevices.getDisplayMedia({video:true,audio:false});
      const captured = await capture;
      if (stopped || run !== generation) {captured.getTracks().forEach(track => track.stop()); return;}
      stream = captured;
      if (!stream.getVideoTracks().length) throw new Error('Safari did not provide a screen video track.');
      const pc = peer = new RTCPeerConnection({iceServers:[]});
      const id = sessionId = crypto.randomUUID();
      stream.getTracks().forEach(track => {pc.addTrack(track,stream);track.onended = () => end('Screen sharing stopped.');});
      preview.srcObject = stream; preview.hidden = false;
      pc.onconnectionstatechange = () => {
        if (stopped || sessionId !== id) return;
        if (pc.connectionState === 'connected') show('Screen sharing connection is active. Check Glove for the live picture.');
        if (pc.connectionState === 'failed') end('Could not connect video. Check that both devices use the same Wi-Fi and Windows allows Glove through the firewall.');
        if (pc.connectionState === 'disconnected') show('Video connection interrupted. Waiting for the local network…');
      };
      show('Preparing local video connection…');
      const offer = await pc.createOffer();
      if (stopped || run !== generation) return;
      await pc.setLocalDescription(offer);
      if (stopped || run !== generation) return;
      await waitForIce(pc);
      await stopRequest;
      if (stopped || run !== generation) return;
      await request('offer', {sessionId:id,sdp:pc.localDescription.sdp});
      if (stopped || run !== generation) return;
      show('Waiting for the Glove desktop app to receive your screen…');
      poll(id, pc, performance.now());
    } catch (error) {
      if (!stopped && run === generation) end(error.name === 'NotAllowedError' ? 'Screen sharing was declined. Tap Start to try again.' : (error.message || 'Screen sharing failed.'));
    }
  };
  stop.onclick = () => end('Screen sharing stopped.');
  window.addEventListener('pagehide', () => {
    // The lease also handles process termination or a failed keepalive.
    end('Screen sharing stopped.', true);
  });
  if (!window.isSecureContext) {
    show('A trusted HTTPS connection is required. Install and fully trust this computer’s Glove certificate, then reopen the secure page.');
  } else if (typeof navigator.mediaDevices?.getDisplayMedia !== 'function') {
    show('This browser cannot share the screen. Use Safari on iOS 27 or later. iOS 26 and earlier are not supported by this browser method.');
  } else if (typeof RTCPeerConnection !== 'function') {
    show('This browser does not support the video connection. Use Safari on iOS 27 or later.');
  } else {
    canStart = true;
    start.disabled = false;
    show('Ready. Tap Start screen sharing to choose what to share.');
  }
})();
`;
