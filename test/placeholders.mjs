// 模板变量契约的单元测试：把"哪些 {{…}} 会被替换、怎么替换"钉死。
//
// 为什么值得单独测：模板正文是纯文本，写错一个占位符不会报错，只会让模型收到
// 一段没渲染的 `{{…}}` 或一段被二次替换坏掉的 JSON——两者都只在真实调用时才暴露。
// 这些用例不依赖模型、不依赖宿主，可进 CI。
import { PLACEHOLDER_NAMES, renderVars } from '../lib/host/placeholders.js';

let failures = 0;
function check(name, actual, expected) {
	if (actual === expected) {
		console.log(`✔ ${name}`);
		return;
	}
	failures += 1;
	console.error(`✗ ${name}\n    expected: ${JSON.stringify(expected)}\n    actual  : ${JSON.stringify(actual)}`);
}

const vars = { originalPrompt: '把这段改成任务书', context: '[用户] 刚才说的那个' };

// 1) 三种受支持的占位符
check('originalPrompt → 原文',
	renderVars('A{{originalPrompt}}B', vars), 'A把这段改成任务书B');
check('对话上下文 → 上下文',
	renderVars('A{{对话上下文}}B', vars), 'A[用户] 刚才说的那个B');

// 2) json 变体必须产出合法 JSON 字符串（引号/换行/反斜杠都要转义）
const nasty = '他说"这样"\n然后 C:\\path\\x';
const jsonRendered = renderVars('[{{json:originalPrompt}}]', { originalPrompt: nasty, context: '' });
check('json:originalPrompt → 合法 JSON',
	JSON.stringify(JSON.parse(jsonRendered)), JSON.stringify([nasty]));

// 3) 白名单之外一律原样保留（模板里大量输出格式示例依赖这一点）
for (const kept of ['{{placeholder}}', '{{variable_name}}', '{{subject}}', '{{include:ctx-core}}', '{{...}}']) {
	check(`保留 ${kept}`, renderVars(`x ${kept} y`, vars), `x ${kept} y`);
}

// 4) 单次扫描：用户内容里含占位符也不能被二次替换
check('单次扫描（不重入）',
	renderVars('A{{originalPrompt}}B', { originalPrompt: 'X{{对话上下文}}Y', context: 'CTX' }),
	'AX{{对话上下文}}YB');
check('单次扫描（json 变体不破转义）',
	renderVars('{{json:originalPrompt}}', { originalPrompt: '{{json:originalPrompt}}', context: '' }),
	'"{{json:originalPrompt}}"');

// 5) 没有占位符就是恒等
const plain = '# Role: 例子\n用 {{subject}} 当例子';
check('无占位符恒等', renderVars(plain, vars), plain);

// 6) 契约一致性：PLACEHOLDER_NAMES 里的每个名字都必须真的被替换
for (const name of PLACEHOLDER_NAMES) {
	const rendered = renderVars(`{{${name}}}`, vars);
	if (rendered === `{{${name}}}`) {
		failures += 1;
		console.error(`✗ 契约不一致：${name} 声明了但未被替换`);
	}
}
console.log(`契约一致性：${PLACEHOLDER_NAMES.length} 个占位符均已接线`);

// 7) 空上下文 → 空串（占位语义由调用方决定，不在渲染层臆造文案）
check('空上下文渲染为空串', renderVars('[{{对话上下文}}]', { originalPrompt: 'x', context: '' }), '[]');

if (failures > 0) {
	console.error(`\nplaceholders: ${failures} 个用例失败`);
	process.exit(1);
}
console.log('\n全部通过 ✅ placeholders');
