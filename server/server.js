/**
 * HTTP 服务 —— 客户管理系统
 *
 * 零依赖：仅使用 Node 内置模块（http / fs / path / url）。
 * 职责：
 *   1. 提供 REST API（当前阶段：健康检查、状态、优雅退出）
 *   2. 提供 web/ 目录下的静态文件
 *   3. 单实例锁（.run.json + 进程存活探测）
 *
 * 启动方式：由 启动.bat 调用，传入 ROOT 环境变量指向项目根目录。
 */

'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { initDatabase, getSettings, closeDatabase } = require('./db');
const crmRoutes = require('./routes/crm');
const pmRoutes = require('./routes/pm');
const systemRoutes = require('./routes/system');
const attachmentRoutes = require('./routes/attachment');
const mapRoutes = require('./routes/map');
const collectRoutes = require('./routes/collect');
const remindersRoutes = require('./routes/reminders');
const quotationRoutes = require('./routes/quotation');
const quotationTemplateRoutes = require('./routes/quotation-template');
const quotationFieldRoutes = require('./routes/quotation-field');
const backupService = require('./services/backup');

/* ------------------------------------------------------------------ */
/* 路径与常量                                                          */
/* ------------------------------------------------------------------ */

const ROOT = process.env.CRM_ROOT || path.resolve(__dirname, '..');
const WEB_DIR = path.join(ROOT, 'web');
const DATA_DIR = path.join(ROOT, 'data');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');
const MIRROR_DIR = path.join(BACKUP_DIR, 'mirror');
const ATTACH_DIR = path.join(DATA_DIR, 'attachments');
const DB_FILE = path.join(DATA_DIR, 'crm.db');
const RUN_FILE = path.join(DATA_DIR, '.run.json');

/** 本软件的标识串 —— 用于单实例判定时确认"这是我们自己的服务" */
const APP_SIGNATURE = 'crm-bjxt/1';
/** 应用版本号：每次功能修改或 Bug 修复后递增，并在 CHANGELOG.md 归档 */
const APP_VERSION = '1.16';
/** 扫描端口的范围：服务端从 CRM_PORT 起向后扫描这么多端口（启动器不再预检端口） */
const PORT_SCAN_RANGE = 11;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.pdf': 'application/pdf'
};

/** 静态缓存策略：vendor 下带版本号参数，可长缓存；其余禁用缓存便于开发 */
const LONG_CACHE_EXT = new Set(['.woff', '.woff2', '.ttf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico']);

const MAX_BODY_BYTES = 220 * 1024 * 1024; // 220MB 请求体上限（容纳 base64 编码后的 50MB 附件 + 余量）

/* ------------------------------------------------------------------ */
/* 启动：准备目录、数据库、单实例                                     */
/* ------------------------------------------------------------------ */

function parsePort() {
  const raw = process.env.CRM_PORT || process.argv[2] || '8899';
  const port = Number.parseInt(raw, 10);
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : 8899;
}

function prepareDirs() {
  for (const dir of [DATA_DIR, BACKUP_DIR, MIRROR_DIR, ATTACH_DIR]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

/** 查询某个端口上是否运行着本软件的服务 */
async function probePort(port) {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 900);
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) return null;
    const body = await res.json();
    // 必须确认是本软件的服务，避免误判同端口的其他程序
    if (body && body.ok === true && body.data && body.data.app === APP_SIGNATURE) {
      return { port, pid: body.data.pid, data: body.data };
    }
  } catch (_) {
    return null;
  }
  return null;
}

