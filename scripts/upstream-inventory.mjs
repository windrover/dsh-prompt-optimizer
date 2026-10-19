#!/usr/bin/env node
// 上游依赖台账：把"还依赖 linshenkx/prompt-optimizer 哪些模板"变成可测量的数字。
//
// 本插件**没有**任何上游代码依赖（无 import、无 npm 依赖）；依赖面是模板文本。
// 这里维护"仍源自上游"的模板清单，替换一个就从清单里删一行，脚本报出的比例随之下降。
//
// 用法：node scripts/upstream-inventory.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const TEMPLATES = path.join(ROOT, 'templates');

/**
 * 归属判据：看**正文**。正文仍与上游逐段对应才计入；重写后即使 id / 用途相同也不再计入。
 * 仍源自上游的模板：本插件文件名 → 上游文件（相对
 * packages/core/src/services/template/default-templates/）。
 * 逐条替换后从本表删除，比例即下降。
 */
const STILL_UPSTREAM = {
	'analytical-optimize.md': 'optimize/analytical-optimize.ts',
	'context-analytical-optimize.md': 'optimize/context/context-analytical-optimize.ts',
	'context-message-optimize.md': 'optimize/context/context-message-optimize.ts',
	'context-output-format-optimize.md': 'optimize/context/context-output-format-optimize.ts',
	'general-optimize.md': 'optimize/general-optimize.ts',
	'output-format-optimize.md': 'optimize/output-format-optimize.ts',
	'soul-openclaw-compose.md': 'optimize/soul-openclaw-compose.ts',
};

const files = fs.readdirSync(TEMPLATES).filter((f) => f.endsWith('.md')).sort();
const upstream = files.filter((f) => Object.hasOwn(STILL_UPSTREAM, f));
const local = files.filter((f) => !Object.hasOwn(STILL_UPSTREAM, f));
const pct = ((upstream.length / files.length) * 100).toFixed(1);

console.log(`模板总数: ${files.length}`);
console.log(`仍源自上游: ${upstream.length} (${pct}%)`);
console.log(`本地原创  : ${local.length} (${local.join(', ')})\n`);
for (const file of upstream) console.log(`  上游  ${file.padEnd(34)} ← ${STILL_UPSTREAM[file]}`);

// 台账必须覆盖真实存在的文件，否则替换后忘了删行会让数字虚高。
const stale = Object.keys(STILL_UPSTREAM).filter((f) => !files.includes(f));
if (stale.length > 0) {
	console.error(`\n✗ 台账里的文件已不存在（替换后请删除对应行）：${stale.join(', ')}`);
	process.exit(1);
}
