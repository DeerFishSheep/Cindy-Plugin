// 本地实测：直接起 node/worker.cjs，按宿主的方式发 JSON-RPC。
// 这一步验证的是 worker + core + curl + 浏览器登录同步，不依赖 Cindy 安装。
//
//   node dev/probe-worker.mjs
//
// 输出的 Cookie 永远不打印；登录同步只打印来源、用户 ID、令牌数。
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
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
  try {
    msg = JSON.parse(line);
  } catch {
    console.error('[bad line]', line.slice(0, 200));
    return;
  }
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
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(method + ' timeout'));
    }, 120000);
    waiters.set(id, { resolve, reject, timer });
    child.stdin.write(JSON.stringify(payload) + '\n');
  });
}

function brief(result) {
  if (!result || !result.ok) return result;
  const out = { ...result };
  if (Array.isArray(out.ranking)) {
    out.ranking = out.ranking.slice(0, 3).map((r) => ({
      id: r.id,
      sup: r.sup,
      score: r.score,
      ttftMs: r.ttft,
      tps: r.tps,
      cache: r.cache,
      ratio: r.ratio,
      costCny100m: r.costCny100m,
      pinned: r.pinned
    }));
  }
  if (Array.isArray(out.valueRanking)) delete out.valueRanking;
  if (out.cookie) out.cookie = '<redacted ' + out.cookie.length + ' chars>';
  if (Array.isArray(out.models)) out.models = out.models.slice(0, 8).concat(out.models.length > 8 ? ['…'] : []);
  return out;
}

async function main() {
  const started = Date.now();

  console.log('## 1. 无登录态拉公开数据');
  const pub = await rpc('search/run', {
    model: 'deepseek-v4.1-flash',
    onlyQualified: true,
    minCache: 80,
    minSr: 95,
    maxRatio: 0.1,
    maxTtft: 8
  });
  console.log(JSON.stringify(brief(pub), null, 2));

  console.log('\n## 2. 从本机浏览器同步登录态');
  const imp = await rpc('session/import', {});
  console.log(JSON.stringify(brief(imp), null, 2));
  if (!imp.ok) throw new Error('浏览器登录同步失败，后续登录态测试跳过');

  const secrets = { a6api_cookie: imp.cookie };
  const userId = imp.userId;

  console.log('\n## 3. 用宿主注入的 Cookie 走登录态接口');
  const auth = await rpc(
    'search/run',
    { model: 'deepseek-v4.1-flash', onlyQualified: true, minCache: 80, minSr: 95, maxRatio: 0.1, maxTtft: 8, userId },
    { secrets }
  );
  console.log(JSON.stringify(brief(auth), null, 2));

  console.log('\n## 4. 余额（只读）');
  const bal = await rpc('balance/get', { userId }, { secrets });
  console.log(JSON.stringify(brief(bal), null, 2));

  console.log('\n## 5. 当前固定渠道（只读，令牌 ' + imp.tokens[0].id + '）');
  const pinned = await rpc('pin/current', { model: 'deepseek-v4.1-flash', tokenId: imp.tokens[0].id, userId }, { secrets });
  console.log(JSON.stringify(brief(pinned), null, 2));

  console.log('\n## 6. 按品牌拉模型（公开 /api/pricing）');
  const models = await rpc('models/list', { brand: 'DeepSeek' });
  console.log(JSON.stringify(brief(models), null, 2));

  console.log('\n耗时 ' + ((Date.now() - started) / 1000).toFixed(1) + 's');
}

main()
  .then(() => {
    child.stdin.end();
    setTimeout(() => process.exit(0), 200);
  })
  .catch((err) => {
    console.error('FAILED:', err.message);
    child.kill();
    process.exit(1);
  });
