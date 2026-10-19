/**
 * @local/dsh-prompt-optimizer — host half（装配层）。
 *
 * 移植自 linshenkx/prompt-optimizer（AGPL-3.0）的核心优化模板，去冗余后仅保留：
 * 三类模板（基础 / 上下文 / 图像）的一次性提示词优化。优化调用走宿主的
 * `ctx.llm` 服务（模型路由跟随 DSH 默认模型，或用设置页里配置的 provider/model），
 * 不直连任何 API、不触碰凭据。
 *
 * 源结构（2026-10-19 梳理，按"改动原因"分层）：
 *   lib/index.js         ← 本文件：插件声明 + 路由装配 + 配置归一化
 *   lib/host/config.js   ← 设置 schema、上下界钳制、活配置解包
 *   lib/host/http.js     ← loopback 闸、读体、写响应、deadline/abort
 *   lib/host/context.js  ← 会话上下文收集、裁剪、预算装配
 *   lib/host/llm.js      ← 模板→消息组装、流式调用、自愈重试、围栏清尾
 *   lib/validate.js      ← 输出守卫（约束账本 / 占位符 / 角色卡 / JSON 结构）
 *   lib/templates.js     ← 模板目录加载（mtime 缓存、include 展开）
 *   lib/client.js        ← 浏览器半身（单文件，ModuleLoader 格式，见该文件头）
 *
 * 改配置语义 → host/config.js；改网络/取消行为 → host/http.js；
 * 改上下文策略 → host/context.js；改模型调用或重试 → host/llm.js；
 * 只有"新增一条路由"才需要动本文件。
 *
 * 路由（loopback + same-origin 闸，同 dsh-session-delete 惯例）：
 *   GET  /api/dsh-prompt-optimizer/templates → 模板目录（客户端下拉用）
 *   POST /api/dsh-prompt-optimizer/optimize  { templateId, text, sessionId? }
 *     → { ok, text, ms, contextChars }；客户端断开即中止模型调用
 *
 * 设置（0.1.7 规范，2026-09-22 迁移）：不再调用已删除的 `ctx.settings.register()`，
 * 改为导出 `Config`（schemastery schema），全部参数标 `.volatile()` —— 宿主
 * dsh-settings 的 configEditor 据此投影出可编辑表单（namespace = 本插件的
 * profile entry id `dsh-prompt-optimizer-host`），改动即时生效并持久化到
 * profile patch。本插件自建「设置 → 提示词优化」分区页，故用
 * `settings.configure({ auto: false })` 抑制宿主再自动生成一份重复页面。
 * 旧宿主（无 configForms/volatile 语义）下走 schema 默认值，优化功能不受影响。
 */
import { getTemplates } from './templates.js';
import {
	DEFAULT_MAX_TOKENS,
	MAX_CONTEXT_MAX_CHARS,
	MAX_CONTEXT_MAX_MESSAGES,
	MAX_INPUT_CHARS_FALLBACK,
	MAX_MAX_INPUT_CHARS,
	MAX_MAX_TOKENS,
	MAX_TEMPLATE_ID_CHARS,
	MIN_MAX_INPUT_CHARS,
	MIN_MAX_TOKENS,
	nonNegativeIntOr,
	positiveIntOr,
	readConfig,
	timeoutOr,
} from './host/config.js';
import { DIALOG_COLLECT_CAP, gatherContext } from './host/context.js';
import {
	abortError,
	boundedError,
	createDeadline,
	isLoopbackRequest,
	readBody,
	withAbort,
	writeJson,
} from './host/http.js';
import { runOptimize } from './host/llm.js';

/** Stable cordis plugin name. */
export const name = 'dsh-prompt-optimizer';

/** 本插件版本（与 package.json 同步；仅用于启动日志，避免对宿主强依赖）。 */
const version = '0.8.0-rc2.1';

/** Services required before the routes mount. */
export const inject = ['webServer', 'llm'];

