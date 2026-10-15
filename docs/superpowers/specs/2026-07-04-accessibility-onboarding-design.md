# Accessibility 授权 onboarding 优化 — 设计

日期:2026-07-04 · 来源:TODO.md #3(方案已在 2026-06-30 调查中拍板)

状态:已实现(`00ad7e3`);设计记录,之后的改动没有同步到本文。

## 目标

Accessibility 是 TypeAloud 能工作的前提(文字插入 + 全局快捷键都依赖它)。当前主窗只有一个
"辅助功能" warn pill,点了只会打开 Settings 窗口,用户要自己翻到权限区、点按钮、去系统设置、
再手动切回来触发重查 —— 首次用户在这一步流失。目标:把"未授权 → 已授权"做成一条一键、
自动推进、文案打消顾虑的路径。

## 技术约束(不可绕过)

App 不能用 API 把自己加进 Accessibility 列表(Apple 防自我授权)。最后一下必须用户在
系统设置里完成;我们能做的是让这一步最省事,并在完成后自动继续。

## 方案(复用主窗 readiness 卡,不开新窗)

### 1. 引导面板(main.js `renderReadiness`)

AX 未授权(`granted=false` 且平台需要;非 macOS `not_required` 不显示)时,在 pills 下方
追加 `.ax-guide` 面板:

- **标题 + 引导语**:开启辅助功能,完成最后一步。
- **拿它做什么**(两条,各配图标):把听写文字输入到当前应用;在任意应用监听按住说话快捷键。
- **不拿它做什么**(安抚,一条):不记录按键、不监控其他应用、不上传任何数据 —— 权限只用于
  上面两件事。
- **主按钮**"打开辅助功能设置" + 等待/超时状态(见下)。

AX pill 的 onFix 从 `openSettings` 改为触发同一个一键流程。API key / 麦克风 pill 不变。

### 2. 一键流程(顺序是关键)

1. 先 `request-accessibility-permission`(prompt:true)—— 只有弹过一次系统提示,
   系统设置的辅助功能列表里才会预先出现 TypeAloud 那一行;否则首次用户打开列表发现没东西可勾。
   若返回已授权则直接刷新收工。
2. 再 `show-permission-dialog`(深链 `x-apple.systempreferences:...Privacy_Accessibility`)
   直达辅助功能页。
3. 启动**有上限的主动轮询**:每 1s 调 `recheck-accessibility-permission`(prompt:false),
   90s 封顶。授权瞬间后端 `sync_accessibility_status` 已会重启 hotkey 监听 + 广播
   `accessibility-permission-changed`,主窗收到即刷新 —— 面板收起、卡片变"就绪",用户
   不用手动切回来点任何东西。
4. 90s 未授权:停止轮询,回到可点状态并显示柔和的重试提示。

### 3. 轮询状态与重渲染

`refreshReadiness` 会因 focus / 事件随时整卡重建(replaceChildren),所以等待/超时状态放
模块级变量(waiting / timedOut / timer),`renderReadiness` 按它渲染;`axOk` 变 true 时无条件
停轮询清状态。waiting 中按钮换成"等待授权中…"提示(不可再点),pill 触发也被 waiting 守卫。

### 4. 附带修正:主窗 focus 重查改用 recheck

现状 `checkAxOk` 用 `check-accessibility-permission`(纯读)。它不同步 AppState、不重启
hotkey —— 用户绕过按钮手动去系统设置授权再切回主窗时,卡片会变绿但快捷键还是死的。
改用 `recheck-accessibility-permission`(幂等;只在状态变化时 emit,不会循环:事件处理器
再次 recheck 时状态已一致)。

## 改动面

- `src/views/main.js`:面板渲染 + 一键流程 + 轮询;`checkAxOk` 换 recheck。
- `src/views/i18n.js`:`readiness.axGuide.*` 文案(en + zh)。
- `src/views/main.css`:`.ax-guide` 样式(复用现有主题变量)。
- Rust:**零改动**(request / recheck / 深链 / hotkey 重启均已就绪)。

## 测试

- `node --check` 语法校验三个 JS;`cargo test` 保持绿(Rust 未动)。
- 真机验收(用户):`tccutil reset Accessibility com.tao.typealoud` 后启动 → 主窗出现引导面板 →
  点按钮 → 系统提示出现 + 设置页直达 + TypeAloud 已在列表 → 打开开关 → 数秒内主窗自动变
  "就绪"、快捷键立即可用(不重启 app)。
