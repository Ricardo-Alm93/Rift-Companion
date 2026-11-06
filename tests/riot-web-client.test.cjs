const test = require('node:test');
const assert = require('node:assert/strict');
const { RiotWebClient, RiotApiError } = require('../src/services/riot-web-client');
const { parseEnv, loadLocalEnv } = require('../src/services/env-config.cjs');

function response(status, body = {}, headers = {}) {
  return { ok: status >= 200 && status < 300, status, headers: { get: name => headers[name.toLowerCase()] || null }, json: async () => body };
}

test('no key disables calls without network requests', async () => {
  let calls = 0; const client = new RiotWebClient({ getApiKey: () => '', fetchImpl: async () => { calls++; } });
  await assert.rejects(client.platformStatus('na1'), error => error instanceof RiotApiError && error.code === 'not_configured');
  assert.equal(calls, 0); assert.deepEqual(client.diagnostics(), { configured: false, status: 'not_configured', cacheEntries: 0 });
});

test('key stays in authorization header and errors never include it', async () => {
  const secret = 'TEST_ONLY_SECRET_VALUE'; let header;
  const client = new RiotWebClient({ getApiKey: () => secret, fetchImpl: async (_url, init) => { header = init.headers['X-Riot-Token']; return response(401); } });
  await assert.rejects(client.platformStatus('na1'), error => { assert.equal(error.code, 'unauthorized'); assert.ok(!error.message.includes(secret)); return true; });
  assert.equal(header, secret); assert.equal(client.diagnostics().status, 'expired_or_invalid');
});

test('403 is a credential rejection and is not retried', async () => {
  let calls = 0; const client = new RiotWebClient({ getApiKey: () => 'test', fetchImpl: async () => { calls++; return response(403); } });
  await assert.rejects(client.platformStatus('euw1'), error => error.code === 'forbidden');
  assert.equal(calls, 1); assert.equal(client.diagnostics().status, 'rejected');
});

test('429 honors Retry-After and blocks later calls without hitting Riot', async () => {
  let now = 1000, calls = 0, sleeps = [];
  const client = new RiotWebClient({ getApiKey: () => 'test', now: () => now, sleep: async ms => { sleeps.push(ms); now += ms; }, fetchImpl: async () => { calls++; return calls === 1 ? response(429, {}, { 'retry-after': '3' }) : response(200, { id: 'ok' }); } });
  await assert.rejects(client.platformStatus('na1'), error => error.code === 'rate_limited' && error.retryAfterMs === 3000);
  await assert.rejects(client.platformStatus('na1'), error => error.code === 'rate_limited' && error.retryAfterMs > 0);
  assert.equal(calls, 1); now += 3000;
  assert.deepEqual(await client.platformStatus('na1'), { id: 'ok' }); assert.equal(calls, 2);
});

test('region and endpoint windows enforce documented development request caps', async () => {
  let now = 0, sleeps = 0, calls = 0;
  const client = new RiotWebClient({ getApiKey: () => 'test', now: () => now, sleep: async ms => { sleeps++; now += ms; }, fetchImpl: async () => { calls++; return response(200, { calls }); } });
  for (let i = 0; i < 21; i++) await client.request({ host: 'na1.api.riotgames.com', path: '/lol/status/v4/platform-data', bucket: 'na1:status' });
  assert.equal(calls, 21); assert.ok(sleeps >= 1); assert.ok(now >= 1000);
});


test('concurrent calls reserve application-wide 20 requests per rolling second', async () => {
  const started = [], client = new RiotWebClient({ getApiKey: () => 'test', fetchImpl: async () => { started.push(Date.now()); return response(200, { ok: true }); } });
  await Promise.all(Array.from({ length: 25 }, (_, i) => client.request({ host: 'americas.api.riotgames.com', path: `/test/${i}`, bucket: `americas:endpoint-${i}` })));
  const sorted = started.sort((a, b) => a - b);
  for (let i = 20; i < sorted.length; i++) assert.ok(sorted[i] - sorted[i - 20] >= 950, 'rolling window must schedule the next batch after the first 20');
});

test('429 blocks other endpoints that share the same regional application bucket', async () => {
  let calls = 0; const client = new RiotWebClient({ getApiKey: () => 'test', fetchImpl: async () => { calls++; return response(429, {}, { 'retry-after': '5' }); } });
  await assert.rejects(client.request({ host: 'americas.api.riotgames.com', path: '/endpoint', bucket: 'americas:account' }), error => error.code === 'rate_limited');
  await assert.rejects(client.matchIds('abcdefghijk123456789', 'la1'), error => error.code === 'rate_limited');
  assert.equal(calls, 1);
});

test('account and match queries validate Riot ID, route only to Riot HTTPS hosts and clamp request counts', async () => {
  const urls = []; const client = new RiotWebClient({ getApiKey: () => 'test', fetchImpl: async url => { urls.push(url); return response(200, { puuid: 'abcdefghijk123456789', gameName: 'Tester', tagLine: 'LAS' }); } });
  await client.accountByRiotId('Name/with chars', 'LAS', 'la1');
  await client.matchIds('abcdefghijk123456789', 'la1', { count: 100 });
  assert.match(urls[0], /^https:\/\/americas\.api\.riotgames\.com\/riot\/account\/v1\/accounts\/by-riot-id\/Name%2Fwith%20chars\/LAS$/);
  assert.match(urls[1], /count=10$/); assert.ok(urls.every(url => url.startsWith('https://') && url.includes('.api.riotgames.com/')));
  await assert.rejects(client.accountByRiotId('', 'LAS', 'la1'));
  await assert.rejects(client.matchIds('short', 'la1'));
});

test('memory cache stores results for TTL and returns defensive copies', async () => {
  let now = 0, calls = 0; const client = new RiotWebClient({ getApiKey: () => 'test', now: () => now, fetchImpl: async () => { calls++; return response(200, { nested: { n: 1 } }); } });
  const first = await client.request({ host: 'na1.api.riotgames.com', path: '/lol/status/v4/platform-data', bucket: 'na1:status', cacheKey: 'x', ttlMs: 10 });
  first.nested.n = 99;
  assert.equal((await client.request({ host: 'na1.api.riotgames.com', path: '/lol/status/v4/platform-data', bucket: 'na1:status', cacheKey: 'x', ttlMs: 10 })).nested.n, 1);
  now = 11; await client.request({ host: 'na1.api.riotgames.com', path: '/lol/status/v4/platform-data', bucket: 'na1:status', cacheKey: 'x', ttlMs: 10 }); assert.equal(calls, 2);
});

test('environment parser handles local assignments without printing or exporting values', () => {
  assert.deepEqual(parseEnv('# comment\nRIOT_API_KEY="abc123"\nAPP_MODE=dev'), { RIOT_API_KEY: 'abc123', APP_MODE: 'dev' });
});

test('CI can disable local env-file loading even when .env.local exists', () => {
  const env = { RIFT_DISABLE_LOCAL_ENV_FILE: '1', RIOT_API_KEY: '' };
  const result = loadLocalEnv({ appDir: require('node:os').tmpdir(), env });
  assert.deepEqual(result, { loaded: false, path: null });
  assert.equal(env.RIOT_API_KEY, '');
});
