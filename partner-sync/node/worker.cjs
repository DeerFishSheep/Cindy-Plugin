#!/usr/bin/env node
/**
 * 伙伴同步 — Node 工作进程
 *
 * Cindy 没有伙伴 Soul / 记忆的插件 API（cindy.companions 只读），但 Node 进程有
 * 本机文件权限。伙伴数据在：
 *   ~/Library/Application Support/Cindy/owners/<owner>/bots/<botId>/
 *     SOUL.md                 人设
 *     memories/*.md           每条记忆（YAML frontmatter + 正文）
 *     memories/MEMORY.md      记忆索引
 *
 * 只经 JSON-RPC stdio 与 main.js 通信；stdout 只写协议行，日志写 stderr。
 * 写入前一律备份目标 Soul；记忆按正文去重后追加。
 */
'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const readline = require('node:readline');
const { execFileSync } = require('node:child_process');
const crypto = require('node:crypto');

process.env.PATH = [
  '/opt/homebrew/bin',
  '/usr/local/bin',
  '/usr/bin',
  '/bin',
  process.env.PATH || ''
].join(':');

const APP_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'Cindy');
const OWNERS_DIR = path.join(APP_DIR, 'owners');
const BOT_ID_RE = /^[a-zA-Z0-9_-]{1,80}$/;

// ── JSON-RPC ───────────────────────────────────────────────────────────────

function reply(message) {
  process.stdout.write(JSON.stringify(message) + '\n');
}

function log(message) {
  try {
    process.stderr.write('[partner-sync] ' + String(message) + '\n');
  } catch {}
}

function fail(id, message) {
  reply({ jsonrpc: '2.0', id, result: { ok: false, error: String(message || '未知错误') } });
}

// ── 伙伴发现 ───────────────────────────────────────────────────────────────

/** 主库是 owners 同级体积最大的 cindy-*.db；另有 0 字节占位库要排除。 */
function mainDbPath() {
  try {
    let best = null;
    for (const name of fs.readdirSync(APP_DIR)) {
      if (!/^cindy-.*\.db$/.test(name)) continue;
      const full = path.join(APP_DIR, name);
      const size = fs.statSync(full).size;
      if (size > 0 && (!best || size > best.size)) best = { full, size };
    }
    return best ? best.full : null;
  } catch {
    return null;
  }
}

/** botId → display_name；读不到就返回空表，界面回落成 botId。 */
function displayRows() {
  const db = mainDbPath();
  if (!db) return {};
  try {
    const out = execFileSync('sqlite3', ['-readonly', db, 'select id, display_name, avatar from bot_profiles;'], {
      encoding: 'utf8',
      timeout: 5000
    });
    const map = {};
    for (const line of out.split('\n')) {
      const parts = line.split('|');
      if (parts.length >= 2 && parts[0]) map[parts[0]] = { name: parts[1], avatar: parts[2] || '' };
    }
    return map;
  } catch (err) {
    log('读取伙伴名失败: ' + err.message);
    return {};
  }
}

/** 伙伴头像：媒体 blob 或内置预设图，读成 data URI 给面板用。 */
const avatarCache = new Map();
function avatarDataUri(avatar) {
  if (!avatar || typeof avatar !== 'string') return null;
  if (avatarCache.has(avatar)) return avatarCache.get(avatar);
  let file = null;
  let mime = 'image/png';
  const media = /^cindy-media:\/\/blobs\/([a-f0-9]+)\.([a-z0-9]+)$/i.exec(avatar);
  if (media) {
    const ext = media[2].toLowerCase();
    mime = ext === 'jpg' || ext === 'jpeg' ? 'image/jpeg' : ext === 'webp' ? 'image/webp' : ext === 'gif' ? 'image/gif' : 'image/png';
    file = path.join(APP_DIR, 'cindy-media', 'blobs', media[1].slice(0, 2), media[1] + '.' + ext);
  } else {
    const preset = /^cindy:\/\/avatar\/preset\/([a-z0-9-]+)$/i.exec(avatar);
    if (preset) file = path.join('/Applications/Cindy.app/Contents/Resources/companion-preset-avatars', preset[1] + '.png');
  }
  let out = null;
  if (file) {
    try {
      out = 'data:' + mime + ';base64,' + fs.readFileSync(file).toString('base64');
    } catch {
      out = null;
    }
  }
  avatarCache.set(avatar, out);
  return out;
}

