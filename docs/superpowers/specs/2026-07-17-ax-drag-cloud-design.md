# 辅助功能授权「拖拽小云朵」— 设计

日期:2026-07-17 · 来源:用户指出 AX 授权是新用户流失的最大关口

状态:已实现(`59a6f20`–`caf1f9c`);设计记录,之后的改动没有同步到本文。

## 背景与目标

macOS 的辅助功能授权是这个软件**装机漏斗上最大的一个洞**。它发生在用户还没从软件里得到任何好处的时刻,而门槛是双重的:

1. **心理抵触**:"辅助功能"听起来像是把电脑交出去。非专业用户不知道它用来干什么,本能地害怕。
2. **操作困难**:即便愿意授权,他要在一个陌生的系统面板里找到正确的那一行、理解该点什么。macOS 那个 "+" 按钮添加 app 的流程本身就很难用。

两件事叠加,结果是"算了,不用了"——软件根本没被打开过。**帮他一点就是一点。**

本设计交付:AX 引导流程中弹出一个含 app 图标的小浮窗(小云朵),用户可以**直接把它拖进**系统设置的辅助功能列表,把"找到 + 添加 + 开启"压缩成一个手势。

### 对 2026-07-04 结论的推翻(重要)

TODO #12 原记录写着"对我们价值有限",理由是:我们的流程先调 `prompt:true`,TypeAloud 那一行**已经预先出现在列表里**,用户只差拨开关,没有"要把 app 拖进去"的问题。

**这个结论是错的,已于 2026-07-17 由用户推翻。** 错在两处:

- **它拿开发者自己已授权的机器做判断。** 相关的用户不是开发者,是一个刚装完、什么都还没看懂的陌生人。
- **它衡量的是"机械上是否等价",而真正该衡量的是"首次运行的流失率"。** 一个更容易、更看得懂的手势,即便存在机械等价的旧路径,依然有巨大价值——因为卡住用户的从来不是"这件事在理论上做不到",而是"他不知道该怎么做,而且有点怕"。

**不要再用"反正已经在列表里了"来论证这个功能没必要。**

## 已定决策(2026-07-17 brainstorm)

- **整朵云都是拖拽源**(用户拍板),**仅右上角关闭按钮除外**(见下条)。省掉 HTML→AppKit 的坐标换算(Retina 缩放 + 原点翻转,易错),且"抓住整朵云拖进去"更符合直觉。代价:窗口位置固定,用户无法用鼠标挪开它。
- **超时后云朵留着,只停轮询**(用户拍板)。用户可能只是在慢慢读、慢慢找;轮询停掉省资源,但拖拽入口继续在。
- **跟深链同时出现**,不等超时。用户在第一秒就需要它——参见既有教训:救急入口的稀有性只能justify低调,不能justify延迟。
- **关闭按钮走 `hitTest:` 穿透**。云朵是 `focus:false`,焦点在「系统设置」上,Escape 收不到,必须有可点的关闭方式。

## 技术可行性(已核实,2026-07-17)

| 需要的能力 | 现状 |
|---|---|
| 运行时声明 ObjC 类(`NSDraggingSource` 协议需要) | `objc 0.2.7` 的 `ClassDecl` 齐全(`add_method` / `add_protocol` / `add_ivar` / `register`);该 crate **项目里已在用**(`macos.rs` 查麦克风权限) |
| 拿到原生视图句柄 | Tauri 2.10.3 暴露 `WebviewWindow::ns_view()` / `ns_window()` |
| 无边框置顶浮窗 | input-prompt 窗口是现成模板 |

## 设计

### 1. 窗口

在 `tauri.conf.json` 静态声明第四个窗口 `ax-drag-cloud`(与现有三窗一致的模式),配置照搬 input-prompt:
`decorations:false, transparent:true, alwaysOnTop:true, focus:false, skipTaskbar:true, resizable:false, visible:false`。

尺寸约 200×230。内容用 HTML 渲染(白拿 i18n 和主题):大号 app 图标 + 一行说明 + 右上角关闭按钮。

**位置**:屏幕偏左中部——「系统设置」通常居中偏右打开,避开它。用 `PhysicalPosition` 按主屏尺寸算,不硬编码像素。

