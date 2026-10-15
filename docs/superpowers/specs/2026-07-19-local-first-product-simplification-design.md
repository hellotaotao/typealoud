# Local-first 产品收敛与翻译功能移除 — 设计

> **Historical design — status updated 2026-09-14:** Local-first has shipped; translation is retained with explicit provider and consent. Hardware-aware fresh defaults, selection independent of readiness, and the named-step onboarding now supersede the first-use flow below. The translation-removal plan is not current work. See [Product pathway](../../PRODUCT_PATHWAY.md).

日期：2026-07-19

最近更新：2026-07-29

状态：产品方向已确认；已按 `v1.8.1`（`10670b0`）重新校准；产品代码尚未按本设计实施

来源：本地 Qwen3-ASR 真机效果达到主力使用标准后，对产品定位、首次体验和功能层级的整体重审

本设计取代 `2026-07-14-engine-switch-and-local-first-design.md` 中以下旧决定：

- OpenAI 继续作为新配置默认 provider；
- 首页和托盘把 Local、Groq、OpenAI 作为三个平级快切项；
- 未下载模型时不能选择 Local；
- 本地模式保留翻译快捷键并隐式回退云端。

本设计不否定旧 spec 已交付的本地 ASR、模型下载、断点续传、完整性校验和平台能力判定；这些基础设施继续复用。

## 0. 2026-07-29 当前实现基线

本次更新以仓库 `main` 的 `v1.8.1`（`10670b0`）为实现基线。原产品方向没有改变，但 2026-07-19 以后代码新增了多项必须保留的能力，因此实施本设计时不能再按旧文件列表直接删除或重写。

截至该基线，本设计的核心产品改造**尚未实施**：

- fresh config 仍是 `provider=openai`；
- 模型未 ready 时仍不能持久化 Local；
- 首页、托盘和 Settings 仍呈现三个平级 provider；
- 六页 onboarding 和第二个翻译快捷键仍存在；
- `hasApiKey`、translation endpoint 与 Local -> Cloud translation fallback 仍存在；
- README 仍先让用户在三种引擎/API key 之间选择。

与此同时，当前代码已经新增并交付：

1. **Accessibility drag cloud**：首次授权可打开系统设置，并显示可拖入权限列表的浮动入口；授权后自动隐藏；
2. **输入提示跨屏定位**：优先跟随当前焦点应用所在屏幕，其次鼠标所在屏幕，最后才回退主屏；
3. **本地 ASR 卡死恢复**：后端首字节/无进度 watchdog、前端自动重试一次、最终失败后保存 exact WAV 到 History 并允许稍后重新转写；
4. **录音 session 竞态保护**：旧转写不能覆盖或隐藏新录音，多个结果按录音顺序插入；
5. **跨平台 raw audio IPC**：macOS/Linux 使用 `ipc:`，Windows WebView2 使用 `http://ipc.localhost`；
6. **本地 runner 优化**：跳过重复 CLI warmup，并在 Windows 隐藏 console window。

后续实现必须把这些能力视为回归基线，而不是可被“产品简化”顺手删除的旧代码。

## 1. 背景

TypeAloud 最初以 BYOK 云端转写为主：音频不经过 TypeAloud 自有服务器，而是直接发送到用户选择并信任的 Groq 或 OpenAI。随后加入的本地 Qwen3-ASR 在 Apple Silicon 真机上表现良好，具有无需账号、无需 API key、无按分钟费用和音频不离开设备等优势，因此已经具备成为默认主路径的条件。

当前产品只完成了“局部 local-first”：

- Apple Silicon onboarding 将本地模型置顶；
- 但 fresh config 仍默认 `openai`；
- 未下载模型前禁止持久化 `local`，导致产品保存了用户从未选择过的云端意图；
- 首页、托盘和 Settings 仍把 Local、Groq、OpenAI 当作三个同级产品选项；
- 翻译快捷键让本地模式在某个隐蔽分支中仍依赖云端 key；
- README、Dictionary 和设置文案仍以云端能力为中心。

结果是用户必须理解 TypeAloud 的内部 provider 架构，而不是直接完成“按住说话，松手输入”。

## 2. 产品定义

TypeAloud 是一个 **local-first voice input tool**：

> 按住一个快捷键说话，松手，文字出现在当前应用中。

产品层只存在两种转写方式：

