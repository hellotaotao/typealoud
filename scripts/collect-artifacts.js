#!/usr/bin/env node
"use strict";

// Post-build artifact handling for macOS.
//
// ALWAYS (the essential part): copy the freshly built .dmg out of Tauri's deep
// bundle directory (src-tauri/target/<triple>/release/bundle/dmg/) into a
// top-level dist/ folder, so every built version is archived there, and reveal
// it in Finder.
//
// With --install (opt-in convenience): also mount that .dmg, copy TypeAloud.app
// into /Applications over the old version, detach, and relaunch it.
//
// Usage: node scripts/collect-artifacts.js [target-triple] [--install]
//   - target-triple e.g. aarch64-apple-darwin (omit for a host build dir)
//   - --install also installs the app into /Applications

const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync } = require("child_process");

const args = process.argv.slice(2);
const triple = args.find((arg) => !arg.startsWith("--")) || "";
const wantInstall = args.includes("--install");

const repoRoot = path.resolve(__dirname, "..");
const bundleDir = path.join(repoRoot, "src-tauri", "target", triple, "release", "bundle");
const dmgDir = path.join(bundleDir, "dmg");
const distDir = path.join(repoRoot, "dist");

if (!fs.existsSync(dmgDir)) {
  console.warn(`[collect-artifacts] no dmg directory at ${dmgDir} — nothing to copy`);
  process.exit(0);
}

const dmgs = fs
  .readdirSync(dmgDir)
  .filter((name) => name.toLowerCase().endsWith(".dmg"))
  .map((name) => path.join(dmgDir, name));

if (!dmgs.length) {
  console.warn(`[collect-artifacts] no .dmg found in ${dmgDir}`);
  process.exit(0);
}

fs.mkdirSync(distDir, { recursive: true });

const copied = [];
for (const src of dmgs) {
  const dest = path.join(distDir, path.basename(src));
  fs.copyFileSync(src, dest);
  copied.push(dest);
}

console.log("\n[collect-artifacts] installer archived to dist/:");
for (const dest of copied) {
  console.log("  " + path.relative(repoRoot, dest));
}

// Newest dmg drives both the Finder reveal and the optional install.
const newestDmg = copied
  .map((p) => ({ p, mtime: fs.statSync(p).mtimeMs }))
  .sort((a, b) => b.mtime - a.mtime)[0].p;

if (wantInstall && process.platform === "darwin") {
  installToApplications(newestDmg);
}

// Reveal the newest installer in Finder (macOS only, best-effort).
if (process.platform === "darwin") {
  try {
    execFileSync("open", ["-R", newestDmg]);
  } catch {
    // Revealing in Finder is a convenience only; ignore failures.
  }
}

function installToApplications(dmgPath) {
  const appName = "TypeAloud.app";
  const destApp = path.join("/Applications", appName);

  // Quit the currently running app so the bundle can be replaced.
  try {
    execFileSync("osascript", ["-e", 'tell application "TypeAloud" to quit']);
  } catch {
    /* not running */
  }
  // SayType.app is the pre-rename bundle. A running copy would keep the global
  // hotkey and transcribe alongside the freshly installed app.
  for (const bundle of [appName, "SayType.app"]) {
    try {
      execFileSync("pkill", ["-f", `${bundle}/Contents/MacOS/`]);
    } catch {
      /* not running */
    }
  }

  // Mount at a unique temp path so a leftover/duplicate volume name can't
  // collide (which would mount as "TypeAloud 1" and leak), and detach is exact.
  const mountPoint = fs.mkdtempSync(path.join(os.tmpdir(), "typealoud-dmg-"));
  let mounted = false;
  try {
    execFileSync("hdiutil", [
      "attach",
      "-nobrowse",
      "-noverify",
      "-noautoopen",
      "-mountpoint",
      mountPoint,
      dmgPath,
    ]);
    mounted = true;

    const srcApp = path.join(mountPoint, appName);
    if (!fs.existsSync(srcApp)) {
      throw new Error(`${appName} not found in mounted dmg`);
    }
    fs.rmSync(destApp, { recursive: true, force: true });
    execFileSync("ditto", [srcApp, destApp]);
    console.log(`[collect-artifacts] installed ${appName} → /Applications (over old version)`);
  } catch (error) {
    console.warn(`[collect-artifacts] install skipped: ${error.message}`);
  } finally {
    if (mounted) {
      try {
        execFileSync("hdiutil", ["detach", mountPoint, "-quiet"]);
      } catch {
        try {
          execFileSync("hdiutil", ["detach", mountPoint, "-force", "-quiet"]);
        } catch {
          /* leave it mounted rather than fail the build */
        }
      }
    }
    try {
      fs.rmSync(mountPoint, { recursive: true, force: true });
    } catch {
      /* temp mountpoint cleanup is best-effort */
    }
  }

  // Relaunch the freshly installed app.
  try {
    execFileSync("open", [destApp]);
  } catch {
    /* best-effort */
  }
}
