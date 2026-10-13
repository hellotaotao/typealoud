// Every number that bounds what the relay will do for free.

export const MAX_TEXT_CHARS = 4000;
export const MAX_BODY_BYTES = 32 * 1024;

// A person dictating two hours a day produces about 27,000 characters.
export const INSTALL_DAILY_CHARS = 50_000;
export const IP_DAILY_CHARS = 200_000;
export const IP_REQUESTS_PER_MINUTE = 60;

export const DEFAULT_MONTHLY_BUDGET_USD = 50;
export const BUDGET_ALERT_PERCENTS = [50, 80, 100];

export const MODEL = 'gpt-6-luna';
export const SERVICE_TIER = 'fast';
export const UPSTREAM_TIMEOUT_MS = 8000;

// USD per million tokens on the fast tier, which is also micro-dollars per token.
export const MICRO_USD_PER_TOKEN = { input: 0.2, cachedInput: 0.02, output: 1.0 };

export function costMicroUsd(usage) {
  const cached = usage?.prompt_tokens_details?.cached_tokens ?? 0;
  const input = (usage?.prompt_tokens ?? 0) - cached;
  const output = usage?.completion_tokens ?? 0;
  return Math.ceil(input * MICRO_USD_PER_TOKEN.input + cached * MICRO_USD_PER_TOKEN.cachedInput
    + output * MICRO_USD_PER_TOKEN.output);
}

// Chinese runs about 0.7 tokens per character; the margin covers English and added punctuation.
export function maxOutputTokens(chars) {
  return chars * 2 + 64;
}
