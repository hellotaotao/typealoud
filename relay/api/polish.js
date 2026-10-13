import { createPolishHandler } from '../lib/handler.js';
import { DEFAULT_MONTHLY_BUDGET_USD } from '../lib/limits.js';
import { polishWithOpenAi } from '../lib/openai.js';
import { upstashStore } from '../lib/store.js';

const env = process.env;
const storeUrl = env.UPSTASH_REDIS_REST_URL ?? env.KV_REST_API_URL;
const storeToken = env.UPSTASH_REDIS_REST_TOKEN ?? env.KV_REST_API_TOKEN;
const configured = Boolean(env.OPENAI_API_KEY && storeUrl && storeToken && env.IP_HASH_SALT);

async function alert(message) {
  if (!env.ALERT_WEBHOOK_URL) return;
  const text = `TypeAloud polish spend reached ${message.percent}% of the ${message.month} budget: `
    + `$${message.spentUsd.toFixed(2)} of $${message.budgetUsd}.`;
  await fetch(env.ALERT_WEBHOOK_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text, ...message }),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
}

const handle = configured && createPolishHandler({
  store: upstashStore({ url: storeUrl, token: storeToken }),
  polish: (text) => polishWithOpenAi(text, { apiKey: env.OPENAI_API_KEY }),
  budgetMicroUsd: Number(env.MONTHLY_BUDGET_USD ?? DEFAULT_MONTHLY_BUDGET_USD) * 1e6,
  ipSalt: env.IP_HASH_SALT,
  alert,
  log: (line) => console.log(JSON.stringify(line)),
});

export default {
  fetch(request) {
    if (!handle) return Response.json({ error: 'unavailable' }, { status: 503 });
    return handle(request);
  },
};
