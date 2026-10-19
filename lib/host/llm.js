/**
 * 宿主半身 · 模型调用与输出守卫。
 *
 * 负责把「模板 + 原提示词 + 上下文」组装成一次 `host.stream()` 调用，并处理
 * 三种可自愈的失败：
 *   1. 模型不支持所选推理强度 → 去掉覆盖、按模型默认档位重试一次；
 *   2. 思考 token 吃光输出预算 → 按更宽预算重试一次；
 *   3. 模型给整条提示词套了代码围栏 → 仅在无歧义时脱壳。
 *
 * 最后交给 validate.js 做输出守卫（占位符丢失 / 角色卡泄漏 / 约束账本等），
 * 只告警不自动重试。
 */
import { randomUUID } from 'node:crypto';
import { validateOptimizedOutput } from '../validate.js';
import { abortReason } from './http.js';
import { renderVars } from './placeholders.js';
import { BUDGET_RETRY_CEILING, REASONING_EFFORTS } from './config.js';

/**
 * 按模板组装一次模型调用（沿用 linshenkx TemplateProcessor 的语义简化版）：
 * 字符串模板 → system=模板全文，user=原提示词；数组模板 → 渲染变量后
 * 聚合 system 消息，取最后一条 user 消息作为请求正文。
 */
export function buildLlmRequest(template, originalPrompt, contextText) {
	const vars = { originalPrompt, context: contextText };
	if (typeof template.content === 'string') {
		return { system: template.content, user: originalPrompt };
	}
	const rendered = template.content.map((m) => ({ role: m.role, content: renderVars(m.content, vars) }));
	const system = rendered.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
	const user = [...rendered].reverse().find((m) => m.role === 'user')?.content;
	return { system, user: user ?? originalPrompt };
}

/** 只保留可序列化的 token 统计字段，避免把适配器私有结构透给客户端。 */
const USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens'];

export function usageSummary(usage) {
	if (usage === null || typeof usage !== 'object') return null;
	const summary = {};
	for (const field of USAGE_FIELDS) {
		const value = usage[field];
		if (typeof value === 'number' && Number.isFinite(value)) summary[field] = value;
	}
	return Object.keys(summary).length > 0 ? summary : null;
}

/** 解析模型路由：设置里同时配置了 provider+model 则用之，否则跟随 DSH 默认模型。 */
export function resolveRoute(host, cfg) {
	const provider = (cfg.provider ?? '').trim();
	const model = (cfg.model ?? '').trim();
	if (provider !== '' && model !== '') return { provider, model };
	if (provider !== '' || model !== '') {
		throw new Error('提供方与模型 ID 必须同时配置，或都留空以跟随 DSH 默认模型');
	}
	const selection = host.defaultRoute();
	if (selection === null || !selection.provider || !selection.model) {
		throw new Error('没有可用的模型路由：请在设置页配置提供方与模型，或先在 DSH 设置默认模型');
	}
	const route = { provider: selection.provider, model: selection.model };
	if (selection.reasoningEffort !== undefined && selection.reasoningEffort !== null) {
		route.reasoningEffort = selection.reasoningEffort;
	}
	return route;
}

/**
 * 输出清尾：剥掉模型给整条提示词套的代码围栏。
 *
 * 判据只有一条：**没有歧义才动手**。
 *   1. 首尾成对，且**内部围栏自身配对** → 脱壳；
 *   2. 全文只有唯一一处围栏 → 那是残留的半截围栏，按位置剥掉；
 *   3. 其余（内部围栏落单、或围栏 ≥ 2 处且未成对）→ 一个字都不动。
 *
 * 第 1 条的"内部配对"校验是踩过两次坑补上的：只看首尾成对就脱壳，会把
 * 「外层围栏 + 正文里的代码块」中的代码块开围栏当成内容剥掉，制造出未闭合
 * 代码块（`示例：```js foo()`）。宁可留一处残留围栏，也不能破坏正文结构。
 */
