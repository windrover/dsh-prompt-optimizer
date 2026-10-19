/**
 * 模板变量词汇表（本插件自有语义）。
 *
 * 这是"模板引擎契约"的唯一出处：模板里能写哪些 `{{…}}`、每个什么意思，都在这里，
 * 不跟随任何上游项目的约定。`llm.js` 只调用 `renderVars`，不再自己维护替换表。
 *
 * 支持三种（其余 `{{…}}` 一律原样保留——多为输出格式示例，如 `{{placeholder}}`）：
 *
 *   {{originalPrompt}}       原提示词，原文插入
 *   {{json:originalPrompt}}  原提示词，JSON 字符串编码后插入（用于嵌进 JSON 骨架）
 *   {{对话上下文}}            本次携带的会话上下文（可能是占位标记或空串）
 *
 * 两条硬约束：
 *   1. **单次扫描**替换：用户内容里若含 `{{…}}`，绝不能被二次替换——否则会破坏
 *      JSON 转义，甚至把一个字段的内容注入另一个字段。
 *   2. **白名单**：未列出的 `{{…}}` 原样保留，不做任何"猜测式"替换。
 */

/** 支持的占位符名（顺序即正则里的优先级：长的在前，避免前缀误匹配）。 */
export const PLACEHOLDER_NAMES = Object.freeze(['json:originalPrompt', 'originalPrompt', '对话上下文']);

/** 每个占位符 → 取值函数。新增占位符只需在这里加一行并进 PLACEHOLDER_NAMES。 */
const RENDER = {
	originalPrompt: (vars) => vars.originalPrompt,
	'json:originalPrompt': (vars) => JSON.stringify(vars.originalPrompt),
	'对话上下文': (vars) => vars.context,
};

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 一次扫描完毕的替换正则（由 PLACEHOLDER_NAMES 生成，杜绝"表与正则不同步"）。 */
const PLACEHOLDER_PATTERN = new RegExp(
	`\\{\\{(${[...PLACEHOLDER_NAMES].sort((a, b) => b.length - a.length).map(escapeRegExp).join('|')})\\}\\}`,
	'g',
);

/**
 * 渲染模板变量。
 * @param {string} text - 模板正文。
 * @param {{originalPrompt: string, context: string}} vars - 变量取值。
 * @returns {string} 渲染结果；未识别的 `{{…}}` 原样保留。
 */
export function renderVars(text, vars) {
	return text.replace(PLACEHOLDER_PATTERN, (_match, key) => RENDER[key](vars));
}
