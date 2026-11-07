import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";

import {
  PLACEHOLDER_IDENTITY,
  STARTUP_TASK_ID,
  msixVersion,
  packageFileName,
  renderManifest,
  taskbarIconFiles,
  validateIdentity,
} from "./msix-lib.mjs";

const template = fs.readFileSync(
  new URL("../build/msix/AppxManifest.template.xml", import.meta.url),
  "utf8",
);
const tauriConf = JSON.parse(
  fs.readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"),
);

function render(overrides = {}) {
  return renderManifest(template, {
    identity: PLACEHOLDER_IDENTITY,
    version: tauriConf.version,
    displayName: tauriConf.productName,
    description: "Voice typing",
    executable: "TypeAloud.exe",
    ...overrides,
  });
}

test("the Store version is the app version with a zero fourth part", () => {
  assert.equal(msixVersion("1.19.3"), "1.19.3.0");
  assert.throws(() => msixVersion("1.19"));
  assert.throws(() => msixVersion("1.19.3-beta.1"));
  assert.throws(() => msixVersion("0.9.0"));
  assert.throws(() => msixVersion("1.70000.0"));
});

test("the shipped template renders with no placeholder left", () => {
  const manifest = render();
  assert.doesNotMatch(manifest, /\{\{/);
  assert.match(manifest, new RegExp(`Version="${msixVersion(tauriConf.version)}"`));
  assert.match(manifest, /Executable="TypeAloud\.exe"/);
});

test("the package asks for full trust and the microphone", () => {
  const manifest = render();
  assert.match(manifest, /<rescap:Capability Name="runFullTrust" \/>/);
  assert.match(manifest, /<DeviceCapability Name="microphone" \/>/);
  // The schema wants device capabilities last.
  assert.ok(manifest.indexOf("runFullTrust") < manifest.indexOf("DeviceCapability"));
});

test("every logo the manifest names exists among the app icons", () => {
  const manifest = render();
  const logos = [...manifest.matchAll(/Assets\\([A-Za-z0-9]+\.png)/g)].map((match) => match[1]);
  assert.ok(logos.length >= 3);
  for (const logo of logos) {
    assert.ok(
      fs.existsSync(new URL(`../src-tauri/icons/${logo}`, import.meta.url)),
      `missing icon: ${logo}`,
    );
  }
});

test("values are escaped into the manifest", () => {
  const manifest = render({ description: 'Speak & "type" <fast>' });
  assert.match(manifest, /Description="Speak &amp; &quot;type&quot; &lt;fast&gt;"/);
});

test("a malformed identity is refused before packing", () => {
  assert.doesNotThrow(() => validateIdentity(PLACEHOLDER_IDENTITY));
  assert.throws(() => validateIdentity({ ...PLACEHOLDER_IDENTITY, name: "Type Aloud" }));
  assert.throws(() => validateIdentity({ ...PLACEHOLDER_IDENTITY, publisher: "Tao" }));
  assert.throws(() => validateIdentity({ ...PLACEHOLDER_IDENTITY, publisherDisplayName: " " }));
});

test("the package file is named after the product and Store version", () => {
  assert.equal(packageFileName("TypeAloud", "1.19.3"), "TypeAloud_1.19.3.0_x64.msix");
});

test("the startup task the manifest declares is the one the app looks up", () => {
  const manifest = render();
  assert.match(
    manifest,
    new RegExp(`<desktop:StartupTask TaskId="${STARTUP_TASK_ID}" Enabled="false"`),
  );
  const windowsRs = fs.readFileSync(
    new URL("../src-tauri/src/platform/windows.rs", import.meta.url),
    "utf8",
  );
  assert.match(windowsRs, new RegExp(`const STARTUP_TASK_ID: &str = "${STARTUP_TASK_ID}";`));
});

test("every unplated taskbar icon exists at the size its name promises", () => {
  for (const { source, targets } of taskbarIconFiles()) {
    const file = new URL(`../build/msix/Assets/${source}`, import.meta.url);
    assert.ok(fs.existsSync(file), `missing icon: ${source}`);
    const png = fs.readFileSync(file);
    const size = Number(/targetsize-(\d+)_/.exec(source)[1]);
    // PNG IHDR: width and height are the big-endian words at bytes 16 and 20.
    assert.equal(png.readUInt32BE(16), size, `${source} width`);
    assert.equal(png.readUInt32BE(20), size, `${source} height`);
    assert.ok(targets.some((name) => name.endsWith("_altform-unplated.png")));
    assert.ok(targets.some((name) => name.endsWith("_altform-lightunplated.png")));
  }
});
