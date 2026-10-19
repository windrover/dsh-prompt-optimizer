# 与上游 linshenkx/prompt-optimizer 的关系

## 结论先行

本插件**没有任何上游代码依赖**：`package.json` 里没有 linshenkx 的任何包，
`lib/` 里没有一行 `import` 指向上游。所有宿主适配、模板加载、输出守卫都是本仓库
自己的实现（TypeScript → 我们重写为 ESM + 自有模板格式）。

**残留的依赖面是"模板文本"**，以及由它带来的两类习惯：

| 依赖面 | 具体内容 | 性质 |
|---|---|---|
| 模板正文（1 个） | `templates/*.md` 的 system 提示词正文 | 文本，可逐条替换 |
| 模板目录语义 | `basic / context / image` 三类 + `order` 排序 | 约定，已在 `templates.js` 固化 |
| 变量占位符 | `{{originalPrompt}}` / `{{json:originalPrompt}}` / `{{对话上下文}}` | 语义兼容层，已在 `llm.js: renderVars` 收口 |
| 输出习惯 | "角色卡 / 任务指令"两类输出风格 | 设计取向，非代码依赖 |

许可证：上游 AGPL-3.0，本插件同为 AGPL-3.0（`LICENSE`）。

## 台账（可执行）

```bash
node scripts/upstream-inventory.mjs
# 模板总数: 15
# 仍逐字源自上游: 1 (6.7%)
# 本地原创      : 14
```

脚本里维护"仍源自上游"的映射表；替换掉一个模板就从表里删一行，比例随之下降。
若表里残留了已被删除的文件，脚本会报错退出（防止数字虚高）。

映射依据是上游
`packages/core/src/services/template/default-templates/` 下的文件名与正文。
抽样核对：`analytical-optimize.md` 与上游 `optimize/analytical-optimize.ts`
正文逐段一致（我们只删掉了 `Author: prompt-optimizer` 行、把 `Language` 改为
"跟随原始 Prompt 的语言"，并加了本插件的 JSON 头）。

| 本插件模板 | 上游文件 | 逐字重合 |
|---|---|---|
| `soul-openclaw-compose.md` | `optimize/soul-openclaw-compose.ts` | 89.4% |

（`analytical` / `general` / `output-format` 已重写，审计重合率均降到 **0.0%**，从表里移出。）

### 更正：台账口径从"文件名"改为"逐字重合"（2026-10-19）

早期版本按**文件名相同**即计入台账，报出 7/15（46.7%）。用逐字重合审计复核后发现，
**context 类三个模板与上游正文的重合率只有 4.0%**：它们的正文是本仓库自己写的
（共享总纲 + include 结构），只是沿用了上游的 id 与用途。按"文本是否逐字来自上游"的
口径，台账应为 **4/15（26.7%）**。

```
node scripts/upstream-audit.mjs     # 逐字重合审计（需联网）
```

审计方法：去掉空白后按 24 字符窗口滑动比对，报告重合率与判读。脚本带**自校准**——
先算上游文件对自身的重合率（应 ≈100%），低于 95% 就判定方法失效并退出，避免把
"匹配不到"误读成"没有依赖"。对照组：已知移植 77.3% / 66.2%，已知原创 0.0%。

`templates/_shared/` 的 14 个 include 同样审计过：全部 ≤3.0%，即不承载上游文本
（它们是本插件自建的组织方式；上游的 TS 模板是整段字面量，没有 include 机制）。

## 为什么还留着（不一次性替换的原因）

1. **效果是有回归样本的**：`test/effect-regression.mjs` 的 27 条样本按模板 id 覆盖
   15/15。改写模板必须逐条过样本，否则等于用"看起来更干净"换"实际变差"。
2. **风险与收益不按"类"均分**：`image` 类 5 个已全部替换（只影响出图措辞，验证快）；
   `context` 类 3 个经审计**本就没有上游文本**，无需替换；剩下 4 个都在 `basic` 类，
   是角色卡/输出格式这类"结构性"模板，改写需要同时保证角色卡结构与输出格式约束
   仍然成立，验证成本最高。
3. **上游仍在演进**：它是 38k star 的活跃项目，模板会继续更新。保留映射表意味着
   我们**可以选择**跟进或替换，而不是被动跟跑。

## 分阶段替换计划

