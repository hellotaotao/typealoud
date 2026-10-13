import { MODEL, SERVICE_TIER, UPSTREAM_TIMEOUT_MS, maxOutputTokens } from './limits.js';
import { POLISH_PROMPT, wrapTranscript } from './prompt.js';

export function polishRequestBody(text) {
  return {
    model: MODEL,
    // Reasoning adds seconds to every dictation and bills its tokens as output.
    reasoning_effort: 'none',
    service_tier: SERVICE_TIER,
    max_completion_tokens: maxOutputTokens(Array.from(text).length),
    messages: [
      { role: 'system', content: POLISH_PROMPT },
      { role: 'user', content: wrapTranscript(text) },
    ],
  };
}

// Resolves to { text, usage }; rejects on any failure, timeout, or empty answer.
export async function polishWithOpenAi(text, { apiKey, fetchImpl = fetch }) {
  const response = await fetchImpl('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(polishRequestBody(text)),
    signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`upstream ${response.status}`);
  const body = await response.json();
  const polished = body.choices?.[0]?.message?.content?.trim();
  if (!polished) throw new Error('upstream empty');
  return { text: polished, usage: body.usage };
}