function botDir(ownerId, botId) {
  if (!BOT_ID_RE.test(botId)) throw new Error('伙伴 id 不合法：' + botId);
  return path.join(OWNERS_DIR, ownerId, 'bots', botId);
}

function listPartners() {
  const names = displayRows();
  const partners = [];
  let owners = [];
  try {
    owners = fs.readdirSync(OWNERS_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return [];
  }
  for (const owner of owners) {
    const botsDir = path.join(OWNERS_DIR, owner.name, 'bots');
    let bots = [];
    try {
      bots = fs.readdirSync(botsDir, { withFileTypes: true }).filter((d) => d.isDirectory());
    } catch {
      continue;
    }
    for (const bot of bots) {
      const dir = path.join(botsDir, bot.name);
      const soul = path.join(dir, 'SOUL.md');
      if (!fs.existsSync(soul)) continue;
      partners.push({
        id: bot.name,
        owner: owner.name,
        name: (names[bot.name] && names[bot.name].name) || bot.name,
        avatarSrc: avatarDataUri(names[bot.name] && names[bot.name].avatar) || null,
        soulBytes: safeSize(soul),
        memoryCount: memoryFiles(dir).length
      });
    }
  }
  partners.sort((a, b) => a.name.localeCompare(b.name, 'zh'));
  return partners;
}

function safeSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function findPartner(botId) {
  for (const p of listPartners()) if (p.id === botId) return p;
  throw new Error('找不到伙伴：' + botId);
}

// ── 记忆解析 ───────────────────────────────────────────────────────────────

function memoryDir(partner) {
  return path.join(botDir(partner.owner, partner.id), 'memories');
}

function memoryFiles(partnerDir) {
  const dir = path.join(partnerDir, 'memories');
  try {
    return fs
      .readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== 'MEMORY.md' && f !== 'USER.md')
      .sort();
  } catch {
    return [];
  }
}

/** frontmatter 只取 title / description / type，够界面用；不引 YAML 库。 */
function parseMemory(text) {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  const meta = {};
  let body = text;
  if (match) {
    body = text.slice(match[0].length);
    for (const line of match[1].split(/\r?\n/)) {
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      let value = line.slice(i + 1).trim();
      if (
        (value.startsWith("'") && value.endsWith("'")) ||
        (value.startsWith('"') && value.endsWith('"'))
      ) {
        value = value.slice(1, -1);
      }
      if (key === 'title' || key === 'description' || key === 'type') meta[key] = value;
    }
  }
  return { title: meta.title || '', description: meta.description || '', type: meta.type || 'other', body };
}

/** 去重只看正文：标题/描述改动不影响判重。取 md5，便于跨伙伴比对。 */
function bodyHash(body) {
  return crypto.createHash('md5').update(String(body).replace(/\s+/g, '').trim()).digest('hex');
}

function readMemories(partner) {
  return memoryFiles(botDir(partner.owner, partner.id)).map((file) => {
    const text = fs.readFileSync(path.join(memoryDir(partner), file), 'utf8');
    const parsed = parseMemory(text);
    return { file, ...parsed, hash: bodyHash(parsed.body) };
  });
}

// ── 写入 ───────────────────────────────────────────────────────────────────

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return (
    d.getFullYear() +
    p(d.getMonth() + 1) +
    p(d.getDate()) +
    '-' +
    p(d.getHours()) +
    p(d.getMinutes()) +
    p(d.getSeconds())
  );
}

function writeAtomic(file, content) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, content, 'utf8');
  fs.renameSync(tmp, file);
}

function backupSoul(dir) {
  const soul = path.join(dir, 'SOUL.md');
  const target = soul + '.bak-' + stamp();
  fs.copyFileSync(soul, target);
  return path.basename(target);
}

/**
 * 人设真正生效的是 DB：bot_profile_versions.identity_source，当前版本由
 * bot_profiles.current_version 指定；SOUL.md 只是镜像，宿主只在建主任务那一刻
 * 才回读文件。所以只改文件不生效，这里同步插一条新版本并抬 current_version。
 * 旧版本行保留，回退就是把 current_version 指回去。
 */