| 阶段 | 做什么 | 验收 |
|---|---|---|
| **Phase 0**（本轮） | 台账化：本文件 + `scripts/upstream-inventory.mjs`；抽样确认"依赖的是文本" | `node scripts/upstream-inventory.mjs` 输出 12/80% |
| **Phase 1** ✅（已完成） | 语义收口：占位符词汇表独立为 `lib/host/placeholders.js`（`PLACEHOLDER_NAMES` + 渲染表，正则由词汇表生成），`llm.js` 只调用 `renderVars`；`test/placeholders.mjs` 钉死 13 条语义（含单次扫描、JSON 转义、白名单保留） | ✅ 词汇表与正则不再可能不同步；替换模板时不必改 `llm.js` |
| **Phase 2** ✅（5/5 完成） | 改写 `image` 类 5 个。上游那版普遍是长篇修辞（"解构 / 炼金术 / 维度跃迁"），把硬约束写成了口号；重写后规则具体、可核对，并把四个模板共用的脚手架抽成 `_shared/image-core.md` + `_shared/image-user.md` | ✅ effect 样本 image 组全绿；台账 **12/15 → 7/15（46.7%）** |
| **Phase 3** ✅（无需替换） | `context` 类 3 个：逐字审计 4.0%，正文本就是我们自己的共享总纲，**不存在上游文本依赖**。降级为"质量复审"，不再消耗模型调用 | 已由 `scripts/upstream-audit.mjs` 出具证据 |
| **Phase 4** ✅（3 重写 + 1 按设计保留） | `analytical` / `general` / `output-format` 已重写，审计 **0.0%**，各用例 3/3；`soul-openclaw-compose`（89.4%）**决定保留**——理由见下 | 台账 1/15（6.7%），该项已登记为"按设计保留" |

每一步都是**独立可回滚的提交**，不做一次性全量替换。

### Phase 2 实测记录（2026-10-19）

image 类 5 个模板全部重写，每条用例重复采样：

| 用例 | 结果 |
|---|---|
| `image-creative-core-image-kept`（鲸鱼） | 3/3（重写前 0/1） |
| `image-general-zh`（猫） | 5/5 |
| `image-general-en-language-kept`（英文草稿） | 5/5，其中混入中文 0/5 |
| `image-photography-zh`（夜景） | 3/3 |
| `image-chinese-aesthetic-kept`（水墨山水） | 3/3 |
| `image2image-no-assumed-original`（换背景） | 3/3 |

一个中途发现：把四个模板的共用脚手架抽成 `image-core` 时，我把"英文草稿不得翻译成中文"
弱化成了"按 Profile 执行"，结果英文用例掉到 2/3（抽到一条中文输出）。把该条写回 Profile 的
`Language` 行后回到 5/5。**说明共用的规则摘要会丢掉关键约束，摘出来时必须逐条比对原文。**

模板体量：这 4 个从 485 行降到 138 行（含共享 include），且共用部分只维护一份。

### 首个模板的历史记录

| 用例 | 改写前 | 改写后 | 说明 |
|---|---|---|---|
| `image-creative-core-image-kept` | 0/1 | **3/3** | 目标缺陷：核心主体"鲸鱼"被抽象掉 |
| `image-photography-zh` | 1/1 → 1/3 | **3/3** | 模板**未改动**；模型把"夜景"改写成"夜幕初降"，是断言过字面导致的假阴性 |

因此本阶段同时修了测试夹具：`image-photography-zh` 的 `mustContain: ["夜景"]` 改为
`mustContainAny: ["夜景","夜幕","夜晚","夜里","夜色","入夜","夜间"]`——该用例的 purpose 本就是
"保留主体场景"，要求逐字命中会让一次正确输出被判失败。

**已知局限**：effect 断言只检查硬约束（主体在不在、语言、占位符、是否输出 JSON），
不评价审美质量。模板改写后仍需要人工看几条真实输出再决定是否保留。

### 决定：`soul-openclaw-compose` 保留，不做措辞改写

它生成的是 **OpenClaw 的 SOUL.md**——第三方产品定义的目标格式。把它的措辞改写一遍可以
让审计重合率从 89.4% 掉到 0%，但实质仍是同一份规范的转述，属于**为了让数字好看而洗稿**，
不是真正的去依赖。

因此决定：

- 保留该模板，按设计计入台账，并在 `scripts/upstream-inventory.mjs` 里登记理由；
- 它不构成"代码依赖"（无 import、无 npm 包），只涉及一段第三方格式说明；
- 若将来 OpenClaw 的格式变更或不再需要该模板，直接下架即可——那才是真正的移除。

判断"是否已摆脱依赖"时，请以**是否还有上游代码/文本逐字存在**为准，而不是以账面数字为准。

## 仍未决的问题

- ~~`_shared/*.md` 来源未核~~：已用 `scripts/upstream-audit.mjs` 核完，14 个 include 全部 ≤3.0%，
  台账因此同时覆盖 `templates/*.md` 与 `_shared/*.md`。
- 上游的模板加载/校验逻辑：已评估，不借鉴。我们的 `templates.js`（mtime 缓存 + include +
  单文件降级）已覆盖所需能力，且加载失败只跳过单文件，比上游更耐受坏模板。
