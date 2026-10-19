# 与上游 linshenkx/prompt-optimizer 的关系

## 结论先行

本插件**没有任何上游代码依赖**：`package.json` 里没有 linshenkx 的任何包，
`lib/` 里没有一行 `import` 指向上游。所有宿主适配、模板加载、输出守卫都是本仓库
自己的实现（TypeScript → 我们重写为 ESM + 自有模板格式）。

**残留的依赖面是"模板文本"**，以及由它带来的两类习惯：

| 依赖面 | 具体内容 | 性质 |
|---|---|---|
| 模板正文（12 个） | `templates/*.md` 的 system 提示词正文 | 文本，可逐条替换 |
| 模板目录语义 | `basic / context / image` 三类 + `order` 排序 | 约定，已在 `templates.js` 固化 |
| 变量占位符 | `{{originalPrompt}}` / `{{json:originalPrompt}}` / `{{对话上下文}}` | 语义兼容层，已在 `llm.js: renderVars` 收口 |
| 输出习惯 | "角色卡 / 任务指令"两类输出风格 | 设计取向，非代码依赖 |

许可证：上游 AGPL-3.0，本插件同为 AGPL-3.0（`LICENSE`）。

## 台账（可执行）

```bash
node scripts/upstream-inventory.mjs
# 模板总数: 15
# 仍源自上游: 12 (80.0%)
# 本地原创  : 3 (secure-reverse-optimize, user-task-optimize, user-task-planning)
```

脚本里维护"仍源自上游"的映射表；替换掉一个模板就从表里删一行，比例随之下降。
若表里残留了已被删除的文件，脚本会报错退出（防止数字虚高）。

映射依据是上游
`packages/core/src/services/template/default-templates/` 下的文件名与正文。
抽样核对：`analytical-optimize.md` 与上游 `optimize/analytical-optimize.ts`
正文逐段一致（我们只删掉了 `Author: prompt-optimizer` 行、把 `Language` 改为
"跟随原始 Prompt 的语言"，并加了本插件的 JSON 头）。

| 本插件模板 | 上游文件 |
|---|---|
| `analytical-optimize.md` | `optimize/analytical-optimize.ts` |
| `context-analytical-optimize.md` | `optimize/context/context-analytical-optimize.ts` |
| `context-message-optimize.md` | `optimize/context/context-message-optimize.ts` |
| `context-output-format-optimize.md` | `optimize/context/context-output-format-optimize.ts` |
| `general-optimize.md` | `optimize/general-optimize.ts` |
| `output-format-optimize.md` | `optimize/output-format-optimize.ts` |
| `soul-openclaw-compose.md` | `optimize/soul-openclaw-compose.ts` |
| `image-chinese-optimize.md` | `image-optimize/text2image/chinese-model-optimize.ts` |
| `image-creative-text2image.md` | `image-optimize/text2image/creative-text2image.ts` |
| `image-general-optimize.md` | `image-optimize/text2image/general-image-optimize.ts` |
| `image-photography-optimize.md` | `image-optimize/text2image/photography-optimize.ts` |
| `image2image-general-optimize.md` | `image-optimize/image2image/image2image-optimize.ts` |

`templates/_shared/` 的 12 个 include 是**本插件自建的组织方式**（上游的 TS 模板是
整段字面量，没有 include 机制），但其段落文本可能摘自上游对应模板，需在 Phase 0
逐条比对后才能下结论——这正是 Phase 0 的交付物。

## 为什么还留着（不一次性替换的原因）

1. **效果是有回归样本的**：`test/effect-regression.mjs` 的 27 条样本按模板 id 覆盖
   15/15。改写模板必须逐条过样本，否则等于用"看起来更干净"换"实际变差"。
2. **三类模板的风险不同**：`image` 类（5 个）只影响出图提示词措辞，替换风险低；
   `context` 类（4 个）与上下文消歧逻辑耦合（`ctx-core` / `ctx-user` 的边界约定）；
   `basic` 类的 3 个已是本地原创，替换其余 6 个收益最低。
3. **上游仍在演进**：它是 38k star 的活跃项目，模板会继续更新。保留映射表意味着
   我们**可以选择**跟进或替换，而不是被动跟跑。

## 分阶段替换计划

| 阶段 | 做什么 | 验收 |
|---|---|---|
| **Phase 0**（本轮） | 台账化：本文件 + `scripts/upstream-inventory.mjs`；抽样确认"依赖的是文本" | `node scripts/upstream-inventory.mjs` 输出 12/80% |
| **Phase 1** ✅（已完成） | 语义收口：占位符词汇表独立为 `lib/host/placeholders.js`（`PLACEHOLDER_NAMES` + 渲染表，正则由词汇表生成），`llm.js` 只调用 `renderVars`；`test/placeholders.mjs` 钉死 13 条语义（含单次扫描、JSON 转义、白名单保留） | ✅ 词汇表与正则不再可能不同步；替换模板时不必改 `llm.js` |
| **Phase 2** | 改写 `image` 类 5 个（低风险） | effect 样本 image 组全绿；台账降到 7/46.7% |
| **Phase 3** | 改写 `context` 类 4 个（中风险） | context 组样本全绿；台账降到 4/26.7% |
| **Phase 4** | 改写 `basic` 类余下 6 个；评估 `soul-*` 是否保留 | 台账 0/0%；记录替换后的差异与回滚点 |

每一步都是**独立可回滚的提交**，不做一次性全量替换。

## 仍未决的问题

- `_shared/*.md` 的段落来源尚未逐条核对（Phase 0 遗留）。
- 上游是 TypeScript 单仓，其模板加载/校验逻辑是否值得借鉴，需在 Phase 2 前评估；
  目前我们的 `templates.js`（mtime 缓存 + include + 单文件降级）已覆盖所需能力。
