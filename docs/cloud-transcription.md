# Cloud transcription

Groq and OpenAI are optional engines. This file keeps the model choices and the measurements behind
them, checked against `a183354` (1.15.1) on 2026-09-11.

## Current setup

- OpenAI has a single model row, `gpt-transcribe`. It is the default in `settings.rs`
  (`default_model`), in `commands.rs` (`default_model_for` and the empty-model fallback in
  `perform_transcription_request`) and in `input-prompt.js` (`RECORD_DEFAULT_MODEL`). Groq offers
  Whisper large-v3-turbo (its default, marked recommended) and large-v3.
- Chinese Whisper requests carry a punctuation seed, `SEED_ZH` in `commands.rs`. The local engines
  never receive it.
- Retired model ids keep their `MODEL_LABEL` entries so old History rows still show a name.
- There is no translate mode. The Shift+Alt translation to English (the Whisper
  `/audio/translations` endpoint, with its own provider choice and upload consent for local
  engines) was removed on 2026-09-25 as unused. Old History rows may still carry a `translate`
  field; nothing reads it.
- Audio is uploaded without noise suppression or AGC; see the decision in
  [audio-capture.md](audio-capture.md).

## Why these choices (measured 2026-07-03 and 2026-09-07)

A 77-call controlled sweep on 2026-07-03 (same audio sent to Groq/OpenAI, temperature × prompt, 3–5
repetitions each) and a head-to-head on 2026-09-07 back four decisions:

- **Groq recommends turbo over large-v3.** On a real 96-character run-on Chinese dictation,
  `whisper-large-v3` returned zero punctuation every time, with or without the seed, while
  `whisper-large-v3-turbo` + seed placed 3 marks correctly. Whether punctuation appears depends on the
  utterance, not on luck: repeats return byte-identical text.
- **`SEED_ZH` stays** because it costs nothing and helps turbo; it does not rescue large-v3. On
  degenerate repetitive audio `whisper-1` once returned the seed itself as the whole transcript; the
  VAD gate covers the silent case.
- **Don't add a temperature parameter for punctuation.** Groq's default is identical to
  `temperature=0`, and `0.4` was strictly worse (zero-punctuation collapse plus run-to-run variance).
- **OpenAI offers only `gpt-transcribe`** ($0.0045/min). On a 20 s run-on Chinese clip it matched
  `gpt-4o-mini-transcribe` ($0.003/min) on words and punctuation count (6 marks), but the mini used
  half-width ASCII commas and ran the utterance into one sentence, which `scrub.rs` doesn't fix; the
  price gap is about $0.68/month at 15 minutes a day. `gpt-4o-transcribe` and `whisper-1` cost more
  and collapsed to zero or near-zero punctuation. Caveat: one TTS clip.

For Groq users the lasting fix would be the LLM post-processing pass parked in TODO.md #1.

## Hallucination guards

Whisper large-v3 (zh) can append YouTube-outro boilerplate at long pauses or trailing silence, even
on otherwise correct long dictations. Current guards: the VAD gate skips clips with no speech and
trims audio to 300 ms before the first and 450 ms after the last speech segment (`bcc568d`), and
`scrub.rs` strips known boilerplate families and seed-prompt leaks, returning empty text when the
whole output is boilerplate (`5882e78`). Further options, such as segment-level `verbose_json`
filtering, are parked in TODO.md #10.

## OpenRouter candidates (measured 2026-11-22/23)

Context: issue #21 suggested OpenRouter, and the plan is to replace Groq with it (see
`docs/PRODUCT_PATHWAY.md`). Seven speech-to-text models went through
`POST https://openrouter.ai/api/v1/audio/transcriptions` on 40 real dictations from the maintainer's
own machine (40 sessions, 3–60 s each, about 9 minutes, mostly Chinese with English terms). There is
no hand-checked transcript, so the 27 clips where the leading candidates disagreed were judged one
by one from context; only wrong words count, not numeral style ("110万" vs "一百一十万") or punctuation.

