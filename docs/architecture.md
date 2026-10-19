# 架构

一个包，两个半身：宿主半身跑在 Node（cordis 插件），浏览器半身由 DSH 的
ModuleLoader 加载。二者只通过两条本机 HTTP 路由通信。

```
package.json
  main                → lib/index.js    宿主半身（cordis 插件入口）
  exports["./client"] → lib/client.js   浏览器半身（ModuleLoader 单文件）
  dsh.bundle.patch    → cordis.patch.yml 把宿主插件插进 profile
  dsh.client.inject   → 声明客户端依赖的宿主模块（cordis-client-runner / client-connection）
```

## 宿主半身

按「改动原因」分层，依赖只向下：

```
lib/index.js            装配层：插件声明（name/inject/Config）+ 路由 + 配置归一化
  ├── host/dsh.js       ★ DSH 适配层：唯一知道宿主服务长什么样的文件  （无内部依赖）
  ├── host/config.js    设置 schema、上下界钳制、活配置解包       （无内部依赖）
  ├── host/http.js      loopback 闸、读体、写响应、deadline/abort （无内部依赖）
  ├── host/context.js   会话上下文收集/裁剪/预算装配               → http.js, dsh.js
  ├── host/llm.js       模板→消息、流式调用、自愈重试、围栏清尾    → http.js, config.js, dsh.js, placeholders.js, validate.js
  ├── host/placeholders.js  模板变量词汇表（{{originalPrompt}} 等）  （纯叶子，无依赖）
  ├── validate.js       输出守卫（约束账本/占位符/角色卡/JSON 结构）（无内部依赖）
  └── templates.js      模板目录加载（mtime 缓存、include 展开）    （无内部依赖）
```

| 要改的东西 | 改哪里 |
|---|---|
| **DSH 服务/协议变了** | **`host/dsh.js`（只有这里）** |
| 设置项、默认值、上下界 | `host/config.js` |
| 鉴权、读体大小、超时/取消语义 | `host/http.js` |
| 上下文取多少、怎么截、占位文案 | `host/context.js` |
| 模型调用参数、重试策略、清尾 | `host/llm.js` |
| 守卫规则（占位符丢失/注水/账本） | `validate.js` |
| 模板语法、include、缓存 | `templates.js` + `templates/` |
| 新增一条路由 | `lib/index.js` |

## DSH 适配面（升级时只看这一节）

`host/dsh.js` 是**唯一**出现 `ctx.get / ctx.webServer / ctx.inject / ctx.logger`
的地方（`test/layering.mjs` 强制）。它把宿主暴露成 7 个窄接口：

| 适配接口 | 依赖的 DSH 面 | 变化时的吸收方式 |
|---|---|---|
| `route(spec)` | `ctx.webServer.register` | 签名变化在本函数内转换 |
| `stream(options)` | `ctx.get('llm').stream` | 原样转发，不改分块协议 |
| `defaultRoute()` | `agentDefaultModel.currentSelection()` | 改名/改形状只影响这里 |
| `readSession(id)` | `sessionQuery.readSurface/readSession` | 归一为 `{surface, pending}` |
| `disableSettingsPage()` | `ctx.inject(['settings'])` + `settings.configure` | 失败只降级日志 |
| `capabilities()` | 上述服务的存在性探测 | 只汇总，供启动日志降级 |
| `service(name)` | `ctx.get` 与属性代理两种形态 | 都试、吞掉未声明抛错 |
| `log.info/warn` | `ctx.logger` | 可选调用，永不抛 |

设计约束：**零额外开销**（只转发 + 一次服务查找，每请求调用次数与原实现一致；
不缓存服务实例，避免服务晚到导致失效）。

客户端半身的适配面同样是"一节"而不是"一个文件"（`client.js` 不能拆文件）：

| 适配接口 | 依赖的 DSH 面 | 位置 |
|---|---|---|
| `lookupService` / `resolveBinderFrom` | `configForms` / `settingsScope` 二选一 | ⑨ |
| `useDraftInput(props)` | `props.useInput` hook，旧宿主 `props.input` 回退 | ⑨ |
| `writeDraftTo(props, v)` | `props.inputActions.setDraft` | ⑨ |
| `apply(ctx)` | `ctx.slots.inject/register` | ⑩ |

## 分层约束（可执行）

`test/layering.mjs` 已接入 `npm test`，断言三条规则：

