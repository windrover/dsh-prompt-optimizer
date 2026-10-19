// 纯 CPU 基准：只测与本插件逻辑相关的热点，不碰网络与宿主。
//
// 目的：证明"压缩代码量 / 加适配层"没有带来性能退化。同一份脚本分别在
// 重构前（git worktree 在 de4610a）和当前工作树上跑，比较 ns/op。
//
// 用法：
//   node test/bench.mjs                       # 当前工作树
//   node test/bench.mjs --root /tmp/dpo-base   # 指定另一棵树
//   node test/bench.mjs --rounds 7 --iters 20000
//
// 退出码恒为 0：基准不是断言，避免机器抖动让 CI 变红；结论由人读表得出。
import { pathToFileURL } from 'node:url';
import path from 'node:path';

const arg = (name, fallback) => {
	const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
	return hit === undefined ? fallback : hit.slice(name.length + 3);
};
const ROOT = path.resolve(arg('root', path.join(import.meta.dirname ?? new URL('.', import.meta.url).pathname, '..')));
const ITERS = Number(arg('iters', 20000));
const ROUNDS = Number(arg('rounds', 5));

const load = (rel) => import(pathToFileURL(path.join(ROOT, rel)).href);
const { validateOptimizedOutput } = await load('lib/validate.js');
const { fitContextBudget } = await load('lib/host/context.js');
const { stripCodeFence } = await load('lib/host/llm.js');

// ---- 固定输入（与真实请求同量级） ----------------------------------------
const template = {
	id: 'user-task-optimize',
	name: '任务指令优化',
	desc: 'bench',
	category: 'basic',
	content: '你是提示词优化器。',
};
const draft = '# 优化一下这个脚本\n\n帮我把 /Users/me/proj 下的 build.js 改成支持增量构建，别动现有 API，报错要能定位到行号。';
const output = [
	'## 目标',
	'把 build.js 改为支持增量构建。',
	'',
	'## 约束',
	'- 不改动现有公开 API',
	'- 报错信息需包含文件与行号',
	'',
	'## 完成标准',
	'- 第二次构建只重编变更文件',
	'- 现有测试全部通过',
].join('\n');
const messages = Array.from({ length: 12 }, (_, i) =>
	`[${i % 2 === 0 ? '用户' : '助手'}] ${'这是一条用于基准的上下文消息，包含一些中英混排内容 and some english words. '.repeat(8)}`);

// ---- 计时 ------------------------------------------------------------------
const time = (fn) => {
	const t0 = process.hrtime.bigint();
	fn();
	return Number(process.hrtime.bigint() - t0);
};

const cases = [
	['validateOptimizedOutput', () => validateOptimizedOutput({ template, draft, output })],
	['fitContextBudget (12 msgs)', () => fitContextBudget(messages, 4000)],
	['stripCodeFence (fenced)', () => stripCodeFence('```markdown\n' + output + '\n```')],
];

console.log(`root: ${ROOT}`);
console.log(`iters/round: ${ITERS}, rounds: ${ROUNDS} (median reported)\n`);
console.log('case'.padEnd(30) + 'median ns/op'.padStart(14) + 'ops/s'.padStart(14));

for (const [name, fn] of cases) {
	// warmup：让 JIT 完成内联，避免把编译时间摊进结果。
	for (let i = 0; i < Math.min(2000, ITERS); i += 1) fn();
	const samples = [];
	for (let r = 0; r < ROUNDS; r += 1) samples.push(time(() => { for (let i = 0; i < ITERS; i += 1) fn(); }) / ITERS);
	samples.sort((a, b) => a - b);
	const median = samples[Math.floor(samples.length / 2)];
	console.log(name.padEnd(30) + median.toFixed(1).padStart(14) + Math.round(1e9 / median).toLocaleString('en-US').padStart(14));
}
