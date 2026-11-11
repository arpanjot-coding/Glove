// SPDX-License-Identifier: MIT
// Original, self-contained phone interface. No remote scripts, fonts, or services.
export function phonePage(nonce) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="color-scheme" content="light"><title>Glove · File handoff</title>
<style>
:root{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#182333;background:#f4f6fa;font-synthesis:none}*{box-sizing:border-box}body{margin:0}main{max-width:700px;margin:auto;padding:30px 20px 44px}.brand{display:flex;gap:10px;align-items:center;font-size:24px;font-weight:760;letter-spacing:-1px}.mark{width:36px;height:36px;display:grid;place-items:center;color:white;background:#2563eb;border-radius:13px;font-size:22px;letter-spacing:0}header{display:flex;align-items:center;justify-content:space-between;margin-bottom:40px}.pill{font-size:12px;background:#eaf0ff;border:1px solid #d7e2fb;border-radius:30px;padding:7px 10px;color:#45669b}.eyebrow{color:#587297;letter-spacing:2px;font-size:11px;font-weight:750}h1{font-size:clamp(32px,7vw,46px);line-height:1.08;letter-spacing:-1.6px;margin:12px 0}h1 span{color:#2563eb}.intro{max-width:470px;font-size:16px;line-height:1.6;color:#65748b;margin:0 0 27px}.card{background:#fff;border:1px solid #e1e6ef;box-shadow:0 8px 24px #17243906;border-radius:22px;padding:22px;margin:16px 0}h2{font-size:18px;letter-spacing:-.35px;margin:0 0 8px}.caption{color:#65748b;font-size:14px;line-height:1.5;margin:0 0 18px}.choose{display:flex;align-items:center;justify-content:center;min-height:56px;border:1px dashed #9ab8ee;border-radius:13px;background:#f7f9ff;color:#2454ad;font-size:15px;font-weight:650;cursor:pointer}.choose:focus-within{outline:3px solid #91b3ff;outline-offset:3px}.choose input{position:absolute;clip:rect(0,0,0,0);width:1px;height:1px;overflow:hidden}.selection{font-size:13px;line-height:1.5;overflow-wrap:anywhere;color:#65748b;margin:12px 0 0}.send{width:100%;border:0;background:#2563eb;color:white;border-radius:12px;font:inherit;font-size:15px;font-weight:650;padding:14px;margin-top:14px;cursor:pointer}.send:disabled{opacity:.45;cursor:default}.status{font-size:13px;line-height:1.5;color:#587297;min-height:20px;margin:13px 0 0}.status.error{color:#a24232}.filelist{list-style:none;margin:0;padding:0}.file{display:flex;gap:12px;align-items:center;padding:15px 0;border-top:1px solid #edf0f6}.icon{background:#edf2ff;border:1px solid #dce4f2;border-radius:11px;min-width:38px;height:44px;display:grid;place-items:center;color:#5a7fbd;font-size:20px}.details{min-width:0;flex:1}.name{font-size:14px;font-weight:650;overflow-wrap:anywhere;line-height:1.4}.meta{font-size:12px;color:#8b97a9;margin-top:4px}.download{flex-shrink:0;display:grid;place-items:center;width:39px;height:39px;border-radius:50%;background:#edf2ff;color:#2454ad;text-decoration:none;font-size:23px}.download:focus-visible,.send:focus-visible{outline:3px solid #91b3ff;outline-offset:3px}.empty{font-size:14px;color:#8b97a9;line-height:1.6;margin:18px 0 0}.heading{display:flex;justify-content:space-between;align-items:center;gap:15px;margin-bottom:8px}.count{font-size:12px;color:#65748b}.note{padding:5px 7px 0;font-size:12px;line-height:1.7;color:#65748b}.note strong{color:#52627b}footer{margin-top:28px;font-size:11px;letter-spacing:1px;color:#8b97a9;text-align:center}button,a,label{-webkit-tap-highlight-color:transparent}@media(max-width:380px){main{padding:22px 14px 30px}.card{padding:18px}header{margin-bottom:30px}.pill{font-size:10px}}
</style></head><body><main>
<header><div class="brand"><span class="mark" aria-hidden="true">g</span>glove</div><span class="pill">Local file handoff</span></header>
<div class="eyebrow">PHONE ↔ COMPUTER</div><h1>Share files.<br><span>Across your devices.</span></h1>
<p class="intro">Send a photo to your computer, or take a file with you. Keep this page open while files transfer.</p>
<section class="card" aria-labelledby="send-heading"><h2 id="send-heading">Send to your computer</h2><p class="caption">Choose your files. Glove saves them in your computer’s receive folder.</p>
<label class="choose"><input id="picker" type="file" multiple><span>＋ &nbsp;Choose files</span></label><p class="selection" id="selection">No files selected · Up to 2 GiB per file</p><button id="send" class="send" disabled>Send files</button><p id="status" class="status" role="status" aria-live="polite"></p></section>
<section class="card" aria-labelledby="files-heading"><div class="heading"><h2 id="files-heading">Available files</h2><span class="count" id="count"></span></div><p class="caption">Tap the arrow to save a file on this phone.</p><ul class="filelist" id="files"></ul><p class="empty" id="empty">Looking for your files…</p></section>
<p class="note"><strong>Stay on a trusted private network.</strong> This HTTP connection is not encrypted. Anyone with this link on the network can access the shared files. Stop sharing in Glove when you’re done.</p>
<footer>MADE FOR THE SPACE BETWEEN DEVICES</footer></main>
<script nonce="${nonce}">
'use strict';
const picker = document.getElementById('picker');
const send = document.getElementById('send');
const status = document.getElementById('status');
const selection = document.getElementById('selection');
const list = document.getElementById('files');
const empty = document.getElementById('empty');
const count = document.getElementById('count');
const base = new URL('./', location.href);
let busy = false;
let expired = false;
function bytes(value) {
  if (value < 1024) return value + ' B';
  const units = ['KiB', 'MiB', 'GiB', 'TiB']; let unit = -1;
  do { value /= 1024; unit++; } while (value >= 1024 && unit < units.length - 1);
  return value.toFixed(value < 10 ? 1 : 0) + ' ' + units[unit];
}
function message(text, error) { status.textContent = text; status.classList.toggle('error', !!error); }
function show(snapshot) {
  list.replaceChildren();
  const items = snapshot.items || [];
  count.textContent = items.length ? String(items.length) : '';
  empty.hidden = items.length > 0;
  empty.textContent = 'Files shared from your computer will appear here.';
  for (const item of items) {
    const row = document.createElement('li'); row.className = 'file';
    const icon = document.createElement('span'); icon.className = 'icon'; icon.textContent = '▤'; icon.setAttribute('aria-hidden', 'true');
    const details = document.createElement('div'); details.className = 'details';
    const name = document.createElement('div'); name.className = 'name'; name.textContent = item.name;
    const meta = document.createElement('div'); meta.className = 'meta'; meta.textContent = bytes(item.size) + ' · ' + (item.direction === 'from-phone' ? 'Sent to computer' : 'From computer');
    details.append(name, meta);
    const link = document.createElement('a'); link.className = 'download'; link.href = new URL('files/' + encodeURIComponent(item.id), base).href;
    link.download = item.name; link.textContent = '↓'; link.setAttribute('aria-label', 'Download ' + item.name);
    row.append(icon, details, link); list.append(row);
  }
}
async function refresh() {
  if (busy || expired || document.hidden) return;
  try {
    const response = await fetch(new URL('api/items', base), { cache: 'no-store', credentials: 'same-origin' });
    if (response.status === 404) { expired = true; send.disabled = true; message('Sharing stopped or this link expired. Open a new link from Glove.', true); return; }
    if (!response.ok) throw new Error('Could not refresh files.');
    show(await response.json());
  } catch { empty.textContent = 'Cannot reach your computer. Check that both devices are on the same network.'; }
}
picker.addEventListener('change', () => {
  const files = Array.from(picker.files || []);
  const tooLarge = files.some(file => file.size > 2147483648);
  selection.textContent = files.length ? files.length + ' selected · ' + bytes(files.reduce((sum, file) => sum + file.size, 0)) + ' · ' + files.slice(0, 3).map(file => file.name).join(', ') + (files.length > 3 ? '…' : '') : 'No files selected · Up to 2 GiB per file';
  send.disabled = busy || expired || !files.length || tooLarge;
  message(tooLarge ? 'Choose files that are each 2 GiB or smaller.' : '', tooLarge);
});
send.addEventListener('click', async () => {
  if (busy || expired) return;
  const files = Array.from(picker.files || []);
  busy = true; send.disabled = true; picker.disabled = true;
  let completed = 0;
  try {
    for (const file of files) {
      message('Sending ' + (completed + 1) + ' of ' + files.length + ': ' + file.name + '…');
      const endpoint = new URL('api/upload', base); endpoint.searchParams.set('name', file.name);
      const response = await fetch(endpoint, { method: 'POST', body: file, credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' } });
      let result; try { result = await response.json(); } catch { result = {}; }
      if (!response.ok) throw new Error(result.error || 'The transfer did not finish. Try again.');
      completed++; show(result.snapshot);
    }
    picker.value = ''; selection.textContent = 'No files selected · Up to 2 GiB per file';
    message(completed === 1 ? 'Your file arrived on the computer.' : completed + ' files arrived on the computer.');
  } catch (error) { message((completed ? completed + ' file(s) arrived. ' : '') + (error.message || 'Cannot reach your computer.'), true); }
  finally { busy = false; picker.disabled = false; send.disabled = expired || !picker.files.length; }
});
document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh(); });
void refresh(); setInterval(() => void refresh(), 5000);
</script></body></html>`;
}
