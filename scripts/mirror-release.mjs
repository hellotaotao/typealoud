#!/usr/bin/env node
// Copies a published release's macOS and Windows packages to the
// mainland-China mirror (the saytype-downloads Blob store behind
// typealoud.app/download) and writes the mirror's own latest.json there.
// Run by release.yml after the GitHub release is published; safe to re-run.
//
//   BLOB_READ_WRITE_TOKEN=... node scripts/mirror-release.mjs v1.19.0

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { MIRROR_BASE, mirrorManifest, mirroredAssetNames, mirrorPath, stalePaths } from "./mirror-release-lib.mjs";

// The SDK is installed into the scratch directory per run, so the repo keeps
// no JS dependency for it. The `vercel blob` CLI is not an option here: it
// demands a Vercel login even when handed the store's own token.
const BLOB_SDK = "@vercel/blob@2.8.1";
const YEAR_SECONDS = 365 * 24 * 60 * 60;
// Blob's shortest cache lifetime; the manifest and index change every release.
const MANIFEST_MAX_AGE = 60;
const INDEX_PATH = "releases/current.json";

const tag = process.argv[2];
const token = process.env.BLOB_READ_WRITE_TOKEN;
if (!/^v\d+\.\d+\.\d+/.test(tag ?? "") || !token) {
  console.error("usage: BLOB_READ_WRITE_TOKEN=... node scripts/mirror-release.mjs vX.Y.Z");
  process.exit(2);
}

async function put(sdk, file, path, maxAge) {
  const { url } = await sdk.put(path, readFileSync(file), {
    access: "public",
    token,
    addRandomSuffix: false,
    allowOverwrite: true,
    cacheControlMaxAge: maxAge,
    multipart: true,
  });
  return url;
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function fetchMirror(path) {
  // A unique query string gets past the cached copy of a file just replaced.
  const response = await fetch(`${MIRROR_BASE}/${path}?mirror-check=${Date.now()}`);
  return response.ok ? Buffer.from(await response.arrayBuffer()) : null;
}

function writeJson(name, value) {
  const file = join(dir, name);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  return file;
}

const dir = mkdtempSync(join(tmpdir(), "typealoud-mirror-"));
try {
  execFileSync("npm", ["install", "--silent", "--no-audit", "--no-fund", "--prefix", dir, BLOB_SDK], { stdio: "inherit" });
  const sdk = await import(pathToFileURL(createRequire(join(dir, "package.json")).resolve("@vercel/blob")).href);

  const release = JSON.parse(execFileSync("gh", ["release", "view", tag, "--json", "assets,isDraft"], { encoding: "utf8" }));
  if (release.isDraft) throw new Error(`${tag} is still a draft; mirror only published releases`);
  execFileSync("gh", ["release", "download", tag, "--dir", dir, "--pattern", "latest.json"]);
  const manifest = JSON.parse(readFileSync(join(dir, "latest.json"), "utf8"));
  if (`v${manifest.version}` !== tag) throw new Error(`latest.json is ${manifest.version}, expected ${tag}`);

  const names = mirroredAssetNames(manifest, release.assets.map((asset) => asset.name));
  const paths = names.map((name) => mirrorPath(tag, name));
  const previousIndex = JSON.parse((await fetchMirror(INDEX_PATH))?.toString("utf8") ?? "null");

  for (const name of names) {
    execFileSync("gh", ["release", "download", tag, "--dir", dir, "--pattern", name]);
    await put(sdk, join(dir, name), mirrorPath(tag, name), YEAR_SECONDS);
    const served = await fetchMirror(mirrorPath(tag, name));
    if (!served || sha256(served) !== sha256(readFileSync(join(dir, name)))) {
      throw new Error(`${name} does not read back intact from the mirror`);
    }
    console.log(`mirrored ${name}`);
  }

  // The manifest goes last, so clients never see one whose packages are missing.
  const manifestUrl = await put(sdk, writeJson("mirror-latest.json", mirrorManifest(manifest, tag)), "latest.json", MANIFEST_MAX_AGE);
  await put(sdk, writeJson("current.json", { tag, paths }), INDEX_PATH, MANIFEST_MAX_AGE);
  console.log(`mirror manifest now serves ${tag}`);

  const storeBase = manifestUrl.slice(0, -"latest.json".length);
  for (const path of stalePaths(previousIndex, paths)) {
    await sdk.del(storeBase + path, { token });
    console.log(`removed ${path}`);
  }
} finally {
  rmSync(dir, { recursive: true, force: true });
}
