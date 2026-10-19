/**
 * 宿主半身 · DSH 适配层。
 *
 * **唯一**知道"DSH 的宿主服务长什么样"的文件。上层（index / llm / context）
 * 只认本文件导出的窄接口，因此 DSH 升级时的改动被收敛在这里：
 *
 *   DSH 做了什么             | 本层怎么吸收                          | 上层受影响
 *   -------------------------|---------------------------------------|------------
 *   webServer.register 变签名 | route() 内部适配                      | 否
 *   llm.stream 参数/分块变    | stream() 原样转发（无加工）           | 否
 *   agentDefaultModel 改名    | defaultRoute() 内换探测               | 否
 *   sessionQuery 读法变       | readSession() 归一为 {surface,pending}| 否
 *   settings.configure 语义变 | disableSettingsPage() 吞错降级        | 否
 *   logger 接口变             | log.info/warn 兜底为可选调用          | 否
 *   服务暴露方式变（get/属性）| service() 两种都试，吞掉未声明抛错     | 否
 *   能力缺失/改名             | capabilities() 汇总，仅打日志         | 否
 *
 * 设计约束：
 *  - **零额外开销**：只做转发与一次服务查找，不复制数据、不做序列化；每请求的
 *    服务查找次数与原实现一致（服务可能晚到，不做一次性固化）。
 *  - **只读能力，不改变语义**：拿不到可选服务就降级，拿不到必需服务就抛，
 *    由调用方决定是 500 还是降级。
 *  - **不引入业务概念**：这里不出现"模板 / 上下文预算 / 优化"等词。
 */

/** 会话读取结果：unavailable = 宿主没有该服务；ok = 拿到了一次 pending 读取。 */
export const SESSION_UNAVAILABLE = Symbol('session-query-unavailable');

export function createHost(ctx) {
	const log = {
		info(message, ...rest) {
			try { ctx.logger?.info?.(message, ...rest); } catch { /* 日志永不抛 */ }
		},
		warn(message, ...rest) {
			try { ctx.logger?.warn?.(message, ...rest); } catch { /* 日志永不抛 */ }
		},
	};

	/**
	 * 查一个宿主服务。
	 *
	 * 真实 cordis 子作用域同时提供 `ctx.get(name)` 与属性代理；部分 facade /
	 * 测试替身只有其中一种，且未声明时 `ctx.get` 可能直接抛错（9-19 的教训：
	 * 未声明即抛会让整个插件 failed）。所以两种都试、且吞掉异常。
	 */
	const service = (name) => {
		if (typeof ctx.get === 'function') {
			try {
				const viaGet = ctx.get(name);
				if (viaGet !== undefined && viaGet !== null) return viaGet;
			} catch { /* 未声明：退回属性访问 */ }
		}
		try {
			return ctx[name];
		} catch {
			return undefined;
		}
	};

	/** 必选服务：缺失即抛，让 handler 明确失败而不是静默降级。 */
	const required = (name, shape) => {
		const found = service(name);
		if (!found || (shape !== undefined && !shape(found))) throw new Error(`宿主服务不可用：${name}`);
		return found;
	};

	return {
		log,

		/** 注册一条 web 路由（当前宿主：kind + path + handler）。 */
		route(spec) {
			required('webServer', (s) => typeof s.register === 'function').register(spec);
		},

		/** 关闭宿主自动生成的设置页；配置协议漂移时只降级，不影响优化。 */
		disableSettingsPage() {
			try {
				ctx.inject(['settings'], (sctx) => {
					const settings = sctx.settings;
					if (!settings || typeof settings.configure !== 'function') return;
					sctx.effect(() => settings.configure({ auto: false }, ctx.fiber));
				});
			} catch (error) {
				log.warn('dsh-prompt-optimizer: 设置自动页面关闭失败，已降级（功能不受影响）', error);
			}
		},

		/**
		 * 读一次会话快照。两种宿主读法归一为同一形状，上层不关心是哪一种：
		 *   { surface: true,  pending } —— canonical surface（优先）
		 *   { surface: false, pending } —— 原始会话日志
		 *    SESSION_UNAVAILABLE       —— 宿主没有该服务（降级为占位上下文）
		 */
		readSession(sessionId) {
			const query = service('sessionQuery');
			const surface = typeof query?.readSurface === 'function';
			if (!surface && typeof query?.readSession !== 'function') return SESSION_UNAVAILABLE;
			return { surface, pending: surface ? query.readSurface(sessionId) : query.readSession(sessionId) };
		},

		/** 流式调用模型服务。 */
		stream(options) {
			return required('llm', (s) => typeof s.stream === 'function').stream(options);
		},

		/** DSH 当前的默认模型选择；没有就是 null（由上层决定报什么错）。 */
		defaultRoute() {
			const selection = service('agentDefaultModel')?.currentSelection?.();
			return selection ?? null;
		},

		/** 能力探测：只汇总，不抛错（用于启动日志与降级判断）。 */
		capabilities() {
			const missing = [];
			if (typeof service('webServer')?.register !== 'function') missing.push('webServer.register');
			if (typeof service('llm')?.stream !== 'function') missing.push('llm.stream');
			// 配置页是增强项：有 configForms/settingsScope 任一即可，缺失只降级设置分区。
			const settings = service('settings');
			const hasSettingsUi = !!(settings && (typeof settings.configure === 'function' || settings.configForms || settings.settingsScope));
			return { missing, hasSettingsUi };
		},
	};
}
