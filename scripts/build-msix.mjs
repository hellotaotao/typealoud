#!/usr/bin/env node
// Wraps an already built Windows exe into the Microsoft Store (MSIX) package.
// The exe is the same one the NSIS installer ships: it detects the package
// identity at run time and leaves updating to the Store (platform/windows.rs).
//
// Usage: node scripts/build-msix.mjs [--exe <path>] [--layout-only]
//   --exe          the built exe (default: the x86_64-pc-windows-msvc release build)
//   --layout-only  write the package layout and stop before makeappx
//
// Identity comes from MSIX_IDENTITY_NAME / MSIX_PUBLISHER /
// MSIX_PUBLISHER_DISPLAY_NAME (Partner Center → Product identity). Without
// them the package gets a placeholder identity, good for local registration
// only. The package is left unsigned: the Store signs it during certification.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PLACEHOLDER_IDENTITY, packageFileName, renderManifest } from "./msix-lib.mjs";

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
console.log(`[build-msix] layout: ${layoutDir}`);
if (layoutOnly) process.exit(0);

// makeappx ships with the Windows SDK and isn't on PATH; take the newest one.
function findMakeAppx() {
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
    const candidate = path.join(kits, version, "x64", "makeappx.exe");
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

if (process.platform !== "win32") {
  console.error("[build-msix] packing needs makeappx (Windows SDK); use --layout-only elsewhere");
  process.exit(1);
}
const makeAppx = findMakeAppx();
if (!makeAppx) {
  console.error("[build-msix] makeappx.exe not found — install the Windows 10/11 SDK");
  process.exit(1);
}

const distDir = path.join(repoRoot, "dist");
fs.mkdirSync(distDir, { recursive: true });
const msixPath = path.join(distDir, packageFileName(tauriConf.productName, tauriConf.version));
execFileSync(makeAppx, ["pack", "/o", "/d", layoutDir, "/p", msixPath], { stdio: "inherit" });
console.log(`[build-msix] package: ${msixPath}`);
