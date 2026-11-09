# Privacy

TypeAloud is built so that your voice stays on your computer. This page lists every connection the
app makes and exactly what the anonymous usage statistics contain.

[中文版见下方](#隐私说明)

## What never leaves your computer

- **Audio**, when you use a local engine (Qwen3-ASR or Nemotron). Speech becomes text on this machine.
- **Transcribed text, History and the dictionary.** They are stored only in the app's data folder.
- **API keys** you enter, apart from being sent to the provider they belong to.

TypeAloud has no account and no sign-up.

## Connections the app makes

| When | Where | What is sent |
| --- | --- | --- |
| At startup and every 24 hours | GitHub (`github.com`) or the TypeAloud website (`typealoud.app`) | A request for the latest version manifest. No data about you or your use. |
| When you download a local model | Hugging Face, ModelScope, GitHub or the TypeAloud website (`typealoud.app`) | Ordinary file downloads. |
| Only if you choose a cloud engine | OpenAI or Groq, directly with your own key | The recorded audio of each dictation, the audio of any file you transcribe on the Files page (in segments of up to 40 seconds), and the dictionary's words (for an automatic replacement, only the corrected spelling). TypeAloud's servers are not involved. |
| Once a day, unless turned off | PostHog, EU region (Frankfurt) | Anonymous usage statistics, described below. |

## Anonymous usage statistics

These tell us how many people use TypeAloud, whether they come back day after day, and how much they
dictate. They are on by default. The onboarding privacy page and **Settings → App Settings → Anonymous usage
statistics** both carry the switch.

### What is sent

One row per day on which the app ran, sent the following day:

```json
{
  "event": "daily_usage",
  "distinct_id": "3f2b8c1e-5a7d-4e9b-9c3a-1d2e4f6a8b0c",
  "timestamp": "2026-09-29T12:00:00+09:30",
  "properties": {
    "date": "2026-09-29",
    "dictations": 37,
    "failures": 1,
    "inserted_chars": 2860,
    "engine": "local/qwen3-asr-0.6b-q8_0",
    "app_version": "1.19.0",
    "os": "macos",
    "os_version": "15.6",
    "arch": "aarch64"
  }
}
```

- `distinct_id` is a random ID created on this computer. It is not derived from your hardware,
  account, name or anything else, and it is linked to nothing but these rows.
- `dictations` and `failures` count recordings that finished or failed. `inserted_chars` is only a
  number of characters.

In addition, a few one-off events describe the first run, each sent at most once per install:
the onboarding step reached (`onboarding_step`: welcome, privacy, engine, microphone, accessibility,
practice), finishing onboarding (`onboarding_completed`), a local model download finishing, failing
or being cancelled (`model_download`, with the model name), and whether the very first dictation
worked (`first_dictation`).

Nothing is sent before you have passed the onboarding privacy page.

### What is never sent

Audio, transcribed or inserted text, the dictionary, History, file paths, device names, API keys,
the apps you type into, and your IP address. The app asks PostHog to skip IP geolocation and person
profiles, and the project is set to discard IP addresses.

### How much and how often

Usually one request per day of about half a kilobyte, over HTTPS. If the computer is offline, the
counts wait on disk and are sent later; anything older than 30 days is dropped.

### Seeing and turning it off

- **Settings → App Settings → View what is sent** shows the exact content of the next upload, including
  today's running count.
- Turning the switch off stops recording and sending at once and deletes the counts not yet sent,
  including the random ID. Turning it back on starts with a new ID.
- Development builds never send anything.

Data is kept for at most 12 months, is used only to understand how TypeAloud is used, and is never
sold or shared.

---

# 隐私说明

TypeAloud 的设计原则是声音留在你的电脑上。本页列出 App 发起的每一种网络连接，以及匿名使用统计的具体内容。

## 不会离开你电脑的东西

- **录音**：使用本地引擎（Qwen3-ASR 或 Nemotron）时，语音在本机转成文字。
- **转写出的文字、历史记录和词典**：只保存在 App 的数据文件夹里。
- **你填写的 API key**：只发给它所属的服务商。

TypeAloud 没有账号，也不需要注册。

## App 会发起的连接

| 什么时候 | 连到哪里 | 发送什么 |
| --- | --- | --- |
| 启动时，之后每 24 小时 | GitHub（`github.com`）或 TypeAloud 官网（`typealoud.app`） | 请求最新版本清单，不含任何关于你或你使用情况的数据 |
| 下载本地模型时 | Hugging Face、ModelScope、GitHub 或 TypeAloud 官网（`typealoud.app`） | 普通的文件下载 |
| 仅当你选择云端引擎 | OpenAI 或 Groq，用你自己的 key 直连 | 每次听写的录音、在「转写文件」页转写的文件音频（按最长 40 秒分段发送），以及词典，不经过 TypeAloud 的服务器 |
| 每天一次（可关闭） | PostHog 欧盟节点（法兰克福） | 匿名使用统计，见下文 |

## 匿名使用统计

用来了解有多少人在用 TypeAloud、是不是每天都回来用、平均听写多少。默认开启，引导里的隐私页和**设置 → 应用设置 → 匿名使用统计**都有开关。

### 发送什么

App 运行过的每一天对应一条，第二天发出：

```json
{
  "event": "daily_usage",
  "distinct_id": "3f2b8c1e-5a7d-4e9b-9c3a-1d2e4f6a8b0c",
  "timestamp": "2026-09-29T12:00:00+09:30",
  "properties": {
    "date": "2026-09-29",
    "dictations": 37,
    "failures": 1,
    "inserted_chars": 2860,
    "engine": "local/qwen3-asr-0.6b-q8_0",
    "app_version": "1.19.0",
    "os": "macos",
    "os_version": "15.6",
    "arch": "aarch64"
  }
}
```

- `distinct_id` 是在这台电脑上随机生成的 ID，不来自硬件、账号、姓名或任何其他信息，除了这些统计行之外不和任何东西关联。
- `dictations`、`failures` 是完成和失败的录音次数，`inserted_chars` 只是一个字数。
- 另外还有几条首次使用时的一次性事件，每个安装最多发一次：引导走到了哪一步（`onboarding_step`）、完成引导（`onboarding_completed`）、本地模型下载成功、失败或取消（`model_download`，带模型名）、第一次听写是否成功（`first_dictation`）。

在你看过引导里的隐私页之前，什么都不会发送。

### 绝不发送

录音、转写或输入的文字、词典、历史记录、文件路径、设备名、API key、你在哪个应用里打字，以及你的 IP 地址。App 要求 PostHog 不做 IP 定位、不建用户档案，项目本身也设置为丢弃 IP。

### 多大、多久一次

通常每天一次请求，约 0.5 KB，走 HTTPS。电脑离线时计数先存在本地，联网后补发；超过 30 天的直接丢弃。

### 查看和关闭

- **设置 → 应用设置 → 查看发送的内容**会显示下一次上传的原始内容，包括今天到目前为止的计数。
- 关掉开关后立即停止记录和发送，本地还没发出的计数连同随机 ID 一起删除。重新打开会生成新的 ID。
- 开发版从不发送。

数据最多保存 12 个月，只用来了解 TypeAloud 的使用情况，不出售，也不分享给任何人。
