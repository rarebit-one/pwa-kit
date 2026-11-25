import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMcpServer, ToolError, MCP_VERSIONS, mintMcpKey, verifyMcpKey, presentedKey } from '../src/mcp.mjs';
import { makeToken } from '../src/session.mjs';

const server = createMcpServer({
  name: 'demo', version: '1.2.3', instructions: 'Use echo.',
  tools: [
    { name: 'echo', description: 'Echo', inputSchema: { type: 'object', properties: { s: { type: 'string' } } }, handler: async (a, ctx) => ({ said: a.s, who: ctx.who }) },
    { name: 'fail', description: 'Fails', handler: () => { throw new ToolError('nope'); } },
    { name: 'crash', description: 'Crashes', handler: () => { throw new Error('boom'); } },
    { name: 'list', description: 'Returns an array', handler: () => [1, 2] },
  ],
});
const rpc = (method, params, id = 1) => ({ jsonrpc: '2.0', id, method, params });

test('initialize negotiates a known protocol version', async () => {
  const r = await server.handle(rpc('initialize', { protocolVersion: '2025-03-26' }));
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.deepEqual(r.result.serverInfo, { name: 'demo', version: '1.2.3' });
  assert.equal(r.result.instructions, 'Use echo.');
  assert.equal(r.result.capabilities.resources, undefined);
  assert.equal((await server.handle(rpc('initialize', { protocolVersion: '1999-01-01' }))).result.protocolVersion, MCP_VERSIONS[0]);
});

test('tools/list and tools/call', async () => {
  const list = (await server.handle(rpc('tools/list'))).result.tools;
  assert.deepEqual(list.map((t) => t.name), ['echo', 'fail', 'crash', 'list']);
  assert.deepEqual(list[1].inputSchema, { type: 'object', properties: {} });
  const r = await server.handle(rpc('tools/call', { name: 'echo', arguments: { s: 'hi' } }), { who: 'alice' });
  assert.deepEqual(r.result.structuredContent, { said: 'hi', who: 'alice' });
  assert.equal(r.result.isError, false);
  assert.deepEqual(JSON.parse(r.result.content[0].text), { said: 'hi', who: 'alice' });
  assert.deepEqual((await server.handle(rpc('tools/call', { name: 'list' }))).result.structuredContent, { result: [1, 2] });
});

