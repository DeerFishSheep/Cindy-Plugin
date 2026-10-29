// A6API 渠道数据的抓取、筛选与评分，与 Chrome 扩展同一套算法。
// 纯 Node 实现：不依赖浏览器，UA 必须伪装成 Chrome，否则 CDN 会返回人机验证页。

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const pexec = promisify(execFile);

export const BASE = 'https://a6api.com';
const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const PATH_PUBLIC = '/api/marketplace/public/channels/search';
const PATH_AUTH = '/api/marketplace/channels/search';

/** 固定工作量：输入 10M（按各渠道自己的缓存命中率拆分）+ 输出 25K。 */
export const WORKLOAD_IN = 10_000_000;
export const WORKLOAD_OUT = 25_000;

/**
 * 价格基准成本（美元）：倍率 0.1、缓存约 90% 的渠道在固定工作量下的典型成本。
 * 用它当及格线——成本正好等于它得 0.5 分，便宜 10 倍得满分，贵 10 倍得 0 分。
 * 基准是固定值，不随榜单里有哪些渠道变化。
 */
export const PRICE_BASE_COST = 0.02;
/** 吞吐满分线（tok/s）。 */
export const TPS_BASE = 300;

const clamp01 = (v) => Math.min(1, Math.max(0, v));

// DeepSeek V4-Flash 官方闲时价（元 / 百万 token），2026-09-10 12:00 起执行。
// 官方调价时只改这三个数。
export const OFFICIAL_PRICE = { hit: 0.02, miss: 1, out: 4 };
// 官方基准口径：1 亿输入 + 25 万输出，按 95% 缓存命中。
export const OFFICIAL_CACHE_RATE = 0.95;
export const OFFICIAL_COST_100M =
  (1e8 * (1 - OFFICIAL_CACHE_RATE) * OFFICIAL_PRICE.miss +
    1e8 * OFFICIAL_CACHE_RATE * OFFICIAL_PRICE.hit +
    25e4 * OFFICIAL_PRICE.out) / 1e6;

/**
 * 1亿成本（人民币）→ 价格分，以官方闲时价为基准，允许为负。
 * 得分 = (1 - 相对官方倍数) × 100。
 * 例：0.1x → 90 分，1x → 0 分，3x → -200 分。
 */
export function priceTier(cny) {
  if (cny === null || cny === undefined) return 0;
  if (!(OFFICIAL_COST_100M > 0)) return 0;
  const ratio = Math.max(cny, 0) / OFFICIAL_COST_100M;
  return (1 - ratio) * 100;
}

/**
 * 按固定工作量算真实成本（美元）。
 * 缓存与未缓存的比例用该渠道自己的命中率，不套统一折价系数。
 */
export function workloadCost(x) {
  if (!x || (!x.inP && !x.outP && !x.ckP)) return null;
  const hit = Math.min(Math.max((Number(x.cache) || 0) / 10000, 0), 1);
  const missTok = WORKLOAD_IN * (1 - hit);
  const hitTok = WORKLOAD_IN * hit;
  // micros/百万token × token 数 ÷ 1e12 = 美元
  const usd =
    (Number(x.inP) * missTok + Number(x.ckP) * hitTok + Number(x.outP) * WORKLOAD_OUT) / 1e12;
  return usd > 0 ? usd : null;
}

/**
 * 估算 1 亿「输入」token 的人民币成本。
 * 按该渠道自己的缓存命中率拆分未缓存/缓存，单价用接口给的 USD micros，再乘站点汇率。
 */
/**
 * 榜单展示用成本：1 亿输入 + 25 万输出（人民币）。
 * 与评分用的 workloadCost 完全同口径，只是放大 10 倍（1亿 vs 1000万输入）。
 */
export function costCnyPer100MInput(x) {
  const usd = workloadCost(x);
  if (usd === null || usd <= 0) return null;
  const fx = Number(x.fx) || 0;
  if (!fx) return null;
  return usd * 10 * fx;
}

/** 兼容旧调用：返回该渠道在固定工作量下的成本。 */
export function effectiveRatio(x) {
  return workloadCost(x);
}

/** 成功率阶梯：并列太多，绝对值比名次更能区分。 */
function rateTier(v) {
  if (v >= 0.995) return 1;
  if (v >= 0.99) return 0.9;
  if (v >= 0.98) return 0.75;
  if (v >= 0.95) return 0.5;
  return 0.2;
}

/** 权重：五项各 20%（有效率 / 价格 / 稳定性 / 首字 / 吞吐），屏蔽项已移除。 */
export const WEIGHTS = [
  ['rel', 0.2, false],
  ['eff', 0.2, false],
  ['stab', 0.2, false],
  ['ttft', 0.2, false],
  ['tps', 0.2, false]
];