/** 设置 schema 与 `Config` 由 host/config.js 持有，这里沿用历史导出路径。 */
export { buildConfigSchema, Config } from './host/config.js';

/**
 * 配置就绪信号（测试钩子）：0.1.7 迁移后配置由宿主在装配时按 `Config` schema
 * 解析并传入 `apply`，不再有异步注册阶段，因此恒为已 resolve。
 */
export let settingsReady = Promise.resolve();

/** 模板 id → 定义。每次现取（getTemplates 内部按 mtime 缓存），改模板免重载。 */
function templateMap() {
	return new Map(getTemplates().map((template) => [template.id, template]));
}

/**
 * 把 apply 收到的活配置归一化成 handler 使用的普通对象。
 * 所有钳制集中在这里：handler 内不再出现散落的 typeof / clamp 判断。
 */
function normalizeConfig(raw) {
	return {
		provider: typeof raw.provider === 'string' ? raw.provider : '',
		model: typeof raw.model === 'string' ? raw.model : '',
		temperature: typeof raw.temperature === 'number' && raw.temperature >= 0 && raw.temperature <= 2 ? raw.temperature : 0.3,
		reasoningEffort: typeof raw.reasoningEffort === 'string' ? raw.reasoningEffort : 'inherit',
		maxTokens: positiveIntOr(raw.maxTokens, DEFAULT_MAX_TOKENS, MIN_MAX_TOKENS, MAX_MAX_TOKENS),
		timeoutMs: timeoutOr(raw.timeoutMs, 120000),
		maxInputChars: positiveIntOr(raw.maxInputChars, MAX_INPUT_CHARS_FALLBACK, MIN_MAX_INPUT_CHARS, MAX_MAX_INPUT_CHARS),
		contextMaxMessages: Math.min(DIALOG_COLLECT_CAP, nonNegativeIntOr(raw.contextMaxMessages, 12, MAX_CONTEXT_MAX_MESSAGES)),
		contextMaxChars: nonNegativeIntOr(raw.contextMaxChars, 4000, MAX_CONTEXT_MAX_CHARS),
	};
}

/**
 * 前向兼容探针：检查本插件依赖的几个 host 能力是否齐备，并打一条启动日志。
 *
 * 设计原则（为「将来新版本」留余量）：
 *  - 纯只读、纯日志，任何缺失都**不抛错**——缺失只意味着某项增强降级，
 *    核心优化链路（webServer 路由 + ctx.llm.stream）始终可用。
 *  - 探测的是「能力」而非版本号：这样无论 DSH 在 0.2.0 / 0.3.0 还是改写内部
 *    实现的版本，只要能力还在，插件就不需要跟着改；能力被移除才会在日志里
 *    暴露出来，便于及时发现并补适配，而不是静默跑偏。
 *  - 客户端 half 另有对称的 `lookupService` 软探测，二者不重复、各管各的半边。
 *
 * @param {object} ctx - Host plugin context.
 */
function probeHostCapabilities(ctx) {
	const missing = [];
	if (!ctx.get || typeof ctx.get('webServer')?.register !== 'function') missing.push('webServer.register');
	const llm = ctx.get?.('llm');
	if (!llm || typeof llm.stream !== 'function') missing.push('llm.stream');
	// 配置页是增强项：有 configForms/settingsScope 任一即可，缺失只降级设置分区。
	const settings = ctx.get?.('settings');
	const hasSettingsUi = !!(settings && (typeof settings.configure === 'function' || settings.configForms || settings.settingsScope));
	const tag = `[dsh-prompt-optimizer@${version}]`;
	if (missing.length === 0) {
		ctx.logger?.info?.(`${tag} 已挂载（核心能力就绪${hasSettingsUi ? '，设置分区可用' : '，设置分区降级'}）`);
	} else {
		ctx.logger?.warn?.(`${tag} 缺核心能力 ${missing.join(' / ')}，插件可能无法正常工作 —— 请确认 DSH 版本 ≥ 0.1.7`);
	}
}

