const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "..");
const packageJsonPath = path.join(root, "package.json");
const packageLockPath = path.join(root, "package-lock.json");
const cargoTomlPath = path.join(root, "src-tauri", "Cargo.toml");
const cargoLockPath = path.join(root, "src-tauri", "Cargo.lock");
const tauriConfigPath = path.join(root, "src-tauri", "tauri.conf.json");

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;

function bumpPatch(version) {
  const match = version.match(SEMVER);
  if (!match) {
    throw new Error(`Unsupported version format: ${version}`);
  }
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]) + 1;
  return `${major}.${minor}.${patch}`;
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeJson(filePath, data) {
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

// Replace the [package] version in Cargo.toml (the first top-level `version = "..."`).
function updateCargoTomlVersion(filePath, version) {
  const re = /^(version\s*=\s*")[^"]+("\s*)$/m;
  const content = fs.readFileSync(filePath, "utf8");
  if (!re.test(content)) {
    throw new Error("Could not find a [package] version line in src-tauri/Cargo.toml");
  }
  fs.writeFileSync(filePath, content.replace(re, `$1${version}$2`), "utf8");
}

// Replace the version of this crate's own entry in Cargo.lock (leave deps alone).
function updateCargoLockVersion(filePath, version) {
  // Cargo.lock is CRLF in a Windows checkout, so these two lines are not joined
  // by a bare \n. Matching one pins the whole release flow to LF platforms, and
  // it fails *after* the other three files are already rewritten.
  const re = /(name = "typealoud"\r?\nversion = ")[^"]+(")/;
  const content = fs.readFileSync(filePath, "utf8");
  if (!re.test(content)) {
    throw new Error('Could not find the "typealoud" package entry in src-tauri/Cargo.lock');
  }
  fs.writeFileSync(filePath, content.replace(re, `$1${version}$2`), "utf8");
}

function main() {
  const packageJson = readJson(packageJsonPath);
  const currentVersion = packageJson.version;

  // Optional explicit target version:
  //   node scripts/bump-tauri-version.js 1.2.0   (supports minor/major)
  // With no argument, bump the patch component (x.y.Z -> x.y.Z+1).
  const explicit = process.argv[2];
  let nextVersion;
  if (explicit) {
    if (!SEMVER.test(explicit)) {
      throw new Error(`Invalid version "${explicit}" — expected MAJOR.MINOR.PATCH, e.g. 1.2.0`);
    }
    nextVersion = explicit;
  } else {
    nextVersion = bumpPatch(currentVersion);
  }

  packageJson.version = nextVersion;
  writeJson(packageJsonPath, packageJson);

  // The lockfile repeats this package's own version twice. Left behind, every
  // later `npm install` rewrites it and leaves a stray diff.
  const packageLock = readJson(packageLockPath);
  packageLock.version = nextVersion;
  packageLock.packages[""].version = nextVersion;
  writeJson(packageLockPath, packageLock);

  const tauriConfig = readJson(tauriConfigPath);
  tauriConfig.version = nextVersion;
  writeJson(tauriConfigPath, tauriConfig);

  updateCargoTomlVersion(cargoTomlPath, nextVersion);
  updateCargoLockVersion(cargoLockPath, nextVersion);

  console.log(
    `Set version ${currentVersion} -> ${nextVersion} ` +
      "(package.json, package-lock.json, tauri.conf.json, Cargo.toml, Cargo.lock)"
  );
}

main();
