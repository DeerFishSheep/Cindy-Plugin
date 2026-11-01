#!/usr/bin/env node
/**
 * i-have-adhd — Node 工作进程
 *
 * Cindy 没有插件级 systemPrompt 注入点，但宿主会把 ~/.pi/agent/AGENTS.md
 * 作为真·全局上下文注入每一轮会话。本 worker 充当那个文件的托管写入端：
 * 把自己的一段规则用标记包好写进去 / 抽出来，不动用户的其它内容。
 *
 * 插件根目录由 __dirname 反推，不依赖外面传参。
 * 只经 JSON-RPC stdio 与 main.js 通信；stdout 只写协议行，日志写 stderr。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');

const PLUGIN_ROOT = path.resolve(__dirname, '..');
const RULES_FILE = path.join(__dirname, 'rules.md');

const BEGIN = '<!-- i-have-adhd:begin (managed by the i-have-adhd plugin) -->';
const END = '<!-- i-have-adhd:end -->';

function contextHome() {
  const fromEnv = process.env.PI_CODING_AGENT_DIR;
  if (fromEnv) return path.resolve(fromEnv.replace(/^~(?=$|[\\/])/, () => os.homedir()));
  return path.join(os.homedir(), '.pi', 'agent');
}

function contextFile() {
  return path.join(contextHome(), 'AGENTS.md');
}

function readRules() {
  return fs.readFileSync(RULES_FILE, 'utf8').replace(/\s+$/, '');
}

function readCurrent() {
  try {
    return fs.readFileSync(contextFile(), 'utf8');
  } catch (error) {
    if (error.code === 'ENOENT') return null;
    throw error;
  }
}

function hasBlock(text) {
  const b = text.indexOf(BEGIN);
  return b !== -1 && text.indexOf(END, b) !== -1;
}

/** 剥掉受管段（含标记，含前导分隔空行），其余内容逐字节保留 */
function stripBlock(text) {
  const b = text.indexOf(BEGIN);
  if (b === -1) return text;
  const e = text.indexOf(END, b);
  if (e === -1) return text.slice(0, b).replace(/\n+$/, '');
  let head = text.slice(0, b);
  const tail = text.slice(e + END.length);
  // 去掉我们 enable 时加在前面的分隔空行，避免累计空行
  head = head.replace(/\n+$/, '');
  // 去掉我们 enable 时加在后面的收尾换行
  const rest = head + (tail.startsWith('\n') ? tail.slice(1) : tail);
  return rest;
}

function buildBlock(rules) {
  return `${BEGIN}\n${rules}\n${END}`;
}

function status() {
  const current = readCurrent();
  return {
    enabled: current !== null && hasBlock(current),
    file: contextFile(),
    exists: current !== null,
    fileBytes: current === null ? 0 : Buffer.byteLength(current, 'utf8'),
    rulesBytes: Buffer.byteLength(readRules(), 'utf8'),
    pluginRoot: PLUGIN_ROOT,
  };
}

function enable() {
  const file = contextFile();
  const current = readCurrent() || '';
  const base = stripBlock(current);
  const next = base === '' ? `${buildBlock(readRules())}\n` : `${base}\n\n${buildBlock(readRules())}\n`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next, { encoding: 'utf8', mode: 0o600 });
  return { ...status(), changed: next !== current, action: 'enabled' };
}

function disable() {
  const file = contextFile();
  const current = readCurrent();
  if (current === null || !hasBlock(current)) {
    return { ...status(), changed: false, action: 'noop' };
  }
  const next = stripBlock(current);
  if (next.trim() === '') {
    fs.rmSync(file, { force: true });
  } else {
    // 原文件末尾没有换行时保持原样，做到逐字节还原
    fs.writeFileSync(file, next, { encoding: 'utf8', mode: 0o600 });
  }
  return { ...status(), changed: true, action: 'disabled' };
}

const handlers = {
  'adhd/probe': () => status(),
  'adhd/status': () => status(),
  'adhd/enable': () => enable(),
  'adhd/disable': () => disable(),
};

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

readline
  .createInterface({ input: process.stdin })
  .on('line', (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let request;
    try {
      request = JSON.parse(trimmed);
    } catch {
      process.stderr.write('i-have-adhd: bad JSON line\n');
      return;
    }
    const handler = handlers[request.method];
    if (!handler) {
      reply({ jsonrpc: '2.0', id: request.id, error: { code: -32601, message: 'Method not found' } });
      return;
    }
    try {
      reply({ jsonrpc: '2.0', id: request.id, result: handler() });
    } catch (error) {
      reply({
        jsonrpc: '2.0',
        id: request.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
    }
  })
  .on('close', () => process.exit(0));