test('tool errors, unknown tools and methods, bad requests', async () => {
  const f = await server.handle(rpc('tools/call', { name: 'fail' }));
  assert.equal(f.result.isError, true);
  assert.equal(f.result.content[0].text, 'nope');
  assert.equal((await server.handle(rpc('tools/call', { name: 'zzz' }))).error.code, -32602);
  assert.equal((await server.handle(rpc('tools/call', { name: 'echo', arguments: [] }))).error.code, -32602);
  assert.equal((await server.handle(rpc('resources/list'))).error.code, -32601);
  assert.equal((await server.handle(rpc('nope'))).error.code, -32601);
  assert.equal((await server.handle({ id: 1, method: 'ping' })).error.code, -32600);
  assert.equal(await server.handle({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
});

test('handlePost: parse errors, notifications (202), batches, internal errors', async () => {
  assert.equal((await server.handlePost('{')).statusCode, 400);
  assert.equal((await server.handlePost(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }))).statusCode, 202);
  const b = await server.handlePost(JSON.stringify([rpc('ping', {}, 1), rpc('tools/call', { name: 'crash' }, 2)]));
  assert.equal(b.statusCode, 200);
  assert.deepEqual(b.body[0], { jsonrpc: '2.0', id: 1, result: {} });
  assert.equal(b.body[1].error.code, -32603);
  assert.doesNotMatch(JSON.stringify(b.body), /boom/, 'internal error text is not leaked');
});

test('resources are optional', async () => {
  const s = createMcpServer({ name: 'r', resources: { list: () => [{ uri: 'x://a', name: 'a' }], read: (uri) => (uri === 'x://a' ? { contents: [{ uri, text: 'A' }] } : null) } });
  assert.ok((await s.handle(rpc('initialize'))).result.capabilities.resources);
  assert.equal((await s.handle(rpc('resources/list'))).result.resources.length, 1);
  assert.equal((await s.handle(rpc('resources/read', { uri: 'x://a' }))).result.contents[0].text, 'A');
  assert.equal((await s.handle(rpc('resources/read', { uri: 'x://b' }))).error.code, -32002);
  assert.deepEqual((await s.handle(rpc('resources/templates/list'))).result.resourceTemplates, []);
});

test('prompts are optional: list, get (with required arguments), unknown names', async () => {
  assert.equal((await server.handle(rpc('initialize'))).result.capabilities.prompts, undefined);
  assert.equal((await server.handle(rpc('prompts/list'))).error.code, -32601);
  const s = createMcpServer({
    name: 'p',
    prompts: [
      { name: 'brief', title: 'Brief', description: 'A morning brief', get: () => [{ role: 'user', content: { type: 'text', text: 'Read today.' } }] },
      { name: 'about', arguments: [{ name: 'id', required: true }], get: (a, ctx) => ({ description: 'About one', messages: [{ role: 'user', content: { type: 'text', text: `${a.id} for ${ctx.who}` } }] }) },
    ],
  });
  assert.deepEqual((await s.handle(rpc('initialize'))).result.capabilities.prompts, { listChanged: false });
  assert.deepEqual((await s.handle(rpc('prompts/list'))).result.prompts, [{ name: 'brief', title: 'Brief', description: 'A morning brief' }, { name: 'about', arguments: [{ name: 'id', required: true }] }]);
  const brief = (await s.handle(rpc('prompts/get', { name: 'brief' }))).result;
  assert.equal(brief.description, 'A morning brief');
  assert.equal(brief.messages[0].content.text, 'Read today.');
  assert.equal((await s.handle(rpc('prompts/get', { name: 'about', arguments: { id: 'x' } }), { who: 'al' })).result.messages[0].content.text, 'x for al');
  assert.equal((await s.handle(rpc('prompts/get', { name: 'about' }))).error.code, -32602);
  assert.equal((await s.handle(rpc('prompts/get', { name: 'nope' }))).error.code, -32602);
  assert.throws(() => createMcpServer({ name: 'x', prompts: [{ name: 'a' }] }));
  assert.throws(() => createMcpServer({ name: 'x', prompts: [{ name: 'a', get() {} }, { name: 'a', get() {} }] }));
});

test('tool registry rejects duplicates and handler-less tools', () => {
  assert.throws(() => createMcpServer({ name: 'x', tools: [{ name: 'a', handler() {} }, { name: 'a', handler() {} }] }));
  assert.throws(() => createMcpServer({ name: 'x', tools: [{ name: 'a' }] }));
});

test('scoped keys: bearer or ?key, scope and epoch enforced', () => {
  const secret = 'm'.repeat(32);
  const key = mintMcpKey('alice', { secret, scope: 'app-mcp', epoch: 2 });
  assert.equal(verifyMcpKey({ headers: { authorization: `Bearer ${key}` } }, { secret, scope: 'app-mcp', epoch: 2 }).u, 'alice');
  assert.equal(verifyMcpKey({ headers: {}, query: { key } }, { secret, scope: 'app-mcp', epoch: 2 }).u, 'alice');
  assert.equal(verifyMcpKey({ headers: {}, query: { key } }, { secret, scope: 'app-mcp', epoch: 2, allowQuery: false }), null);
  assert.equal(verifyMcpKey({ headers: { authorization: `Bearer ${key}` } }, { secret, scope: 'app-mcp', epoch: 3 }), null);
  assert.equal(verifyMcpKey({ headers: { authorization: `Bearer ${key}` } }, { secret, scope: 'other' }), null);
  const session = makeToken('alice', { secret, ttlMs: 1000 });
  assert.equal(verifyMcpKey({ headers: { authorization: `Bearer ${session}` } }, { secret, scope: 'app-mcp' }), null, 'a plain session is not a key');
  assert.equal(presentedKey({ headers: { Authorization: 'bearer  abc ' } }), 'abc');
});