function apply(ctx, pluginConfig) {
	// 前向兼容探针：仅做**非破坏性**的能力探测与日志，绝不抛出 —— 这样即使
	// 未来某版 DSH 调整了 host 服务/配置协议，本插件也只是降级（设置分区消失 /
	// 走默认值），而不会拖垮整个插件树（DSH 原生 fail-loud）。
	probeHostCapabilities(ctx);

	// 0.1.7 规范：不再注册命名空间（`settings.register` 已从宿主删除）。宿主
	// configEditor 从本模块导出的 `Config` 投影设置表单；本插件自带「设置 →
	// 提示词优化」分区页（客户端 half），故显式关闭宿主的自动页面生成，避免
	// 同一份配置出现两个入口。
	try {
		ctx.inject(['settings'], (sctx) => {
			const settings = sctx.settings;
			if (!settings || typeof settings.configure !== 'function') return;
			sctx.effect(() => settings.configure({ auto: false }, ctx.fiber));
		});
	} catch (error) {
		// 配置协议漂移（如未来宿主移除 settings.configure 或注入签名变化）：
		// 只降级设置分区，优化功能本身不受影响。
		ctx.logger?.warn?.('dsh-prompt-optimizer: 设置自动页面关闭失败，已降级（功能不受影响）', error);
	}

	/** 读取活配置（`.volatile()` 引用解包）并归一化。 */
	const config = () => normalizeConfig(readConfig(pluginConfig));

	ctx.webServer.register({
		kind: 'exact',
		path: '/api/dsh-prompt-optimizer/templates',
		handler: async (req, res) => {
			if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' });
			if (req.method !== 'GET' && req.method !== undefined) return writeJson(res, 405, { ok: false, error: 'GET only' }, { allow: 'GET' });
			writeJson(res, 200, {
				ok: true,
				templates: getTemplates().map(({ id, name: templateName, desc, category }) => ({ id, name: templateName, desc, category })),
			});
		},
	});

	ctx.webServer.register({
		kind: 'exact',
		path: '/api/dsh-prompt-optimizer/optimize',
		handler: async (req, res) => {
			if (!isLoopbackRequest(req)) return writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' });
			if (req.method !== 'POST' && req.method !== undefined) return writeJson(res, 405, { ok: false, error: 'POST only' }, { allow: 'POST' });

			// 从读取请求体开始监听响应断开，避免客户端在 body 解析期间取消时漏掉事件。
			// res 的 close 同时覆盖正常结束和提前断开；writableEnded 用来区分二者。
			const controller = new AbortController();
			const onResponseClose = () => {
				if (!res.writableEnded) controller.abort(abortError('客户端已断开'));
			};
			if (typeof res.on === 'function') res.on('close', onResponseClose);
			const detachResponseClose = () => {
				if (typeof res.off === 'function') res.off('close', onResponseClose);
				else if (typeof res.removeListener === 'function') res.removeListener('close', onResponseClose);
			};

			const cfg = config();
			/** 统一的超时响应：body / 上下文 / 模型三个阶段共用同一份可操作文案。 */
			const timeoutResponse = () => {
				// 秒数向上取整并至少显示 1 秒：Math.round 会把 <500ms 的超时说成
				// 「0 秒」，用户看不懂也没法据此调参。
				const seconds = Math.max(1, Math.ceil(cfg.timeoutMs / 1000));
				return { ok: false, error: 'timeout', message: `优化超时（${seconds} 秒），可在「设置 → 提示词优化」调大超时或调低推理强度` };
			};

			// deadline 提前到 body 读取之前（二轮 P3）：慢滴流的 body 同样受 timeoutMs
			// 约束，不再只有模型阶段有超时。deadline.signal 是 controller.signal 的子
			// 信号（二者已合并），客户端断开照常穿透 readBody，无需再传原 signal。
			const startedAt = Date.now();
			const deadline = createDeadline(controller.signal, cfg.timeoutMs);

			let body;
			try {
				body = await readBody(req, 256 * 1024, deadline.signal);
			} catch (error) {
				deadline.dispose();
				if (deadline.signal.reason?.name === 'TimeoutError') {
					detachResponseClose();
					return writeJson(res, 200, timeoutResponse());
				}
				if (controller.signal.aborted || error?.name === 'AbortError') {
					detachResponseClose();
					return;
				}
				const status = error?.code === 'body-too-large' ? 413 : 400;
				detachResponseClose();
				return writeJson(res, status, { ok: false, error: `bad body: ${boundedError(error)}` });
			}
			const templateId = typeof body?.templateId === 'string' ? body.templateId : '';
			const text = typeof body?.text === 'string' ? body.text : '';
			const sessionId = typeof body?.sessionId === 'string' ? body.sessionId : '';
			if (templateId.length > MAX_TEMPLATE_ID_CHARS) {
				deadline.dispose();
				detachResponseClose();
				return writeJson(res, 400, { ok: false, error: '模板 ID 过长' });
			}
			const template = templateMap().get(templateId);
			if (template === undefined) {
				deadline.dispose();
				detachResponseClose();
				return writeJson(res, 400, { ok: false, error: `未知模板：${templateId}` });
			}
			if (text.trim() === '') {
				deadline.dispose();
				detachResponseClose();
				return writeJson(res, 400, { ok: false, error: '输入框为空，先写点内容再优化' });
			}

			const maxChars = cfg.maxInputChars > 0 ? cfg.maxInputChars : MAX_INPUT_CHARS_FALLBACK;
			if (text.length > maxChars) {
				deadline.dispose();
				detachResponseClose();
				return writeJson(res, 400, { ok: false, error: `文本过长（${text.length} > ${maxChars} 字符），可截取后重试或在设置页调大上限` });
			}
			if (controller.signal.aborted) {
				deadline.dispose();
				detachResponseClose();
				return;
			}

			try {
				// 同一个 deadline 覆盖 body 读取、上下文读取和模型调用；否则慢的
				// sessionQuery 会绕过“单次优化超时”，并在用户取消后继续阻塞 handler。
				const context = template.category === 'context'
					? await gatherContext(ctx, sessionId, cfg, deadline.signal)
					: { text: '', chars: 0 };
				// LLM adapters normally honor options.signal; the outer race also bounds
				// handler latency when an older adapter does not.
				const optimized = await withAbort(
					runOptimize(ctx, cfg, template, text, context.text, deadline.signal),
					deadline.signal,
				);
				writeJson(res, 200, {
					ok: true,
					text: optimized.text,
					// 模板自检之外的第二道防线：占位符丢失/角色卡泄漏/注水等只告警，
					// 由客户端提示用户，不自动重试（避免延迟与成本翻倍）。
					warnings: optimized.warnings,
					// 约束账本统计（保留/删除/新增），客户端据此显示变更摘要。
					ledger: optimized.ledger,
					usage: optimized.usage,
					ms: Date.now() - startedAt,
					// 只统计真实对话字符：占位标记不计入，客户端据此提示本次没带上下文。
					contextChars: context.chars,
				});
			} catch (error) {
				// 超时与用户取消分开报：超时给可操作的提示，取消才静默。
				if (error?.code === 'timeout' || error?.name === 'TimeoutError' || deadline.signal.reason?.name === 'TimeoutError') {
					return writeJson(res, 200, timeoutResponse());
				}
				if (controller.signal.aborted || error?.code === 'canceled' || error?.name === 'AbortError') {
					return writeJson(res, 200, { ok: false, error: 'canceled' });
				}
				ctx.logger?.warn?.('dsh-prompt-optimizer: 优化失败', error);
				writeJson(res, 200, { ok: false, error: boundedError(error) });
			} finally {
				deadline.dispose();
				detachResponseClose();
			}
		},
	});
}

export { apply };