/** 读取 .run.json（仅作为快速路径） */
function readRunFile() {
  try {
    return JSON.parse(fs.readFileSync(RUN_FILE, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * 探测已运行实例。
 * 不依赖 .run.json 是否存在——锁文件可能被手工删除或被异常退出的进程清掉，
 * 因此改为：先试锁文件记录的端口（快），再依次扫描候选端口区间（稳）。
 */
async function probeExisting(preferredPort) {
  const info = readRunFile();
  if (info && info.port) {
    const hit = await probePort(info.port);
    if (hit) return hit;
  }

  const start = Number.isInteger(preferredPort) ? preferredPort : 8899;
  for (let p = start; p <= start + PORT_SCAN_RANGE; p++) {
    const hit = await probePort(p);
    if (hit) return hit;
  }
  return null;
}

/**
 * 直接流式发送文件（用于附件下载与内联预览）。
 * 支持：
 *   - HTTP Range 请求（206 Partial Content）—— PDF 在浏览器里翻页预览必需
 *   - ETag 条件请求（304）
 *   - Content-Disposition inline / attachment
 */
function sendFile(req, res, spec) {
  let stat;
  try {
    stat = fs.statSync(spec.path);
  } catch (_) {
    return fail(res, 404, 'FILE_MISSING', '文件不存在');
  }

  const total = stat.size;
  const etag = spec.etag;

  if (etag && req.headers['if-none-match'] === etag) {
    res.writeHead(304, { 'ETag': etag, 'Cache-Control': 'no-cache' });
    return res.end();
  }

  const ext = path.extname(spec.path).toLowerCase();
  /* 文件名里的中文需要按 RFC 5987 编码，否则部分浏览器会显示乱码 */
  const encodedName = encodeURIComponent(spec.fileName || path.basename(spec.path));
  const disposition = `${spec.inline ? 'inline' : 'attachment'}; filename="${encodedName}"; filename*=UTF-8''${encodedName}`;

  const baseHeaders = {
    'Content-Type': spec.mime || MIME[ext] || 'application/octet-stream',
    'Content-Disposition': disposition,
    'Accept-Ranges': 'bytes',
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': `private, max-age=${spec.cacheSeconds || 0}, no-transform`
  };
  if (etag) baseHeaders['ETag'] = etag;

  /* 解析 Range */
  const rangeHeader = req.headers.range;
  let start = 0;
  let end = total - 1;
  let partial = false;

  if (rangeHeader && /^bytes=/.test(rangeHeader)) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim());
    if (m) {
      const hasStart = m[1] !== '';
      const hasEnd = m[2] !== '';
      if (hasStart) {
        start = parseInt(m[1], 10);
        end = hasEnd ? parseInt(m[2], 10) : total - 1;
      } else if (hasEnd) {
        /* bytes=-N 表示最后 N 字节 */
        const n = parseInt(m[2], 10);
        start = Math.max(0, total - n);
        end = total - 1;
      }
      if (isNaN(start) || isNaN(end) || start > end || start >= total) {
        res.writeHead(416, Object.assign({}, baseHeaders, { 'Content-Range': `bytes */${total}` }));
        return res.end();
      }
      if (end >= total) end = total - 1;
      partial = !(start === 0 && end === total - 1);
    }
  }

  const length = end - start + 1;
  const headers = Object.assign({}, baseHeaders, { 'Content-Length': length });
  if (partial) headers['Content-Range'] = `bytes ${start}-${end}/${total}`;

  if (spec.mtimeMs) headers['Last-Modified'] = new Date(spec.mtimeMs).toUTCString();

  res.writeHead(partial ? 206 : 200, headers);
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(spec.path, { start, end });
  stream.on('error', () => { try { res.destroy(); } catch (_) { /* 忽略 */ } });
  stream.pipe(res);
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function sendJson(res, status, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': body.length,
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function ok(res, data) {
  sendJson(res, 200, { ok: true, data });
}

function fail(res, status, code, message) {
  sendJson(res, status, { ok: false, code, message });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('请求体过大'), { code: 'BODY_TOO_LARGE' }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ------------------------------------------------------------------ */
/* 静态文件服务                                                        */
/* ------------------------------------------------------------------ */

/**
 * 安全解析静态文件路径：
 *   1. 百分号解码（处理中文文件名）
 *   2. 拒绝含 \0 的路径
 *   3. 拼接后确认仍位于 WEB_DIR 之内（阻止 ../ 越权访问）
 */
function safeResolve(urlPath) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch (_) {
    return null; // 非法百分号编码
  }
  if (decoded.includes('\0')) return null;

  const rel = decoded.replace(/^\/+/, '');
  const full = path.resolve(WEB_DIR, rel);
  const base = path.resolve(WEB_DIR);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

function serveStatic(req, res, urlPath) {
  let target = safeResolve(urlPath);
  if (!target) return fail(res, 400, 'BAD_PATH', '非法路径');

  let stat;
  try {
    stat = fs.statSync(target);
  } catch (_) {
    return fail(res, 404, 'NOT_FOUND', '文件不存在');
  }

  if (stat.isDirectory()) {
    target = path.join(target, 'index.html');
    try {
      stat = fs.statSync(target);
    } catch (_) {
      return fail(res, 404, 'NOT_FOUND', '目录下无 index.html');
    }
  }

  const ext = path.extname(target).toLowerCase();
  const isVendor = target.includes(`${path.sep}vendor${path.sep}`);
  const headers = {
    'Content-Type': MIME[ext] || 'application/octet-stream',
    'Content-Length': stat.size,
    'X-Content-Type-Options': 'nosniff'
  };
  if (isVendor && LONG_CACHE_EXT.has(ext)) {
    headers['Cache-Control'] = 'public, max-age=604800, immutable';
  } else if (isVendor) {
    headers['Cache-Control'] = 'public, max-age=86400';
  } else {
    headers['Cache-Control'] = 'no-store, must-revalidate';
  }

  res.writeHead(200, headers);
  if (req.method === 'HEAD') return res.end();

  const stream = fs.createReadStream(target);
  stream.on('error', () => { try { res.destroy(); } catch (_) { /* 忽略 */ } });
  stream.pipe(res);
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const startedAt = Date.now();

function buildRouter(ctx) {
  return async function route(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1');
    const pathname = url.pathname;
    const method = req.method || 'GET';

    /* ---------- API ---------- */
    if (pathname.startsWith('/api/')) {

      if (pathname === '/api/health' && (method === 'GET' || method === 'HEAD')) {
        return ok(res, {
          app: APP_SIGNATURE,
          status: 'running',
          version: APP_VERSION,
          pid: process.pid,
          port: ctx.port,
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
          time: new Date().toISOString()
        });
      }

      if (pathname === '/api/status' && method === 'GET') {
        const settings = getSettings(ctx.db);
        const dictStats = ctx.db.prepare(
          `SELECT category, COUNT(*) AS n FROM dict
           WHERE deleted_at IS NULL AND enabled = 1 GROUP BY category ORDER BY category`
        ).all().map((r) => Object.assign({}, r));
        const tables = ctx.db.prepare(
          `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
        ).all().map((r) => r.name);
        return ok(res, {
          app: APP_SIGNATURE,
          version: APP_VERSION,
          schemaVersion: ctx.dbInfo.schemaVersion,
          dbCreated: ctx.dbInfo.created,
          dbPath: DB_FILE,
          dataDir: DATA_DIR,
          tables,
          tableCount: tables.length,
          dictCategories: dictStats.length,
          dictItems: dictStats.reduce((s, r) => s + r.n, 0),
          dictStat: dictStats,
          settings,
          node: process.version,
          platform: `${process.platform} ${process.arch}`,
          startedAt: new Date(startedAt).toISOString(),
          uptimeSec: Math.floor((Date.now() - startedAt) / 1000)
        });
      }

      if (pathname === '/api/open-data-dir' && method === 'POST') {
        // 仅允许本机调用；在资源管理器中打开数据目录，便于手动拷贝备份
        const ip = req.socket.remoteAddress || '';
        const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
        if (!local) return fail(res, 403, 'FORBIDDEN', '仅允许本机调用');
        try {
          const { spawn } = require('node:child_process');
          spawn('explorer.exe', [DATA_DIR], { detached: true, stdio: 'ignore' }).unref();
          return ok(res, { message: '已打开数据目录', path: DATA_DIR });
        } catch (e) {
          return fail(res, 500, 'OPEN_FAILED', '打开目录失败：' + (e.message || '未知错误'));
        }
      }

      if (pathname === '/api/shutdown' && method === 'POST') {
        // 仅允许本机调用
        const ip = req.socket.remoteAddress || '';
        const local = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1';
        if (!local) return fail(res, 403, 'FORBIDDEN', '仅允许本机调用');
        ok(res, { message: '服务正在停止' });
        setTimeout(() => gracefulExit('收到停止指令'), 120);
        return;
      }

      /* ---------- 业务接口：客户 / 联系人 / 跟进 / 标签 / 字典 / 回收站 ---------- */
      const raw = await readBody(req);
      let parsedBody = null;
      if (raw) {
        try {
          parsedBody = JSON.parse(raw);
        } catch (_) {
          return fail(res, 400, 'BAD_JSON', '请求体不是合法的 JSON');
        }
      }

      const routeCtx = {
        db: ctx.db,
        method,
        pathname,
        query: Object.fromEntries(url.searchParams.entries()),
        body: parsedBody,
        root: ROOT,
        /* 阶段四：备份与设置需要的上下文 */
        backupPaths: {
          backupDir: BACKUP_DIR,
          mirrorDir: MIRROR_DIR,
          dbFile: DB_FILE,
          dataDir: DATA_DIR
        },
        getSettings: () => getSettings(ctx.db),
        /* 阶段五：附件需要的上下文 */
        attachDir: ATTACH_DIR,
        maxMb: Number(getSettings(ctx.db).attachment_max_mb) || 50,
        req,
        res,
        /* 恢复数据前调用：关闭数据库连接并做 WAL 检查点，避免恢复后数据被覆盖 */
        prepareRestore: () => {
          try { closeDatabase(ctx.db); } catch (_) { /* 忽略 */ }
          ctx.db = null;
          ctx.pendingRestart = true;
          console.log('\n[恢复] 数据库已从备份还原。');
          console.log('[恢复] 服务将在 2 秒后自动重启以加载还原后的数据…');
          setTimeout(() => {
            clearRunFile();
            process.exit(4);   // 退出码 4 表示"需要重启"，供启动器识别
          }, 2000);
        }
      };

      /* 依次尝试各模块路由，返回 null 表示未命中 */
      const handlers = [crmRoutes, pmRoutes, systemRoutes, attachmentRoutes, mapRoutes, collectRoutes, remindersRoutes, quotationRoutes, quotationTemplateRoutes, quotationFieldRoutes];
      for (const handler of handlers) {
        const handled = await handler(routeCtx);

        /* 原始响应（文件流）：直接发送，不套 JSON 包装 */
        if (handled && handled.__raw === 'file') {
          return sendFile(req, res, handled);
        }
        if (handled && handled.__raw === 'buffer') {
          res.writeHead(handled.status || 200, handled.headers || {});
          return res.end(handled.body);
        }

        if (handled && handled.ok === true) return ok(res, handled.data);
        if (handled && handled.ok === false) {
          return fail(res, handled.status || 400, handled.code || 'BAD_REQUEST', handled.message || '请求失败');
        }
      }

      return fail(res, 404, 'API_NOT_FOUND', `接口不存在：${pathname}`);
    }

    /* ---------- 静态文件 ---------- */
    if (method === 'GET' || method === 'HEAD') {
      return serveStatic(req, res, pathname);
    }

    return fail(res, 405, 'METHOD_NOT_ALLOWED', `不支持的方法：${method}`);
  };
}

/* ------------------------------------------------------------------ */
/* 启动与退出                                                          */
/* ------------------------------------------------------------------ */

let shuttingDown = false;
/** 只有本进程成功写入过 .run.json，才有资格清理它 */
let ownsRunFile = false;

function writeRunFile(info) {
  fs.writeFileSync(RUN_FILE, JSON.stringify(info, null, 2), 'utf8');
  ownsRunFile = true;
}

function clearRunFile() {
  if (!ownsRunFile) return;   // 绝不删除别人（或上一个实例）的锁文件
  try {
    if (fs.existsSync(RUN_FILE)) fs.unlinkSync(RUN_FILE);
  } catch (_) { /* 忽略 */ }
  ownsRunFile = false;
}

function gracefulExit(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n[${new Date().toLocaleTimeString('zh-CN')}] 正在停止服务：${reason}`);
  try { ctx.server && ctx.server.close(); } catch (_) { /* 忽略 */ }
  try { closeDatabase(ctx.db); } catch (_) { /* 忽略 */ }
  clearRunFile();
  console.log('数据已安全落盘，服务已停止。');
  process.exit(0);
}

const ctx = { db: null, dbInfo: null, server: null, port: 0 };

async function main() {
  const port = parsePort();

  /* 单实例判定：已在运行则告知并退出，由 .bat 负责打开浏览器 */
  const existing = await probeExisting(port);
  if (existing) {
    console.log('');
    console.log('  [提示] 服务已经在运行了，无需重复启动。');
    console.log(`         运行端口：${existing.port}    进程号：${existing.pid}`);
    console.log(`         访问地址：http://127.0.0.1:${existing.port}`);
    console.log('         如需停止，请关闭原来的服务窗口，或双击「停止.bat」。');
    console.log('');
    process.exit(0);
  }

  prepareDirs();

  /* 初始化数据库 */
  const info = initDatabase({ dataDir: DATA_DIR, dbFile: DB_FILE, backupDir: BACKUP_DIR });
  ctx.db = info.db;
  ctx.dbInfo = { created: info.created, schemaVersion: info.schemaVersion };

  if (info.backedUpTo) {
    console.log(`[迁移] 升级前已自动备份到：${info.backedUpTo}`);
  }
  if (info.migrations && info.migrations.length) {
    console.log(`[迁移] 数据库结构已从 v${info.fromVersion} 升级到 v${info.schemaVersion}：`);
    for (const m of info.migrations) console.log(`        · ${m}`);
  }

  const router = buildRouter(ctx);

  /* 启动时做一次轻量数据归一化（幂等）：
     早期版本可能把待办的 customer_id / project_id 写成 0，
     这类行会让「未关联客户」的查询与地图/统计口径漏数据。 */
  try {
    const fixed = require('./services/pm').normalizeTaskLinks(ctx.db);
    if (fixed.customer_id || fixed.project_id) {
      console.log(`[数据] 已归一化历史待办关联：customer_id ${fixed.customer_id} 条、project_id ${fixed.project_id} 条`);
    }
  } catch (e) {
    console.error('[数据] 待办关联归一化失败（不影响使用）：', e.message);
  }

  /* 早期前端「归属地州」下拉把地州名当值提交，库里因此有过 region_code='克拉玛依市'
     这类数据，地图按编码聚合时就认不出来。这里统一纠正成编码。 */
  try {
    const fixed = require('./services/crm').fixLegacyRegionCodes(ctx.db);
    if (fixed) console.log(`[数据] 已纠正历史归属地州：${fixed} 条（原为地州名，现为编码）`);
  } catch (e) {
    console.error('[数据] 归属地州归一化失败（不影响使用）：', e.message);
  }

  /* 招标信息采集：每日首次启动时自动执行一次（附录 A.7 执行时机）
   *
   * 三重护栏，确保默认不联网：
   *   1. 来源默认全部 enabled=0 —— 没启用就什么也不做，启动完全零外部请求
   *   2. 24 小时节流 —— 当日已采集过直接跳过
   *   3. 延迟 8 秒执行 —— 不阻塞启动，也不与备份抢资源
   * 失败只记日志，绝不影响软件正常使用。 */
  setTimeout(() => {
    if (!ctx.db) return;                       // 期间可能已停机或正在恢复数据
    let enabledCount = 0;
    try {
      enabledCount = ctx.db.prepare(
        'SELECT COUNT(*) AS n FROM collect_sources WHERE deleted_at IS NULL AND enabled = 1'
      ).get().n;
    } catch (e) {
      /* v4 之前的库没有该表时会走到这里，静默跳过 */
      return;
    }
    if (!enabledCount) return;                 // 未启用任何来源 → 不做任何网络请求

    console.log(`[采集] 检测到 ${enabledCount} 个已启用的采集来源，开始每日采集…`);
    require('./collect/service.js').runCollect(ctx.db, {})
      .then((r) => {
        if (!r.results || !r.results.length) return;
        for (const x of r.results) {
          if (x.status === 'skipped') console.log(`[采集] ${x.sourceName}：${x.message}`);
          else if (x.status === 'failed') console.log(`[采集] ${x.sourceName} 失败：${x.message}`);
          else console.log(`[采集] ${x.sourceName}：${x.message}`);
        }
      })
      .catch((e) => console.error('[采集] 启动采集失败（不影响使用）：', e.message));
  }, 8000);

  /* ------------------------------------------------------------------ */
  /* 邮件提醒调度                                                        */
  /*                                                                     */
  /* 与招标采集同一套护栏：**未启用时不建立任何网络连接**。               */
  /* 启用后每 5 分钟检查一次：到了设定时间且当天没发过，就发一次当日提醒； */
  /* 当天没有待跟进客户时不会发空邮件。                                   */
  /* ------------------------------------------------------------------ */
  setTimeout(() => {
    const tick = () => {
      if (!ctx.db) return;                     // 期间可能已停机或正在恢复数据
      try {
        const s = getSettings(ctx.db);
        require('./notify').tick(ctx.db, s).then((r) => {
          if (r && r.data && r.data.sent) {
            console.log(`[提醒] 已发送当日跟进提醒：${r.data.count} 位客户 → ${r.data.to}`);
          } else if (r && r.message) {
            console.log(`[提醒] ${r.message}`);
          }
        }).catch((e) => console.error('[提醒] 发送失败（不影响使用）：', e.message));
      } catch (e) {
        /* 默认关闭时这里什么也不做；表/设置缺失也静默跳过 */
      }
    };
    /* 启动后先等 20 秒（避开启动高峰），之后每 5 分钟一次 */
    setTimeout(() => {
      tick();
      setInterval(tick, 5 * 60 * 1000).unref();
    }, 20000);
  }, 1000);

  /* 每日自动备份：当天没备份过就备一次（不阻塞启动） */
  const settings = getSettings(ctx.db);
  backupService.autoBackupOnStart({
    db: ctx.db,
    dbFile: DB_FILE,
    backupDir: BACKUP_DIR,
    mirrorDir: MIRROR_DIR,
    keep: Number(settings.backup_keep) || 30,
    mirrorKeep: Number(settings.backup_mirror_keep) || 7,
    enabled: settings.backup_auto === '1'
  }).then((r) => {
    if (!r) return;
    if (r.skipped) {
      console.log(`[备份] 已跳过每日自动备份：${r.reason}`);
    } else {
      console.log(`[备份] 已生成每日自动备份：${r.name}（${Math.round(r.size / 1024)} KB）`);
      if (r.mirrorPath) console.log(`[备份] 镜像副本：${path.basename(r.mirrorPath)}`);
      if (r.rotatedOut) console.log(`[备份] 按保留策略清理旧备份 ${r.rotatedOut} 份`);
    }
  }).catch((e) => {
    console.error('[备份] 自动备份失败（不影响使用）：', e.message);
  });

  ctx.server = http.createServer((req, res) => {
    Promise.resolve(router(req, res)).catch((err) => {
      const status = err && err.status ? err.status
        : (err && err.code === 'BODY_TOO_LARGE' ? 413 : 500);
      const code = (err && err.code) || 'INTERNAL';
      const message = (err && err.message) || '服务器内部错误';

      // 业务异常（4xx）只记一行；真正的内部错误才打印堆栈
      if (status >= 500) {
        console.error('[错误]', err && err.stack ? err.stack : err);
      } else {
        console.warn(`[业务提示] ${status} ${code} ${message}`);
      }

      if (!res.headersSent) {
        fail(res, status, code, message);
      } else {
        try { res.destroy(); } catch (_) { /* 忽略 */ }
      }
    });
  });

  ctx.server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`[错误] 端口 ${port} 已被占用。`);
      console.error('       请在 启动.bat 中改用其他端口（set PORT=8900），或关闭占用该端口的程序。');
    } else {
      console.error('[错误] 服务启动失败：', err && err.message);
    }
    try { closeDatabase(ctx.db); } catch (_) { /* 忽略 */ }
    clearRunFile();
    process.exit(1);
  });

  ctx.server.listen(port, '127.0.0.1', () => {
    ctx.port = port;
    writeRunFile({
      pid: process.pid,
      port,
      app: APP_SIGNATURE,
      version: APP_VERSION,
      startedAt: new Date().toISOString()
    });

    const url = `http://127.0.0.1:${port}`;
    console.log('');
    console.log('  客户管理系统 · 服务已启动');
    console.log('  ----------------------------------------');
    console.log(`  访问地址 : ${url}`);
    console.log(`  数据目录 : ${DATA_DIR}`);
    console.log(`  数据库   : ${DB_FILE}`);
    console.log(`  数据表   : ${info.tables} 张`);
    console.log(`  结构版本 : v${info.schemaVersion}`);
    console.log(`  本次建库 : ${info.created ? '是（全新数据库）' : '否（沿用已有数据）'}`);
    console.log(`  字典新增 : ${info.dictCount} 项`);
    console.log(`  Node     : ${process.version}`);
    console.log('  ----------------------------------------');
    console.log('  关闭本窗口即停止服务；也可双击 停止.bat');
    console.log('');
  });

  process.on('SIGINT', () => gracefulExit('收到 Ctrl+C / 窗口关闭信号'));
  process.on('SIGTERM', () => gracefulExit('收到终止信号'));
  process.on('uncaughtException', (err) => {
    console.error('[未捕获异常]', err && err.stack ? err.stack : err);
    gracefulExit('发生未捕获异常');
  });
}

main().catch((err) => {
  console.error('[致命错误] 启动失败：', err && err.stack ? err.stack : err);
  clearRunFile();
  process.exit(1);
});
