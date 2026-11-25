// A stateless MCP server transport: JSON-RPC 2.0 over a single HTTP POST, JSON in, JSON out.
// No sessions and no server-sent events, which suits a serverless function.
//
//   const server = createMcpServer({ name, version, tools: [{ name, description, inputSchema, handler }] });
//   const { statusCode, body } = await server.handlePost(rawBody, ctx);
//
// A handler receives (args, ctx) and returns any JSON value; it is sent both as text content
// and as structuredContent. Throw ToolError for a tool-level failure the model should see.
//
// Keys: an assistant can't carry a browser cookie, so it presents a scoped signed token
// (see session.mjs) as "Authorization: Bearer <key>" (or ?key= for URL-only clients).

import { makeToken, verifyToken } from './session.mjs';

export const MCP_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export class ToolError extends Error {}

const rpcError = (id, code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data ? { data } : {}) } });

export function createMcpServer({ name, version = '0.0.0', instructions, tools = [], resources = null, maxBatch = 20 }) {
  const byName = new Map();
  for (const t of tools) {
    if (!t?.name || typeof t.handler !== 'function') throw new Error('each tool needs a name and a handler');
    if (byName.has(t.name)) throw new Error(`duplicate tool ${t.name}`);
    byName.set(t.name, t);
  }
  const toolList = () => tools.map(({ name: n, title, description, inputSchema, annotations }) => ({
    name: n, ...(title ? { title } : {}), description: description || '',
    inputSchema: inputSchema || { type: 'object', properties: {} }, ...(annotations ? { annotations } : {}),
  }));

  /** Answer one JSON-RPC message → response object, or null for a notification. */
  async function handle(msg, ctx = {}) {
    const id = msg?.id ?? null;
    const reply = (result) => ({ jsonrpc: '2.0', id, result });
    if (!msg || typeof msg !== 'object' || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return rpcError(id, -32600, 'Invalid request');
    if (msg.id === undefined) return null;
    switch (msg.method) {
      case 'initialize': {
        const want = msg.params?.protocolVersion;
        const capabilities = { tools: { listChanged: false }, ...(resources ? { resources: { listChanged: false } } : {}) };
        return reply({ protocolVersion: MCP_VERSIONS.includes(want) ? want : MCP_VERSIONS[0], capabilities, serverInfo: { name, version }, ...(instructions ? { instructions } : {}) });
      }
      case 'ping': return reply({});
      case 'tools/list': return reply({ tools: toolList() });
      case 'tools/call': {
        const tool = byName.get(msg.params?.name);
        if (!tool) return rpcError(id, -32602, `Unknown tool: ${String(msg.params?.name).slice(0, 60)}`);
        const args = msg.params?.arguments ?? {};
        if (typeof args !== 'object' || Array.isArray(args)) return rpcError(id, -32602, 'arguments must be an object');
        try {
          const result = await tool.handler(args, ctx);
          const structured = result && typeof result === 'object' && !Array.isArray(result) ? result : { result };
          return reply({ content: [{ type: 'text', text: JSON.stringify(result) }], structuredContent: structured, isError: false });
        } catch (e) {
          if (e instanceof ToolError) return reply({ content: [{ type: 'text', text: e.message }], isError: true });
          throw e;
        }
      }
      case 'resources/list':
        return resources ? reply({ resources: await resources.list(ctx) }) : rpcError(id, -32601, 'Method not found: resources/list');
      case 'resources/templates/list':
        return resources ? reply({ resourceTemplates: resources.templates ? await resources.templates(ctx) : [] }) : rpcError(id, -32601, 'Method not found: resources/templates/list');
      case 'resources/read': {
        if (!resources) return rpcError(id, -32601, 'Method not found: resources/read');
        const uri = msg.params?.uri;
        const r = await resources.read(uri, ctx);
        return r ? reply(r) : rpcError(id, -32002, `Resource not found: ${String(uri).slice(0, 80)}`, { uri });
      }
      default: return rpcError(id, -32601, `Method not found: ${msg.method}`);
    }
  }

  /** Answer a raw POST body (a message or a batch) → { statusCode, body }. */
  async function handlePost(rawBody, ctx = {}) {
    let msg;
    try { msg = JSON.parse(rawBody || ''); } catch { return { statusCode: 400, body: rpcError(null, -32700, 'Parse error') }; }
    const list = Array.isArray(msg) ? msg.slice(0, maxBatch) : [msg];
    const out = [];
    for (const m of list) {
      try { const r = await handle(m, ctx); if (r) out.push(r); } catch { out.push(rpcError(m?.id ?? null, -32603, 'Internal error')); }
    }
    if (!out.length) return { statusCode: 202, body: '' };
    return { statusCode: 200, body: Array.isArray(msg) ? out : out[0] };
  }

  return { handle, handlePost, toolList };
}

// --- scoped keys ----------------------------------------------------------------

/** Mint an MCP key: a signed token carrying its own scope (and epoch). */
export const mintMcpKey = (login, { secret, scope = 'mcp', ttlMs = 30 * 24 * 3600e3, epoch, now } = {}) =>
  makeToken(login, { secret, scope, ttlMs, epoch, now });

/** The key a request presents: a Bearer header, or `?key=` when allowed. */
export function presentedKey(req, { allowQuery = true } = {}) {
  const h = req.headers || {};
  const auth = String(h.authorization || h.Authorization || '');
  if (/^bearer\s+/i.test(auth)) return auth.replace(/^bearer\s+/i, '').trim();
  return allowQuery ? String(req.query?.key || '') : '';
}

/** Verify a request's MCP key → claims, or null. */
export const verifyMcpKey = (req, { secret, scope = 'mcp', epoch, allowQuery = true, now } = {}) => {
  const key = presentedKey(req, { allowQuery });
  return key ? verifyToken(key, { secret, scope, epoch, now }) : null;
};