1. 宿主 API（`ctx.get/webServer/inject/logger/fiber`）只出现在 `lib/host/dsh.js`；
2. 依赖只向下——没有模块 import `lib/index.js`，`config/http` 不依赖兄弟模块；
3. 客户端 `props.useInput` / `props.inputActions` 只出现在客户端适配层（⑨）。

改目录结构时若越层，`npm test` 直接失败——边界是断言，不是注释。

## 代码量与性能

```bash
node test/bench.mjs                        # 当前树
node test/bench.mjs --root /tmp/dpo-base   # 对照另一棵树（git worktree）
```

基准只测 CPU 热点（`validateOptimizedOutput`、`fitContextBudget`、`stripCodeFence`），
不碰网络与宿主；`--iters/--rounds` 可调，报中位数避开抖动。
本轮的实测对比见提交说明与 `docs/upstream.md` 同期的交接记录。

### 一次优化请求的生命周期

1. `isLoopbackRequest` —— 回环 + 同源闸（本插件唯一的鉴权面）。
2. `createDeadline(controller.signal, cfg.timeoutMs)` —— 一个 deadline 覆盖后续全部阶段。
3. `readBody` —— 上限 256 KB，超限 413、坏 JSON 400；慢滴流也受 timeoutMs 约束。
4. 校验 `templateId` / 非空 / 长度上限。
5. 仅 `context` 类模板才 `gatherContext`（best-effort，读不到给占位标记）。
6. `runOptimize` —— 组装 messages → `ctx.llm.stream` → 聚合 → 围栏清尾 → `validateOptimizedOutput`。
7. 返回 `{ ok, text, warnings, ledger, usage, ms, contextChars }`。
8. `finally` —— `deadline.dispose()` + 解绑响应 close 监听。

### 必须保持的不变量

- **鉴权只有回环 + 同源**；不要以为宿主模型服务本身有鉴权。
- **deadline 覆盖 body / 上下文 / 模型三段**。把 deadline 只放在模型阶段会让慢的
  body 或 sessionQuery 绕过「单次优化超时」。
- **取消与超时不能混报**：客户端断开 → 静默不写响应；超时 → 带秒数的可操作文案。
- **输出预算只救一次**（`BUDGET_RETRY_CEILING`），已经吐出正文的真截断不重试。
- **上下文从最新一条往回装**，`[用户]/[助手]` 标签不能被截断（否则助手猜测会被
  当成用户确认）。
- **守卫只告警，不自动重试**（避免延迟与成本翻倍）。

## 浏览器半身

`dsh.client` 只允许 `exports["./client"]` 一个入口，ModuleLoader 的 `require`
用于宿主服务（react 等），**加载不了本包自己的兄弟文件**——所以 `lib/client.js`
必须保持单文件，结构靠文件内 ①–⑩ 分区（见该文件头的地图）：

```
① 常量与缓存   ② 样式   ③ 图标   ④ 选择持久化   ⑤ 模板预选
⑥ 展示格式化   ⑦ 输入框工具行组件   ⑧ 设置分区   ⑨ 设置表单服务软探测   ⑩ 插槽注册
```

两处值得留意的设计：

- **样式是一整个字符串**（`styles`），首次渲染时注入 `<style id="dpo-style">`。
  窄屏收起用的是 `@container`（宿主工具行本身是 `container-type:inline-size`），
  不是视口媒体查询——卡片宽度被 `--dsh-composer-card-max-width` 截断，视口断点会滞后。
- **设置表单服务二选一**：0.1.7 的 `configForms`（按 entry id）或旧宿主的
  `settingsScope`；两者都是可选依赖，拿不到只降级设置分区，工具行必须始终可用。

## 测试

```
npm test            确定性、进 CI
  test/host-smoke.mjs             mock 宿主，走通 12 条路由路径（含取消/越权/超时/钳制）
  test/client-smoke.mjs           最小 React/DOM 替身，验证两个插槽都注册
  test/client-lifecycle-smoke.mjs 手动编辑、取消重试、卸载守卫、无障碍键盘等

npm run test:effect 非确定性，需真实模型 + 运行中的 web 实例（不进 CI）
```

改宿主半身的分层后，至少跑 `npm test`；`host-smoke` 会把真实 handler 当黑盒驱动，
是判断「只是搬家、没有改行为」的主要依据。