/** 稳定性：24 小时内最差那个两小时桶的分数（0~1）。桶太少就不给分。 */
export const STAB_MIN_BUCKETS = 4;
export const STAB_NEUTRAL = 0.7;
const STAB_MIN_SAMPLES = 300;

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

// Node 自带的 fetch 会被站点 CDN 按 TLS 指纹掐断（ECONNRESET），
// 只有 curl 能稳定通过，所以统一用 curl 子进程发请求。
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 站点偶尔会掐 TLS 握手（LibreSSL SSL_ERROR_SYSCALL / ECONNRESET），
// 单次失败重试三次即可恢复，所以这里自己做重试并给出人话错误。
function explain(err) {
  const text = String((err && (err.stderr || err.message)) || err);
  if (/SSL_ERROR_SYSCALL|ECONNRESET|SSL_connect|socket hang up/i.test(text)) {
    return '连不上 a6api.com（TLS 握手被重置）。检查代理是否稳定，或多试一次。';
  }
  if (/timed out|Operation timed out|code: 28/i.test(text)) {
    return '连接 a6api.com 超时（30 秒）。检查网络或代理。';
  }
  if (/Could not resolve host/i.test(text)) return '解析不了 a6api.com，检查 DNS 或代理。';
  return '请求 a6api.com 失败：' + text.split('\n')[0].slice(0, 160);
}

async function requestOnce(method, url, hdrs, body) {
  const MARK = '\n#HTTP#';
  const args = ['-sS', '--max-time', '20', '--compressed', '--http1.1', '-X', method];
  for (const [k, v] of Object.entries(hdrs)) args.push('-H', k + ': ' + v);
  if (body !== undefined && body !== null) args.push('--data-binary', JSON.stringify(body));
  args.push('-w', MARK + '%{http_code}', url.toString());

  const { stdout } = await pexec('curl', args, { maxBuffer: 32 * 1024 * 1024 });
  const at = stdout.lastIndexOf(MARK);
  const text = at >= 0 ? stdout.slice(0, at) : stdout;
  const status = at >= 0 ? Number(stdout.slice(at + MARK.length)) : 0;
  if (!at || Number.isNaN(status)) throw new Error('响应不完整（没有拿到状态码）');

  return {
    status,
    ok: status >= 200 && status < 300,
    text: () => Promise.resolve(text),
    json: () => Promise.resolve(JSON.parse(text || '{}'))
  };
}

async function httpGet(url, hdrs) {
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await requestOnce('GET', url, hdrs);
    } catch (err) {
      last = err;
      if (attempt < 3) await sleep(350 * attempt);
    }
  }
  throw new Error(explain(last));
}

function headers(cred) {
  const h = {
    'User-Agent': UA,
    Accept: 'application/json',
    Referer: BASE + '/'
  };
  if (cred && cred.cookie) h.Cookie = cred.cookie;
  if (cred && cred.userId) h['new-api-user'] = String(cred.userId);
  return h;
}

/**
 * 抓一页渠道数据。
 * 先走登录态接口（认 token_id、带固定状态），401 时退回公开接口。
 */
