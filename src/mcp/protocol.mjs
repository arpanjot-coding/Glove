// SPDX-License-Identifier: MIT
// Small stdio implementation of the MCP initialization and tool lifecycle.
const versions = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_REQUEST_BYTES = 64 * 1024;
const decoder = new TextDecoder('utf-8', { fatal: true });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const validId = value => (typeof value === 'string' && value.length <= 256) || Number.isSafeInteger(value);

async function* readLines(input) {
  let buffered = Buffer.alloc(0);
  let oversized = false;
  for await (const value of input) {
    const chunk = Buffer.isBuffer(value) ? value : Buffer.from(value);
    let start = 0;
    while (start < chunk.length) {
      const newline = chunk.indexOf(10, start);
      const end = newline < 0 ? chunk.length : newline;
      if (!oversized && buffered.length + end - start <= MAX_REQUEST_BYTES) {
        buffered = Buffer.concat([buffered, chunk.subarray(start, end)]);
      } else {
        oversized = true;
        buffered = Buffer.alloc(0);
      }
      if (newline < 0) break;
      yield oversized ? null : buffered;
      buffered = Buffer.alloc(0);
      oversized = false;
      start = newline + 1;
    }
  }
}

function validateArguments(args, schema) {
  const keys = Object.keys(args);
  if (keys.some(key => !Object.hasOwn(schema.properties, key))) return 'Unexpected tool argument.';
  for (const key of schema.required ?? []) {
    if (!Object.hasOwn(args, key)) return 'Missing required tool argument.';
  }
  for (const key of keys) {
    const value = args[key];
    const rule = schema.properties[key];
    if (rule.type === 'integer' && (!Number.isInteger(value) || value < rule.minimum || value > rule.maximum)) {
      return `${key} must be an integer between ${rule.minimum} and ${rule.maximum}.`;
    }
  }
}

export async function serveMcp({ input, output, tools, version }) {
  const send = message => new Promise((resolve, reject) => {
    output.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\n', error => error ? reject(error) : resolve());
  });
  const ok = (id, result) => send({ id, result });
  const fail = (id, code, message) => send({ id, error: { code, message } });
  const toolError = (id, message) => ok(id, { isError: true, content: [{ type: 'text', text: message }] });
  let initialized = false;
  let negotiated = false;
  let active;
  let rateStartedAt = 0;
  let rateCount = 0;

  try {
    for await (const line of readLines(input)) {
      let request;
      try {
        if (!line) throw new Error('Oversized request');
        const text = decoder.decode(line).trim();
        if (!text) continue;
        request = JSON.parse(text);
      } catch {
        await fail(null, -32700, 'Invalid JSON or request larger than 64 KiB.');
        continue;
      }

      if (!object(request) || request.jsonrpc !== '2.0' || typeof request.method !== 'string' ||
          (Object.hasOwn(request, 'id') && !validId(request.id))) {
        await fail(null, -32600, 'Invalid JSON-RPC request.');
        continue;
      }
      const { id, method, params } = request;
      if (id === undefined) {
        if (method === 'notifications/initialized' && negotiated) initialized = true;
        if (method === 'notifications/cancelled' && active && active.id === params?.requestId) active.controller.abort();
        continue;
      }
      if (method === 'ping') {
        await ok(id, {});
        continue;
      }
      if (method === 'initialize') {
        if (negotiated || !object(params) || typeof params.protocolVersion !== 'string' ||
            !object(params.capabilities) || !object(params.clientInfo) ||
            typeof params.clientInfo.name !== 'string' || typeof params.clientInfo.version !== 'string') {
          await fail(id, -32602, 'Invalid initialization request.');
          continue;
        }
        negotiated = true;
        await ok(id, {
          protocolVersion: versions.includes(params.protocolVersion) ? params.protocolVersion : versions[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'glove-android', version },
          instructions: 'Glove operates on Android devices already authorized in local ADB. Screen capture and optional UI input are restricted to the configured device.'
        });
        continue;
      }
      if (!initialized) {
        await fail(id, -32002, 'Initialize the MCP session first.');
        continue;
      }
      if (method === 'tools/list') {
        await ok(id, { tools: Array.from(tools.values(), tool => tool.definition) });
        continue;
      }
      if (method !== 'tools/call') {
        await fail(id, -32601, 'Method not supported.');
        continue;
      }
      if (!object(params) || typeof params.name !== 'string' ||
          (params.arguments !== undefined && !object(params.arguments))) {
        await fail(id, -32602, 'Invalid tool request.');
        continue;
      }
      const tool = tools.get(params.name);
      if (!tool) {
        await fail(id, -32602, 'Unknown or disabled tool.');
        continue;
      }
      const args = params.arguments ?? {};
      const validation = validateArguments(args, tool.definition.inputSchema);
      if (validation) {
        await toolError(id, validation);
        continue;
      }
      if (active) {
        await toolError(id, 'Another Android operation is in progress. Wait for it to finish.');
        continue;
      }
      const now = performance.now();
      if (now - rateStartedAt >= 1000) {
        rateStartedAt = now;
        rateCount = 0;
      }
      if (rateCount >= 12) {
        await toolError(id, 'Android tool rate limit reached. Retry in a second.');
        continue;
      }
      rateCount++;
      const controller = new AbortController();
      const task = { id, controller };
      active = task;
      task.done = (async () => {
        let result;
        try {
          result = await tool.call(args, controller.signal);
        } catch (error) {
          if (!controller.signal.aborted) await toolError(id, error.message);
          return;
        }
        if (!controller.signal.aborted) await ok(id, result);
      })().catch(() => input.destroy()).finally(() => { active = undefined; });
    }
  } finally {
    if (active) {
      active.controller.abort();
      await active.done;
    }
  }
}
