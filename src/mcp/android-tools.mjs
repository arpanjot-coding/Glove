// SPDX-License-Identifier: MIT
import { execFile } from 'node:child_process';
import { dirname } from 'node:path';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
const MAX_SCREEN_BYTES = 16 * 1024 * 1024;
const MAX_SCREEN_PIXELS = 20_000_000;
const MAX_COORDINATE = 16383;

export function validSerial(serial) {
  return typeof serial === 'string' && /^[A-Za-z0-9\[][A-Za-z0-9._:%\[\]-]{0,199}$/.test(serial);
}

export function createAdbRunner(adb, port = 5037) {
  return async (args, { signal, maxBuffer = 1024 * 1024 } = {}) => {
    try {
      const { stdout } = await exec(adb, ['-H', '127.0.0.1', '-P', String(port), ...args], {
        cwd: dirname(adb),
        encoding: 'buffer',
        maxBuffer,
        shell: false,
        signal,
        timeout: 10000,
        windowsHide: true
      });
      return stdout;
    } catch (error) {
      if (error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Android output exceeded the size limit.');
      if (error.killed && !signal?.aborted) throw new Error('Android did not respond within 10 seconds.');
      if (error.code === 'ENOENT') throw new Error('ADB could not start. Check the configured tools path.');
      throw new Error('ADB could not complete the request. Check that the selected device is connected and authorized.');
    }
  };
}

function connectionType(serial) {
  if (serial.startsWith('emulator-')) return 'emulator';
  if (serial.includes(':') || /\._adb-tls-connect\._tcp(?:\.local)?\.?$/.test(serial)) return 'wireless';
  return 'usb';
}

function dimensions(png) {
  if (!Buffer.isBuffer(png) || png.length < 33 || png.length > MAX_SCREEN_BYTES ||
      !png.subarray(0, 8).equals(PNG_SIGNATURE) || png.readUInt32BE(8) !== 13 ||
      png.toString('ascii', 12, 16) !== 'IHDR' || png.toString('ascii', png.length - 8, png.length - 4) !== 'IEND') {
    throw new Error('Android did not return a PNG screenshot.');
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 1 || height < 1 || width > MAX_COORDINATE + 1 || height > MAX_COORDINATE + 1 ||
      width * height > MAX_SCREEN_PIXELS) {
    throw new Error('Android returned unsupported screenshot dimensions.');
  }
  return { width, height };
}

const emptySchema = { type: 'object', properties: {}, additionalProperties: false };
const coordinates = { type: 'integer', minimum: 0, maximum: MAX_COORDINATE };
const tapSchema = {
  type: 'object',
  properties: { x: coordinates, y: coordinates },
  required: ['x', 'y'],
  additionalProperties: false
};
const swipeSchema = {
  type: 'object',
  properties: {
    x1: coordinates, y1: coordinates, x2: coordinates, y2: coordinates,
    durationMs: { type: 'integer', minimum: 100, maximum: 1500, default: 300 }
  },
  required: ['x1', 'y1', 'x2', 'y2'],
  additionalProperties: false
};
const readOnly = { readOnlyHint: true, destructiveHint: false, openWorldHint: false };
const inputAction = { readOnlyHint: false, destructiveHint: true, openWorldHint: true };

export function createAndroidTools({ run, device, allowInput = false }) {
  if (device !== undefined && !validSerial(device)) throw new Error('Invalid Android device serial.');
  if (allowInput && !device) throw new Error('UI input requires a configured Android device.');

  const tools = new Map();
  let lastScreen;
  function add(name, description, inputSchema, annotations, call) {
    tools.set(name, { definition: { name, description, inputSchema, annotations }, call });
  }

  add('android_list_devices', 'List authorized Android devices on the local ADB server. If a device is configured, list only that device.', emptySchema, readOnly, async (_args, signal) => {
    const output = await run(['devices', '-l'], { signal });
    const devices = [];
    for (const line of output.toString('utf8').split(/\r?\n/)) {
      const [serial, status, ...details] = line.trim().split(/\s+/);
      if (status !== 'device' || !validSerial(serial) || (device && serial !== device)) continue;
      const model = details.find(detail => detail.startsWith('model:'))?.slice(6).replaceAll('_', ' ') ?? '';
      devices.push({
        serial,
        model: model.replace(/[^\p{L}\p{N} ._-]/gu, '').slice(0, 100) || 'Android',
        connection: connectionType(serial)
      });
    }
    return { content: [{ type: 'text', text: JSON.stringify({ devices }) }], structuredContent: { devices } };
  });

  if (device) {
    add('android_screenshot', 'Capture the configured Android screen as a PNG. Use only on a device whose screen may be shared with this client.', emptySchema, readOnly, async (_args, signal) => {
      lastScreen = undefined;
      const png = await run(['-s', device, 'exec-out', 'screencap', '-p'], { signal, maxBuffer: MAX_SCREEN_BYTES });
      const size = dimensions(png);
      if (allowInput) lastScreen = { ...size, capturedAt: performance.now() };
      return { content: [{ type: 'image', mimeType: 'image/png', data: png.toString('base64') }] };
    });
  }

  if (allowInput) {
    function useScreenshot(points) {
      if (!lastScreen || performance.now() - lastScreen.capturedAt > 30000) {
        throw new Error('Capture a fresh screenshot before using coordinates.');
      }
      if (points.some(([x, y]) => x >= lastScreen.width || y >= lastScreen.height)) {
        throw new Error('The coordinates must be inside the latest screenshot.');
      }
      lastScreen = undefined;
    }
    add('android_tap', 'Tap a coordinate on the configured Android device. First capture a screenshot, then choose a pixel in that screenshot. A tap can change app state.', tapSchema, inputAction, async ({ x, y }, signal) => {
      useScreenshot([[x, y]]);
      await run(['-s', device, 'shell', 'input', 'tap', String(x), String(y)], { signal });
      return { content: [{ type: 'text', text: 'Tap sent. Capture a screenshot to check the result.' }] };
    });
    add('android_swipe', 'Swipe between two pixels on the configured Android device. First capture a screenshot, then choose both points in that screenshot. A swipe can change app state.', swipeSchema, inputAction, async ({ x1, y1, x2, y2, durationMs = 300 }, signal) => {
      useScreenshot([[x1, y1], [x2, y2]]);
      await run(['-s', device, 'shell', 'input', 'swipe', ...[x1, y1, x2, y2, durationMs].map(String)], { signal });
      return { content: [{ type: 'text', text: 'Swipe sent. Capture a screenshot to check the result.' }] };
    });
    add('android_back', 'Press Android Back once on the configured device. This may navigate away from the current screen.', emptySchema, inputAction, async (_args, signal) => {
      lastScreen = undefined;
      await run(['-s', device, 'shell', 'input', 'keyevent', '4'], { signal });
      return { content: [{ type: 'text', text: 'Back sent. Capture a screenshot to check the result.' }] };
    });
  }

  return tools;
}