1. **本地转写**：音频在设备上处理；
2. **云端转写**：音频直接发送到用户主动选择的云端服务。

Groq 与 OpenAI 不是与“本地”平级的产品模式，而是“云端转写”内部的两个 provider。

### 2.1 核心承诺

- 适合本地运行的设备自动选择本地模式；
- 本地模式无需账号、无需 API key、没有按分钟计费；
- 本地模型未安装时，仍然真实保存 Local 作为用户意图；
- 本地失败时绝不静默上传云端；
- 普通听写只有一个快捷键和一条行为路径；
- 云端能力只在用户主动选择云端模式后出现。

### 2.2 推荐 marketing 文案

中文：

> **说话，就是打字。**
>
> 按住快捷键开口说，松手，文字就出现在任何应用里。默认本地转写，无需账号、无需 API Key、没有按分钟计费。

英文：

> **Speak. It types.**
>
> Hold a shortcut, talk, and release. TypeAloud types into any app with private, on-device transcription—no account, no API key, no per-minute fees.

跨平台宣传必须与真实支持范围一致：当前只有 Apple Silicon 被标记为 `local_capable`；Intel Mac、Windows 和 Linux 虽有本地 runner，但尚未完成同等级真机性能验证，因此默认推荐云端，不能宣传为这些平台已经默认本地。

## 3. 目标与非目标

### 3.1 目标

- 让 fresh install 的持久化 provider 与设备推荐和用户实际意图一致；
- 将产品 UI 从“三个平级引擎”收敛为“本地 / 云端”两层结构；
- 从产品、快捷键、IPC、前端和后端完整删除翻译模式；
- 让 onboarding 在最短路径内完成引擎准备、权限和第一次听写；
- 将 API key、provider 和具体模型降为云端高级配置；
- 保留现有用户选择、已存 key、历史记录和本地模型资产；
- 对本地未就绪、下载失败和云端未配置给出明确修复入口。
- 保留 `v1.8.1` 已交付的 Accessibility、跨屏定位、卡死恢复、顺序插入和跨平台 raw IPC 行为；
- 在把 Local 设为默认主路径前，补齐本地 ASR 的全局并发限制和完整子进程生命周期上限。

### 3.2 非目标

- 不在首次启动时未经同意自动下载约 1 GB 模型；
- 不做运行时跑分、CPU 型号数据库或动态性能 benchmark；
- 不新增 TypeAloud 自有云端代理、账号或额度系统；
- 不做本地失败后的自动 cloud fallback；
- 不更换 Qwen3-ASR 或 llama.cpp；
- 不在本轮扩展 Windows/Linux 的本地性能承诺；
- 不新增翻译功能的替代入口；
- 不在本轮实现 LLM 后处理、专名纠正或本地 dictionary。
- 不在本轮实现长录音分段、AudioWorklet/VAD chunk pipeline 或所谓 streaming ASR；
- 不重新设计 Accessibility drag cloud 或输入提示跨屏定位算法；
- 不把所有既有 reliability 审计项都并入本轮；只处理 Local 默认化直接放大的并发、生命周期和 provider/session 一致性问题。

## 4. 设备推荐规则

继续以现有 `platform::supports_local_first()` 为唯一推荐判断：

| 设备类别 | 当前判定 | fresh install 默认 | onboarding 主路径 | 可选路径 |
|---|---:|---|---|---|
| Apple Silicon Mac | `true` | Local + Qwen3 | 下载并启用本地模型 | 主动改用 Cloud |
| Intel Mac | `false` | Cloud + Groq | 配置 Groq key | 可尝试 Local，提示可能较慢 |
| Windows x64 | `false` | Cloud + Groq | 配置 Groq key | 可尝试 Local，提示尚未充分验证 |
| Linux x64 | `false` | Cloud + Groq | 配置 Groq key | 可尝试 Local，提示尚未充分验证 |

这里的 `local_capable=false` 表示“不自动推荐”，不是“技术上禁止本地运行”。Local 始终可以在 Settings 中被用户选择。

