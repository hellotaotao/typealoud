# Releasing

**English** · [中文说明 ↓](#发布中文)

TypeAloud ships installers for **macOS, Windows and Linux** on the project's
[GitHub Releases](https://github.com/hellotaotao/typealoud/releases) page. They are built by the
[`Release`](.github/workflows/release.yml) GitHub Actions workflow; nothing is built or uploaded by
hand.

## What the workflow does

Pushing a tag shaped like `vX.Y.Z` runs a **3-platform matrix**:

1. **macOS**: a **universal** binary (Intel + Apple Silicon) via
   `tauri build --target universal-apple-darwin`, signed with Developer ID, notarized and stapled,
   **if** the signing secrets are configured (see [One-time setup](#one-time-setup)).
2. **Windows**: NSIS `.exe` + `.msi`. **Linux**: AppImage, deb, rpm. Both are unsigned, and neither is
   verified on real machines.
3. Every leg emits minisign-signed **auto-update artifacts** and merges them into one `latest.json`.
   `createUpdaterArtifacts` is set only in `tauri.release.conf.json`, so local builds never need the
   updater key.
4. A follow-up job writes bilingual AI release notes into the release (optional, see
   [Release notes](#release-notes)).
5. Everything above lands in a **draft** release (created up front by the `create-release` job).
   When every leg has uploaded and the notes job has run, the `publish` job turns the draft into the
   latest release. Nothing is manual: pushing the tag is still the whole release.

Publishing is also the **auto-update rollout**. Installed clients (v1.4.0 and later) check
`releases/latest/download/latest.json` at startup and every 24 hours, download in the background, and
offer "Restart to update" in the tray and in Settings. Because the release stays a draft until all
three legs are in, no client ever sees a `latest.json` that lacks its platform. (Before this change the
release was published by the first leg, and a Mac that checked in the minutes before the macOS leg
finished got an update error.)

If a leg fails, the draft stays unpublished and clients keep the previous version. Re-run the failed
jobs from the Actions run; `publish` runs once they pass. To give up on the version, delete the draft.

> The workflow only runs on `v*` tag pushes; ordinary commits never trigger it.

## Cutting a release

The version shown in the app is compiled from `Cargo.toml` (`env!("CARGO_PKG_VERSION")`), and the
workflow builds whatever version is in the tagged commit. So bump and commit first, then tag:

```bash
npm run version:tauri:patch        # or: node scripts/bump-tauri-version.js 1.2.0
git commit -am "chore(release): bump version to X.Y.Z"
git tag vX.Y.Z && git push origin main --tags
```

Then watch the **Actions** tab. A first run takes ~15–25 min (two architectures plus the notary
queue); later runs are faster thanks to the Rust cache.

> Don't use `npm run build:mac` to cut a release. It produces a local dev-channel build, signed with
> the identity in `scripts/sign.env` if that file exists and never notarized.

### If a release is bad

Clients follow `releases/latest`, which resolves to the newest published, non-prerelease release.
Turning the bad release back into a draft (or deleting it) points `latest` at the previous version
again, so clients that haven't updated stop being offered it. Clients that already updated stay on
the bad version until a newer one is published, so the real fix is another patch release.

<a id="one-time-setup"></a>

## One-time setup

### Signing & notarization (macOS)

Without these secrets the workflow still **succeeds**, but the `.dmg` is **unsigned**: downloaders
hit a Gatekeeper warning and must right-click → Open (or run `xattr -cr /Applications/TypeAloud.app`).
The "Configure Apple signing" step passes the `APPLE_*` values to tauri-cli only when
`APPLE_CERTIFICATE` is set, so adding them later needs no workflow change.

Notarization means Apple scans the signed app and returns a ticket that is **stapled into the
bundle**, so Gatekeeper lets other Macs run it without the "unidentified developer" warning. It
requires the Hardened Runtime (already on) and a **Developer ID Application** certificate. The
`Apple Development` certificate used for local builds is a different type, and the notary service
rejects it.

| Secret | How to get it |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | The full `Developer ID Application: Name (TEAMID)` string from `security find-identity -v -p codesigning`. This repo: `Developer ID Application: Tao Wang (CU3VTR9MRH)` |
| `APPLE_TEAM_ID` | The 10-character ID in the parentheses above (this repo: `CU3VTR9MRH`) |
| `APPLE_CERTIFICATE` | Base64 of the exported `.p12` (see below) |
| `APPLE_CERTIFICATE_PASSWORD` | The password set when exporting the `.p12` |
| `APPLE_ID` | The Apple Developer account email |
| `APPLE_PASSWORD` | An [app-specific password](https://appleid.apple.com) (Sign-In and Security → App-Specific Passwords), **not** the login password |

**Creating and exporting the certificate:** create a *Developer ID Application* certificate in
Xcode → Settings → Accounts → (team) → Manage Certificates → `+`, or at
[developer.apple.com](https://developer.apple.com/account/resources/certificates/list). In Keychain
Access → *login* → *My Certificates*, expand the entry to confirm it has a private key, export it as
a password-protected `.p12`, then:

```bash
base64 -i ~/Desktop/certificate.p12 | pbcopy   # paste into APPLE_CERTIFICATE
```

`tauri-action` imports the certificate into a temporary keychain and signs; because the `APPLE_ID` /
`APPLE_PASSWORD` / `APPLE_TEAM_ID` trio is present, it then notarizes and staples. An App Store
Connect API key (`APPLE_API_ISSUER` / `APPLE_API_KEY` / `APPLE_API_KEY_PATH`) can replace the trio.
`tauri.conf.json` keeps `signingIdentity: null` on purpose: in CI the environment variable takes over,
and local builds are unaffected.

### Updater signing key

| Secret | Value |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | Contents of `~/.tauri/saytype-updater.key` (minisign). **Back it up: if this key is lost, installed clients can never auto-update again.** |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | The key's password (also in the local `scripts/sign.env`) |

The bundler reads only `TAURI_SIGNING_PRIVATE_KEY` (a path or the contents); a `_PATH` variant is
ignored. The matching public key is in `tauri.conf.json`.

### Usage statistics key

| Secret | Value |
| --- | --- |
| `SAYTYPE_POSTHOG_KEY` | The project API key (`phc_…`) of the TypeAloud project in PostHog's EU region. It is write-only and public by design. |

It is compiled into official builds (`usage.rs`). Without it a release still builds and records
counts locally, but never sends them. In the PostHog project settings, turn on "Discard client IP
data". What is sent is described in `PRIVACY.md`.

<a id="release-notes"></a>

### Release notes

After the build, the workflow runs `scripts/generate-release-notes.mjs`: commits from the previous
`v*` tag to this one → Claude API (`claude-sonnet-5`) → bilingual (EN + 中文) user-facing notes,
written into the release with `gh release edit`. It needs the `ANTHROPIC_API_KEY` secret; if that is
missing or the call fails, the step warns and the release keeps its default body. Debug locally with
`node scripts/generate-release-notes.mjs <tag> --dry-run` (prints the prompt, no API call). Design:
`docs/superpowers/specs/2026-07-12-ai-release-notes-design.md`.

## Verifying

**Notarization**, on the downloaded app:

- `spctl -a -t exec -vv TypeAloud.app` → `accepted … source=Notarized Developer ID`
- `xcrun stapler validate TypeAloud.app` → `The validate action worked!`

**Auto-update end to end without publishing**, using `src-tauri/tauri.updater-e2e.conf.json`
(localhost endpoint). This replaces `/Applications/TypeAloud.app` and temporarily bumps the version
files. Don't run `scripts/collect-artifacts.js` during it, or it overwrites the archived installer in
`dist/`.

1. Quit TypeAloud and build the "old" version:
   `CI=true sh -c '. ./scripts/sign.env; npx tauri build --target aarch64-apple-darwin --config src-tauri/tauri.updater-e2e.conf.json'`.
   Replace `/Applications/TypeAloud.app` with
   `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/TypeAloud.app`.
2. Run `npm run version:tauri:patch` (don't commit) and build again with the same command. Check that
   `TypeAloud.app.tar.gz` and its `.sig` exist in that bundle directory.
3. Copy the `.tar.gz` into a scratch directory and write a `latest.json` next to it: the new `version`,
   and a `platforms["darwin-aarch64"]` entry whose `signature` is the `.sig` contents and whose `url`
   is `http://127.0.0.1:8765/TypeAloud.app.tar.gz`. Serve that directory with
   `python3 -m http.server 8765`.
4. Restore the version files with
   `git checkout -- package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock`,
   open the installed app and use Settings → "Check for updates". Expect checking → downloading →
   ready, a "Restart to update to vX.Y.Z" tray entry, a relaunch into the new version, and dictation
   still working with no new permission prompts.
5. Stop the server and reinstall the real build with `npm run build:mac:install`.

## Troubleshooting

- **Notarization fails with 401.** GitHub secrets are write-only, so validate the app-specific
  password locally with
  `xcrun notarytool history --apple-id <apple-id> --team-id CU3VTR9MRH --password <password>`. If that
  works, `gh secret set APPLE_PASSWORD` and re-run the failed job; the tag doesn't need to be pushed
  again. Changing the Apple ID login password revokes every app-specific password.
- **Only the release build fails to compile.** `ci.yml` builds macOS for arm64 only, while releases
  build universal. `#[cfg]` code that misses the `macos` + `x86_64` combination compiles locally and in
  CI, then fails on the tag. Reproduce with
  `rustup target add x86_64-apple-darwin && cargo check --target x86_64-apple-darwin`.

## Distribution

GitHub Releases hosts the installers and is the primary auto-update source. That is reliable outside
mainland China. macOS builds stay universal.

**Mainland-China mirror.** GitHub is slow or unreachable from mainland China, so the files a
mainland user needs are also served from `https://typealoud.app/download/`. That path is a
rewrite in the `saytype-web` repo's `vercel.json` to the Vercel Blob store `saytype-downloads`
(Hong Kong region, public), so nothing there needs ICP filing. It holds:

- `runtime/…`: the llama.cpp and nemo-speech archives, uploaded by hand when a pinned runtime version
  changes (`vercel blob put <file> --access public --pathname runtime/llama.cpp/<build>/<file>`, then
  add the URL beside the GitHub one in `local_asr.rs` / `nemotron_asr.rs`).
- `latest.json` and `releases/<tag>/…`: written by the `mirror` job of `release.yml`
  (`scripts/mirror-release.mjs`) after the GitHub release is published. It copies the macOS and Windows
  updater packages and the DMG, checks each one reads back with the same sha256, writes a `latest.json`
  whose macOS and Windows URLs point at the mirror (Linux entries keep their GitHub URLs), and deletes
  the previous release's files, so the store holds one release.

The app lists both manifests in `tauri.conf.json`. `updater.rs` puts the mirror first on machines set
to a mainland China time zone and GitHub first everywhere else; the model downloader orders its
sources the same way. Packages are minisign-verified whichever host served them.

The job needs the store's read-write token as the `SAYTYPE_DOWNLOADS_BLOB_TOKEN` secret (in the
Vercel dashboard: Storage → saytype-downloads → `BLOB_READ_WRITE_TOKEN`); without it the job warns and
skips. The plugin stops at the first endpoint that answers, so if the `mirror` job fails, mainland
clients keep seeing the previous version until it is re-run: `gh run rerun <run-id> --failed`, or
locally `BLOB_READ_WRITE_TOKEN=… node scripts/mirror-release.mjs vX.Y.Z`. Reachability from inside
mainland China has not been measured yet.

**Planned website download button (not built).** Keep the site a pure static frontend with no
backend, which also avoids ICP filing: only mainland-hosted sites need 备案, and only mainland
hosting/CDN would actually fix China speed, so defer that until China is a real market. Point the
button at the newest DMG with a little client-side JS:

```html
<a id="dl-mac" href="https://github.com/hellotaotao/typealoud/releases/latest">Download for macOS</a>
<script>
fetch('https://api.github.com/repos/hellotaotao/typealoud/releases/latest')
  .then(r => r.json())
  .then(rel => {
    const dmg = rel.assets.find(a => a.name.endsWith('.dmg'));
    if (dmg) document.getElementById('dl-mac').href = dmg.browser_download_url;
  })
  .catch(() => {}); // falls back to the releases page if the API is unavailable
</script>
```

GitHub's anonymous API limit (60 per hour) is per visitor IP, so a download button never hits it. The
zero-JS alternative, uploading a version-less `TypeAloud-macOS.dmg` with every release, adds a CI step
and clutters the releases page. The mirror above already carries each release's DMG at
`https://typealoud.app/download/releases/<tag>/…` (the tag and file names are in
`releases/current.json`), which the button can use for mainland visitors.

## Microsoft Store

The Store build is an MSIX wrapping the same exe the NSIS installer ships. The Store signs it during
certification, so it needs no code-signing certificate and shows no SmartScreen warning; the direct
downloads stay unsigned. Status: packaging works in CI, nothing has been submitted yet.

**Building.** Run the `Microsoft Store package` workflow by hand (`gh workflow run msix.yml`) and
download its `msix` artifact. It builds the exe with `tauri build --no-bundle`, packs it with
`scripts/build-msix.mjs` (manifest template: `build/msix/AppxManifest.template.xml`), then registers
the unpacked layout on the runner and launches it to confirm Windows accepts the manifest and the app
sees its package identity. It is separate from `release.yml`, so it can never hold up a release.

**Identity.** After reserving the name in Partner Center, copy the three values from Product
identity into repository variables (Settings → Variables): `MSIX_IDENTITY_NAME` (Package/Identity/Name),
`MSIX_PUBLISHER` (Package/Identity/Publisher, the `CN=…` string) and `MSIX_PUBLISHER_DISPLAY_NAME`.
Without them the package gets a placeholder identity that only works for local testing.

**What differs at run time.** Nothing is compiled differently. `platform::is_store_install` asks
Windows whether the process has package identity; when it does, `updater.rs` reports the
`storeManaged` status, never checks `latest.json`, and the update controls disappear. The Store
version must end in `.0`, so `1.19.3` is submitted as `1.19.3.0`. App data written under `%APPDATA%`
is redirected into the package's private folder and removed on uninstall, so the Store install and a
direct install on the same machine don't share settings, History or downloaded models.

**Submission notes.** `runFullTrust` is a restricted capability and Partner Center asks why it is
needed: the global hold-to-record hotkey and typing into the focused app. Keep it to two or three
sentences. The listing needs a privacy policy URL (`PRIVACY.md` on the website) and should say that
the first run downloads the speech model and its inference runtime.

**Testing a package locally** (Windows, Developer Mode on): `node scripts/build-msix.mjs
--layout-only`, then `Add-AppxPackage -Register src-tauri\target\msix\layout\AppxManifest.xml`.

**Not done yet:** launch at login (a packaged app needs a `StartupTask` in the manifest; Windows
autostart is a stub in every build today), unplated taskbar icons (`resources.pri`), and a check for
a missing WebView2 runtime on Windows 10, which an MSIX can't install.

---

<a id="发布中文"></a>

# 发布(中文)

[↑ English](#releasing)

TypeAloud 面向 **macOS、Windows、Linux** 三平台发布安装包到项目的
[GitHub Releases](https://github.com/hellotaotao/typealoud/releases) 页面。安装包由
[`Release`](.github/workflows/release.yml) GitHub Actions workflow 自动构建,不需要手动构建或上传。

## workflow 做了什么

推送形如 `vX.Y.Z` 的 tag 会触发一个**三平台矩阵**:

1. **macOS**:通过 `tauri build --target universal-apple-darwin` 构建**通用**二进制(Intel + Apple
   Silicon),用 Developer ID 签名、公证并 staple,**前提是**配置了签名 secrets(见[一次性配置](#一次性配置))。
2. **Windows**:NSIS `.exe` + `.msi`;**Linux**:AppImage、deb、rpm。两者都没签名,也都没在真机上验证过。
3. 每条腿都产出 minisign 签名的**自动更新产物**,并合并成一个 `latest.json`。`createUpdaterArtifacts`
   只写在 `tauri.release.conf.json` 里,所以本地构建永远不需要更新密钥。
4. 随后的 job 把中英双语的 AI 发布说明写进 release(可选,见[发布说明](#发布说明))。
5. 以上产物都上传到一个**草稿** release(由 `create-release` job 预先创建)。三条腿都上传完、发布说明
   job 也跑完后,`publish` job 把草稿转成最新的正式 release。全程不需要手动操作,推 tag 仍然就是发版。

发布同时就是**自动更新放量**。已安装的客户端(v1.4.0 起)在启动时和每 24 小时检查一次
`releases/latest/download/latest.json`,后台下载,然后在托盘和设置里提供"重启以更新"。release 在三条腿
都传完之前一直是草稿,所以客户端不会读到缺了自己平台的 `latest.json`。(改成草稿流程之前,第一条腿上传后
release 就公开了,macOS 那条腿完成前几分钟里检查更新的 Mac 会报更新错误。)

某条腿失败时,草稿不会发布,客户端继续停在上一个版本。在 Actions 里重跑失败的 job,通过后 `publish` 会接着
发布。不打算发这个版本了,就删掉草稿。

> 该 workflow 只在推送 `v*` tag 时运行,普通提交不会触发。

## 发布一个版本

应用里显示的版本号是编译时从 `Cargo.toml` 读取的(`env!("CARGO_PKG_VERSION")`),workflow 构建的也是被打
tag 的那个提交里的版本。所以先 bump 并提交,再打 tag:

```bash
npm run version:tauri:patch        # 或:node scripts/bump-tauri-version.js 1.2.0
git commit -am "chore(release): bump version to X.Y.Z"
git tag vX.Y.Z && git push origin main --tags
```

然后去 **Actions** 标签查看。首次运行约需 15–25 分钟(两种架构 + 公证排队);之后有 Rust 缓存会更快。

> 不要用 `npm run build:mac` 发版。它产出的是本地 dev-channel 构建:有 `scripts/sign.env` 时用其中的
> identity 签名,但从不公证。

### 发出去的版本有问题

客户端跟随 `releases/latest`,它指向最新的、已发布且不是 prerelease 的 release。把有问题的 release 改回草稿
(或删掉)后,`latest` 会重新指向上一个版本,还没更新的客户端就不会再收到它。已经更新的客户端会一直停在这个
版本,直到有更新的版本发布,所以真正的修复是再发一个补丁版本。

<a id="一次性配置"></a>

## 一次性配置

### 签名与公证(macOS)

没有这些 secrets,workflow 仍然会**成功**,只是 `.dmg` **没有签名**:下载者会遇到 Gatekeeper 警告,必须右键
→ 打开(或运行 `xattr -cr /Applications/TypeAloud.app`)。"Configure Apple signing" 步骤只在设置了
`APPLE_CERTIFICATE` 时才把 `APPLE_*` 传给 tauri-cli,所以之后再补 secrets 也不用改 workflow。

公证就是 Apple 扫描签过名的 app,返回一张 ticket 并 **staple 进 bundle**,别的 Mac 上 Gatekeeper 才会放行、
不再提示"身份不明的开发者"。前提是 Hardened Runtime(已开启)和 **Developer ID Application** 证书。本地构建用的
`Apple Development` 证书是另一种类型,公证服务会拒绝。

| Secret | 怎么获取 |
| --- | --- |
| `APPLE_SIGNING_IDENTITY` | `security find-identity -v -p codesigning` 输出里完整的 `Developer ID Application: 名字 (TEAMID)`。本仓库:`Developer ID Application: Tao Wang (CU3VTR9MRH)` |
| `APPLE_TEAM_ID` | 上面括号里的 10 位 ID(本仓库:`CU3VTR9MRH`) |
| `APPLE_CERTIFICATE` | 导出的 `.p12` 的 base64(见下文) |
| `APPLE_CERTIFICATE_PASSWORD` | 导出 `.p12` 时设置的密码 |
| `APPLE_ID` | Apple Developer 账号邮箱 |
| `APPLE_PASSWORD` | 一个 [App 专用密码](https://appleid.apple.com)(登录与安全 → App 专用密码),**不是**登录密码 |

**创建并导出证书:** 在 Xcode → 设置 → 账户 →(团队)→ 管理证书 → `+` 里创建 *Developer ID Application* 证书,
或者去 [developer.apple.com](https://developer.apple.com/account/resources/certificates/list) 创建。在钥匙串访问
→ *登录* → *我的证书* 里展开该条目,确认带私钥,导出为带密码的 `.p12`,然后:

```bash
base64 -i ~/Desktop/certificate.p12 | pbcopy   # 粘贴到 APPLE_CERTIFICATE
```

`tauri-action` 会把证书导入临时钥匙串并签名;因为 `APPLE_ID` / `APPLE_PASSWORD` / `APPLE_TEAM_ID` 三项都在,它接着
完成公证和 staple。也可以用 App Store Connect API key(`APPLE_API_ISSUER` / `APPLE_API_KEY` /
`APPLE_API_KEY_PATH`)代替这三项。`tauri.conf.json` 特意保持 `signingIdentity: null`:CI 里由环境变量接管,本地
构建不受影响。

### 更新签名密钥

| Secret | 值 |
| --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY` | `~/.tauri/saytype-updater.key` 的内容(minisign)。**务必备份:丢了这把钥匙,已安装的客户端就再也无法自动更新。** |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | 这把钥匙的密码(本地 `scripts/sign.env` 里也有) |

bundler 只认 `TAURI_SIGNING_PRIVATE_KEY`(路径或内容都行),`_PATH` 变体不生效。对应的公钥在 `tauri.conf.json` 里。

### 使用统计 key

| Secret | 值 |
| --- | --- |
| `SAYTYPE_POSTHOG_KEY` | PostHog 欧盟区 TypeAloud 项目的 project API key(`phc_…`),只能写入,本来就是公开的 |

它被编译进正式版(`usage.rs`)。没有它照样能发版,统计只在本地记录、从不发送。PostHog 项目设置里要打开 "Discard client IP data"。发送内容见 `PRIVACY.md`。

<a id="发布说明"></a>

### 发布说明

构建完成后,workflow 运行 `scripts/generate-release-notes.mjs`:取上一个 `v*` tag 到本 tag 之间的提交 →
Claude API(`claude-sonnet-5`)→ 面向用户的中英双语说明,用 `gh release edit` 写进 release。它需要
`ANTHROPIC_API_KEY` secret;缺失或调用失败时只告警,release 保留默认正文。本地调试用
`node scripts/generate-release-notes.mjs <tag> --dry-run`(打印 prompt,不调用 API)。设计:
`docs/superpowers/specs/2026-07-12-ai-release-notes-design.md`。

## 验证

**公证**,对下载下来的 app:

- `spctl -a -t exec -vv TypeAloud.app` → `accepted … source=Notarized Developer ID`
- `xcrun stapler validate TypeAloud.app` → `The validate action worked!`

**不发布也能跑通自动更新全链路**,用 `src-tauri/tauri.updater-e2e.conf.json`(localhost 端点)。这会替换
`/Applications/TypeAloud.app` 并临时改版本号文件。过程中不要运行 `scripts/collect-artifacts.js`,否则会覆盖
`dist/` 里归档的安装包。

1. 退出 TypeAloud,构建"旧"版本:
   `CI=true sh -c '. ./scripts/sign.env; npx tauri build --target aarch64-apple-darwin --config src-tauri/tauri.updater-e2e.conf.json'`。
   用 `src-tauri/target/aarch64-apple-darwin/release/bundle/macos/TypeAloud.app` 替换 `/Applications/TypeAloud.app`。
2. 运行 `npm run version:tauri:patch`(不要提交),用同一条命令再构建一次。确认该 bundle 目录里有
   `TypeAloud.app.tar.gz` 和对应的 `.sig`。
3. 把 `.tar.gz` 复制到一个临时目录,在旁边写一个 `latest.json`:`version` 填新版本号,
   `platforms["darwin-aarch64"]` 的 `signature` 填 `.sig` 的内容、`url` 填
   `http://127.0.0.1:8765/TypeAloud.app.tar.gz`。然后在该目录运行 `python3 -m http.server 8765`。
4. 用 `git checkout -- package.json src-tauri/tauri.conf.json src-tauri/Cargo.toml src-tauri/Cargo.lock`
   还原版本号文件,打开已安装的 app,设置 →"检查更新"。应依次看到检查中 → 下载中 → 已就绪,托盘出现
   "重启以更新到 vX.Y.Z",重启后是新版本,听写照常,没有新的权限弹窗。
5. 停掉服务,用 `npm run build:mac:install` 装回正常构建。

## 排查

- **公证报 401。** GitHub secret 只能写不能读,所以在本地验证 App 专用密码:
  `xcrun notarytool history --apple-id <apple-id> --team-id CU3VTR9MRH --password <密码>`。能跑通就
  `gh secret set APPLE_PASSWORD`,再重跑失败的 job,tag 不用重推。改 Apple ID 登录密码会吊销全部 App 专用密码。
- **只有发版构建编译失败。** `ci.yml` 里 macOS 只构建 arm64,发版构建的是 universal。漏了 `macos` + `x86_64`
  组合的 `#[cfg]` 代码在本地和 CI 都能过,到打 tag 时才失败。本地复现:
  `rustup target add x86_64-apple-darwin && cargo check --target x86_64-apple-darwin`。

## 分发

GitHub Releases 托管安装包,也是自动更新的主要来源,在中国大陆以外稳定可靠。macOS 继续构建通用二进制。

**大陆镜像。** 大陆访问 GitHub 很慢甚至连不上,所以大陆用户需要的文件在 `https://typealoud.app/download/`
也放了一份。这个路径是 `saytype-web` 仓库 `vercel.json` 里的一条转发规则,指向 Vercel Blob 存储
`saytype-downloads`(香港区,公开读),所以不涉及 ICP 备案。里面有:

- `runtime/…`:llama.cpp 和 nemo-speech 的运行时包。锁定的运行时版本变了才需要手动重传
  (`vercel blob put <文件> --access public --pathname runtime/llama.cpp/<版本>/<文件>`,再到 `local_asr.rs` /
  `nemotron_asr.rs` 里把新地址加在 GitHub 地址旁边)。
- `latest.json` 和 `releases/<tag>/…`:由 `release.yml` 的 `mirror` 任务(`scripts/mirror-release.mjs`)在 GitHub
  release 发布之后写入。它复制 macOS 和 Windows 的更新包以及 DMG,逐个下载回来核对 sha256,写一份 macOS 和
  Windows 地址指向镜像的 `latest.json`(Linux 条目保留 GitHub 地址),再删掉上一个版本的文件,所以存储里始终只有
  一个版本。

`tauri.conf.json` 里两份清单都列着。`updater.rs` 在系统时区是大陆时区的机器上把镜像排第一,其他地方 GitHub
排第一;模型下载器用的是同一套排序。无论从哪边下载,更新包都要过 minisign 校验。

这个任务需要存储的读写令牌,配成 `SAYTYPE_DOWNLOADS_BLOB_TOKEN` 这个 secret(Vercel 后台:Storage →
saytype-downloads → `BLOB_READ_WRITE_TOKEN`);没配的话任务只给警告并跳过。更新插件在第一个有响应的端点就停,所以
`mirror` 任务失败时,大陆用户会一直看到上一个版本,直到重跑:`gh run rerun <run-id> --failed`,或者本地执行
`BLOB_READ_WRITE_TOKEN=… node scripts/mirror-release.mjs vX.Y.Z`。大陆境内的实际连通性和速度还没有实测过。

**计划中的官网下载按钮(还没做)。** 官网保持纯静态前端、不要后端,这样也不需要 ICP 备案:只有托管在大陆的站点
才需要备案,而真正能解决大陆速度的也只有大陆托管/CDN,所以等中国成为真实市场再一起做。按钮用几行前端 JS 指向
最新的 DMG,代码见英文部分。

GitHub 匿名 API 限额(每小时 60 次)按访客 IP 计算,下载按钮碰不到。不写 JS 的替代方案是每次发版额外上传一个不带
版本号的 `TypeAloud-macOS.dmg`,但要多一个 CI 步骤,还会让 releases 页面更乱。上面的镜像已经带着每个
版本的 DMG,地址是 `https://typealoud.app/download/releases/<tag>/…`(tag 和文件名在
`releases/current.json` 里),下载按钮可以给大陆访客用这个地址。

## Microsoft Store

商店版是一个 MSIX 包,里面装的就是 NSIS 安装包里的同一个 exe。微软在审核时给它签名,所以不用买代码签名证书,
也不会弹 SmartScreen 警告;直接下载的安装包仍然没有签名。现状:CI 里能打出包,还没有提交过。

**构建。** 手动运行 `Microsoft Store package` 工作流(`gh workflow run msix.yml`),下载它的 `msix` 产物。它先用
`tauri build --no-bundle` 编出 exe,再由 `scripts/build-msix.mjs` 打包(清单模板在
`build/msix/AppxManifest.template.xml`),最后在 runner 上注册并启动一次,确认 Windows 接受这份清单、应用也认出了
自己的包身份。它和 `release.yml` 分开,不会拖住发版。

**身份信息。** 在 Partner Center 预留名称后,把 Product identity 里的三个值填进仓库变量(Settings → Variables):
`MSIX_IDENTITY_NAME`(Package/Identity/Name)、`MSIX_PUBLISHER`(Package/Identity/Publisher,`CN=…` 那一串)和
`MSIX_PUBLISHER_DISPLAY_NAME`。没填的话包里是占位身份,只能本地测试。

**运行时的差别。** 编译上没有任何不同。`platform::is_store_install` 问 Windows 当前进程有没有包身份;有的话
`updater.rs` 报 `storeManaged` 状态,不再检查 `latest.json`,更新按钮也随之隐藏。商店要求版本号以 `.0` 结尾,所以
`1.19.3` 提交为 `1.19.3.0`。写到 `%APPDATA%` 的数据会被重定向到包的私有目录,卸载时一并删除,因此同一台机器上的
商店版和直接下载版不共享设置、History 和已下载的模型。

**提交时注意。** `runFullTrust` 是受限能力,Partner Center 会问用途:全局按住录音的热键,以及向当前应用输入文字。
写两三句即可。商店页面需要隐私政策链接(官网上的 `PRIVACY.md`),并写明首次使用会下载语音模型和推理运行时。

**本地测试**(Windows,打开开发者模式):`node scripts/build-msix.mjs --layout-only`,然后
`Add-AppxPackage -Register src-tauri\target\msix\layout\AppxManifest.xml`。

**还没做:** 开机自启(打包应用要在清单里声明 `StartupTask`;目前所有 Windows 版本的自启都还是空实现)、任务栏
无底板图标(`resources.pri`)、以及 Windows 10 缺 WebView2 运行时的检测(MSIX 没法替用户安装)。
