import assert from 'node:assert/strict';
import test from 'node:test';
import { createPolishHandler } from '../lib/handler.js';
import { INSTALL_DAILY_CHARS, IP_REQUESTS_PER_MINUTE, MAX_TEXT_CHARS, costMicroUsd } from '../lib/limits.js';
import { polishRequestBody } from '../lib/openai.js';
import { memoryStore } from '../lib/store.js';

const INSTALL = 'a1b2c3d4-e5f6-7890-abcd-ef0123456789';
const USAGE = { prompt_tokens: 700, prompt_tokens_details: { cached_tokens: 0 }, completion_tokens: 20 };

function setup(overrides = {}) {
  const store = memoryStore();
  const calls = [], logs = [], alerts = [];
  const handle = createPolishHandler({
    store,
    polish: async (text) => {
      calls.push(text);
      return { text: `polished:${text}`, usage: USAGE };
    },
    budgetMicroUsd: 50e6,
    ipSalt: 'salt',
    alert: async (message) => alerts.push(message),
    log: (line) => logs.push(line),
    now: () => new Date('2026-10-13T03:04:05Z'),
    ...overrides,
  });
  const post = (body, ip = '203.0.113.7') => handle(new Request('https://relay.test/v1/polish', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-forwarded-for': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  }));
  return { store, calls, logs, alerts, handle, post };
}

test('polishes the text and charges the install, the address and the budget', async () => {
  const { store, post, calls } = setup();
  const response = await post({ text: '我们明天三点，不对，四点开会。', installId: INSTALL, appVersion: '1.20.0' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { text: 'polished:我们明天三点，不对，四点开会。' });
  assert.equal(calls.length, 1);
  assert.equal(store.values.get(`chars:install:${INSTALL}:2026-10-13`), 15);
  assert.equal(store.values.get('spend:2026-10'), costMicroUsd(USAGE));
});

test('rejects malformed requests before spending anything', async () => {
  const { post, calls, handle } = setup();
  assert.equal((await post('not json')).status, 400);
  assert.equal((await post({ text: '  ', installId: INSTALL })).status, 400);
  assert.equal((await post({ text: '你好', installId: 'short' })).status, 400);
  assert.equal((await post({ text: '你好', installId: INSTALL, appVersion: 'a b' })).status, 400);
  assert.equal((await post({ text: '字'.repeat(MAX_TEXT_CHARS + 1), installId: INSTALL })).status, 413);
  assert.equal((await handle(new Request('https://relay.test/v1/polish'))).status, 405);
  assert.equal(calls.length, 0);
});

test('an install that would pass its daily allowance gets 429 without an upstream call', async () => {
  const { store, post, calls } = setup();
  store.values.set(`chars:install:${INSTALL}:2026-10-13`, INSTALL_DAILY_CHARS - 3);
  const response = await post({ text: '超过额度了', installId: INSTALL });
  assert.equal(response.status, 429);
  assert.deepEqual(await response.json(), { error: 'quota' });
  assert.equal(calls.length, 0);
});

test('one address is limited per minute across install ids', async () => {
  const { post } = setup();
  let last;
  for (let index = 0; index <= IP_REQUESTS_PER_MINUTE; index += 1) {
    last = await post({ text: '你好', installId: `${INSTALL.slice(0, -2)}${String(index).padStart(2, '0')}` });
  }
  assert.equal(last.status, 429);
  assert.deepEqual(await last.json(), { error: 'rate' });
});

test('a spent budget stops the service until next month', async () => {
  const { store, post, calls } = setup();
  store.values.set('spend:2026-10', 50e6);
  const response = await post({ text: '你好', installId: INSTALL });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'budget' });
  assert.equal(calls.length, 0);
});

test('an upstream failure costs the user no allowance', async () => {
  const { store, post } = setup({ polish: async () => { throw new Error('upstream 500'); } });
  const response = await post({ text: '你好', installId: INSTALL });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'upstream' });
  assert.equal(store.values.has(`chars:install:${INSTALL}:2026-10-13`), false);
});

test('a store outage fails closed', async () => {
  const { post, calls } = setup({ store: { pipeline: async () => { throw new Error('down'); } } });
  assert.equal((await post({ text: '你好', installId: INSTALL })).status, 503);
  assert.equal(calls.length, 0);
});

test('each budget threshold alerts once', async () => {
  const { store, post, alerts } = setup();
  store.values.set('spend:2026-10', 25e6 - 1);
  await post({ text: '你好', installId: INSTALL });
  await post({ text: '你好', installId: INSTALL });
  assert.equal(alerts.length, 1);
  assert.equal(alerts[0].percent, 50);
  assert.equal(alerts[0].month, '2026-10');
});

test('neither logs nor stored keys contain the text or the address', async () => {
  const { store, post, logs } = setup();
  await post({ text: '绝密内容不能落盘', installId: INSTALL }, '198.51.100.23');
  const written = JSON.stringify(logs) + JSON.stringify([...store.values.entries()]);
  assert.equal(written.includes('绝密'), false);
  assert.equal(written.includes('198.51.100.23'), false);
  assert.equal(logs.at(-1).status, 200);
  assert.equal(logs.at(-1).chars, 8);
});

test('the model request keeps reasoning off and bounds the output', () => {
  const body = polishRequestBody('好的，收到。');
  assert.equal(body.reasoning_effort, 'none');
  assert.equal(body.service_tier, 'fast');
  assert.equal(body.max_completion_tokens, 6 * 2 + 64);
  assert.equal(body.messages[1].content, '<转写>\n好的，收到。\n</转写>');
});
