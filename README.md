# TypeAloud

**English** · [中文说明 ↓](#中文)

A voice input method built with **Tauri** that lets you dictate text in any application using a global hotkey and AI transcription.

Project direction: [Product pathway](docs/PRODUCT_PATHWAY.md) · [Reliability acceptance](docs/RELIABILITY_ACCEPTANCE.md).

## Features

- **Hold-to-Record Hotkey**: Hold down Ctrl+Shift to start recording, release to stop and transcribe. Double-tap Ctrl+Shift to record hands-free; press it once more to finish
- **Real-time Audio Visualization**: Waveform animation while recording
- **Local-first AI Transcription**: Qwen3-ASR runs on-device for batch quality (0.6B by default, 1.7B as a larger option); Nemotron 3.5 adds live local transcription on Apple Silicon and Windows x64. Groq and OpenAI remain optional cloud choices
- **Auto-typing**: Inserts transcribed text into the active application (macOS; Windows/Linux experimental, untested)
- **Background Operation**: Runs silently in the system tray
- **Automatic Updates**: New releases download in the background; restart from the tray or Settings when you're ready
- **Customizable Settings**: Configure the engine, API keys, and language

## Requirements

- No account or API key is needed for local transcription. A Groq or OpenAI API key is required only for a cloud provider
- Microphone access permission (and Accessibility permission on macOS)
- To build from source: Node.js 22 or newer and a Rust toolchain (`rustup`)

## Download

Grab the latest installer from the [Releases page](https://github.com/hellotaotao/typealoud/releases/latest):

- **macOS** — the `.dmg`
- **Windows** — the `_x64-setup.exe` (or `.msi`)
- **Linux** — the `.AppImage` (portable), `.deb` (Debian/Ubuntu), or `.rpm` (Fedora/RHEL)

Once installed, TypeAloud keeps itself up to date. The other files on the Releases page (`*.sig`, `latest.json`, `*.app.tar.gz`) are used by the built-in auto-updater — you don't need to download them.

## Installation / Development

```bash
# Install JS tooling (only @tauri-apps/cli)
npm install

# Run in development mode
npm run dev        # = tauri dev

# Run tests
npm test                                          # frontend and scripts
cargo test --manifest-path src-tauri/Cargo.toml   # Rust

# Build for production
npm run build      # current host target
npm run build:mac  # macOS (aarch64)
npm run build:win  # Windows
npm run build:linux
```

On first launch, follow Welcome → Privacy → Engine → Microphone → Accessibility (macOS only) → Practice. Choose a local model to start its download while completing permissions, or enter your own cloud API key. You can open Settings and resume the guide from the same step.

New installs default to Qwen3-ASR 0.6B on all platforms, except detected low-end machines (less than 8 GiB RAM or 4 logical cores), which default to OpenAI. Existing settings are preserved. No model downloads or audio uploads start just because an engine is the default.

Releases are built, signed, and published automatically when a `v*` tag is pushed; see [RELEASING.md](RELEASING.md).

## Usage

1. Launch TypeAloud
2. Complete the first-use guide, or configure an engine and permissions in Settings; wait until the selected engine is ready
3. Hold down Ctrl+Shift to start recording
4. Speak while holding the keys
5. Release to stop recording and transcribe
6. Text is inserted into the active application (macOS; Windows/Linux experimental, untested)
7. Press Escape to cancel recording or an in-progress transcription

## Configuration

Access settings through the tray menu or main window to configure:
- Transcription engine: Qwen3-ASR (0.6B, or the larger 1.7B) or Nemotron 3.5 local model (no key; Nemotron supports Apple Silicon and Windows x64), or optional Groq / OpenAI with an API key
- Transcription language (Nemotron and cloud providers); custom dictionary (words guide cloud providers; automatic replacements apply to every engine)

TypeAloud records from the system's default input device; change it in your OS sound settings.

## Privacy

Local engines keep audio on your computer. TypeAloud sends anonymous daily usage counts (how many
dictations and characters, engine, app and OS version; never audio or text). Turn them off in
Settings, where you can also view exactly what is sent. Every connection the app makes is listed in
[PRIVACY.md](PRIVACY.md).

## Reset macOS permissions for repeated testing

```
tccutil reset Accessibility com.tao.saytype
tccutil reset Microphone com.tao.saytype
```

## License

PolyForm Noncommercial 1.0.0
https://polyformproject.org/licenses/noncommercial/1.0.0/

---

<a id="中文"></a>

# TypeAloud(中文)

[↑ English](#typealoud)

一款基于 **Tauri** 构建的语音输入法,让你通过全局快捷键和 AI 转写,在任意应用中用口述输入文字。

项目方向:[产品路径](docs/PRODUCT_PATHWAY.md) · [可靠性验收](docs/RELIABILITY_ACCEPTANCE.md)。

## 功能特性

- **按住录音快捷键**:按住 Ctrl+Shift 开始录音,松开即停止并转写;双击 Ctrl+Shift 可免按住录音,再按一下结束
- **实时音频可视化**:录音时显示波形动画
- **本地优先 AI 转写**:Qwen3-ASR 在本机提供高质量批量转写(默认 0.6B,也可选更大的 1.7B);Nemotron 3.5 在 Apple Silicon 和 Windows x64 上提供本地实时转写。Groq 和 OpenAI 作为可选云端方案
- **自动输入**:将转写结果插入到当前活动应用(macOS;Windows/Linux 为实验性支持,未经真机验证)
- **后台运行**:静默驻留在系统托盘
- **自动更新**:新版本后台自动下载,你随时从托盘或设置里重启完成升级
- **可自定义设置**:配置转写引擎、API key 和语言

## 环境要求

- 本地转写无需账号或 API key;只有选择 Groq 或 OpenAI 云端服务时才需要 API key
- 麦克风访问权限(macOS 上还需辅助功能权限)
- 从源码构建:Node.js 22 或更高版本,以及 Rust 工具链(`rustup`)

## 下载

从 [Releases 页面](https://github.com/hellotaotao/typealoud/releases/latest) 下载对应平台的安装包:

- **macOS** — `.dmg`
- **Windows** — `_x64-setup.exe`(或 `.msi`)
- **Linux** — `.AppImage`(免安装)、`.deb`(Debian/Ubuntu)或 `.rpm`(Fedora/RHEL)

安装后 TypeAloud 会自动保持更新。Releases 页面上其余文件(`*.sig`、`latest.json`、`*.app.tar.gz`)是自动更新用的,无需下载。

## 安装 / 开发

```bash
# 安装 JS 工具链(仅 @tauri-apps/cli)
npm install

# 以开发模式运行
npm run dev        # = tauri dev

# 运行测试
npm test                                          # 前端与脚本
cargo test --manifest-path src-tauri/Cargo.toml   # Rust

# 构建生产版本
npm run build      # 当前主机架构
npm run build:mac  # macOS(aarch64)
npm run build:win  # Windows
npm run build:linux
```

首次启动按「欢迎 → 隐私 → 引擎 → 麦克风 → 辅助功能（仅 macOS）→ 练习」完成引导。主动选择本地模型后，下载会在授权期间后台继续；也可以填写自己的云端 API key。进入设置后，可回到向导原来的步骤。

新装默认千问 0.6B；只有检测到内存低于 8 GiB 或逻辑核心少于 4 的机器默认 OpenAI。已有配置不变。默认选中引擎不会自动下载模型或上传录音。

推送 `v*` tag 时会自动构建、签名并发布,见 [RELEASING.md](RELEASING.md)。

## 使用方法

1. 启动 TypeAloud
2. 完成首次引导，或在设置中配置引擎与权限；等当前引擎就绪后再录音
3. 按住 Ctrl+Shift 开始录音
4. 按住按键的同时说话
5. 松开按键停止录音并转写
6. 文字会插入到当前活动应用(macOS;Windows/Linux 为实验性支持,未经真机验证)
7. 按 Escape 取消录音或正在进行的转写

## 配置

通过托盘菜单或主窗口进入「设置」,可配置:

- 转写引擎:Qwen3-ASR(0.6B,或更大的 1.7B)或 Nemotron 3.5 本地模型(无需 key;Nemotron 支持 Apple Silicon 和 Windows x64),或可选的云端服务(Groq / OpenAI)+ API key
- 转写语言(Nemotron 和云端服务商);自定义词典(仅云端服务商)

TypeAloud 使用系统默认的输入设备录音;要换麦克风,请在系统的声音设置里修改。

## 隐私

本地引擎下录音不离开电脑。TypeAloud 每天发送一次匿名使用统计(听写次数和字数、引擎、软件和系统版本;不含录音和文字),可以在设置里关闭,也能在那里查看发送的原始内容。App 的全部网络连接见 [PRIVACY.md](PRIVACY.md#隐私说明)。

## 重复测试时重置 macOS 权限

```
tccutil reset Accessibility com.tao.saytype
tccutil reset Microphone com.tao.saytype
```

## 许可证

PolyForm Noncommercial 1.0.0
https://polyformproject.org/licenses/noncommercial/1.0.0/
