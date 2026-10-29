// 打包前的静态自检。Cindy Forge 不可用时，至少把文档里写明的硬约束逐条过一遍。
//   node dev/validate.mjs
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const errors = [];
const notes = [];

function check(ok, message) {
  if (!ok) errors.push(message);
  else notes.push('ok  ' + message);
}

function readJson(rel) {
  return JSON.parse(readFileSync(join(root, rel), 'utf8'));
}

const m = readJson('ghost.json');

check(/^[a-z0-9][a-z0-9-]{0,31}$/.test(m.id), 'ghost.json id 合法');
check(/^\d+\.\d+\.\d+$/.test(m.version), 'version 是 SemVer');
check(/^\d+\.\d+\.\d+$/.test(String(m.minCindyVersion || '')), 'minCindyVersion 是 SemVer');
check(typeof m.name === 'string' && m.name.length > 0, 'name 非空');
check(typeof m.description === 'string' && m.description.length >= 1 && m.description.length <= 300, 'description 1–300');
check(typeof m.whenToUse === 'string' && m.whenToUse.length >= 1 && m.whenToUse.length <= 300, 'whenToUse 1–300');
check(typeof m.command === 'string' && m.command.length > 0, 'command 非空');

const entryFiles = [m.entry, m.panel && m.panel.html, m.settingsHtml, m.icon, m.node && m.node.entry].filter(Boolean);
for (const rel of entryFiles) check(existsSync(join(root, rel)), '文件存在：' + rel);

check(m.panel && ['left', 'right', 'top', 'bottom', 'tab'].includes(m.panel.position), 'panel.position 合法');
check(m.panel.position !== 'tab' || (m.panel.minWidth === undefined && m.panel.defaultFraction === undefined), 'tab 形态没有宽度声明');
check(typeof m.fs === 'boolean', 'fs 是布尔值');

// node
const node = m.node || {};
check(node.protocol === 'json-rpc-stdio' || node.protocol === 'mcp-stdio', 'node.protocol 合法');
check(['on-demand', 'resident'].includes(node.lifecycle), 'node.lifecycle 合法');
if (node.idleTimeoutSeconds !== undefined) {
  check(node.idleTimeoutSeconds >= 30 && node.idleTimeoutSeconds <= 3600, 'idleTimeoutSeconds 30–3600');
}
check(/\.(c?js)$/.test(node.entry || ''), 'node.entry 是 .js/.cjs');

const bindings = node.secretBindings || [];
check(bindings.length >= 1 && bindings.length <= 4, 'secretBindings 1–4 条');
for (const b of bindings) {
  check(/^[a-z][a-z0-9_]{0,31}$/.test(b.key || ''), 'binding key 合法：' + b.key);
  check(typeof b.label === 'string' && b.label.length >= 1 && b.label.length <= 64, 'binding label 1–64：' + b.key);
  check(Array.isArray(b.methods) && b.methods.length >= 1 && b.methods.length <= 16, 'binding methods 1–16：' + b.key);
  for (const method of b.methods || []) check(/^[A-Za-z0-9_./:-]{1,128}$/.test(method), 'method 名合法：' + method);
  if (b.hint !== undefined) check(b.hint.length <= 200, 'binding hint ≤200：' + b.key);
  if (b.url !== undefined) {
    let u;
    try { u = new URL(b.url); } catch { u = null; }
    check(u && u.protocol === 'https:' && !u.username && !u.password, 'binding url 是 https：' + b.key);
  }
}
check(Boolean(m.settingsHtml), 'secretBindings 有 settingsHtml');

// tools
for (const tool of m.tools || []) {
  check(/^[a-z][a-z0-9_]*$/.test(tool.name || ''), 'tool 名合法：' + tool.name);
  check(typeof tool.description === 'string' && tool.description.length > 0, 'tool 有 description：' + tool.name);
  check(tool.parameters && tool.parameters.type === 'object', 'tool 参数是 object：' + tool.name);
}

// 页面：外挂脚本 / 样式都在包里；没有内联 script。
function checkHtml(rel) {
  const html = readFileSync(join(root, rel), 'utf8');
  check(!/<script(?![^>]*\bsrc=)[^>]*>/i.test(html), rel + ' 没有内联 script');
  for (const match of html.matchAll(/(?:src|href)="([^"]+)"/g)) {
    const ref = match[1];
    if (/^(https?:|cindy-ghost:|#|data:)/.test(ref)) continue;
    const target = join(dirname(join(root, rel)), ref);
    check(existsSync(target), rel + ' 引用存在：' + ref);
  }
}
checkHtml('panel.html');
checkHtml('settings.html');

// 代码红线（我们自己的文件）。
const ownCode = ['main.js', 'bridge.js', 'panel.js', 'settings.js', 'node/worker.cjs'];
for (const rel of ownCode) {
  const text = readFileSync(join(root, rel), 'utf8');
  check(!text.includes("join(homedir(), '.dsh')"), rel + ' 不写 ~/.dsh');
  if (rel === 'node/worker.cjs') {
    check(!text.includes('process.execPath'), rel + ' 不使用 process.execPath');
    check(!text.includes('child_process.fork'), rel + ' 不使用 fork');
    const coreText = readFileSync(join(root, 'node/core.mjs'), 'utf8');
    check(coreText.includes("pexec('curl'"), 'core.mjs 通过 curl 抓取');
  }
}

// 包大小 / 文件数。
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.git') continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (!name.endsWith('.cindy')) out.push(p);
  }
  return out;
}
const files = walk(root);
const total = files.reduce((sum, f) => sum + statSync(f).size, 0);
check(files.length <= 2048, '文件数 ≤2048（' + files.length + '）');
check(total <= 256 * 1024 * 1024, '解压后 ≤256MB（' + total + ' 字节）');

console.log(notes.join('\n'));
if (errors.length) {
  console.error('\nFAILED:\n- ' + errors.join('\n- '));
  process.exit(1);
}
console.log('\n全部静态约束通过。文件清单：');
for (const f of files) console.log('  ' + relative(root, f));
