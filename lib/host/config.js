/**
 * 宿主半身 · 配置层。
 *
 * 三件事，全部是纯函数 / 纯常量，不触碰宿主服务：
 *   1. 设置 schema（0.1.7 规范的 `Config` 导出，字段全部 `.volatile()`）；
 *   2. 上下界常量与标量钳制（设置页清空数字框会提交空串，必须回落默认）；
 *   3. 活配置解包（`.volatile()` 字段在 pluginConfig 上是 `{ get(), write() }` 引用）。
 *
 * 位置约束：`Config` 必须在它引用的上下界常量之后求值，否则顶层 const 会撞上
 * 这些常量的 TDZ（Cannot access before initialization）。
 */
import z from '@deepseek-ai/schemastery';

/**
 * volatile 配置引用的判定：宿主 cosmokit 用全局注册符号
 * `Symbol.for('cosmokit.volatile.write')` 标记引用（createVolatile 只挂
 * `get()` 与该符号方法）。这里用同一个全局符号做等价判定，避免为本插件
 * 新增 @deepseek-ai/cosmokit 依赖 —— 该符号跨 ESM/CJS 副本一致，判定与
 * cosmokit 的 isVolatile 完全等价。
 */
export const VOLATILE_WRITE = Symbol.for('cosmokit.volatile.write');

/** 输入框目录接口无缓存，仅防误用的输入长度兜底。 */
export const MAX_INPUT_CHARS_FALLBACK = 8000;
export const MAX_TEMPLATE_ID_CHARS = 256;

/** 输出 token 地板值：低于此值必然被推理型模型的思考 token 吃光，纯属徒劳重试。 */
export const MIN_MAX_TOKENS = 64;
/** 超时地板值：亚秒级超时是受支持特性（测试覆盖 timeoutMs=50），只挡 1ms 级病态值。 */
export const MIN_TIMEOUT_MS = 10;
/** 输入长度地板值：与设置页 UI 的 min 一致——floor=1 时任何输入都会被 400（二轮 P3）。 */
export const MIN_MAX_INPUT_CHARS = 200;

/**
 * 各项上限（天花板）。
 *
 * 原来这几个设置项**只有下界没有上界**：把「上下文文本总长上限」填成 1e8 后，
 * `perMessageLimit` 被 CONTEXT_MESSAGE_CLIP_CHARS 顶到 2000、条数被
 * DIALOG_COLLECT_CAP 顶到 200 → 单次请求最多携带 200×2000 = 40 万字符
 * （≈10 万+ token）上下文，且 fitContextBudget 因 `full.length <= maxChars`
 * 提前返回而**完全不截断**，每次点击都发。timeoutMs 早已有 MAX_TIMEOUT_MS
 * 钳制，这几项属同类防护缺失。
 */
export const MAX_MAX_TOKENS = 65536;
export const MAX_MAX_INPUT_CHARS = 200000;
export const MAX_CONTEXT_MAX_MESSAGES = 200;
export const MAX_CONTEXT_MAX_CHARS = 20000;

/** setTimeout 在 Node 与浏览器都能接受的最大安全延迟。 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** 输出预算默认值（与 Config schema 默认保持一致）。 */
export const DEFAULT_MAX_TOKENS = 8192;

/** 「纯烧预算」自动重试的输出上限天花板：只救一次，不无限放大成本。 */
export const BUDGET_RETRY_CEILING = 32768;

/** 合法的推理强度档位（与 settings.yaml reasoningEfforts 键一致）。 */
export const REASONING_EFFORTS = new Set(['off', 'low', 'medium', 'high', 'max']);