function bumpIdentityVersion(botId, text) {
  const db = mainDbPath();
  if (!db) throw new Error('找不到 Cindy 主数据库，无法写入人设版本');
  const id = String(botId).replace(/'/g, "''");

  let row;
  try {
    row = execFileSync(
      'sqlite3',
      [
        '-readonly',
        db,
        `select p.current_version || '|' || ifnull((select max(version) from bot_profile_versions where bot_id = p.id), 0) from bot_profiles p where p.id = '${id}';`
      ],
      { encoding: 'utf8', timeout: 5000 }
    ).trim();
  } catch (err) {
    throw new Error('读取伙伴版本失败：' + err.message);
  }
  const [current, max] = row.split('|').map(Number);
  if (!current || !max) throw new Error('伙伴没有可用的版本记录：' + botId);

  const next = max + 1;
  const now = Date.now();
  const sql = [
    'PRAGMA busy_timeout=8000;',
    'BEGIN IMMEDIATE;',
    `INSERT INTO bot_profile_versions (id, bot_id, version, identity_source, capabilities_json, created_at)
SELECT '${id}:v' || ${next}, '${id}', ${next}, '${String(text).replace(/'/g, "''")}', capabilities_json, ${now}
  FROM bot_profile_versions WHERE bot_id = '${id}' AND version = ${current};`,
    `UPDATE bot_profiles SET current_version = ${next}, updated_at = ${now} WHERE id = '${id}' AND current_version = ${current};`,
    'COMMIT;'
  ].join('\n');

  try {
    execFileSync('sqlite3', ['-bail', db], { input: sql, encoding: 'utf8', timeout: 15000 });
  } catch (err) {
    throw new Error('写入伙伴版本失败：' + err.message);
  }

  const check = execFileSync(
    'sqlite3',
    ['-readonly', db, `select current_version from bot_profiles where id = '${id}';`],
    { encoding: 'utf8', timeout: 5000 }
  ).trim();
  if (Number(check) !== next) throw new Error('版本写入没有生效（current_version=' + check + '）');
  return next;
}

function syncSoul(params) {
  const src = findPartner(params.srcId);
  const dst = findPartner(params.dstId);
  if (src.id === dst.id) throw new Error('源伙伴和目标伙伴不能是同一个');

  const srcDir = botDir(src.owner, src.id);
  const dstDir = botDir(dst.owner, dst.id);
  const content = fs.readFileSync(path.join(srcDir, 'SOUL.md'), 'utf8');
  if (!content.trim()) throw new Error('源伙伴的 Soul 是空的，不同步');

  const backup = backupSoul(dstDir);
  writeAtomic(path.join(dstDir, 'SOUL.md'), content);
  const version = bumpIdentityVersion(dst.id, content);
  return { ok: true, backup, bytes: Buffer.byteLength(content, 'utf8'), version };
}

/** 在 MEMORY.md 的 type 分组末尾插入一行；没有该分组就新建。 */
function appendIndex(indexText, type, line) {
  const lines = indexText.split('\n');
  const header = '## ' + type;
  let start = lines.findIndex((l) => l.trim() === header);
  if (start === -1) {
    const tail = indexText.replace(/\s*$/, '');
    return (tail ? tail + '\n\n' : '# Memory Index\n\n') + header + '\n' + line + '\n';
  }
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith('## ')) {
      end = i;
      break;
    }
  }
  let insertAt = end;
  while (insertAt > start + 1 && lines[insertAt - 1].trim() === '') insertAt--;
  lines.splice(insertAt, 0, line);
  return lines.join('\n');
}

function freeFileName(dir, base) {
  if (!fs.existsSync(path.join(dir, base))) return base;
  const ext = path.extname(base);
  const stem = base.slice(0, -ext.length);
  for (let n = 2; n < 1000; n++) {
    const candidate = stem + '-' + n + ext;
    if (!fs.existsSync(path.join(dir, candidate))) return candidate;
  }
  throw new Error('同名记忆太多，无法写入：' + base);
}

