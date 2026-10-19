#!/usr/bin/env node
// 上游文本审计：用逐字重合率回答"这段文字是不是抄自上游"。
//
// 为什么需要它：`upstream-inventory.mjs` 只能按文件名维护台账，回答不了
// "`_shared/*.md` 的段落是不是上游文本"。本脚本把两份文本去掉空白后按 24 字符
// 窗口滑动比对，输出重合率——比人工逐段读更可复核。
//
// 判读（含对照组校准）：
//   ≥ 50%   逐字来自上游
//   15–50%  部分重合，需人工判读
//   < 15%   未发现上游文本
//
// 校准：脚本末尾会打印上游文件自匹配率（应 ≈100%）。若它掉下来，说明比对方法
// 失效，此时任何"未发现上游文本"都不可信。
//
// 用法：node scripts/upstream-audit.mjs
//   网络失败时退出码 1（审计结果不可用，不静默通过）。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const REF = 'develop';
const BASE = `https://raw.githubusercontent.com/linshenkx/prompt-optimizer/${REF}/packages/core/src/services/template/default-templates/optimize`;
const FILES = [
	'analytical-optimize.ts',
	'general-optimize.ts',
	'output-format-optimize.ts',
	'soul-openclaw-compose.ts',
	'context/context-analytical-optimize.ts',
	'context/context-message-optimize.ts',
	'context/context-output-format-optimize.ts',
];

const WINDOW = 24;
const STEP = 8;
const strip = (s) => s.replace(/\s+/g, '');

async function fetchText(url) {
	const res = await fetch(url, { signal: AbortSignal.timeout(15000) });
	if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
	return res.text();
}

const parts = [];
try {
	for (const file of FILES) parts.push(await fetchText(`${BASE}/${file}`));
} catch (error) {
	console.error(`✗ 无法获取上游源文件，审计未执行（不是"没有依赖"）：${error.message}`);
	console.error('  检查网络/代理后重试；未联网时请勿引用任何重合率数字。');
	process.exit(1);
}
const upstream = strip(parts.join('\n'));

/** 滑动窗口重合率：text 里有多少 24 字符片段（去空白后）逐字出现在上游。 */
function overlap(text) {
	const t = strip(text);
	if (t.length < WINDOW) return 0;
	let total = 0;
	let hit = 0;
	for (let i = 0; i + WINDOW <= t.length; i += STEP) {
		total += 1;
		if (upstream.includes(t.slice(i, i + WINDOW))) hit += 1;
	}
	return hit / total;
}

const verdictOf = (r) => (r >= 0.5 ? '上游文本' : r >= 0.15 ? '部分重合（需人工判读）' : '未发现上游文本');

const rows = [];
const dirs = [
	{ dir: path.join(ROOT, 'templates'), label: 'templates/' },
	{ dir: path.join(ROOT, 'templates', '_shared'), label: 'templates/_shared/' },
];
for (const { dir, label } of dirs) {
	for (const name of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
		const r = overlap(fs.readFileSync(path.join(dir, name), 'utf8'));
		rows.push({ name: label + name, ratio: r, verdict: verdictOf(r) });
	}
}

rows.sort((a, b) => b.ratio - a.ratio);
console.log('file'.padEnd(46) + 'overlap'.padStart(9) + '   verdict');
for (const r of rows) {
	console.log(r.name.padEnd(46) + (r.ratio * 100).toFixed(1).padStart(8) + '%   ' + r.verdict);
}

// 校准：上游文本自匹配必须接近 100%，否则上面的"未发现"都不可信。
const self = overlap(parts[0]);
console.log(`\ncalibration: 上游 ${FILES[0]} 自匹配 ${(self * 100).toFixed(1)}% （应 ≈100%，否则比对失效）`);
if (self < 0.95) {
	console.error('✗ 校准失败：比对方法未生效，本次审计结果不可用');
	process.exit(1);
}

const upstreamCount = rows.filter((r) => r.ratio >= 0.5).length;
console.log(`\n结论：${rows.length} 个文件里 ${upstreamCount} 个逐字来自上游`);
