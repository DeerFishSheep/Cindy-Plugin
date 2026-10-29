// 抓一份真实数据给 dev/preview.html 用（不安装插件也能验证面板渲染）。
// 生成 dev/sample.js；Cookie 不写入文件。
//
//   node dev/capture.mjs
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const child = spawn(process.execPath, [join(root, 'node/worker.cjs')], {
  cwd: root,
  env: { ...process.env, A6API_DATA_DIR: '/tmp/cindy-a6api-picker-test' },
  stdio: ['pipe', 'pipe', 'pipe']
});
const lines = createInterface({ input: child.stdout });
const waiters = new Map();
let seq = 0;

child.stderr.on('data', (buf) => {
  const text = String(buf).trim();
  if (text) console.error('[worker]', text);
});

lines.on('line', (line) => {
  let msg;
  try { msg = JSON.parse(line); } catch { return; }
  const job = waiters.get(msg.id);
  if (!job) return;
  waiters.delete(msg.id);
  clearTimeout(job.timer);
  if (msg.error) job.reject(new Error(msg.error.message));
  else job.resolve(msg.result);
});

function rpc(method, params = {}, cindy) {
  const id = ++seq;
  const payload = { jsonrpc: '2.0', id, method, params };
  if (cindy) payload.cindy = cindy;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(id); reject(new Error(method + ' timeout')); }, 120000);
    waiters.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify(payload) + '\n');
  });
}

const FILTERS = {
  brand: 'DeepSeek',
  model: 'deepseek-v4.1-flash',
  minCache: 80,
  minSr: 95,
  maxRatio: 0.1,
  minSample: undefined,
  maxTtft: 8,
  minTps: undefined,
  onlyQualified: true,
  guaranteed: false
};

async function main() {
  const pub = await rpc('search/run', FILTERS);
  console.log('public:', pub.total, 'fetched,', pub.kept, 'kept,', (pub.ranking || []).length, 'ranked');

  let auth = null;
  let balance = null;
  let pinned = null;
  let tokens = [];
  let userId = null;

  try {
    const imp = await rpc('session/import', {});
    if (imp.ok) {
      userId = imp.userId;
      tokens = imp.tokens;
      const cindy = { secrets: { a6api_cookie: imp.cookie } };
      auth = await rpc('search/run', { ...FILTERS, userId }, cindy);
      balance = await rpc('balance/get', { userId }, cindy);
      if (tokens.length) {
        pinned = await rpc('pin/current', { model: FILTERS.model, tokenId: tokens[0].id, userId }, cindy);
      }
      console.log('auth:', auth.total, 'fetched,', auth.kept, 'kept, scope', auth.scope);
    }
  } catch (err) {
    console.error('auth capture skipped:', err.message);
  }

  const sample = {
    capturedAt: new Date().toISOString(),
    filters: FILTERS,
    userId,
    tokens,
    public: pub,
    auth,
    balance: balance && balance.ok ? balance.balance : null,
    pinned: pinned && pinned.ok ? pinned.pinned : null
  };
  const target = join(root, 'dev/sample.js');
  writeFileSync(target, 'window.__A6API_SAMPLE__ = ' + JSON.stringify(sample, null, 2) + ';\n');
  console.log('wrote', target);

  // 用 panel.html 本身生成预览页，避免维护两份标记。
  const panel = readFileSync(join(root, 'panel.html'), 'utf8');
  const preview = panel
    .replace('href="panel.css"', 'href="../panel.css"')
    .replace(
      '<script src="bridge.js"></script>',
      '<script src="sample.js"></script>\n<script src="test-bridge.js"></script>\n<script src="../bridge.js"></script>'
    )
    .replace('<script src="panel.js"></script>', '<script src="../panel.js"></script>')
    .replace(
      '</head>',
      '<style>html,body{height:100%}body{max-width:460px;margin:0 auto;border-left:1px solid rgba(127,127,127,.2);border-right:1px solid rgba(127,127,127,.2)}#devnote{position:fixed;left:8px;bottom:8px;z-index:99;padding:3px 6px;border-radius:5px;background:rgba(0,0,0,.55);color:#fff;font:10px/1.3 ui-monospace,monospace;opacity:.75}</style></head>'
    )
    .replace('<body>', '<body>\n<div id="devnote">dev preview · real captured data</div>');
  writeFileSync(join(root, 'dev/preview.html'), preview);
  console.log('wrote', join(root, 'dev/preview.html'));
}

main()
  .then(() => { child.stdin.end(); setTimeout(() => process.exit(0), 200); })
  .catch((err) => { console.error('FAILED:', err.message); child.kill(); process.exit(1); });
