// 分层约束检查：让"边界"成为可执行的断言，而不是注释里的约定。
//
// 为什么需要它：DSH 升级时最怕的不是改一处，而是改动扩散到每个文件。
// 下面三条规则一旦被破坏，适配层的价值就没了，所以放进 npm test。
//
//   1. 宿主 API 只允许出现在 lib/host/dsh.js
//   2. 依赖只向下：任何模块不得 import lib/index.js；config/http 不得依赖兄弟模块
//   3. 客户端宿主的 props 字段只在客户端适配层（⑨）读写
//
// 纯文本扫描，不执行插件代码。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const fail = [];

/**
 * 规则 1：宿主 API 只能出现在适配层。
 * 用足够具体的记号，避免把注释里提到的名词也算进去（匹配调用/访问形态）。
 */
const HOST_API = [/ctx\.get\s*\(/, /ctx\.webServer/, /ctx\.inject\s*\(/, /ctx\.logger/, /ctx\.fiber/];
const HOST_FILES = ['lib/index.js', 'lib/host/config.js', 'lib/host/http.js', 'lib/host/context.js', 'lib/host/llm.js'];
for (const file of HOST_FILES) {
	const src = read(file);
	for (const pattern of HOST_API) {
		if (pattern.test(src)) fail.push(`规则1: ${file} 直接访问宿主 API（${pattern}）—— 应改为经 host/dsh.js`);
	}
}

/** 规则 2：依赖方向。 */
const FORBIDDEN_IMPORTS = {
	'lib/index.js': [],                        // 装配层不 import 自己
	'lib/host/config.js': ['./llm.js', './context.js', './dsh.js'],
	'lib/host/http.js': ['./llm.js', './context.js', './config.js', './dsh.js'],
	'lib/host/context.js': ['./llm.js', './config.js'],
	'lib/host/llm.js': ['./context.js'],
	'lib/host/dsh.js': ['./llm.js', './context.js', './config.js'],
};
for (const [file, forbidden] of Object.entries(FORBIDDEN_IMPORTS)) {
	const src = read(file);
	const imports = [...src.matchAll(/from\s+'([^']+)'/g)].map((m) => m[1]);
	for (const spec of imports) {
		if (spec.endsWith('index.js')) fail.push(`规则2: ${file} 依赖了 ./index.js（向上依赖）`);
		if (forbidden.includes(spec)) fail.push(`规则2: ${file} 依赖了 ${spec}，违反分层方向`);
	}
}

/**
 * 规则 3：客户端宿主 props 字段只允许在适配层（⑨ 之后）出现。
 * 组件的渲染体不应出现 props.useInput / props.inputActions。
 */
const client = read('lib/client.js');
const adapterBanner = client.indexOf('─── ⑨ DSH 客户端适配层');
if (adapterBanner === -1) {
	fail.push('规则3: lib/client.js 找不到客户端适配层分区（⑨），无法判定边界');
} else {
	for (const token of ['props.useInput', 'props.inputActions']) {
		let at = client.indexOf(token);
		while (at !== -1) {
			if (at < adapterBanner) {
				const line = client.slice(0, at).split('\n').length;
				fail.push(`规则3: lib/client.js:${line} 直接使用 ${token} —— 应改为调用适配层的 useDraftInput/writeDraftTo`);
			}
			at = client.indexOf(token, at + 1);
		}
	}
}

if (fail.length > 0) {
	for (const message of fail) console.error('✗', message);
	process.exit(1);
}
console.log('layering ok: 宿主 API 仅限 host/dsh.js；依赖只向下；客户端宿主字段仅限适配层');
