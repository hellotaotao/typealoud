#!/usr/bin/env node
// Runs the relay's polish prompt (relay/lib/prompt.js) over a set of dictation cases and prints each result with two
// fidelity numbers, so a prompt or model change can be compared against the last one.
//
//   OPENAI_API_KEY=... node scripts/polish-eval/run.mjs [--cases file] [--prompt file]
//                                                       [--model id] [--tier default|fast] [--runs n]
//
// novelty: share of the output's letters and digits that are not in the input (rewording).
// kept:    share of the input's letters and digits that survive (how much was deleted).
// Punctuation and whitespace are ignored by both. cases.json holds hand-written cases only;
// real dictations stay out of the repository.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { POLISH_PROMPT, wrapTranscript } from '../../relay/lib/prompt.js';

const here = dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(process.argv.slice(2).join(' ').split('--').filter(Boolean)
  .map((pair) => pair.trim().split(/\s+/)).map(([name, value]) => [name, value]));
const key = process.env.OPENAI_API_KEY;
if (!key) {
  console.error('Set OPENAI_API_KEY.');
  process.exit(1);
}
const model = args.model ?? 'gpt-6-luna';
const tier = args.tier ?? 'default';
const runs = Number(args.runs ?? 1);
const system = args.prompt ? readFileSync(args.prompt, 'utf8').trim() : POLISH_PROMPT;
const cases = JSON.parse(readFileSync(args.cases ?? join(here, 'cases.json'), 'utf8'));

const lettersOf = (text) => Array.from(text.replace(/[^\p{L}\p{N}]+/gu, ''));

function commonLength(a, b) {
  let previous = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i += 1) {
    const current = [0];
    for (let j = 1; j <= b.length; j += 1) {
      current[j] = a[i - 1] === b[j - 1] ? previous[j - 1] + 1 : Math.max(previous[j], current[j - 1]);
    }
    previous = current;
  }
  return previous[b.length];
}

async function polish(text) {
  const started = Date.now();
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    // Reasoning stays off: it adds seconds and its tokens are billed as output.
    body: JSON.stringify({
      model, reasoning_effort: 'none', service_tier: tier,
      messages: [{ role: 'system', content: system }, { role: 'user', content: wrapTranscript(text) }],
    }),
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`${response.status} ${JSON.stringify(body.error ?? body)}`);
  return { output: body.choices[0].message.content.trim(), seconds: (Date.now() - started) / 1000, usage: body.usage };
}

let inputTokens = 0, cachedTokens = 0, outputTokens = 0;
const seconds = [];
for (const item of cases) {
  const outputs = new Map();
  for (let run = 0; run < runs; run += 1) {
    const result = await polish(item.text);
    inputTokens += result.usage.prompt_tokens;
    cachedTokens += result.usage.prompt_tokens_details?.cached_tokens ?? 0;
    outputTokens += result.usage.completion_tokens;
    seconds.push(result.seconds);
    outputs.set(result.output, (outputs.get(result.output) ?? 0) + 1);
  }
  console.log(`\n[${item.id}] ${item.kind} — ${item.expect}`);
  console.log(`  in:  ${item.text}`);
  for (const [output, count] of outputs) {
    const before = lettersOf(item.text), after = lettersOf(output);
    const common = commonLength(before, after);
    const novelty = after.length ? 1 - common / after.length : 0;
    const kept = before.length ? common / before.length : 1;
    console.log(`  out: ${output.replace(/\n/g, '\\n')}`);
    console.log(`       x${count}  novelty ${novelty.toFixed(3)}  kept ${kept.toFixed(3)}`);
  }
}
seconds.sort((a, b) => a - b);
console.log(`\n${model} (${tier}): ${seconds.length} requests, median ${seconds[Math.floor(seconds.length / 2)].toFixed(2)}s, `
  + `max ${seconds.at(-1).toFixed(2)}s; tokens in ${inputTokens} (cached ${cachedTokens}), out ${outputTokens}`);
