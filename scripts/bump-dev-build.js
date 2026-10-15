#!/usr/bin/env node
"use strict";

// Increments the local dev build counter (.dev-build-number at the repo root,
// gitignored — same local-state precedent as scripts/sign.env). Runs before
// every packaged build; `tauri dev` does not bump. src-tauri/build.rs embeds
// the value as TYPEALOUD_BUILD_NUMBER for the dev-channel version badge.

const fs = require("fs");
const path = require("path");

const counterPath = path.join(__dirname, "..", ".dev-build-number");

let current = 0;
try {
  current = parseInt(fs.readFileSync(counterPath, "utf8").trim(), 10) || 0;
} catch {
  // Missing or unreadable file: start from 0.
}

const next = current + 1;
fs.writeFileSync(counterPath, `${next}\n`);
console.log(`Dev build number: ${next}`);
