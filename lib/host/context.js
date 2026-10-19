/**
 * 宿主半身 · 会话上下文收集。
 *
 * 上下文类模板需要"最近几轮对话"来消歧（"刚才那个""它"）。这里负责：
 *   - 从 canonical surface（优先）或原始会话日志里投影 user/assistant 文本
 *   - 尾窗裁剪（只看会话尾部事件）与按预算装配（从最新往回装）
 *   - 证据边界消毒（转义伪造的闭合标签）
 *   - 缺位时给出显式占位标记，而不是空字符串
 *
 * 全部 best-effort：读不到上下文只会降级为占位标记，不影响优化本身。
 */
import { abortReason, withAbort } from './http.js';

/** 上下文提取只看会话尾部这么多个事件（超长会话不必全量深遍历）。 */
export const EVENT_TAIL_WINDOW = 80;

/** 尾窗内最多收集的对话条数上限（防御畸形结构，正常远够用）。 */
export const DIALOG_COLLECT_CAP = 200;

/** 单条上下文消息的字符上限：长消息保留开头和结尾，结论通常在尾部。 */
export const CONTEXT_MESSAGE_CLIP_CHARS = 2000;
const CONTEXT_CLIP_MARKER = '…（中间省略）…';

/** 上下文缺位时的显式标记：留空会让模板看到一段空白，模型只能靠猜。 */
export const CONTEXT_NONE = '（本次未携带对话上下文，请只按消息本身改写）';
export const CONTEXT_UNAVAILABLE = '（对话上下文不可用：这次没有读到会话记录，请只按消息本身改写）';
export const CONTEXT_FIRST_MESSAGE = '（无，本消息是本次对话的第一条消息）';

/** 空上下文结果：contextChars 只统计真实对话字符，占位标记不计入。 */
export function emptyContext(marker) {
	return { text: marker, chars: 0 };
}

/** 从消息形对象里提取文本（content 为字符串或 {type:'text'} 块数组）。 */
export function messageText(node) {
	const content = node?.content;
	if (typeof content === 'string') return content;
	if (Array.isArray(content)) {
		return content
			.filter((b) => b && b.type === 'text' && typeof b.text === 'string')
			.map((b) => b.text)
			.join('');
	}
	return '';
}

/** 有界深度优先收集会话事件里的 user/assistant 文本消息（防御式，不认识的结构一律跳过）。 */
export function collectDialogTexts(root, maxMessages) {
	const found = [];
	const seen = new Set();
	const visit = (node, depth) => {
		if (found.length >= maxMessages || depth > 6 || node === null || typeof node !== 'object') return;
		if (seen.has(node)) return;
		seen.add(node);
		if (Array.isArray(node)) {
			for (const item of node) visit(item, depth + 1);
			return;
		}
		const role = node.role;
		if ((role === 'user' || role === 'assistant') && !node.toolCallId && node.source?.kind !== 'tool') {
			const text = messageText(node).trim();
			if (text !== '') {
				found.push({ role, text });
				return;
			}
		}
		for (const key of Object.keys(node)) {
			if (key === 'parent' || key === 'root') continue;
			visit(node[key], depth + 1);
		}
	};
	visit(root, 0);
	return found;
}

/** 从 canonical surface 直接投影消息，排除 tool/result 与非消息生命周期事件。 */
export function collectSurfaceDialogTexts(events, maxMessages) {
	const found = [];
	for (const event of events) {
		if (found.length >= maxMessages) break;
		let message = null;
		if (event?.type === 'user/message') message = event.data;
		else if (event?.type === 'assistant/message') message = event.data?.message;
		if (message === null || message?.toolCallId || (message?.role !== 'user' && message?.role !== 'assistant')) continue;
		const text = messageText(message).trim();
		if (text !== '') found.push({ role: message.role, text });
	}
	return found;
}

/**
 * 消毒闭合标签：模板用 <对话上下文>…</对话上下文> 圈定证据边界，
 * 会话里出现的同名闭合标签必须转义，否则一条历史消息就能伪造边界。
 *
 * 必须容忍空白变体：`</对话上下文 >`、`</ 对话上下文>` 在模型眼里同样是
 * 闭合标签，只转义标准写法等于留了个口子。
 */
export function sanitizeContextText(text) {
	return text.replace(/<\s*\/\s*(对话上下文)\s*>/g, '<\\/$1>');
}

/** 单条消息截断为"头 + 标记 + 尾"，保证输出不超 limit。 */
export function clipContextMessage(text, limit = CONTEXT_MESSAGE_CLIP_CHARS) {
	if (text.length <= limit) return text;
	const head = Math.floor(limit * 0.6);
	const tail = Math.max(0, limit - head - CONTEXT_CLIP_MARKER.length);
	return `${text.slice(0, head)}${CONTEXT_CLIP_MARKER}${tail > 0 ? text.slice(-tail) : ''}`;
}

/**
 * 按字符预算组装上下文：预算不足时从最新一条往回装。
 *
 * 这里刻意不沿用「join 后 slice(0, N)」的写法——那会保住最旧的消息、丢掉
 * 最新的对话，而用户说「刚才 / 那个 / 上一条」时，最新的才是消歧依据。
 * 最新一条自身超预算时保留它的尾部（最近的措辞与结论），而不是整条丢弃。
 */