export function stripCodeFence(text) {
	const paired = /^\s*```[^\n]*\n([\s\S]*?)\n?```\s*$/.exec(text);
	if (paired !== null) {
		const inner = paired[1];
		const innerFences = (inner.match(/^[ \t]*```/gm) ?? []).length;
		return innerFences % 2 === 0 ? inner : text;
	}
	const fenceCount = (text.match(/^[ \t]*```/gm) ?? []).length;
	if (fenceCount !== 1) return text;
	if (/^[ \t]*```[^\n]*\n/.test(text)) return text.replace(/^[ \t]*```[^\n]*\n/, '');
	if (/\n[ \t]*```[ \t]*$/.test(text)) return text.replace(/\n?[ \t]*```[ \t]*$/, '');
	return text;
}

/**
 * 适配层是否因「不支持该推理强度」而拒绝：各 provider 支持的档位并不相同
 * （例如 DeepSeek 只接受 off/low/high/max，没有 medium），插件的设置项是通用
 * 白名单，无法预先知道当前模型支持哪些档位。
 */
export function isUnsupportedEffortFailure(failure) {
	if (failure === null || failure === undefined) return false;
	if (failure.code === 'UNSUPPORTED_REASONING_EFFORT') return true;
	const message = typeof failure.message === 'string' ? failure.message : String(failure);
	// 中英双写（二轮 P3）：部分适配层会把这类拒绝包装成中文文案，只认英文
	// 会漏掉回退机会，让一次本可自愈的失败直接变成报错。
	return /reasoning effort/i.test(message) || /推理强度|不支持.{0,12}强度/.test(message);
}

/** 单次流式调用：聚合文本、结束原因与 token 用量。 */
async function streamOnce(host, options) {
	let out = '';
	let finish = null;
	let usage = null;
	for await (const chunk of host.stream(options)) {
		if (chunk?.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text;
		else if (chunk?.type === 'usage' && chunk.usage !== null && typeof chunk.usage === 'object') usage = chunk.usage;
		else if (chunk?.type === 'finish') finish = chunk.reason;
	}
	return { out, finish, usage };
}

/** 跑一次优化：组装消息 → 流式调用 → 聚合文本 → 输出守卫。 */
export async function runOptimize(host, cfg, template, text, contextText, signal) {
	if (signal?.aborted) throw abortReason(signal);
	const route = resolveRoute(host, cfg);
	const { system, user } = buildLlmRequest(template, text, contextText);
	const message = {
		id: randomUUID(),
		role: 'user',
		content: [{ type: 'text', text: user }],
		source: { kind: 'plugin:dsh-prompt-optimizer' },
	};
	const options = {
		provider: route.provider,
		model: route.model,
		messages: [message],
		system,
		temperature: cfg.temperature,
		maxTokens: cfg.maxTokens,
		signal,
	};
	// 推理强度：inherit（默认）= 不传该字段，由适配器/模型默认决定。刻意不跟随
	// agent 默认模型的档位——优化是轻量任务，跟随主模型的 max 档会让每次点击
	// 多等十几秒；只有显式档位才覆盖，且模型不支持时允许回退一次。
	let overrodeEffort = false;
	if (REASONING_EFFORTS.has(cfg.reasoningEffort)) {
		options.reasoningEffort = cfg.reasoningEffort;
		// 只要**显式设置了**档位就允许回退一次。原实现写
		// `overrodeEffort = route.reasoningEffort !== cfg.reasoningEffort`，
		// 于是「设置值恰好等于路由默认档位」（例如两边都是 off / max）时
		// overrodeEffort 恒为 false → retryable 恒 false → 注释里承诺的
		// 「不支持该档位时按模型默认档位重试一次」这条自愈路径完全不生效，
		// 一次本可自愈的失败变成硬报错。
		overrodeEffort = true;
	}
	/** 丢弃插件覆盖，回到路由自带（或不带）推理强度。 */
	const withoutEffortOverride = () => {
		const fallback = { ...options };
		if (route.reasoningEffort === undefined) delete fallback.reasoningEffort;
		else fallback.reasoningEffort = route.reasoningEffort;
		return fallback;
	};
	// 只回退一次：第二次仍失败就按普通失败上报，不要来回打模型。
	let retried = false;
	const retryable = (failure) => overrodeEffort && !retried && !signal?.aborted && isUnsupportedEffortFailure(failure);
	const retryWithoutOverride = async () => {
		retried = true;
		host.log.warn(`dsh-prompt-optimizer: 模型不支持推理强度「${cfg.reasoningEffort}」，本次按模型默认档位重试`);
		return streamOnce(host, withoutEffortOverride());
	};
	let currentOptions = options;
	let out = '';
	let finish = null;
	let usage = null;
	try {
		({ out, finish, usage } = await streamOnce(host, currentOptions));
	} catch (error) {
		// 适配层可能直接抛（而不是产出 finish 块）。
		if (!retryable(error)) throw error;
		({ out, finish, usage } = await retryWithoutOverride());
		currentOptions = withoutEffortOverride();
	}
	if (finish?.kind === 'error' && retryable(finish.failure)) {
		({ out, finish, usage } = await retryWithoutOverride());
		currentOptions = withoutEffortOverride();
	}
	// 推理型模型把思考 token 记进同一份输出预算：预算被思考吃光时一个字都吐不出来，
	// 用户看到的是"输出达到 token 上限"而不是结果。这种「纯烧预算」失败按更宽预算
	// 重试一次；已经吐出正文的真截断仍照旧报错，由用户决定调多大。
	// effectiveMaxTokens 记录实际生效的预算：重试后再失败时，文案要引用真正用过的
	// 值而不是原始 cfg.maxTokens，否则用户会去调一个已经不起作用的参数（二轮 P3）。
	let effectiveMaxTokens = cfg.maxTokens;
	if (finish?.kind === 'max-tokens' && out.trim() === '' && !signal?.aborted && cfg.maxTokens < BUDGET_RETRY_CEILING) {
		const widened = Math.min(BUDGET_RETRY_CEILING, cfg.maxTokens * 4);
		effectiveMaxTokens = widened;
		host.log.warn(`dsh-prompt-optimizer: 输出预算 ${cfg.maxTokens} 被思考 token 吃光，按 ${widened} 重试一次`);
		({ out, finish, usage } = await streamOnce(host, { ...currentOptions, maxTokens: widened }));
	}
	// 中止归因：request deadline 组合「客户端断开 + 超时」，超时的 reason
	// 是 TimeoutError；按 reason 区分，超时不能报成"已取消"。
	if (signal?.aborted) {
		if (signal.reason?.name === 'TimeoutError') throw Object.assign(new Error('优化超时'), { code: 'timeout' });
		throw Object.assign(new Error('已取消'), { code: 'canceled' });
	}
	const kind = finish?.kind;
	if (kind === 'aborted') {
		if (signal?.aborted && signal.reason?.name === 'TimeoutError') throw Object.assign(new Error('优化超时'), { code: 'timeout' });
		throw Object.assign(new Error('已取消'), { code: 'canceled' });
	}
	if (kind === 'error') throw new Error(`模型调用失败：${finish.failure?.message ?? 'unknown'}`);
	if (kind === 'max-tokens') throw new Error(`输出达到 token 上限（${effectiveMaxTokens}）；推理型模型的思考 token 也算在这个预算里，可在设置页调大「单次输出 token 上限」或调低推理强度`);
	if (out.trim() === '') throw new Error('模型没有返回文本');
	// 模板自检之外的第二道防线：只检测与轻量规范化，不自动重试。
	const guarded = validateOptimizedOutput({ template, draft: text, output: stripCodeFence(out.trim()) });
	return { text: guarded.text, warnings: guarded.warnings, ledger: guarded.ledger, usage: usageSummary(usage) };
}
