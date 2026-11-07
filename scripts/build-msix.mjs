#!/usr/bin/env node
// Wraps an already built Windows exe into the Microsoft Store (MSIX) package.
// The exe is the same one the NSIS installer ships: it detects the package
// identity at run time and leaves updating to the Store (platform/windows.rs).
//
// Usage: node scripts/build-msix.mjs [--exe <path>] [--layout-only]
//   --exe          the built exe (default: the x86_64-pc-windows-msvc release build)
//   --layout-only  write the package layout (with resources.pri on Windows) and
//                  stop before makeappx
//
// Identity comes from MSIX_IDENTITY_NAME / MSIX_PUBLISHER /
// MSIX_PUBLISHER_DISPLAY_NAME (Partner Center → Product identity). Without
// them the package gets a placeholder identity, good for local registration
// only. The package is left unsigned: the Store signs it during certification.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  PLACEHOLDER_IDENTITY,
  packageFileName,
  renderManifest,
  taskbarIconFiles,
} from "./msix-lib.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const layoutOnly = args.includes("--layout-only");
const exeFlag = args.indexOf("--exe");
const tauriConf = JSON.parse(
  fs.readFileSync(path.join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"),
);
const cargoToml = fs.readFileSync(path.join(repoRoot, "src-tauri", "Cargo.toml"), "utf8");
const cargoName = /^name\s*=\s*"([^"]+)"/m.exec(cargoToml)[1];
const targetDir = path.join(repoRoot, "src-tauri", "target");
const exePath = path.resolve(
  exeFlag >= 0
    ? args[exeFlag + 1]
    : path.join(targetDir, "x86_64-pc-windows-msvc", "release", `${cargoName}.exe`),
);
if (!fs.existsSync(exePath)) {
  console.error(`[build-msix] no exe at ${exePath} — build it first (tauri build --no-bundle)`);
  process.exit(1);
}

const supplied = {
  name: process.env.MSIX_IDENTITY_NAME,
  publisher: process.env.MSIX_PUBLISHER,
  publisherDisplayName: process.env.MSIX_PUBLISHER_DISPLAY_NAME,
};
const suppliedCount = Object.values(supplied).filter(Boolean).length;
if (suppliedCount !== 0 && suppliedCount !== 3) {
  console.error("[build-msix] set all three MSIX_* identity variables, or none");
  process.exit(1);
}
const identity = suppliedCount === 3 ? supplied : PLACEHOLDER_IDENTITY;
if (suppliedCount === 0) {
  console.warn("[build-msix] placeholder identity — this package can't be submitted to the Store");
}

const executable = `${tauriConf.productName}.exe`;
const manifest = renderManifest(
  fs.readFileSync(path.join(repoRoot, "build", "msix", "AppxManifest.template.xml"), "utf8"),
  {
    identity,
    version: tauriConf.version,
    displayName: tauriConf.productName,
    description: "Hold a key, speak, and the text lands at your cursor.",
    executable,
  },
);

const layoutDir = path.join(targetDir, "msix", "layout");
fs.rmSync(layoutDir, { recursive: true, force: true });
fs.mkdirSync(path.join(layoutDir, "Assets"), { recursive: true });
fs.writeFileSync(path.join(layoutDir, "AppxManifest.xml"), manifest);
fs.copyFileSync(exePath, path.join(layoutDir, executable));
for (const [, logo] of manifest.matchAll(/Assets\\([A-Za-z0-9]+\.png)/g)) {
  fs.copyFileSync(
    path.join(repoRoot, "src-tauri", "icons", logo),
    path.join(layoutDir, "Assets", logo),
  );
}
for (const { source, targets } of taskbarIconFiles()) {
  for (const target of targets) {
    fs.copyFileSync(
      path.join(repoRoot, "build", "msix", "Assets", source),
      path.join(layoutDir, "Assets", target),
    );
  }
}

// makeappx and makepri ship with the Windows SDK and aren't on PATH; take the
// newest SDK that has the tool.
function findSdkTool(exe) {
  const kits = path.join(
    process.env["ProgramFiles(x86)"] || "C:\\Program Files (x86)",
    "Windows Kits",
    "10",
    "bin",
  );
  const versions = fs.existsSync(kits)
    ? fs.readdirSync(kits).filter((name) => /^10\./.test(name)).sort().reverse()
    : [];
  for (const version of versions) {
    const candidate = path.join(kits, version, "x64", exe);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function requireSdkTool(exe) {
  const tool = findSdkTool(exe);
  if (!tool) {
    console.error(`[build-msix] ${exe} not found — install the Windows 10/11 SDK`);
    process.exit(1);
  }
  return tool;
}

// resources.pri indexes the Assets so Windows can pick the target-size and
// unplated icons; without it every icon falls back to the plated 44x44 one.
// makepri indexes a staging copy of Assets alone, so the exe and manifest
// don't end up as resources.
function buildResourcesPri() {
  const makePri = requireSdkTool("makepri.exe");
  const workDir = path.join(targetDir, "msix", "pri");
  fs.rmSync(workDir, { recursive: true, force: true });
  fs.mkdirSync(workDir, { recursive: true });
  fs.cpSync(path.join(layoutDir, "Assets"), path.join(workDir, "root", "Assets"), {
    recursive: true,
  });
  const config = path.join(workDir, "priconfig.xml");
  const pri = path.join(layoutDir, "resources.pri");
  execFileSync(makePri, ["createconfig", "/cf", config, "/dq", "en-US", "/pv", "10.0.0", "/o"], {
    stdio: "inherit",
  });
  execFileSync(
    makePri,
    [
      "new",
      "/pr", path.join(workDir, "root"),
      "/cf", config,
      "/mn", path.join(layoutDir, "AppxManifest.xml"),
      "/of", pri,
      "/o",
    ],
    { stdio: "inherit" },
  );
  // Fail here rather than ship plated icons: the dump must list the unplated
  // candidates of the taskbar logo.
  const dump = path.join(workDir, "resources.dump.xml");
  execFileSync(makePri, ["dump", "/if", pri, "/of", dump, "/dt", "detailed", "/o"], {
    stdio: "inherit",
  });
  const bytes = fs.readFileSync(dump);
  // makepri may write UTF-16 with a byte-order mark.
  const text = bytes[0] === 0xff && bytes[1] === 0xfe ? bytes.toString("utf16le") : bytes.toString("utf8");
  const unplated = (text.match(/altform-unplated/gi) || []).length;
  const expected = taskbarIconFiles().length;
  if (unplated < expected) {
    console.error(`[build-msix] resources.pri lists ${unplated} unplated icons, expected ${expected}`);
    process.exit(1);
  }
  console.log(`[build-msix] resources.pri: ${unplated} unplated icon candidates`);
}

if (process.platform === "win32") {
  buildResourcesPri();
} else if (!layoutOnly) {
  console.error("[build-msix] packing needs makepri and makeappx (Windows SDK); use --layout-only elsewhere");
  process.exit(1);
} else {
  console.warn("[build-msix] not on Windows: no resources.pri, so the taskbar icon will be plated");
}
console.log(`[build-msix] layout: ${layoutDir}`);
if (layoutOnly) process.exit(0);

const makeAppx = requireSdkTool("makeappx.exe");
const distDir = path.join(repoRoot, "dist");
fs.mkdirSync(distDir, { recursive: true });
const msixPath = path.join(distDir, packageFileName(tauriConf.productName, tauriConf.version));
execFileSync(makeAppx, ["pack", "/o", "/d", layoutDir, "/p", msixPath], { stdio: "inherit" });
console.log(`[build-msix] package: ${msixPath}`);
