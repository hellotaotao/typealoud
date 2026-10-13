import { createHash } from 'node:crypto';
import {
  BUDGET_ALERT_PERCENTS, INSTALL_DAILY_CHARS, IP_DAILY_CHARS, IP_REQUESTS_PER_MINUTE,
  MAX_BODY_BYTES, MAX_TEXT_CHARS, costMicroUsd,
} from './limits.js';

const INSTALL_ID = /^[A-Za-z0-9-]{16,64}$/;
const APP_VERSION = /^[0-9A-Za-z.+-]{1,32}$/;
const TWO_DAYS = 2 * 24 * 60 * 60;
const SEVENTY_DAYS = 70 * 24 * 60 * 60;

function reply(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

function clientIp(request) {
  return (request.headers.get('x-forwarded-for') ?? '').split(',')[0].trim() || 'unknown';
}

async function readJson(request) {
  const raw = await request.text();
  if (Buffer.byteLength(raw) > MAX_BODY_BYTES) return { tooLarge: true };
  try {
    return { value: JSON.parse(raw) };
  } catch {
    return {};
  }
}

// Builds the request handler. Everything it touches is injected so tests can run it offline:
// `store` holds the counters, `polish` calls the model, `alert` reports budget thresholds,
// `log` receives one line per request. No line and no key ever contains dictated text.
export function createPolishHandler({
  store, polish, budgetMicroUsd, ipSalt, alert = async () => {}, log = () => {}, now = () => new Date(),
}) {
  return async function handle(request) {
    const started = Date.now();
    const done = (status, body, fields = {}) => {
      log({ event: 'polish', status, ms: Date.now() - started, ...fields });
      return reply(status, body);
    };

    if (request.method !== 'POST') return done(405, { error: 'method' });
    const parsed = await readJson(request);
    if (parsed.tooLarge) return done(413, { error: 'too_long' });
    const { text, installId, appVersion } = parsed.value ?? {};
    if (typeof text !== 'string' || !text.trim() || typeof installId !== 'string' || !INSTALL_ID.test(installId)
      || (appVersion !== undefined && (typeof appVersion !== 'string' || !APP_VERSION.test(appVersion)))) {
      return done(400, { error: 'bad_request' });
    }
    const chars = Array.from(text).length;
    if (chars > MAX_TEXT_CHARS) return done(413, { error: 'too_long' }, { chars });

    const at = now();
    const day = at.toISOString().slice(0, 10);
    const month = day.slice(0, 7);
    const minute = at.toISOString().slice(0, 16);
    // The address is only ever stored as a salted hash, and only for two days.
    const ip = createHash('sha256').update(`${ipSalt}:${clientIp(request)}`).digest('hex').slice(0, 24);
    const keys = {
      install: `chars:install:${installId}:${day}`,
      ip: `chars:ip:${ip}:${day}`,
      rate: `rate:ip:${ip}:${minute}`,
      budget: `spend:${month}`,
    };
    const fields = { chars, installId, appVersion };

    let counters;
    try {
      counters = await store.pipeline([
        ['GET', keys.budget], ['GET', keys.install], ['GET', keys.ip], ['INCR', keys.rate], ['EXPIRE', keys.rate, 120],
      ]);
    } catch {
      // Without counters there are no limits, so there is no service.
      return done(503, { error: 'unavailable' }, fields);
    }
    const [spent, installChars, ipChars, requestsThisMinute] = counters.map((value) => Number(value ?? 0));
    if (spent >= budgetMicroUsd) return done(503, { error: 'budget' }, fields);
    if (requestsThisMinute > IP_REQUESTS_PER_MINUTE) return done(429, { error: 'rate' }, fields);
    if (installChars + chars > INSTALL_DAILY_CHARS || ipChars + chars > IP_DAILY_CHARS) {
      return done(429, { error: 'quota' }, fields);
    }

    let result;
    try {
      result = await polish(text);
    } catch (error) {
      return done(503, { error: 'upstream' }, { ...fields, reason: String(error?.message ?? error).slice(0, 40) });
    }

    const cost = costMicroUsd(result.usage);
    try {
      const [, , , , total] = await store.pipeline([
        ['INCRBY', keys.install, chars], ['EXPIRE', keys.install, TWO_DAYS],
        ['INCRBY', keys.ip, chars], ['EXPIRE', keys.ip, TWO_DAYS],
        ['INCRBY', keys.budget, cost], ['EXPIRE', keys.budget, SEVENTY_DAYS],
      ]);
      for (const percent of BUDGET_ALERT_PERCENTS) {
        const line = (budgetMicroUsd * percent) / 100;
        if (total >= line && total - cost < line) {
          const [first] = await store.pipeline([['SET', `alert:${month}:${percent}`, '1', 'NX', 'EX', SEVENTY_DAYS]]);
          if (first) await alert({ month, percent, spentUsd: total / 1e6, budgetUsd: budgetMicroUsd / 1e6 });
        }
      }
    } catch {
      // The user already has their text; a missed count is cheaper than a failed dictation.
    }
    return done(200, { text: result.text }, { ...fields, outChars: Array.from(result.text).length, microUsd: cost });
  };
}