function syncMemories(params) {
  const src = findPartner(params.srcId);
  const dst = findPartner(params.dstId);
  if (src.id === dst.id) throw new Error('源伙伴和目标伙伴不能是同一个');

  const wanted = Array.isArray(params.files) ? params.files : [];
  if (wanted.length === 0) throw new Error('没有选中记忆');

  const srcDir = memoryDir(src);
  const dstDir = memoryDir(dst);
  fs.mkdirSync(dstDir, { recursive: true });

  const existing = new Set(readMemories(dst).map((m) => m.hash));
  const indexFile = path.join(dstDir, 'MEMORY.md');
  let indexText = fs.existsSync(indexFile) ? fs.readFileSync(indexFile, 'utf8') : '# Memory Index\n';

  const added = [];
  const skipped = [];
  const failed = [];

  for (const file of wanted) {
    if (!/^[a-zA-Z0-9_.-]+\.md$/.test(file) || file === 'MEMORY.md' || file === 'USER.md') {
      failed.push({ file, error: '文件名不合法' });
      continue;
    }
    const srcFile = path.join(srcDir, file);
    if (!fs.existsSync(srcFile)) {
      failed.push({ file, error: '源文件不存在' });
      continue;
    }
    try {
      const text = fs.readFileSync(srcFile, 'utf8');
      const parsed = parseMemory(text);
      const hash = bodyHash(parsed.body);
      if (existing.has(hash)) {
        skipped.push({ file, title: parsed.title });
        continue;
      }
      const target = freeFileName(dstDir, file);
      writeAtomic(path.join(dstDir, target), text);
      existing.add(hash);
      indexText = appendIndex(
        indexText,
        parsed.type,
        '- [' + target + '] ' + (parsed.title || target) + ' — ' + (parsed.description || '')
      );
      added.push({ file: target, title: parsed.title });
    } catch (err) {
      failed.push({ file, error: String((err && err.message) || err) });
    }
  }

  if (added.length > 0) writeAtomic(indexFile, indexText);
  return { ok: true, added, skipped, failed };
}

function deleteMemory(params) {
  const partner = findPartner(params.botId);
  const dir = memoryDir(partner);
  const file = String(params.file || '');
  if (!/^[a-zA-Z0-9_.-]+\.md$/.test(file) || file === 'MEMORY.md' || file === 'USER.md') {
    throw new Error('文件名不合法');
  }
  const target = path.join(dir, file);
  if (!fs.existsSync(target)) throw new Error('记忆不存在');
  fs.unlinkSync(target);

  const indexFile = path.join(dir, 'MEMORY.md');
  if (fs.existsSync(indexFile)) {
    const text = fs.readFileSync(indexFile, 'utf8');
    const next = text
      .split('\n')
      .filter((line) => line.indexOf('[' + file + ']') === -1)
      .join('\n');
    writeAtomic(indexFile, next);
  }
  return { ok: true, deleted: file };
}

function listBackups(params) {
  const dst = findPartner(params.dstId);
  const dir = botDir(dst.owner, dst.id);
  const backups = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith('SOUL.md.bak-'))
    .sort()
    .reverse()
    .map((f) => ({ file: f, bytes: safeSize(path.join(dir, f)) }));
  return { ok: true, backups };
}

function restoreSoul(params) {
  const dst = findPartner(params.dstId);
  const dir = botDir(dst.owner, dst.id);
  const file = String(params.file || '');
  if (!/^SOUL\.md\.bak-[0-9]{8}-[0-9]{6}$/.test(file)) throw new Error('备份文件名不合法');
  const backup = path.join(dir, file);
  if (!fs.existsSync(backup)) throw new Error('备份不存在：' + file);
  const current = backupSoul(dir);
  writeAtomic(path.join(dir, 'SOUL.md'), fs.readFileSync(backup, 'utf8'));
  return { ok: true, restored: file, backupOfCurrent: current };
}

// ── 方法表 ─────────────────────────────────────────────────────────────────

const handlers = {
  'partners/list': () => ({ ok: true, partners: listPartners() }),
  'partners/soul': (p) => {
    const partner = findPartner(p.botId);
    const text = fs.readFileSync(path.join(botDir(partner.owner, partner.id), 'SOUL.md'), 'utf8');
    return { ok: true, text, bytes: Buffer.byteLength(text, 'utf8') };
  },
  'partners/memories': (p) => {
    const partner = findPartner(p.botId);
    return { ok: true, memories: readMemories(partner) };
  },
  'sync/soul': syncSoul,
  'sync/memories': syncMemories,
  'memories/delete': deleteMemory,
  'sync/backups': listBackups,
  'sync/restore': restoreSoul
};

readline.createInterface({ input: process.stdin }).on('line', async (line) => {
  let request;
  try {
    request = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params } = request || {};
  const fn = handlers[method];
  if (!fn) {
    reply({ jsonrpc: '2.0', id, error: { code: -32601, message: 'Method not found: ' + method } });
    return;
  }
  try {
    reply({ jsonrpc: '2.0', id, result: await fn(params || {}) });
  } catch (err) {
    log(method + ' failed: ' + (err && err.stack ? err.stack : err));
    fail(id, (err && err.message) || err);
  }
});