Groq 是 cloud fresh install 默认 provider；OpenAI 是已有 OpenAI API 账户用户的备选。理由是截至 2026-07-29，[GroqCloud 官方页面](https://groq.com/groqcloud)仍列出 $0 Starter tier，普通个人听写的初次设置摩擦相对更低。对外文案不得承诺永久免费或固定额度；每次发布前仍需复核 provider 的最新账户、模型可用性、rate limit 和计费要求。

## 5. 配置与状态模型

### 5.1 保留内部三值 provider

内部配置继续使用：

```text
provider = local | groq | openai
```

不新增独立 `mode` 字段。产品层的映射是：

```text
local              -> Local mode
groq | openai      -> Cloud mode
```

这样可以避免不必要的配置迁移和两个字段互相矛盾，同时允许 UI 呈现正确的两层结构。

所有读取 provider 的后端路径必须共用同一个验证边界，将持久化字符串解析为：

```text
TranscriptionProvider::Local | Groq | OpenAI
```

未知字符串属于无效配置：UI 显示“转写方式需要重新选择”并打开修复入口，转录请求直接 fail closed。不能继续使用当前部分路径中的“不是 Groq 就当作 OpenAI”式 fallback，因为损坏或未来版本的配置不能触发用户未选择的云端上传。

### 5.2 设备感知的 fresh default

配置文件不存在时：

```text
supports_local_first() == true
  -> provider = local
  -> model = qwen3-asr-0.6b-q8_0

supports_local_first() == false
  -> provider = groq
  -> model = whisper-large-v3-turbo
```

新增可注入测试的 `fresh_config_for(local_capable: bool)`，只负责生成首次安装配置：

- `read_config_from_path` 在配置文件不存在时调用它；
- `read_config` 传入当前 `platform::supports_local_first()`；
- 单测分别注入 `true` 和 `false`，不依赖测试机器架构；
- product startup 不再把 `AppConfig::default()` 当成首次安装策略。

`AppConfig::default()` 和 serde 的旧字段缺省值可保持稳定，服务测试构造和历史 JSON 兼容；真正的 fresh install 必须走 `fresh_config_for`，并产生 provider/model 一致的组合。这样既消除新用户的 `provider=openai` 假默认，也避免某个历史配置缺少单个字段时因当前机器架构而被意外改写。

已有配置文件中的显式 provider 一律保留；升级不能把已完成 onboarding 的 cloud 用户强制切到 Local，也不能把现有 Local 用户切到 Groq。

### 5.3 “已选择”与“已就绪”分离

Local 在模型不存在、部分下载或正在下载时仍然可以被选择并持久化。

因此移除以下约束：

- `local_provider_selectable()` 对未下载模型的拒绝；
- Settings 保存 Local 时要求 `localModelState === "ready"`；
- 首页或托盘必须等模型就绪后才能表达 Local 意图的行为。

Local 的准备状态独立表示：

```text
absent | partial | downloading | ready | error
```

当 provider 为 Local 但模型未 ready：

- 首页显示“本地模型尚未安装”或下载进度；
- 普通听写不调用云端，直接给出可操作错误；
- 修复动作打开本地模型面板；
- 不读取或使用历史上保存的 cloud key。

### 5.4 `hasApiKey` 改为 `engineReady`

当前 `SettingsPayload.has_api_key` 在 Local 下实际表示“模型是否 ready”，名称已经不符合语义。将其重命名为 `engine_ready` / `engineReady`：

- Local：本地模型资产完整即 `true`；
- Groq：Groq key 非空即 `true`；
- OpenAI：OpenAI key 非空即 `true`。

readiness、onboarding gate 和首页状态统一读取 `engineReady`。原始 API key 仍只允许 Settings 窗口读取。

### 5.5 provider 与 recording session 绑定

一次录音从开始、VAD/WAV 预处理、自动重试到最终错误恢复，必须使用同一个已验证 provider。`recordingSession` 应保存不可变的 `providerAtStart`，而不是在异步流程的每个阶段重新读取可变的 `currentProvider`。

约束如下：

- provider 在 `start-recording` 时确定，后续 Settings 变化只影响下一次录音；
- 原始音频请求必须携带并由后端验证该 session provider，后端不能在请求到达时静默改走另一个 provider；
- WAV 编码、模型 badge、错误分类和是否允许保存 pending audio 都读取 `providerAtStart`；
- 只有 Local session 在 watchdog/timeout 自动重试仍失败后，才可保存 pending WAV；
- Cloud session 的音频失败后不得持久化为 pending recovery；
- `retranscribe_pending` 继续明确强制走 Local，因为 pending 文件只允许由 Local session 产生；
- 自动重试和 pending re-transcribe 都必须经过与普通 Local 请求相同的全局并发门。

这同时修复当前 `input-prompt.js` 中旧 session 失败时读取最新 `currentProvider` 的竞态：用户在旧 Local 转写尚未返回时切到 Cloud，不能导致本地录音丢失；反向切换也不能把旧 Cloud 音频误存到磁盘。

## 6. Onboarding

现有六页 wizard 收敛为三个阶段。重点不是减少动画页数本身，而是让用户只理解一个价值循环。

### 6.1 阶段一：欢迎

内容：

- “说话，就是打字”；
- “按住快捷键说话，松手，文字出现在光标处”；
- 主按钮“开始设置”。

不出现 Qwen、Groq、OpenAI、API provider 或模型列表。

### 6.2 阶段二：准备使用

同一页面包含三项可独立完成的 checklist：

1. 转写引擎；
2. 麦克风权限；
3. Accessibility 权限。

模型下载与权限授权可以并行，不要求用户等待下载完成后再处理系统权限。

Accessibility checklist 必须复用 `v1.8.1` 的完整授权流程，而不是退回普通 deep link：

1. 先触发系统 Accessibility prompt，使 TypeAloud 出现在权限列表；
2. 打开系统设置；
3. 在正式 `.app` 环境中立即显示 drag cloud；
4. 轮询和窗口 refocus 都重新检查授权；
5. 授权成功后隐藏 cloud 并更新 checklist；
6. 开发期 bare binary 无法显示 cloud 时允许明确回退，Windows/Linux 保持现有平台适配行为。

三阶段 onboarding 只改变信息架构，不删除 `ax_cloud.rs`、`platform/drag_cloud.rs` 或 `ax-cloud.*` 窗口。

#### Local-capable 设备

- 页面进入时 provider 已经是 Local；
- 首要卡片显示“本地转写 · 推荐”；
- 主按钮为“下载并启用本地转写 · 约 1 GB”；
- 点击后才开始下载，支持现有断点续传、取消和错误重试；
- 页面底部提供低优先级“改用云端转写”；
- 展开云端后默认选中 Groq，OpenAI 为备选。

#### 非 Local-capable 设备

- 页面进入时 provider 已经是 Groq；
- 首要卡片显示“云端转写 · 推荐用于这台设备”；
- 默认展示 Groq key 输入和申请入口；
- OpenAI 作为第二 provider；
- 低优先级入口“仍然尝试本地转写”，进入本地模型下载并显示性能/验证提示。

用户切换 Local/Cloud 时立即保存 provider intent，不需要等待模型或 key ready 才保存。

### 6.3 阶段三：第一次听写

准备完成时显示真实输入框，让用户完成一次：

```text
按住快捷键 -> 说话 -> 松手 -> 文字插入
```

只展示一个快捷键，不再宣传“翻译成英文”。

如果用户跳过未完成项，最后一页继续显示可点击 checklist，并可进入首页；首页 readiness 提供相同修复入口。

## 7. 首页与托盘

### 7.1 首页

首页聚焦状态和使用，不再承担 provider 快切：

- readiness 标题；
- 唯一听写快捷键；
- 麦克风与 Accessibility 状态；
- 当前模式的简短状态；
- 最近听写历史。

删除 `[Groq | OpenAI | Local]` 三段切换器和独立 engine card。替代为 readiness 内的一行状态：

```text
转写：本机运行 · 管理
```

或：

```text
转写：Groq 云端 · 管理
```

“管理”打开 Settings 的 Transcription 区域。

### 7.2 托盘

删除 Engine 子菜单。托盘保留启动/停止相关操作、Settings、更新和退出。provider 是低频设置，不是日常操作。

## 8. Settings 信息架构

Settings 中将现有 Models/API Provider 页面重构为 **Transcription**。

### 8.1 第一层：转写方式

两个 radio/card 选项：

- **本地转写**；
- **云端转写**。

设备推荐只影响默认选择和推荐标记，不禁止另一个选项。

### 8.2 Local 面板

选择本地后显示：

- Qwen3-ASR 模型状态；
- 下载大小与磁盘占用；
- 下载、继续、取消、重试和删除；
- 非推荐设备上的性能提示。

模型名属于设置细节，不进入首页主叙事。

### 8.3 Cloud 面板

选择云端后显示：

1. Provider：Groq（推荐）/ OpenAI；
2. 所选 provider 的 API key；
3. 具体模型选择；
4. 音频直达该服务、TypeAloud 不经过自有服务器的说明。

切回 Local 不删除已经保存的 cloud keys；只有用户主动回到 Cloud 时它们才会被使用。

## 9. 翻译功能完整删除

翻译不是按模式隐藏，而是从整个产品移除。普通听写成为唯一 recording action。

### 9.1 Rust

- 删除 `TRANSLATE_SHORTCUT` 与 `default_translate_shortcut()`；
- 从 `AppConfig` 与 `SettingsPayload` 删除 `translate_shortcut`；
- `HotkeyState` 只维护 `record_shortcut`；
- `Action::Start` 不再携带 `translate_mode`；
- `start-recording` event 不再携带布尔 mode；
- `transcribe_audio` command 删除 `translate_mode`，但保留 raw audio body、MIME 和 session provider；
- `resolve_transcription_route` 只按 provider 路由；
- 删除 Local -> Cloud 的 translation fallback；
- 删除 `/audio/translations` endpoint 和翻译专用模型选择；
- 删除 Translation 错误文案和相关测试，改为单一路由测试。

删除 `Action::Start { translate_mode }` 时，只能把 action payload 收敛成单一 Start；不得回退或重写 `position_input_prompt()`、`target_monitor()`、logical/physical scale 处理与 `wait_for_position()`。现有“焦点窗口 -> 鼠标 -> 主屏”行为和相关 Rust 单测必须继续通过。

`transcribe_audio` 的 Local 分支继续保留：

- 首字节 deadline、无进度 watchdog 和外层 hard timeout；
- `local-transcription-partial` 可见进度；
- `--no-warmup`；
- Windows `CREATE_NO_WINDOW`；
- cancellation token 与临时文件清理。

`save_pending_transcription`、`retranscribe_pending`、History pending entry 和保存音频文件都不是 translation 功能，必须保留。翻译删除不得将它们误判为多路由遗留代码。

旧配置文件中的 `translateShortcut` 是未知字段，serde 默认忽略；下一次保存配置时自然清除，不需要单独迁移脚本。

### 9.2 前端与 IPC

- IPC bridge 删除 `translate-mode` header/参数；
- `transcribe-audio` 的 raw-body contract 收敛为 `audio bytes + provider + mime-type`，并同步 Rust request parser、调用参数索引和 contract tests；
- 保留 `save-pending-transcription` 的 raw body + `mime-type` contract；
- 保留 input-prompt CSP 对 macOS/Linux `ipc:` 和 Windows `http://ipc.localhost` 的允许项；
- input prompt 删除 `translateMode` 状态、翻译模型映射和 English-output 状态；
- `recordingSession` 增加不可变 `providerAtStart`，自动重试、WAV 处理和 pending recovery 都使用它；
- input prompt hint 只显示一个快捷键；
- 首页只显示“听写”快捷键；
- onboarding 删除翻译 tip；
- Settings 删除所有 translation shortcut 文案；
- i18n 删除 English-output 与翻译快捷键字符串；
- CSS 删除只服务于 translation badge/state 的规则；
- 更新 IPC contract tests 和 DOM/static smoke tests。

`input-prompt.test.mjs` 中已有的 stale-session UI ownership、hide timer、录音顺序插入、卡死后只重试一次、Local pending 保存和 Cloud 不落盘用例必须保留，并在删除参数后更新 fixture。不能用“只剩一种 action”为理由简化掉这些 session guards。

### 9.3 隐私结果

删除翻译后，路由承诺变为：

```text
provider == local  -> every dictation stays local
provider == groq   -> every dictation goes directly to Groq
provider == openai -> every dictation goes directly to OpenAI
```

不存在由快捷键或失败状态触发的隐式跨模式路由。

## 10. Dictionary 收敛

当前 Dictionary 主要作为 cloud Whisper prompt，本地 Qwen 不消费它。它不应继续作为所有用户都能获益的核心导航项。

本轮：

- 从主侧边栏移除 Dictionary；
- 保留现有 `dictionary` 配置和 IPC，不删除用户数据；
- 将编辑入口移动到 Cloud 面板的高级设置；
- 英文改名为“Cloud vocabulary prompt”，中文改名为“云端词汇提示”；
- 说明它只影响支持 prompt 的 cloud transcription models；
- Local 模式不宣称该设置能提高识别率。

未来若本地后处理支持术语纠正，再以统一的“专有词语”功能重新进入核心信息架构；不在本轮提前设计。

## 11. README 与对外叙事

README 从“开发项目 + 三个 provider 功能列表”调整为产品优先顺序：

1. 一句话价值主张；
2. 下载与安装；
3. 三步使用方法；
4. 本地隐私与无 API key 主路径；
5. 平台支持矩阵；
6. Optional cloud transcription；
7. Settings 与数据存储；
8. Development/build instructions。

具体调整：

- API key 不再出现在普通用户 Requirements；
- Node.js/Rust 从 end-user 安装要求移到 Development；
- Features 首先写 on-device transcription，不把三个 provider 并列；
- Cloud section 说明 Groq 默认推荐、OpenAI 可选和 BYOK 数据流；
- 删除 translation shortcut 的所有使用说明；
- 明确 Apple Silicon 是当前自动 local-first 范围；
- 不对 Intel/Windows/Linux 的本地性能作未经验证的承诺；
- 保留本地模型约 1 GB、音频不离开设备和云端直连说明。

## 12. 错误处理

### 12.1 Local

- 模型 absent/partial：提供下载/继续入口；
- 下载失败：保持 provider=Local，显示原因和重试；
- 模型文件损坏/缺失：提示重新下载，不使用 cloud key；
- 非推荐设备运行慢：允许取消，不能自动改用 Cloud；
- 无网络：已下载模型继续工作；未下载时明确说明下载需要网络。
- watchdog/timeout：同一 session 自动重试一次；再次失败则将 exact Local WAV 保存为 pending history，提示稍后重新转写；
- pending 保存失败：报告转写失败和恢复保存失败，不能谎称音频已保留；
- pending re-transcribe 失败：条目继续保持 pending，音频不删除；
- pending re-transcribe 成功或确认无语音：原位更新条目并删除 recovery audio。

### 12.2 Cloud

- 未配置 key：状态为未就绪，打开对应 provider 的 key 输入；
- key 无效：保留 provider，提示检查 key；
- rate limit/服务不可用：显示 provider 原始可理解错误，不切换另一个 provider；
- 切换 provider：保留另一家的 key，但只使用当前 provider 的 key。

### 12.3 Local 执行边界

Local 变成默认后，不能允许快速连续听写、自动重试和 History 重转写各自启动一个独立 `llama-mtmd-cli`：

- 在 Rust Local ASR 入口设置进程级并发上限 `1`；
- 普通听写、自动重试和 `retranscribe_pending` 共用同一个门；
- 排队等待必须响应 cancellation，取消后不能继续启动子进程；
- 前端 `pendingInsertionOrder` 只保证文字插入顺序，不能被当作模型并发控制；
- 进程从 spawn、stdout/stderr pump 到 `child.wait()` 的完整生命周期都必须在可取消的 hard timeout 内；
- timeout/watchdog 返回时必须确认子进程被终止，不能只停止读取 output。

这是启用 Apple Silicon fresh default=Local 的 release gate，而不是以后可选的性能优化。

## 13. 迁移规则

| 现有状态 | 升级后行为 |
|---|---|
| 已完成 onboarding + Local | 保持 Local |
| 已完成 onboarding + Groq | 保持 Groq |
| 已完成 onboarding + OpenAI | 保持 OpenAI |
| 已保存 cloud keys | 全部保留 |
| 已下载本地模型 | 全部保留 |
| 已有 pending transcription/history audio | 全部保留，仍可从 History 重新转写 |
| 已授予/未授予 Accessibility | 保留系统状态；未授予时继续提供 drag cloud 授权流程 |
| 旧配置含 `translateShortcut` | 可读取；下次保存时移除 |
| 无配置文件 + local-capable | fresh default = Local |
| 无配置文件 + 非 local-capable | fresh default = Groq |
| onboarding 未完成但已有显式 provider | 保持该 provider，按设备显示推荐标记而不强制覆盖 |

不使用版本号或一次性 migration 强制改写已有 provider。设备感知的 fresh default 只在配置文件不存在时生效；已有文件即使缺少较新的字段，也继续走稳定的 serde 历史缺省值。

## 14. 测试与验证

### 14.1 Rust 单测

- `fresh_config_for(true/false)` 分别生成 Local/Qwen 和 Groq/Whisper；
- 已有显式 provider 反序列化后保持不变；
- Local 未安装时可以被选择和保存；
- `engineReady` 对 Local/Groq/OpenAI 三种 provider 正确；
- provider 字符串只接受 Local/Groq/OpenAI；未知值 fail closed，不能落入 OpenAI；
- Local 未 ready 的 transcription 只返回本地模型错误，不读取 cloud key；
- cloud provider 仍要求各自 key；
- hotkey state 只产生单一 `Action::Start`；
- 删除 translation payload 后，焦点窗口/鼠标/主屏选择、DPI normalization 和 position settle tests 继续通过；
- `transcribe_audio` 只存在 transcription 路由；
- raw request 中的 session provider 经过验证，并在自动重试期间保持不变；
- Local 并发测试证明普通转写、自动重试与 pending re-transcribe 同时到达时最多一个 CLI 运行；
- 等待并发门和运行中子进程都可取消；
- watchdog、hard timeout 和 `child.wait()` 共同覆盖完整子进程生命周期；
- Local hang 保存 pending、re-transcribe 原位更新/失败保留、成功后删除 audio 的现有用例继续通过；
- 旧 JSON 带 `translateShortcut` 仍能读取。

### 14.2 前端自动验证

- onboarding local-capable：Local 预选、cloud 折叠、下载全状态；
- onboarding 非 local-capable：Cloud/Groq 预选、Local 仍可进入；
- Settings 两层选择正确映射 internal provider；
- Local 未 ready 仍保持选中且展示修复状态；
- 首页只有一个快捷键且无 engine segmented control；
- input prompt 无 translation copy/state；
- `recordingSession.providerAtStart` 不受处理中途的 settings/provider 更新影响；
- stale session 不能重绘/隐藏新录音，结果继续按 recording order 插入；
- retryable hang 只自动重试一次；只有 Local 失败保存 pending，Cloud 失败不落盘；
- IPC contract 不再发送 `translate-mode`，但继续发送 raw audio、provider 和 MIME；
- raw-body 页面继续允许 macOS/Linux `ipc:` 与 Windows `http://ipc.localhost`；
- Accessibility checklist 继续调用 `show-ax-cloud`，授权成功调用 `hide-ax-cloud`；
- en/zh i18n key 完整，无遗留 translation key 的 DOM 引用。

### 14.3 手动 E2E

至少覆盖：

1. Apple Silicon 全新安装；
2. Apple Silicon 下载中断、继续和失败重试；
3. 现有 OpenAI 用户升级；
4. 现有 Groq 用户升级；
5. Local 用户升级且保留模型；
6. 非 local-capable UI 分支；
7. 非推荐设备主动安装 Local；
8. Local 模型缺失时按快捷键；
9. Cloud key 无效和 rate limit；
10. Local 转写 hang -> 自动重试 -> pending History -> 稍后成功恢复；
11. 快速连续录音时只有一个 Local CLI，文字仍按录音顺序插入；
12. 转写处理中切换 provider，当前 session 路由不变，下一次录音才使用新 provider；
13. 多屏幕/混合 DPI 下 input prompt 仍出现在焦点应用所在屏幕；
14. macOS 首次 Accessibility 授权的 prompt、系统设置、drag cloud、授权后隐藏完整闭环；
15. Windows release 包 raw audio IPC 可用且转写时不弹 console window；
16. README 的实际安装步骤与 release 包一致。

Node 验证至少运行：

```bash
node --test src/views/input-prompt.test.mjs
node --test scripts/ipc-contract.test.mjs
node --test src/views/vad-decision.test.mjs
```

Rust 验证至少运行：

```bash
cd src-tauri
cargo test
cargo check
```

这些自动测试不能替代 macOS 多屏/Accessibility 和 Windows release 包真机验证。

## 15. 实施顺序与相邻设计

本设计跨配置、录音路由、窗口行为和信息架构，必须按可独立回归的顺序实施：

1. **锁定 `v1.8.1` 回归基线**：先运行现有 Rust/Node tests，确认 pending recovery、session guards、raw IPC、跨屏定位和 Accessibility cloud 都是绿的；
2. **补 Local 默认化 release gates**：provider 验证、session provider 绑定、全局 Local 并发门、完整 child lifecycle timeout；
3. **删除 translation 单独路径**：先改 Rust hotkey/route/config tests，再改 raw IPC 和 input prompt fixtures，保持每一步可运行；
4. **实现 fresh config 与 readiness 语义**：`fresh_config_for`、允许未 ready 的 Local intent、`engineReady`；
5. **重构产品 UI**：三阶段 onboarding、Settings 的 Local/Cloud 两层结构、首页和托盘降噪，同时接回原有 Accessibility flow；
6. **收敛 Dictionary、i18n 和 README**；
7. **完成自动验证与真机矩阵**，最后才允许发布 local-first 默认。

每个阶段应有自己的测试和提交；不能先大面积删除 UI/翻译字符串，再依靠最后一次 build 猜测哪些 reliability 行为被破坏。

另有一份待复核草案：

```text
docs/superpowers/specs/2026-07-22-local-asr-long-audio-chunking-design.md
```

（2026-09-11 注：该草案已于 2026-08-29 实现，原文件已删除，内容合并进 `docs/local-asr.md`。）

它处理长录音分段和 release 后尾延迟，不属于本轮产品收敛。两份设计的关系是：

- 先完成本设计的单一路由 raw IPC 与 immutable session provider，长音频草案再基于新 contract rebase；
- 长音频实现必须先通过 WKWebView AudioWorklet/RealTimeVAD spike，不能仅凭静态代码假设可行；
- 长音频前端即使有 serial chunk queue，后端全局 Local 并发门仍必须保留，因为普通听写、自动重试和 History 重转写可从其他入口并发；
- 后续若扩展 `local-transcription-partial` 的 `sessionId/chunkIndex`，必须继续遵守 stale-session UI ownership，旧 partial 不得显示在新录音上；
- 在长音频设计单独获批前，本轮不修改该草案，也不在 README 宣称无限长度或 streaming transcription。

## 16. 成功标准

- Apple Silicon fresh install 在任何时刻都不会显示或保存用户未选择的 OpenAI 默认；
- 模型下载前、中、后 provider 始终保持 Local；
- 非 local-capable fresh install 默认进入 Cloud/Groq setup；
- 普通用户完成 Local onboarding 时不看见 API key 表单；
- 首页、托盘和 input prompt 不再展示第二快捷键；
- Local 模式不存在任何自动或快捷键触发的 cloud 请求；
- Groq/OpenAI 只在 Cloud mode 内出现；
- 现有用户 provider、keys、history 和模型资产全部保留；
- README、onboarding、Settings 和运行时行为对 Local-first 的表述一致。
- `v1.8.1` 的 Accessibility drag cloud、跨屏 input prompt、hang retry/pending recovery、顺序插入和 Windows raw IPC 无回归；
- 同一时刻最多运行一个 Local ASR CLI，取消和 hard timeout 覆盖排队与完整子进程生命周期；
- provider 在一次 recording session 中不可变，未知 provider 不会触发 OpenAI 或其他云端 fallback。

## 17. 预计涉及文件

预计直接修改：

- `src-tauri/src/settings.rs`
- `src-tauri/src/state.rs`
- `src-tauri/src/hotkey.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/local_asr.rs`
- `src-tauri/src/tray.rs`
- `src-tauri/src/lib.rs`
- `src/views/ipc-bridge.js`
- `src/views/main.html`
- `src/views/main.css`
- `src/views/main.js`
- `src/views/settings.html`
- `src/views/settings.css`
- `src/views/settings.js`
- `src/views/input-prompt.html`
- `src/views/input-prompt.css`
- `src/views/input-prompt.js`
- `src/views/input-prompt.test.mjs`
- `src/views/i18n.js`
- `scripts/ipc-contract.test.mjs`
- 相关 Rust/Node/static smoke tests
- `README.md`

必须纳入回归验证，但本设计原则上不重写其核心实现：

- `src-tauri/src/history.rs`
- `src-tauri/src/ax_cloud.rs`
- `src-tauri/src/platform/drag_cloud.rs`
- `src-tauri/src/platform/mod.rs`
- `src-tauri/src/platform/macos.rs`
- `src-tauri/src/platform/fallback.rs`
- `src-tauri/tauri.conf.json`
- `src/views/ax-cloud.html`
- `src/views/ax-cloud.css`
- `src/views/ax-cloud.js`
- `src/views/vad-decision.test.mjs`

待复核的 long-audio 草案不属于本次改动清单。