| Model | Wrong words in the 27 clips | Median latency | Price per audio hour | Notes |
|---|---|---|---|---|
| `microsoft/mai-transcribe-2` | ~7 | 1.2 s | ~$0.10 | Masks profanity by default (`**`); `provider.options.azure.profanityFilterMode: "None"` turns it off. Marks repetitions with hyphens ("你-你-你") |
| `elevenlabs/scribe-v2` | ~8 | 1.8 s | ~$0.22 | Adds sound tags ("[咂嘴]") by default; `provider.options.elevenlabs.tag_audio_events: false` turns them off. Also uses "——"/"……" and repetition hyphens |
| `openai/gpt-transcribe` | ~11 | 1.5 s | ~$0.28 | The model behind today's OpenAI option; once flipped a meaning ("我们有必要" → "我没有必要") |
| `qwen/qwen3-asr-1.7b` | ~12 | 1.8 s | ~$0.027 | Same output as the local 1.7B (0.6 % apart). In the first run 11 of 40 requests took 15–28 s; reruns and a test after a night idle stayed under 3 s |
| `qwen/qwen3-asr-0.6b` | ~13 | 1.5 s | ~$0.012 | Close to 1.7B |
| `openai/whisper-large-v3-turbo` | far more | 2.0 s | ~$0.015 | Groq's model: no punctuation in 30 of 40, traditional characters, an invented "谢谢大家" |
| `nvidia/nemotron-3.5-transcribe` | unusable | — | ~$0.066 | Translates Chinese into English, or writes pinyin, even with `language: zh` |

Notes for building it: the request takes `provider: {"order": [...], "allow_fallbacks": ...}` (honoured
in multipart too; Qwen 1.7B is served by PrimeIntellect and DeepInfra at the same price), and Azure
forwards `provider.options.azure.*` as-is (ElevenLabs options pass the same way). The maintainer's
calls: masking or changing words is not acceptable, so MAI needs `profanityFilterMode: "None"`;
sound tags don't belong in dictated text, so Scribe needs `tag_audio_events: false`; hyphens at
repetitions and self-corrections are fine and stay. The whole run cost about $0.13.

### Second run: other speakers, with reference transcripts (2026-11-23)

The first run had one voice and no ground truth, so the three front-runners (Qwen 1.7B, MAI with
profanity filtering off, Scribe with sound tags off) went through 150 public clips that come with
human transcripts: 70 from ASCEND (spontaneous Hong Kong conversation, 23 speakers across its
splits; 50 clips that switch between Chinese and English, 20 Chinese-only) and 80 read sentences
from FLEURS (50 Mandarin, 30 English). The score is the error rate counting each Chinese character
and each English word as one token, after turning numerals into digits and traditional characters
into simplified ones, so number style and script don't count; lower is better.

| Set (clips) | Qwen 1.7B | MAI-2 | Scribe v2 |
|---|---|---|---|
| ASCEND mixed Chinese-English (50) | 11.4 % | 7.7 % | 5.9 % |
| ASCEND Chinese only (20) | 7.5 % | 8.3 % | 9.6 % |
| FLEURS Mandarin, read (50) | 2.0 % | 1.8 % | 2.3 % |
| FLEURS English, read (30) | 3.2 % | 2.7 % | 3.5 % |
| All 150 | 5.5 % | 4.4 % | 4.3 % |
| Median latency | 1.4 s | 1.0 s | 1.3 s |

Qwen's gap on mixed speech is mostly one failure mode: when a sentence starts in English it
sometimes translates the whole sentence into English ("so you know呃在赛马会呢…精算师…" came back
as "So you know, uh, in the horse racing, actually, they also hire a lot of actuaries…"), which
costs 40 tokens in one clip. Scribe's losses on Chinese-only clips are fillers: it writes 嗯 as 呃,
adds "……"/"——", and twice dropped or swapped a word ("之类的" → "这类"). On read speech all three
are within half a point. None returned traditional characters. All 150 requests succeeded, at about
$0.12 in total.


Decision (2026-11-23): the OpenRouter option defaults to Qwen 1.7B (cheapest, same family as the
local engine) and offers MAI-2 with `profanityFilterMode: "None"` as the more accurate choice.
Scribe is left out: its lead on mixed speech is small next to MAI's, it is the weakest on
Chinese-only speech, and it costs more than twice as much.

### The dictionary on OpenRouter (2026-11-23)

OpenRouter's endpoint takes the dictionary two ways: `prompt` (free text) and `keyterms` (a list of
up to 1000 terms of at most 100 characters each). Which one a model uses is not documented per
model, so five of the maintainer's dictations with misheard names were sent three ways: plain, with
the terms as `prompt`, and with them as `keyterms` (gpt-6.2-astra, Plaud, TestFlight, Voicely,
Meeting Mate, Codex, Parakeet).

- MAI ignored `prompt` (output identical to plain) and used `keyterms`: all five came out right
  ("6.2stra" → "6.2 astra", "Pro" → "Plaud", "test flight" → "TestFlight", "voicely" → "Voicely",
  "meeting mate" → "Meeting Mate"), at the same price.
- Qwen ignored `prompt` and answered `keyterms` with a 400 ("The selected model does not support
  keyterms").

So MAI gets the dictionary as `keyterms` and Qwen gets nothing. Two of the five fixes ("Pro" →
"Plaud", "6.2stra" → "astra") are beyond the term matching that runs after every engine.