/** 设置值钳制：非正数/非有限值一律回落默认（设置页清空数字框会提交空串→0）。 */
export function numOr(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** 上下文预算类允许 0（=关闭），仅拒绝负数/非有限值。 */
export function numAtLeast0(value, fallback) {
	return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

export function positiveIntOr(value, fallback, floor = 1, ceiling = Number.MAX_SAFE_INTEGER) {
	return Math.min(ceiling, Math.max(floor, Math.floor(numOr(value, fallback))));
}

export function nonNegativeIntOr(value, fallback, ceiling = Number.MAX_SAFE_INTEGER) {
	return Math.min(ceiling, Math.max(0, Math.floor(numAtLeast0(value, fallback))));
}

export function timeoutOr(value, fallback, floor = MIN_TIMEOUT_MS) {
	const number = numOr(value, fallback);
	return Math.min(MAX_TIMEOUT_MS, Math.max(floor, Math.floor(number)));
}

/**
 * 插件设置 schema 工厂（设置 → 插件 → 提示词优化器）。
 *
 * schemastery 是本插件唯一的外部依赖；依赖缺失时由宿主侧降级（走内置默认值），
 * 不让整个插件树加载失败。
 * @param {object} z - schemastery 命名空间（含 object/string/number/natural）。
 */
export function buildConfigSchema(z) {
	return z.object({
		provider: z.string().default('').volatile().description('模型提供方（留空 = 跟随 DSH 默认模型）'),
		model: z.string().default('').volatile().description('模型 ID（留空 = 跟随 DSH 默认模型；与提供方需同时配置）'),
		temperature: z.number().min(0).max(2).step(0.1).default(0.3).volatile().description('采样温度'),
		reasoningEffort: z.string().default('inherit').volatile().description('推理强度：inherit=不指定，由模型/适配器默认决定（推荐；优化是轻量任务，跟随主模型的 max 档会明显变慢）；off/low/medium/high/max 为显式覆盖；模型不支持该档位时本次优化自动回退到模型默认档位重试'),
		maxTokens: z.natural().min(MIN_MAX_TOKENS).max(MAX_MAX_TOKENS).default(8192).volatile().description('单次输出 token 上限（推理型模型会把思考 token 计入同一预算，留足余量；预算被思考吃光时本插件会按更宽预算自动重试一次）'),
		timeoutMs: z.natural().min(MIN_TIMEOUT_MS).default(120000).volatile().description('单次优化超时（毫秒）'),
		maxInputChars: z.natural().min(MIN_MAX_INPUT_CHARS).max(MAX_MAX_INPUT_CHARS).default(8000).volatile().description('待优化文本长度上限（字符，超长拒绝）'),
		contextMaxMessages: z.natural().max(MAX_CONTEXT_MAX_MESSAGES).default(12).volatile().description('上下文类模板携带的最近对话条数'),
		contextMaxChars: z.natural().max(MAX_CONTEXT_MAX_CHARS).default(4000).volatile().description('上下文文本总长上限（字符；0=关闭上下文携带；预算不足时优先保留最新对话）'),
	}).description('提示词优化器（移植自 prompt-optimizer）');
}

/**
 * 0.1.7 规范的插件配置声明：宿主 dsh-settings 的 configEditor 读取本 schema，
 * 把 `.volatile()` 字段投影为设置页表单（namespace = profile entry id）。
 * 字段全部即时生效，因此全部 volatile；无 volatile 字段的插件不会出现在设置页。
 */
export const Config = buildConfigSchema(z);

/** 解包 `.volatile()` 引用；非 volatile 字段原样返回。 */
export function unwrapVolatile(value) {
	return value !== null && typeof value === 'object' && VOLATILE_WRITE in value ? value.get() : value;
}

/**
 * 读取活配置：把 apply 收到的 pluginConfig 逐字段解包成普通对象。
 * 任何异常一律退回空对象（配置协议漂移时走默认值，不影响优化）。
 */
export function readConfig(pluginConfig) {
	try {
		const source = pluginConfig === undefined || pluginConfig === null || typeof pluginConfig !== 'object' ? {} : pluginConfig;
		const out = {};
		for (const key of Object.keys(source)) out[key] = unwrapVolatile(source[key]);
		return out;
	} catch {
		return {};
	}
}
