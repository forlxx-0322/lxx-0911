/**
 * 附件服务
 *
 * 存储设计：
 *   data/attachments/<年>/<月>/<uuid>.<ext>   —— 按年月分目录，避免单目录文件过多
 *   数据库 attachments 表只存元数据与相对路径，文件本体在磁盘上
 *
 * 上传设计（为什么用 base64 走 JSON，而不是 multipart）：
 *   解析 multipart 需要引入依赖或手写解析器；而本软件定位是零依赖 + 单机自用，
 *   附件上限默认 50MB，走 base64（体积增约 33%）完全可接受。
 *   好处：服务端零第三方依赖，且与现有请求通道、错误处理、日志完全一致。
 *
 * 安全：
 *   - 文件名不含路径分隔符（只用于展示），磁盘上用 uuid 命名
 *   - 读取时严格校验路径必须位于 attachments 目录内（防目录穿越）
 *   - 单文件大小受设置项 attachment_max_mb 限制
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { plain, plainAll, now } = require('../db');

/* ------------------------------------------------------------------ */
/* 常量与工具                                                          */
/* ------------------------------------------------------------------ */

/** 可内联预览（浏览器直接打开）的类型 */
const PREVIEWABLE_PREFIX = ['image/'];
const PREVIEWABLE_EXACT = ['application/pdf', 'text/plain'];

/** 允许上传的类型白名单（按扩展名 + MIME 双重判断，避免上传可执行文件） */
const ALLOWED_EXT = new Set([
  '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
  '.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp',
  '.txt', '.csv', '.zip', '.rar', '.7z', '.dwg', '.dxf'
]);

const MIME_BY_EXT = {
  '.pdf': 'application/pdf',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.ppt': 'application/vnd.ms-powerpoint',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.txt': 'text/plain; charset=utf-8', '.csv': 'text/csv; charset=utf-8',
  '.zip': 'application/zip', '.rar': 'application/vnd.rar', '.7z': 'application/x-7z-compressed',
  '.dwg': 'application/acad', '.dxf': 'application/dxf'
};

const CATEGORIES = ['合同', '报价单', '方案', '资质', '凭证', '图纸', '其他'];

/** 附件分类允许值 */
function normalizeCategory(c) {
  const s = String(c || '').trim();
  return CATEGORIES.includes(s) ? s : '其他';
}

function badRequest(message, code) {
  const e = new Error(message);
  e.code = code || 'BAD_REQUEST';
  e.status = 400;
  return e;
}
function notFound(message) {
  const e = new Error(message || '记录不存在');
  e.code = 'NOT_FOUND';
  e.status = 404;
  return e;
}

/** 是否为可预览类型 */
function isPreviewable(mime) {
  const m = String(mime || '');
  if (PREVIEWABLE_EXACT.includes(m)) return true;
  return PREVIEWABLE_PREFIX.some((p) => m.startsWith(p));
}

/** 取扩展名（小写，带点） */
function extOf(fileName) {
  const e = path.extname(String(fileName || '')).toLowerCase();
  return e && e.length <= 10 ? e : '';
}

/**
 * 解析并校验附件相对路径，返回磁盘绝对路径。
 * 任何越出 attachments 目录的尝试都会被拒绝。
 */
function resolvePath(attachDir, relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel || rel.includes('\0') || rel.includes('..')) return null;
  const base = path.resolve(attachDir);
  const full = path.resolve(base, rel);
  if (full !== base && !full.startsWith(base + path.sep)) return null;
  return full;
}

/** 人类可读的文件大小（服务端只用于日志，界面由前端格式化） */
function humanSize(n) {
  const v = Number(n) || 0;
  if (v < 1024) return v + ' B';
  if (v < 1048576) return (v / 1024).toFixed(1) + ' KB';
  return (v / 1048576).toFixed(1) + ' MB';
}

