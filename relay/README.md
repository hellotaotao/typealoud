# TypeAloud polish relay

`POST /v1/polish` takes dictated text, sends it to the polish model with a fixed prompt, and
returns the cleaned text. It exists so users get polish without their own API key. Design,
measurements and the reasons for the limits: `docs/superpowers/specs/2026-10-13-cloud-polish-design.md`.

```
POST /v1/polish
{ "text": "...", "installId": "random id, 16-64 chars", "appVersion": "1.20.0" }

200 { "text": "..." }
400 bad_request   413 too_long   429 rate | quota   503 budget | upstream | unavailable
```

The app treats anything but 200 as "insert the unpolished text".

## What is stored

Counters only: characters per install per day, characters and requests per hashed address, and
the month's spend. Dictated text is never written to the store or the logs. A log line holds the
status, duration, character counts, install id, app version and cost.

## Run the tests

```bash
npm test --prefix relay
```

## Deploy

A Vercel project with **Root Directory** `relay`, an Upstash Redis store attached from the Vercel
Marketplace (it sets `KV_REST_API_URL` and `KV_REST_API_TOKEN`), and these variables:

| Variable | Value |
|---|---|
| `OPENAI_API_KEY` | A key used only by the relay, in an OpenAI project with its own spend limit |
| `IP_HASH_SALT` | Any long random string |
| `MONTHLY_BUDGET_USD` | Optional, default 50 |
| `ALERT_WEBHOOK_URL` | Optional. Receives a JSON POST when spend passes 50%, 80% and 100% |

Without the key, the store or the salt the endpoint answers 503. Limits are in `lib/limits.js`.
