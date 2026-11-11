// SPDX-License-Identifier: MIT
// Original code-native mark. PNG and ICO are generated without an image library.
import { deflateSync } from 'node:zlib';
import { writeFile, mkdir } from 'node:fs/promises';
const table = Array.from({ length: 256 }, (_, n) => { for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0; });
function crc(bytes) { let n = 0xffffffff; for (const b of bytes) n = table[(n ^ b) & 255] ^ (n >>> 8); return (n ^ 0xffffffff) >>> 0; }
function chunk(type, data) { const kind = Buffer.from(type); const size = Buffer.alloc(4); size.writeUInt32BE(data.length); const checksum = Buffer.alloc(4); checksum.writeUInt32BE(crc(Buffer.concat([kind, data]))); return Buffer.concat([size, kind, data, checksum]); }
function png(size) {
  const raw = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const rgba = [0, 0, 0, 0];
    for (let sy = 0; sy < 4; sy++) for (let sx = 0; sx < 4; sx++) {
      const px = (x + (sx + .5) / 4) * 64 / size;
      const py = (y + (sy + .5) / 4) * 64 / size;
      const dx = Math.max(18 - px, 0, px - 46), dy = Math.max(18 - py, 0, py - 46);
      if (Math.hypot(dx, dy) > 18) continue;
      const radius = Math.hypot(px - 32, py - 32);
      const ring = radius >= 8 && radius <= 15 && !(px > 32 && Math.abs(py - 32) < (px - 32) * .85);
      const bar = px >= 31 && px <= 47 && py >= 30 && py <= 37;
      const side = px >= 40 && px <= 47 && py >= 34 && py <= 43;
      const color = ring || bar || side ? [255, 255, 255] : [37, 99, 235];
      for (let i = 0; i < 3; i++) rgba[i] += color[i]; rgba[3] += 255;
    }
    const pos = y * (size * 4 + 1) + 1 + x * 4;
    const alpha = rgba[3] / (255 * 16);
    for (let c = 0; c < 3; c++) raw[pos + c] = alpha ? Math.round(rgba[c] / (16 * alpha)) : 0;
    raw[pos + 3] = Math.round(rgba[3] / 16);
  }
  const header = Buffer.alloc(13); header.writeUInt32BE(size, 0); header.writeUInt32BE(size, 4); header[8] = 8; header[9] = 6;
  return Buffer.concat([Buffer.from([137,80,78,71,13,10,26,10]), chunk('IHDR', header), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const sizes = [16,32,48,64,128,256];
const images = sizes.map(png);
const directory = Buffer.alloc(6 + sizes.length * 16); directory.writeUInt16LE(1, 2); directory.writeUInt16LE(sizes.length, 4);
let offset = directory.length;
for (let i = 0; i < sizes.length; i++) { const pos = 6 + i * 16; directory[pos] = sizes[i] % 256; directory[pos + 1] = sizes[i] % 256; directory.writeUInt16LE(1, pos + 4); directory.writeUInt16LE(32, pos + 6); directory.writeUInt32LE(images[i].length, pos + 8); directory.writeUInt32LE(offset, pos + 12); offset += images[i].length; }
await mkdir('assets', { recursive: true });
await writeFile('assets/glove.ico', Buffer.concat([directory, ...images]));
await writeFile('src/ui/brand.png', images.at(-1));
console.log('Generated original Glove PNG and Windows icon.');