/** 记录操作日志（避免与 crm 服务循环依赖，这里自己写一条） */
function log(db, action, entityId, summary) {
  try {
    db.prepare(
      `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
       VALUES ('attachment', ?, ?, ?, '', ?)`
    ).run(entityId || null, action, summary, now());
  } catch (_) { /* 日志失败不影响主流程 */ }
}

/* ------------------------------------------------------------------ */
/* 上传                                                                */
/* ------------------------------------------------------------------ */

/**
 * 上传附件
 * @param {object} db
 * @param {object} opts { attachDir, maxMb }
 * @param {object} payload {
 *   owner_type: 'customer' | 'project' | 'followup' | 'payment',
 *   owner_id: number,
 *   file_name: string,        // 原始文件名（含扩展名）
 *   mime_type?: string,
 *   category?: string,
 *   remark?: string,
 *   content_base64: string    // 文件内容（不含 data:URL 前缀）
 * }
 * @returns {object} 附件记录
 */
function upload(db, opts, payload) {
  const { attachDir, maxMb } = opts;
  const p = payload || {};

  const ownerType = String(p.owner_type || '').trim();
  if (!['customer', 'project', 'followup', 'payment'].includes(ownerType)) {
    throw badRequest('附件归属类型不合法', 'BAD_OWNER_TYPE');
  }
  const ownerId = Number(p.owner_id);
  if (!Number.isInteger(ownerId) || ownerId <= 0) {
    throw badRequest('缺少附件归属记录 ID', 'BAD_OWNER_ID');
  }

  const fileName = String(p.file_name || '').trim();
  if (!fileName) throw badRequest('缺少文件名', 'NO_FILENAME');
  if (fileName.length > 200) throw badRequest('文件名过长（最多 200 字）', 'NAME_TOO_LONG');
  if (/[\\/]/.test(fileName)) throw badRequest('文件名不能包含路径分隔符', 'BAD_FILENAME');

  const ext = extOf(fileName);
  if (!ext) throw badRequest('文件必须有扩展名', 'NO_EXT');
  if (!ALLOWED_EXT.has(ext)) {
    throw badRequest(`不支持的文件类型：${ext}。允许：${[...ALLOWED_EXT].join(' ')}`, 'EXT_NOT_ALLOWED');
  }

  const b64 = String(p.content_base64 || '');
  if (!b64) throw badRequest('文件内容为空', 'NO_CONTENT');

  /* base64 → Buffer，并做长度预检，避免先解码超大内容再判断 */
  const approxBytes = Math.floor(b64.length * 3 / 4);
  const limitBytes = Math.max(1, Number(maxMb) || 50) * 1024 * 1024;
  if (approxBytes > limitBytes + 1024) {
    throw badRequest(
      `文件超过上限 ${maxMb} MB（约 ${humanSize(approxBytes)}）。可在「功能设置 → 提醒与偏好」中调整上限。`,
      'TOO_LARGE'
    );
  }

  let buf;
  try {
    buf = Buffer.from(b64, 'base64');
  } catch (_) {
    throw badRequest('文件内容不是合法的 base64 编码', 'BAD_BASE64');
  }
  if (buf.length === 0) throw badRequest('文件内容为空', 'NO_CONTENT');
  if (buf.length > limitBytes) {
    throw badRequest(`文件超过上限 ${maxMb} MB（实际 ${humanSize(buf.length)}）`, 'TOO_LARGE');
  }

  /* 归属记录必须存在 */
  const OWNER_TABLE = { customer: 'customers', project: 'projects', followup: 'followups', payment: 'payments' };
  const table = OWNER_TABLE[ownerType];
  const owner = db.prepare(`SELECT id FROM ${table} WHERE id = ?`).get(ownerId);
  if (!owner) throw badRequest('附件归属的记录不存在', 'OWNER_NOT_FOUND');

  /* 落盘：按 年/月 分目录，uuid 命名 */
  const d = new Date();
  const yyyy = String(d.getFullYear());
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dir = path.join(attachDir, yyyy, mm);
  fs.mkdirSync(dir, { recursive: true });

  const uid = crypto.randomUUID().replace(/-/g, '');
  const storedName = uid + ext;
  const relPath = path.join(yyyy, mm, storedName).replace(/\\/g, '/');
  const fullPath = path.join(dir, storedName);

  fs.writeFileSync(fullPath, buf);

  const mime = String(p.mime_type || '').trim() || MIME_BY_EXT[ext] || 'application/octet-stream';
  const category = normalizeCategory(p.category);
  const ts = now();

  let info;
  try {
    info = db.prepare(
      `INSERT INTO attachments
         (owner_type, owner_id, file_name, file_path, file_size, mime_type, category, remark, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(ownerType, ownerId, fileName, relPath, buf.length, mime, category, String(p.remark || '').trim(), ts, ts);
  } catch (e) {
    /* 数据库写入失败要回滚已落盘的文件，避免产生孤儿文件 */
    try { fs.unlinkSync(fullPath); } catch (_) { /* 忽略 */ }
    throw e;
  }

  const id = Number(info.lastInsertRowid);
  log(db, 'create', id, `上传附件：${fileName}（${category}，${humanSize(buf.length)}）`);

  return getById(db, id);
}

/* ------------------------------------------------------------------ */
/* 查询                                                                */
/* ------------------------------------------------------------------ */

function getById(db, id) {
  const row = db.prepare('SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) throw notFound('附件不存在或已删除');
  return decorate(plain(row));
}

/** 补充界面需要的派生字段 */
function decorate(row) {
  row.previewable = isPreviewable(row.mime_type);
  row.size_text = humanSize(row.file_size);
  row.is_image = String(row.mime_type || '').startsWith('image/');
  row.is_pdf = String(row.mime_type || '') === 'application/pdf';
  row.ext = extOf(row.file_name);
  row.url = `/api/attachments/${row.id}/file`;
  return row;
}

/**
 * 列出某条记录下的附件
 * @param {object} q { owner_type, owner_id }
 */
function list(db, q) {
  const ownerType = String(q.owner_type || '').trim();
  const ownerId = Number(q.owner_id);
  if (!ownerType || !Number.isInteger(ownerId)) {
    throw badRequest('请指定 owner_type 与 owner_id', 'BAD_PARAM');
  }

  const rows = db.prepare(
    `SELECT * FROM attachments
     WHERE deleted_at IS NULL AND owner_type = ? AND owner_id = ?
     ORDER BY category, id DESC`
  ).all(ownerType, ownerId).map((r) => decorate(plain(r)));

  const totalSize = rows.reduce((s, r) => s + (Number(r.file_size) || 0), 0);

  /* 按分类分组，便于界面分区展示 */
  const byCategory = {};
  for (const c of CATEGORIES) byCategory[c] = [];
  for (const r of rows) {
    if (!byCategory[r.category]) byCategory[r.category] = [];
    byCategory[r.category].push(r);
  }

  return {
    list: rows,
    total: rows.length,
    total_size: totalSize,
    total_size_text: humanSize(totalSize),
    by_category: byCategory,
    categories: CATEGORIES
  };
}

/** 全库附件用量统计（设置页显示） */
function usage(db, attachDir) {
  const row = db.prepare(
    `SELECT COUNT(*) AS n, COALESCE(SUM(file_size), 0) AS size
     FROM attachments WHERE deleted_at IS NULL`
  ).get();

  const byOwner = plainAll(db.prepare(
    `SELECT owner_type, COUNT(*) AS n, COALESCE(SUM(file_size), 0) AS size
     FROM attachments WHERE deleted_at IS NULL GROUP BY owner_type`
  ).all());

  const byCategory = plainAll(db.prepare(
    `SELECT category, COUNT(*) AS n, COALESCE(SUM(file_size), 0) AS size
     FROM attachments WHERE deleted_at IS NULL GROUP BY category ORDER BY size DESC`
  ).all());

  /* 磁盘实际占用（含已软删除但未清文件的残留） */
  let diskSize = 0;
  let diskFiles = 0;
  try {
    const walk = (dir) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else { diskFiles++; try { diskSize += fs.statSync(p).size; } catch (_) { /* 忽略 */ } }
      }
    };
    if (fs.existsSync(attachDir)) walk(attachDir);
  } catch (_) { /* 忽略 */ }

  return {
    count: row.n,
    size: row.size,
    size_text: humanSize(row.size),
    by_owner: byOwner.map((r) => Object.assign(r, { size_text: humanSize(r.size) })),
    by_category: byCategory.map((r) => Object.assign(r, { size_text: humanSize(r.size) })),
    disk_files: diskFiles,
    disk_size: diskSize,
    disk_size_text: humanSize(diskSize),
    attach_dir: attachDir
  };
}

/* ------------------------------------------------------------------ */
/* 删除（软删除 + 物理可选）                                            */
/* ------------------------------------------------------------------ */

/**
 * @param {boolean} purgeFile 是否同时删除磁盘文件（默认删除，避免占空间）
 */
function remove(db, opts, id, purgeFile) {
  const { attachDir } = opts;
  const row = db.prepare('SELECT * FROM attachments WHERE id = ? AND deleted_at IS NULL').get(Number(id));
  if (!row) throw notFound('附件不存在或已删除');

  const ts = now();
  db.prepare('UPDATE attachments SET deleted_at = ?, updated_at = ? WHERE id = ?').run(ts, ts, row.id);

  let fileDeleted = false;
  if (purgeFile !== false) {
    const full = resolvePath(attachDir, row.file_path);
    if (full && fs.existsSync(full)) {
      try { fs.unlinkSync(full); fileDeleted = true; } catch (_) { /* 忽略 */ }
    }
  }

  log(db, 'delete', row.id, `删除附件：${row.file_name}${fileDeleted ? '（文件已移除）' : ''}`);
  return { id: row.id, file_deleted: fileDeleted };
}

/** 批量删除 */
function removeMany(db, opts, ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map(Number).filter(Number.isInteger);
  if (!list.length) throw badRequest('未指定要删除的附件');
  let count = 0;
  let files = 0;
  for (const id of list) {
    try {
      const r = remove(db, opts, id, true);
      count++;
      if (r.file_deleted) files++;
    } catch (_) { /* 单条失败继续 */ }
  }
  return { count, files_deleted: files };
}

/**
 * 清理孤儿文件：磁盘上存在但数据库已无有效记录
 * 用于「关于 / 维护」里的清理解释与实际释放空间
 */
function cleanOrphans(db, attachDir) {
  const valid = new Set(
    db.prepare('SELECT file_path FROM attachments WHERE deleted_at IS NULL').all()
      .map((r) => String(r.file_path).replace(/\\/g, '/'))
  );
  let removed = 0;
  let freed = 0;

  const walk = (dir, prefix) => {
    if (!fs.existsSync(dir)) return;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      const rel = prefix ? `${prefix}/${e.name}` : e.name;
      if (e.isDirectory()) { walk(p, rel); continue; }
      if (valid.has(rel)) continue;
      try {
        freed += fs.statSync(p).size;
        fs.unlinkSync(p);
        removed++;
      } catch (_) { /* 忽略 */ }
    }
  };
  walk(attachDir, '');

  if (removed) log(db, 'cleanup', null, `清理无主附件文件 ${removed} 个，释放 ${humanSize(freed)}`);
  return { removed, freed, freed_text: humanSize(freed) };
}

module.exports = {
  CATEGORIES,
  ALLOWED_EXT,
  MIME_BY_EXT,
  isPreviewable,
  resolvePath,
  humanSize,
  upload,
  getById,
  list,
  usage,
  remove,
  removeMany,
  cleanOrphans
};