export async function fetchPage({ page = 1, pageSize = 100, model, brand, tokenId, cred, routeStatus, guaranteedOnly, scope: preferScope } = {}) {
  const build = (path) => {
    const u = new URL(path, BASE);
    u.searchParams.set('page', String(page));
    u.searchParams.set('page_size', String(pageSize));
    u.searchParams.set('sort', 'price_asc');
    u.searchParams.set('guaranteed_only', guaranteedOnly ? 'true' : 'false');
    if (model) u.searchParams.set('model', model);
    if (brand) u.searchParams.set('brand', brand);
    if (tokenId) u.searchParams.set('token_id', String(tokenId));
    return u;
  };

  let scope = 'auth';
  // scope 可由调用方指定：一次 collect 里第一页探明该用哪个接口后，后面几页直接走，
  // 不再每页都先打一次必然失败的 auth 请求 —— 未登录时那等于 6 次白跑。
  let res = await httpGet(build(preferScope === 'public' ? PATH_PUBLIC : PATH_AUTH), headers(cred));
  if (!res.ok && !preferScope) {
    scope = 'public';
    res = await httpGet(build(PATH_PUBLIC), headers(cred));
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}（${scope}）：${(await res.text()).slice(0, 200)}`);

  const body = await res.json();
  if (!body || !body.success) throw new Error('接口返回失败：' + (body && body.message));
  return { scope, ...body.data };
}

/** 把接口原始条目压成紧凑结构。万分比数值保持原样（10000 = 100%）。 */
/** 单个两小时桶的质量分（0~1）：成功率 5 成、延迟 2.5 成、缓存 2.5 成。 */
function bucketScore(b) {
  if (!b || !b.s || b.s < STAB_MIN_SAMPLES) return null;
  const sr = (Number(b.r) || 0) / 10000;
  const delay = Math.min((Number(b.d) || 0) / 1000, 30);
  const cache = (Number(b.c) || 0) / 10000;
  const v = sr * 0.5 + (1 - delay / 30) * 0.25 + cache * 0.25;
  return Math.min(1, Math.max(0, v));
}

/** 稳定性 = 24 小时内最差桶的分数；有效桶不足 6 个给中性分。 */
export function bucketStability(b24) {
  const scores = (Array.isArray(b24) ? b24 : []).map(bucketScore).filter((v) => v !== null);
  if (scores.length < STAB_MIN_BUCKETS) return STAB_NEUTRAL;
  return Math.min(...scores);
}

/** 最近 6 个有效桶（样本>0）的成功率平均值，万分比；无桶数据返回 null。 */
export function recentSr(b24) {
  const arr = (Array.isArray(b24) ? b24 : [])
    .filter((b) => b && b.s > 0 && typeof b.r === 'number' && b.r > 0)
    .slice(-6);
  if (!arr.length) return null;
  return Math.round(arr.reduce((sum, b) => sum + b.r, 0) / arr.length);
}

/** 最近 6 个有效桶（样本>0 且有首字）的首字平均值；无桶数据返回 null。 */
export function recentTtft(b24) {
  const arr = (Array.isArray(b24) ? b24 : [])
    .filter((b) => b && b.s > 0 && typeof b.f === 'number' && b.f > 0)
    .slice(-6);
  if (!arr.length) return null;
  return Math.round(arr.reduce((sum, b) => sum + b.f, 0) / arr.length);
}

export function pack(i) {
  return {
    id: i.channel_id,
    lid: num(i.listing_id),
    sup: i.supplier_name || '',
    ch: i.channel_name || '',
    ratio: typeof i.realtime_ratio_usd === 'number' ? i.realtime_ratio_usd : null,
    // 三个价目（micros / 百万 token），用来算真实成本
    inP: num(i.input_price_micros),
    outP: num(i.output_price_micros),
    ckP: num(i.cache_read_price_micros),
    fx: num(i.realtime_ratio_exchange_rate) || 0,
    // 首字优先用最近 6 个桶的平均（反映当前状态），没有桶才退回全局 p50
    ttft: (() => {
      const rt = recentTtft(i.b24);
      if (rt !== null) return rt;
      return i.p50_ttft_ms === undefined ? null : num(i.p50_ttft_ms);
    })(),
    ttftRaw: i.p50_ttft_ms === undefined ? null : num(i.p50_ttft_ms),
    p50: i.recent_p50_ms === undefined ? null : num(i.recent_p50_ms),
    tps: typeof i.throughput_tps === 'number' ? i.throughput_tps : null,
    sr24: num(i.success_rate_24h),
    // 近期成功率优先用最近 6 个桶的平均，没有桶才退回接口的 recent_success_rate
    srr: (() => {
      const rs = recentSr(i.b24);
      if (rs !== null) return rs;
      return num(i.recent_success_rate);
    })(),
    srrRaw: num(i.recent_success_rate),
    cache: num(i.cache_hit_rate_24h),
    blk: num(i.merchant_block_stats && i.merchant_block_stats.block_count),
    n: num(i.sample_count),
    auth: i.authenticity_guaranteed ? 1 : 0,
    off:
      i.user_channel_disabled ||
      i.supplier_channel_disabled ||
      (i.listing_availability !== undefined && i.listing_availability !== 1)
        ? 1
        : 0,
    pch: num(i.pin_channel_id),
    pt: num(i.pin_target_id),
    rtp: i.route_type || '',
    ps: i.pin_status || '',
    stab: bucketStability(i.b24)
  };
}

const has = (v) => v !== null && v !== undefined && v !== '';

/** 筛选：任一项不满足即出局。onlyQualified=false 时全部放行。 */
export function qualifies(it, opt = {}) {
  if (opt.onlyQualified === false) return true;
  if (it.ttft === null || it.p50 === null || it.tps === null) return false;
  if (has(opt.minSr) && (it.srr || 0) < opt.minSr * 100) return false;
  if (has(opt.minSr) && (it.sr24 || 0) < opt.minSr * 100) return false;
  if (has(opt.minCache) && (it.cache || 0) < opt.minCache * 100) return false;
  if (has(opt.minSample) && (it.n || 0) < opt.minSample) return false;
  if (has(opt.minTps) && (it.tps || 0) < opt.minTps) return false;
  if (has(opt.maxRatio) && (it.ratio === null || it.ratio > opt.maxRatio)) return false;
  if (has(opt.maxTtft) && (it.ttft || 0) > opt.maxTtft * 1000) return false;
  return true;
}

/** 综合分：有效率阶梯 + 有效倍率对数 + 首字/吞吐/屏蔽名次，加权求和。 */
export function rank(items) {
  const rows = items.filter((x) => !x.off && x.ttft && x.p50 && x.tps);
  const n = rows.length;
  if (!n) return [];

  for (const r of rows) {
    // 有效率：近期成功率从 90% 起算，100% 满分
    r._s_rel = clamp01(((Number(r.srr) || 0) / 10000 - 0.9) / 0.1);
    // 稳定性：24 小时内最差 2 小时桶
    r._s_stab = typeof r.stab === 'number' ? r.stab : STAB_NEUTRAL;
    // 首字：(10 - 秒数) / 10，10 秒以上 0 分
    r._s_ttft = clamp01((10 - (Number(r.ttft) || 0) / 1000) / 10);
    // 吞吐：tok/s ÷ 300，封顶 1
    r._s_tps = clamp01((Number(r.tps) || 0) / TPS_BASE);
    // 价格：按 1亿输入+25万输出 的人民币成本分档
    r._cost = workloadCost(r);
    r._s_eff = priceTier(costCnyPer100MInput(r)) / 100;
  }

  for (const r of rows) {
    const sum = WEIGHTS.reduce((acc, [key, w]) => acc + w * r['_s_' + key], 0);
    r.score = Math.round(sum * 1000) / 10;
  }

  const isPinned = (r) => r.ps === 'pin_here' || (r.pch && Number(r.pch) === Number(r.id));

  rows.sort((a, b) => b.score - a.score);
  return rows.map((r, i) => ({
    pinned: isPinned(r),
    no: i + 1,
    score: r.score,
    id: r.id,
    lid: r.lid,
    sup: r.sup,
    ch: r.ch,
    ratio: r.ratio,
    cost: r._cost === undefined || r._cost === null ? null : Math.round(r._cost * 1e6) / 1e6,
    inP: r.inP, outP: r.outP, ckP: r.ckP, fx: r.fx,
    ttft: r.ttft,
    ttftRaw: r.ttftRaw,
    p50: r.p50,
    tps: r.tps,
    sr24: r.sr24,
    srr: r.srr,
    srrRaw: r.srrRaw,
    cache: r.cache,
    blk: r.blk,
    n: r.n,
    ps: r.ps,
    pch: r.pch,
    stab: r.stab,
    auth: r.auth,
    rtp: r.rtp,
    parts: {
      rel: Math.round((r._s_rel || 0) * 100),
      eff: Math.round((r._s_eff || 0) * 100),
      stab: Math.round((r._s_stab || 0) * 100),
      ttft: Math.round((r._s_ttft || 0) * 100),
      tps: Math.round((r._s_tps || 0) * 100)
    }
  }));
}

/** 性价比：综合分 ÷ 倍率，综合分不到最高分 55% 的一律沉底。 */
/**
 * 性价比 = 性能分 × 价格分 ÷ 100（乘法模型）。
 * 性能取四项（有效率/稳定性/首字/吞吐）均值，价格用相对官方价的省钱分（可为负）。
 * 乘法意味着两项都必须过得去：性能差或价格贵，都会被直接压低。
 */
export function byValue(rows) {
  const perf = (r) => {
    const p = r.parts || {};
    const vals = [p.rel, p.stab, p.ttft, p.tps].map((v) => Number(v) || 0);
    return vals.reduce((a, b) => a + b, 0) / vals.length;
  };
  const priceOf = (r) => Number((r.parts || {}).eff) || 0;
  const value = (r) => (perf(r) * priceOf(r)) / 100;
  return rows.slice().sort((a, b) => value(b) - value(a));
}

/** 翻页抓全量。 */
export async function collect(opt = {}) {
  const maxPages = opt.maxPages || 6;
  const pageSize = opt.pageSize || 100;
  const all = [];
  let total = 0;
  let scope = 'auth';
  let tokenId = opt.tokenId || null;
  let tokenName = null;

  // 先拉第一页 —— 它带回 total，才知道后面要拉几页。
  // 原实现逐页串行 await，6 页要 30 秒；这里第一页之后并发拉剩余页，实测降到 6 秒级。
  const build = (page) => ({
    page,
    pageSize,
    model: opt.model,
    brand: opt.brand,
    tokenId,
    cred: opt.cred,
    guaranteedOnly: opt.guaranteedOnly === true
  });

  const first = await fetchPage(build(1));
  scope = first.scope || scope;
  total = first.total || 0;
  if (first.query && first.query.token_id) tokenId = first.query.token_id;
  all.push(...(first.items || []));

  const pages = Math.min(maxPages, Math.ceil(total / pageSize) || 1);
  if (pages > 1) {
    // 单页失败不该让整次查询失败：扔掉那一页，其余照常参与排名。
    // build() 每次读最新的 tokenId（第一页可能刚把它换成账号默认令牌）。
    const rest = await Promise.all(
      Array.from({ length: pages - 1 }, (_, i) => fetchPage({ ...build(i + 2), scope }).catch(() => null))
    );
    for (const d of rest) if (d) all.push(...(d.items || []));
  }

  const packed = all.map(pack);
  // 仅保真模式：只用「这个模型 + 保真」查，不再套任何筛选条件
  const kept = opt.guaranteedOnly === true ? packed : packed.filter((it) => qualifies(it, opt));
  const ranked = rank(kept);

  return {
    model: opt.model || '',
    brand: opt.brand || '',
    scope,
    tokenId,
    tokenName,
    total,
    fetched: packed.length,
    kept: kept.length,
    ts: new Date().toISOString(),
    ranking: ranked,
    items: kept
  };
}


// ---------- 登录凭据与账号接口 ----------

import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';

/**
 * 凭据/缓存放哪。
 *
 * Cindy 改写点（唯一）：上游默认写 ~/.dsh，Cindy 插件不允许写别的产品的目录。
 * 这里改成 A6API_DATA_DIR（worker 启动时指向系统临时目录，只用来放 Chrome
 * Cookies 的临时拷贝和模型列表缓存）或 setDataDir() 显式指定。
 * 登录态本身由宿主保险库保管，不落这里。
 */
let DATA_DIR =
  process.env.A6API_DATA_DIR ||
  join(tmpdir(), 'a6api-picker-cindy-' + (typeof process.getuid === 'function' ? process.getuid() : 'u'));
export function setDataDir(dir) {
  if (dir) DATA_DIR = dir;
}
export function dataDir() {
  return DATA_DIR;
}

const credFile = () => join(DATA_DIR, 'a6api-session.json');

export function loadSession() {
  try {
    const file = credFile();
    if (!existsSync(file)) return null;
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function saveSession(sess) {
  try {
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(credFile(), JSON.stringify(sess, null, 2), { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export function clearSession() {
  try {
    writeFileSync(credFile(), '{}', { mode: 0o600 });
    return true;
  } catch {
    return false;
  }
}

export async function postJson(path, body, cred) {
  const url = new URL(path, BASE);
  const h = headers(cred);
  h['content-type'] = 'application/json';
  let last;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      return await requestOnce('POST', url, h, body);
    } catch (err) {
      last = err;
      if (attempt < 3) await sleep(350 * attempt);
    }
  }
  throw new Error(explain(last));
}

/** 账号密码登录：走 New API 的 /api/user/login，用 cookie jar 收 session。 */
export async function loginWithPassword(username, password, jarPath) {
  const MARK = '\n#HTTP#';
  const args = [
    '-sS', '--max-time', '20', '--http1.1',
    '-c', jarPath,
    '-X', 'POST',
    '-H', 'User-Agent: ' + UA,
    '-H', 'Content-Type: application/json',
    '-H', 'Referer: ' + BASE + '/',
    '--data-binary', JSON.stringify({ username, password }),
    '-w', MARK + '%{http_code}',
    BASE + '/api/user/login'
  ];
  const { stdout } = await pexec('curl', args, { maxBuffer: 8 * 1024 * 1024 });
  const at = stdout.lastIndexOf(MARK);
  const raw = at >= 0 ? stdout.slice(0, at) : stdout;
  let body = {};
  try {
    body = JSON.parse(raw);
  } catch {
    throw new Error('登录接口返回了非 JSON：' + raw.slice(0, 120));
  }
  if (!body.success) throw new Error(body.message || '登录失败（账号或密码不对）');

  const jar = readFileSync(jarPath, 'utf8');
  const cookies = jar
    .split('\n')
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t'))
    .filter((p) => p.length >= 7 && p[5] && p[6])
    .map((p) => ({ name: p[5], value: p[6] }));
  const cookie = cookies.map((c) => c.name + '=' + c.value).join('; ');
  if (!cookie) throw new Error('登录成功但没拿到 cookie');
  return cookie;
}

/** 用 cookie 换当前登录用户 id（New API 的 new-api-user 头就是它）。 */
export async function fetchUserId(cookie) {
  const res = await httpGet(new URL('/api/user/self', BASE), headers({ cookie }));
  const body = await res.json().catch(() => ({}));
  const id = body && body.data && (body.data.id || body.data.user_id);
  if (!id) throw new Error('拿不到用户 ID：' + ((body && body.message) || 'not logged in'));
  return Number(id);
}

/** 拉令牌列表（用户要固定的那个令牌）。 */
export async function listTokens(cred) {
  const out = [];
  for (const p of ['/api/token/?p=1&size=100', '/api/token/?p=0&size=100']) {
    const res = await httpGet(new URL(p, BASE), headers(cred));
    const body = await res.json().catch(() => ({}));
    const items = (body && body.data && (body.data.items || body.data)) || [];
    if (Array.isArray(items) && items.length) {
      for (const t of items) {
        if (t && (t.id || t.token_id)) out.push({ id: t.id || t.token_id, name: t.name || String(t.id) });
      }
      break;
    }
  }
  return out;
}

/** 固定渠道到令牌。 */
/** 禁用某渠道的某个模型（站点的「不看这家」）。不可逆，没有反向接口。 */
export async function disableChannel({ cred, channelId, model }) {
  const q = model ? '?model=' + encodeURIComponent(model) : '';
  const res = await postJson(
    '/api/marketplace/channels/' + Number(channelId) + '/disable' + q,
    undefined,
    cred
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    throw new Error((body && (body.message || body.code)) || '禁用失败（HTTP ' + res.status + '）');
  }
  return body.data || {};
}

// /api/status 里的汇率和单位几乎不变，缓存一小时，轮询时只打 user/self
let statusMeta = null;

/** 查余额：/api/user/self 的 quota 按站点 quota_per_unit 折算美元，再按汇率换人民币。 */
export async function fetchBalance(cred) {
  const fresh = statusMeta && Date.now() - statusMeta.ts < 3600 * 1000;
  const jobs = [httpGet(new URL('/api/user/self', BASE), headers(cred))];
  if (!fresh) jobs.push(httpGet(new URL('/api/status', BASE), headers(null)));
  const [selfRes, statusRes] = await Promise.all(jobs);

  if (!fresh) {
    const st = ((await statusRes.json()) || {}).data || {};
    statusMeta = {
      ts: Date.now(),
      perUnit: Number(st.quota_per_unit) || 500000,
      // 汇率只认站点实际生效的 payment_fx_rate_cny_per_usd（如 6.6681）。
      // usd_exchange_rate 是 New API 遗留的 7.3，跟官网显示的 ¥ 对不上，不用它。
      fx: Number(st.payment_fx_rate_cny_per_usd) || null
    };
  }

  const self = ((await selfRes.json()) || {}).data || {};
  const usd = Number(self.quota || 0) / statusMeta.perUnit;
  // 站点不给汇率就不折人民币（返回 null，前端退回显示美元），不猜一个固定值
  const toCny = (q) =>
    statusMeta.fx ? Math.round((Number(q || 0) / statusMeta.perUnit) * statusMeta.fx * 100) / 100 : null;
  return {
    cny: toCny(self.quota),
    usd: Math.round(usd * 10000) / 10000,
    quota: Number(self.quota || 0),
    usedCny: toCny(self.used_quota),
    requests: Number(self.request_count || 0)
  };
}

export async function pinChannel({ cred, tokenId, channelId, model }) {
  const res = await postJson('/api/marketplace/pin', {
    token_id: Number(tokenId),
    model_name: model,
    channel_id: Number(channelId),
    fallback_to_smart_routing: true
  }, cred);
  const body = await res.json().catch(() => ({}));
  if (!res.ok || !body.success) {
    throw new Error((body && body.message) || '固定失败（HTTP ' + res.status + '）');
  }
  return body.data || {};
}


// ---------- 从本机 Chrome 导入登录态 ----------

import { execFileSync } from 'node:child_process';
import { createDecipheriv, pbkdf2Sync, createHash } from 'node:crypto';
import { copyFileSync } from 'node:fs';

const CHROME_DIRS = [
  join(homedir(), 'Library/Application Support/Google/Chrome'),
  join(homedir(), 'Library/Application Support/Microsoft Edge'),
  join(homedir(), 'Library/Application Support/BraveSoftware/Brave-Browser')
];

function chromeKey() {
  const pw = execFileSync('security', ['find-generic-password', '-w', '-s', 'Chrome Safe Storage'], {
    encoding: 'utf8'
  }).trim();
  if (!pw) throw new Error('拿不到 Chrome Safe Storage 密钥');
  return pbkdf2Sync(pw, 'saltysalt', 1003, 16, 'sha1');
}

function decryptValue(buf, key, host) {
  if (!buf || buf.length < 4) return '';
  const prefix = buf.slice(0, 3).toString();
  if (prefix !== 'v10' && prefix !== 'v11') return buf.toString('utf8');
  try {
    const iv = Buffer.alloc(16, ' ');
    const d = createDecipheriv('aes-128-cbc', key, iv);
    d.setAutoPadding(false);
    let out = Buffer.concat([d.update(buf.slice(3)), d.final()]);
    // 新版会在明文前塞 32 字节 host_key 摘要
    const h = createHash('sha256').update(host).digest();
    if (out.length > 32 && out.slice(0, 32).equals(h)) out = out.slice(32);
    else if (out.length > 32 && out.slice(0, 32).equals(h.slice(0, 32))) out = out.slice(32);
    // 去掉 PKCS7 填充
    const pad = out[out.length - 1];
    if (pad > 0 && pad <= 16) out = out.slice(0, out.length - pad);
    return out.toString('utf8');
  } catch {
    return '';
  }
}

/**
 * 直接读本机 Chrome 的 Cookies 数据库，拿 a6api 的登录态。
 * 用户不用手抄 cookie —— 浏览器里登录过就够了。
 */
export function importBrowserCookie(host = 'a6api.com') {
  let key = null;
  const errors = [];

  for (const dir of CHROME_DIRS) {
    let profiles = [];
    try {
      profiles = readdirSync(dir).filter((f) => f === 'Default' || f.startsWith('Profile '));
    } catch {
      continue;
    }
    for (const prof of profiles) {
      const src = join(dir, prof, 'Cookies');
      if (!existsSync(src)) continue;
      const tmp = join(DATA_DIR, '.a6api-ck-' + process.pid + '.db');
      try {
        copyFileSync(src, tmp);
        const out = execFileSync('sqlite3', [
          tmp,
          `select host_key||char(9)||name||char(9)||hex(encrypted_value) from cookies ` +
          `where host_key like '%${host}%' and length(encrypted_value)>0;`
        ], { encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 });

        const rows = out.split('\n').filter(Boolean).map((l) => l.split('\t'));
        if (!rows.length) continue;
        if (!key) key = chromeKey();

        const picked = [];
        for (const [h, name, hex] of rows) {
          const value = decryptValue(Buffer.from(hex, 'hex'), key, h);
          if (!value) continue;
          // 只带站点必需的几个，session 最重要
          if (['session', 'a6api_frontend', '__ct_cya_ckt'].includes(name) || name.startsWith('__ct_')) {
            picked.push({ name, value, host: h });
          }
        }
        if (!picked.some((c) => c.name === 'session')) continue;

        const cookie = picked.map((c) => c.name + '=' + c.value).join('; ');
        return { cookie, source: dir.split('/').pop() + '/' + prof, count: picked.length };
      } catch (err) {
        errors.push(String((err && err.message) || err).slice(0, 120));
      } finally {
        try { rmSync(tmp, { force: true }); } catch {}
      }
    }
  }

  throw new Error(
    '没在浏览器里找到 a6api 的登录状态' + (errors.length ? '（' + errors[0] + '）' : '') +
    '：请先在浏览器登录 a6api.com'
  );
}


/**
 * 从浏览器 localStorage 里读 a6api 的用户 ID。
 * a6api 前端把登录返回的 id 存在 a6api_session_user_id 这个键里，
 * 而 /api/user/self 又强制要 new-api-user 头，只好从这里取。
 */
/** 从 session cookie 里解出用户 ID（gorilla securecookie：ts|base64(gob)|mac）。 */
export function userIdFromCookie(cookie) {
  const m = /(?:^|;\s*)session=([^;]+)/.exec(String(cookie || ''));
  if (!m) return null;
  try {
    const layer1 = Buffer.from(decodeURIComponent(m[1]), 'base64').toString('latin1');
    const parts = layer1.split('|');
    const payload = parts.length >= 2 ? parts[1] : layer1;
    const layer2 = Buffer.from(payload, 'base64').toString('latin1');
    const hit = /(?:oidc?|user_?id)[_\s:]*(\d{3,8})/i.exec(layer2);
    return hit ? Number(hit[1]) : null;
  } catch {
    return null;
  }
}

export function resolveUserId(cookie) {
  const local = readBrowserUserId();
  if (local) return local;
  const saved = loadSession();
  if (saved && saved.userId) return saved.userId;
  // 兜底：Chrome 的 LevelDB 读不到时，直接从 session cookie 里解
  try {
    return userIdFromCookie(cookie || importBrowserCookie().cookie);
  } catch {
    return null;
  }
}

export function readBrowserUserId() {
  const KEYBUF = Buffer.from('a6api_session_user_id');
  for (const dir of CHROME_DIRS) {
    let profiles = [];
    try {
      profiles = readdirSync(dir).filter((f) => f === 'Default' || f.startsWith('Profile '));
    } catch {
      continue;
    }
    for (const prof of profiles) {
      const ld = join(dir, prof, 'Local Storage', 'leveldb');
      let files = [];
      try {
        files = readdirSync(ld).filter((f) => f.endsWith('.log') || f.endsWith('.ldb'));
      } catch {
        continue;
      }
      for (const f of files) {
        let raw;
        try {
          raw = readFileSync(join(ld, f));
        } catch {
          continue;
        }
        // 一个文件里键名可能出现多次，只有一个后面跟着真实 ID
        let from = 0;
        for (;;) {
          const at = raw.indexOf(KEYBUF, from);
          if (at < 0) break;
          from = at + KEYBUF.length;
          const seg = raw.slice(at + KEYBUF.length, at + KEYBUF.length + 60).toString('latin1');
          const m = seg.match(/(\d{3,8})/);
          if (m) return Number(m[1]);
        }
      }
    }
  }
  return null;
}


/**
 * 当前令牌固定的是哪个渠道。
 * 站点支持 route_status=pin_here 过滤，一次请求只回那一条，不用翻页逐条比对。
 */
export async function fetchPinned({ model, tokenId, cred } = {}) {
  const d = await fetchPage({ page: 1, pageSize: 5, model, tokenId, cred, routeStatus: 'pin_here' });
  const items = d.items || [];
  const hit = items.find((i) => i.pin_status === 'pin_here') || items[0];
  if (!hit) return null;
  // 固定的商家可能不满足当前筛选条件、不在榜单里；这里附一份完整评分行，
  // 供对比面板直接使用（评分按行独立计算，与是否在榜无关）。
  const scored = rank([pack(hit)])[0] || null;
  return {
    row: scored,
    channelId: hit.channel_id,
    channelName: hit.channel_name || '',
    supplierName: hit.supplier_name || '',
    model: hit.model_name || model || '',
    ratio: typeof hit.realtime_ratio_usd === 'number' ? hit.realtime_ratio_usd : null,
    tps: typeof hit.throughput_tps === 'number' ? hit.throughput_tps : null,
    ttft: num(hit.p50_ttft_ms),
    cache: num(hit.cache_hit_rate_24h),
    blk: num(hit.merchant_block_stats && hit.merchant_block_stats.block_count)
  };
}


/** 拉可用模型列表（/api/pricing 公开接口，无需登录）。 */
export async function fetchModels() {
  const res = await httpGet(new URL('/api/pricing', BASE), headers(null));
  const body = await res.json();
  const list = (body && body.data) || [];
  const names = [];
  for (const m of list) {
    const name = m && (m.model_name || m.model);
    if (!name) continue;
    const groups = m.enable_groups || [];
    if (Array.isArray(groups) && groups.length === 0) continue;
    // 过期模型（expires-on-0910 这类）不上列表
    if (/expires?-on|expired/i.test(String(name))) continue;
    names.push(String(name));
  }
  const uniq = [...new Set(names)];
  // deepseek 系列排前面，其余按字母
  uniq.sort((a, b) => {
    const ad = a.toLowerCase().includes('deepseek') ? 0 : 1;
    const bd = b.toLowerCase().includes('deepseek') ? 0 : 1;
    return ad - bd || a.localeCompare(b);
  });
  return uniq;
}


/** 品牌列表：渠道接口里带 brand，翻几页收集去重。 */
export async function fetchBrands(cred) {
  const set = new Set();
  for (let page = 1; page <= 3; page++) {
    const d = await fetchPage({ page, pageSize: 100, cred });
    const items = d.items || [];
    for (const i of items) if (i.brand) set.add(String(i.brand));
    if (items.length < 100) break;
  }
  return [...set].sort((a, b) => a.localeCompare(b));
}


/**
 * 按品牌拉模型列表。
 * 渠道接口 page_size 上限 500，大品牌有几千条渠道，必须翻完；
 * 用并发 + 本地缓存，避免每次切换品牌都等十几秒。
 */
export async function fetchModelsByBrand(brand, cred) {
  if (!brand) return [];
  const cached = readModelsCache(brand);
  if (cached) return cached;

  const first = await fetchPage({ page: 1, pageSize: 500, brand, cred });
  const total = Number(first.total) || 0;
  const pages = Math.min(Math.ceil(total / 500) || 1, 12);

  const rest = [];
  for (let p = 2; p <= pages; p++) {
    rest.push(fetchPage({ page: p, pageSize: 500, brand, cred }).catch(() => null));
  }
  const all = [first, ...(await Promise.all(rest))];

  const set = new Set();
  for (const d of all) {
    for (const i of (d && d.items) || []) {
      const name = i.model_name;
      if (!name) continue;
      if (/expires?-on|expired/i.test(String(name))) continue;
      set.add(String(name));
    }
  }
  const models = [...set].sort((a, b) => a.localeCompare(b));
  if (models.length) writeModelsCache(brand, models);
  return models;
}

const MODELS_CACHE_TTL = 6 * 60 * 60 * 1000;

function modelsCachePath() {
  return join(DATA_DIR, 'a6api-models.json');
}

function readModelsCache(brand) {
  try {
    const all = JSON.parse(readFileSync(modelsCachePath(), 'utf8'));
    const hit = all && all[brand];
    if (!hit || !Array.isArray(hit.models) || !hit.models.length) return null;
    if (Date.now() - Number(hit.ts || 0) > MODELS_CACHE_TTL) return null;
    return hit.models;
  } catch {
    return null;
  }
}

function writeModelsCache(brand, models) {
  try {
    const path = modelsCachePath();
    let all = {};
    try {
      all = JSON.parse(readFileSync(path, 'utf8')) || {};
    } catch {}
    all[brand] = { ts: Date.now(), models };
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(all), { mode: 0o600 });
  } catch {}
}