`focus:false` 是必须的:用户正在「系统设置」里点开关,浮窗抢焦点会打断他。

### 2. 拖拽源(核心)

在窗口的 `ns_view()` 上叠一个覆盖全窗的自定义 NSView:

- 用 `ClassDecl` 运行时声明 NSView 子类,`add_protocol(NSDraggingSource)`。
- 拖拽负载:`NSURL fileURLWithPath:` 指向自己的 `.app` bundle 路径。
- 拖拽图:`NSWorkspace sharedWorkspace iconForFile:`。
- `draggingSession:sourceOperationMaskForDraggingContext:` 返回 `NSDragOperationCopy`。
- **`hitTest:` 重写**:右上角固定 28×28 区域返回 `nil`,点击穿透到底下 HTML 的关闭按钮。这块尺寸固定在窗口坐标系里算,不需要 HTML 回传坐标。

**API 路线**:先 spike 便宜的 `dragFile:fromRect:slideBack:event:`(一次调用,约 50 行,10.13 起 deprecated 但可用)。风险是它需要活的鼠标事件上下文,我们的链路是 JS mousedown → IPC → Rust 的异步链,`NSApp.currentEvent` 那时可能已失效——**只能真机验证**。走不通就退到 `beginDraggingSessionWithItems:event:source:`(约 200 行,无此风险)。

在 `platform/` 层落地(macOS 实现 + fallback 空实现),遵循现有平台抽象契约。

### 3. 生命周期与 IPC

- **显示**:前端 `startAccessibilityFlow()` 在 `show-permission-dialog` 之后调 `show_ax_drag_cloud`。
- **隐藏**:①授权成功(现有轮询检测到)→ 前端调 `hide_ax_drag_cloud`;②用户点关闭按钮 → 云朵窗口自己调;③主窗重获焦点时的 `refreshReadiness` 若发现已授权 → 一并隐藏(**覆盖 90s 超时后才授权的情况**,这是"云朵留着"决策的必要配套);④app 退出。
- 两个新命令按 CLAUDE.md 的三处同步规则登记(`commands.rs` / `lib.rs` 的 `generate_handler!` / `ipc-bridge.js`);`scripts/ipc-contract.test.mjs` 会在 CI 拦住漏登记。

### 4. dev 构建回退

dev 模式下跑的是裸二进制,没有 `.app` bundle,拖过去没有意义。`reveal_app_in_finder` 里已有"解析 .app bundle,失败则回退到可执行文件"的逻辑,**直接复用**;若解析不到 bundle,云朵不显示(而不是拖一个没用的二进制过去)。

## 待实测(实现时确认,不阻塞开工)

1. **拖进"已存在但未勾选"的条目,开关会不会自动打开?** 用户与我的判断一致:通过 "+"/拖拽添加的条目默认是勾选的,所以应该会。这只影响云朵上那句文案——会自动开就写"拖进去就好了",不会就写"拖进去,然后打开开关"。**不是要不要做的前提。**
2. `dragFile:` 在异步 IPC 上下文里是否还能拿到有效的 `NSEvent`(决定走哪条 API 路线)。

## 测试策略

- **Rust 单测**:bundle 路径解析的回退分支(复用 `reveal_app_in_finder` 的现有测试模式);云朵显示/隐藏的状态流转。
- **Node 契约测试**:两个新 IPC 命令自动被 `ipc-contract.test.mjs` 覆盖。
- **objc 拖拽本身只能真机验证**——沙盒里发合成事件无效(既有教训)。真机检查清单:云朵出现位置不挡「系统设置」、整朵云可拖出、拖入后条目出现且开关状态如何、关闭按钮可点、授权后自动消失、90s 后仍可拖、dev 模式不显示。

## 不做(YAGNI)

- 云朵位置记忆 / 可拖动窗口(已决:整朵云是拖拽源,与移动窗口互斥)。
- 跟随「系统设置」窗口移动(需要 AX 权限读别的 app 的窗口位置——而我们正是因为没有这个权限才在这儿)。
- Windows/Linux 实现(那两个平台不需要此授权;fallback 空实现即可)。