export function fitContextBudget(texts, maxChars) {
	const marker = '…（已截断）';
	// 截断标记本身也要占预算，否则输出会稳定超出 maxChars。
	const budget = Math.max(0, maxChars - marker.length);
	const full = texts.join('\n');
	if (full.length <= maxChars) return full;
	const parts = [];
	let used = 0;
	for (let index = texts.length - 1; index >= 0; index -= 1) {
		const piece = texts[index];
		const separator = parts.length === 0 ? 0 : 1;
		const remaining = budget - used - separator;
		if (remaining <= 0) break;
		if (piece.length <= remaining) {
			parts.unshift(piece);
			used += separator + piece.length;
			continue;
		}
		// 「[用户] / [助手]」标签是消歧依据：模板要求区分"用户已确认的事实"与
		// "助手自己过去的做法"，标签被切掉就会把助手的猜测当成用户确认搬进输出。
		// 截断只作用于正文，标签必须留在预算内。
		const label = /^\[(?:用户|助手)\]\s?/.exec(piece)?.[0] ?? '';
		const body = piece.slice(label.length);
		// 连标签都放不下时只能整条放弃：room 必须允许 <= 0 并在此退出。
		// 原实现写 `Math.max(0, ...)`，room=0 时 `body.slice(-0) === body.slice(0)`
		// 会把**整条超长正文**原样塞进上下文（实测 27 字预算 → 输出 527 字，
		// 约 20 倍超限），直接打破"输出不超预算"不变量。
		const room = remaining - label.length;
		if (room <= 0) break;
		parts.unshift(`${label}${body.slice(-room)}`);
		break;
	}
	const joined = parts.join('\n');
	// 预算比截断标记还小：宁可不加标记，也不能让输出超过 maxChars。
	if (marker.length >= maxChars) return joined.slice(0, Math.max(0, maxChars));
	return `${joined}${marker}`;
}

/**
 * 上下文类模板的会话背景：读当前会话最近对话（best-effort）。
 * 读不到时返回显式占位标记（不是空串），并让 contextChars 保持 0，
 * 客户端据此提示"本次没带上下文"。
 *
 * @param {object} ctx - Host plugin context.
 * @param {string} sessionId - 当前会话 id（空则不带上下文）。
 * @param {object} cfg - 已归一化的配置。
 * @param {AbortSignal} signal - 本次请求的 deadline 信号。
 */
export async function gatherContext(ctx, sessionId, cfg, signal) {
	if (!sessionId || cfg.contextMaxMessages <= 0 || cfg.contextMaxChars <= 0) return emptyContext(CONTEXT_NONE);
	const sessionQuery = ctx.get('sessionQuery');
	const readSurface = typeof sessionQuery?.readSurface === 'function';
	if (!readSurface && typeof sessionQuery?.readSession !== 'function') return emptyContext(CONTEXT_UNAVAILABLE);
	try {
		if (signal?.aborted) throw abortReason(signal);
		// Prefer the canonical folded surface: readSession() is a raw log and can
		// still contain messages shadowed by compaction/replacement. Both current
		// DSH readers are non-cancellable, so withAbort bounds this plugin's wait.
		const pending = readSurface
			? sessionQuery.readSurface(sessionId)
			: sessionQuery.readSession(sessionId);
		const snap = await withAbort(pending, signal);
		// 只取尾部事件：消息事件按时间序排列，要最后 contextMaxMessages 条对话，
		// 读尾部 80 个事件足够，避免超长会话每次优化都全量深遍历。
		const events = snap?.events ?? [];
		const tail = events.length > EVENT_TAIL_WINDOW ? events.slice(-EVENT_TAIL_WINDOW) : events;
		// 先收满整个事件尾窗，再取末尾 contextMaxMessages 条。
		// 不能按「凑够 N 条就停」来收：事件按正序投影时，提前收手拿到的是尾窗里
		// 最靠前的 N 条（旧消息），最新几轮对话反而被丢掉。尾窗已限制在
		// EVENT_TAIL_WINDOW 个事件内，整窗投影成本可控。
		const collected = readSurface
			? collectSurfaceDialogTexts(tail, DIALOG_COLLECT_CAP)
			: collectDialogTexts(tail, DIALOG_COLLECT_CAP);
		// 单条上限跟着预算走：固定 2000 时，12 条 × 2000 = 24000 字潜在输入，
		// 对默认 4000 字预算是 6 倍，几乎每次调用都会走有损截断。让单条最多占
		// 预算的三分之一，条数与预算才在同一个量级。
		const perMessageLimit = Math.max(200, Math.min(CONTEXT_MESSAGE_CLIP_CHARS, Math.floor(cfg.contextMaxChars / 3)));
		const texts = collected
			.slice(-cfg.contextMaxMessages)
			.map(({ role, text }) => {
				const clipped = clipContextMessage(text, perMessageLimit);
				return `[${role === 'user' ? '用户' : '助手'}] ${sanitizeContextText(clipped)}`;
			});
		if (texts.length === 0) return emptyContext(CONTEXT_FIRST_MESSAGE);
		const joined = fitContextBudget(texts, cfg.contextMaxChars);
		return { text: joined, chars: joined.length };
	} catch (error) {
		// 会话读取失败是 best-effort；但取消/超时必须穿透，否则 handler 会在
		// 上下文读取完成后仍启动模型调用。
		if (signal?.aborted || error?.name === 'AbortError' || error?.code === 'canceled' || error?.code === 'timeout') throw error;
		return emptyContext(CONTEXT_UNAVAILABLE);
	}
}
