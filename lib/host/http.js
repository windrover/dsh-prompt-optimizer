/**
 * 宿主半身 · HTTP 与取消原语。
 *
 * 这一层只关心"一次请求怎么读、怎么写、怎么被中止"，不含任何优化业务概念：
 *   - loopback + same-origin 闸（isLoopbackRequest）
 *   - 有界请求体读取（readBody，超限 413、坏 JSON 400）
 *   - 安全写出（writeJson，客户端已断开时不再写，避免 write-after-destroy）
 *   - AbortSignal 组合：deadline（客户端断开 + 超时子信号）、withAbort（把不认
 *     signal 的 Promise 绑到请求生命周期）
 */

/** 明确的取消错误：与宿主偶发的 AbortError 区分，便于 handler 静默处理。 */
export function abortError(message = '已取消') {
	const error = new Error(message);
	error.name = 'AbortError';
	return error;
}

/** 取 signal 的 reason（本身是 Error 就用它，否则包一层 fallback）。 */
export function abortReason(signal, fallback = '已取消') {
	const reason = signal?.reason;
	return reason instanceof Error ? reason : abortError(fallback);
}

/**
 * 创建可清理的请求 deadline，避免每次完成后留下不可取消的 AbortSignal.timeout 定时器。
 * 返回的子 signal 同时继承「父信号中止（客户端断开）」与「超时」两种中止原因。
 */
export function createDeadline(parentSignal, timeoutMs) {
	const controller = new AbortController();
	const onParentAbort = () => {
		if (!controller.signal.aborted) controller.abort(abortReason(parentSignal));
	};
	parentSignal.addEventListener('abort', onParentAbort, { once: true });
	if (parentSignal.aborted) onParentAbort();
	const timer = setTimeout(() => {
		const error = new Error('优化超时');
		error.name = 'TimeoutError';
		controller.abort(error);
	}, timeoutMs);
	return {
		signal: controller.signal,
		dispose() {
			clearTimeout(timer);
			parentSignal.removeEventListener('abort', onParentAbort);
		},
	};
}

/**
 * loopback + same-origin 闸：只接受本机发起、且 Origin 与 Host 同源的请求。
 * 这是本插件唯一的鉴权面（宿主模型服务本身也只在回环可用）。
 */
export function isLoopbackRequest(request) {
	const address = request?.socket?.remoteAddress;
	if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false;
	const headers = request?.headers;
	const host = headers?.host;
	if (typeof host !== 'string') return false;
	let hostUrl;
	try {
		hostUrl = new URL(`http://${host}`);
	} catch {
		return false;
	}
	if (hostUrl.hostname !== '127.0.0.1' && hostUrl.hostname !== 'localhost' && hostUrl.hostname !== '[::1]') return false;
	if (headers['sec-fetch-site'] === 'cross-site') return false;
	const origin = headers.origin;
	if (origin === undefined) return true;
	try {
		return new URL(origin).host === hostUrl.host;
	} catch {
		return false;
	}
}

/** 把任意错误压成有界单行文案，避免把适配器内部结构回给客户端。 */
export function boundedError(error, limit = 512) {
	const text = error instanceof Error ? error.message : String(error);
	return text.length > limit ? `${text.slice(0, limit)}…` : text;
}

/** 写出 JSON；客户端已取消（响应已结束/已销毁）时静默放弃，不升级成写后销毁错误。 */
export function writeJson(res, status, body, extraHeaders) {
	// 客户端取消后 ServerResponse 已 destroyed；不要再尝试写响应，避免适配器
	// 把一次正常取消升级成 write-after-destroy 错误。
	if (res.writableEnded || res.destroyed) return false;
	try {
		const headers = Object.assign({
			'content-type': 'application/json; charset=utf-8',
			'cache-control': 'no-store',
			'referrer-policy': 'no-referrer',
			'x-content-type-options': 'nosniff',
		}, extraHeaders);
		res.writeHead(status, headers);
		res.end(JSON.stringify(body));
		return true;
	} catch (error) {
		if (res.writableEnded || res.destroyed) return false;
		throw error;
	}
}

/** 将一个不支持 signal 的 Promise 绑定到请求生命周期，结束后移除监听器。 */
export function withAbort(value, signal) {
	if (signal === undefined || signal === null) return Promise.resolve(value);
	if (signal.aborted) return Promise.reject(abortReason(signal));
	return new Promise((resolve, reject) => {
		let settled = false;
		const cleanup = () => signal.removeEventListener('abort', onAbort);
		const onAbort = () => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(abortReason(signal));
		};
		signal.addEventListener('abort', onAbort, { once: true });
		Promise.resolve(value).then(
			(result) => {
				if (settled) return;
				settled = true;
				cleanup();
				resolve(result);
			},
			(error) => {
				if (settled) return;
				settled = true;
				cleanup();
				reject(error);
			},
		);
	});
}

/**
 * 有界读取并解析 JSON 请求体。
 * 超限时保留连接可读（resume 排空），让调用方仍能回一个 413 JSON。
 */
export function readBody(request, limit = 256 * 1024, signal) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let size = 0;
		let ended = false;
		let settled = false;
		const remove = (event, listener) => {
			if (typeof request.off === 'function') request.off(event, listener);
			else request.removeListener?.(event, listener);
		};
		const cleanup = () => {
			remove('data', onData);
			remove('end', onEnd);
			// Keep the request error listener until the stream's close event: aborting
			// or draining a request can report its error on a later turn.
			remove('aborted', onAborted);
			remove('close', onClose);
			signal?.removeEventListener('abort', onSignalAbort);
		};
		const succeed = (value) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve(value);
		};
		const fail = (error) => {
			if (settled) return;
			settled = true;
			cleanup();
			reject(error);
		};
		const onData = (chunk) => {
			if (settled) return;
			const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
			size += buffer.length;
			if (size > limit) {
				const error = new Error('body too large');
				error.code = 'body-too-large';
				fail(error);
				// Keep the connection usable long enough to return a JSON error. The
				// stream is no longer observed, so resume() drains without retaining data.
				// Destroy is only a fallback for non-Node request shims.
				if (typeof request.resume === 'function') request.resume();
				else request.destroy?.();
				return;
			}
			chunks.push(buffer);
		};
		const onEnd = () => {
			if (settled) return;
			ended = true;
			try {
				succeed(JSON.parse(Buffer.concat(chunks).toString('utf8')));
			} catch (error) {
				fail(new Error(`bad JSON: ${error.message}`));
			}
		};
		const onError = (error) => fail(error);
		const onRequestClose = () => {
			// cleanup() deliberately leaves this late error guard in place. Once the
			// stream closes, no further destroy/drain error can be emitted for it.
			remove('error', onError);
			remove('close', onRequestClose);
		};
		const onAborted = () => fail(abortReason(signal, '客户端已断开'));
		const onClose = () => {
			// IncomingMessage 的正常顺序是 end → close；只有 body 尚未结束时，
			// close 才表示上传方提前断开。
			if (!ended) fail(abortReason(signal, '客户端已断开'));
		};
		const onSignalAbort = () => {
			fail(abortReason(signal));
			request.destroy?.();
		};
		request.on('data', onData);
		request.on('end', onEnd);
		request.on('error', onError);
		request.on('aborted', onAborted);
		request.on('close', onClose);
		request.on('close', onRequestClose);
		if (signal !== undefined && signal !== null) {
			signal.addEventListener('abort', onSignalAbort, { once: true });
			if (signal.aborted) onSignalAbort();
		}
	});
}
