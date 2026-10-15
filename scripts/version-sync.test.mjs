import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const read = (path) => readFileSync(new URL(`../${path}`, import.meta.url), "utf8");

// scripts/bump-tauri-version.js writes all five; a file it misses drifts silently.
test("every manifest and lockfile carries the same version", () => {
  const version = JSON.parse(read("package.json")).version;
  const lock = JSON.parse(read("package-lock.json"));
  assert.equal(lock.version, version, "package-lock.json");
  assert.equal(lock.packages[""].version, version, "package-lock.json packages[\"\"]");
  assert.equal(JSON.parse(read("src-tauri/tauri.conf.json")).version, version, "tauri.conf.json");
  assert.match(read("src-tauri/Cargo.toml"), new RegExp(`^version\\s*=\\s*"${version}"\\s*$`, "m"), "Cargo.toml");
  assert.match(
    read("src-tauri/Cargo.lock"),
    new RegExp(`name = "typealoud"\\r?\\nversion = "${version}"`),
    "Cargo.lock"
  );
});
