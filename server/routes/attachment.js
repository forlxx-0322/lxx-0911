/**
 * 附件路由
 *
 * 约定：
 *   - 返回 { ok, data } / { ok:false, status, code, message } → 由 server.js 包装为 JSON
 *   - 返回 { __raw: 'file', ... } → 由 server.js 直接流式响应（用于下载/预览，不能走 JSON 包装）
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const attachment = require('../services/attachment');

const MIME_BY_EXT = attachment.MIME_BY_EXT;

function str(v) { return v === undefined || v === null ? '' : String(v); }

module.exports = async function attachmentRoutes(ctx) {
  const { db, method, pathname, query, body } = ctx;
  const segments = pathname.split('/').filter(Boolean);   // ['api','attachments','12','file']
  if (segments[1] !== 'attachments') return null;

  const ok = (data) => ({ ok: true, data });
  const fail = (status, code, message) => ({ ok: false, status, code, message });
  const opts = { attachDir: ctx.attachDir, maxMb: ctx.maxMb };

  const idSeg = segments[2];
  const action = segments[3] || '';
  const id = idSeg && /^\d+$/.test(idSeg) ? Number(idSeg) : null;

  /* ================= 列表 ================= */
  if (!idSeg && method === 'GET') {
    if (query.owner_type) return ok(attachment.list(db, query));
    return fail(400, 'BAD_PARAM', '请提供 owner_type 与 owner_id 参数');
  }

  /* ================= 上传 ================= */
  if (!idSeg && method === 'POST') {
    return ok(attachment.upload(db, opts, body || {}));
  }

  /* ================= 用量统计 ================= */
  if (idSeg === 'usage' && method === 'GET') {
    const u = attachment.usage(db, ctx.attachDir);
    u.max_mb = ctx.maxMb;
    return ok(u);
  }

  /* ================= 清理无主文件 ================= */
  if (idSeg === 'clean-orphans' && method === 'POST') {
    return ok(attachment.cleanOrphans(db, ctx.attachDir));
  }

  /* ================= 批量删除 ================= */
  if (idSeg === 'batch-delete' && method === 'POST') {
    return ok(attachment.removeMany(db, opts, (body || {}).ids));
  }

  /* ================= 单条操作 ================= */
  if (id) {
    /* 下载 / 内联预览 */
    if (action === 'file' && (method === 'GET' || method === 'HEAD')) {
      const row = attachment.getById(db, id);
      const full = attachment.resolvePath(ctx.attachDir, row.file_path);
      if (!full || !fs.existsSync(full)) {
        return fail(404, 'FILE_MISSING', '附件记录存在，但磁盘文件已丢失（可能被手工删除）');
      }
      const stat = fs.statSync(full);
      return {
        __raw: 'file',
        path: full,
        size: stat.size,
        mime: row.mime_type || MIME_BY_EXT[row.ext] || 'application/octet-stream',
        fileName: row.file_name,
        /* 图片与 PDF 内联显示，其余类型触发下载 */
        inline: attachment.isPreviewable(row.mime_type),
        cacheSeconds: 3600,
        etag: `"${crypto.createHash('sha1').update(`${row.id}-${stat.size}-${stat.mtimeMs}`).digest('hex').slice(0, 16)}"`,
        mtimeMs: stat.mtimeMs
      };
    }

    if (method === 'GET') return ok(attachment.getById(db, id));

    if (action === 'meta' && (method === 'PUT' || method === 'PATCH')) {
      const p = body || {};
      const sets = [];
      const params = [];
      if (p.category !== undefined) { sets.push('category = ?'); params.push(attachment.CATEGORIES.includes(str(p.category)) ? str(p.category) : '其他'); }
      if (p.remark !== undefined) { sets.push('remark = ?'); params.push(str(p.remark).trim()); }
      if (p.file_name !== undefined) {
        const nm = str(p.file_name).trim();
        if (!nm) return fail(400, 'BAD_PARAM', '文件名不能为空');
        if (/[\\/]/.test(nm)) return fail(400, 'BAD_PARAM', '文件名不能包含路径分隔符');
        sets.push('file_name = ?'); params.push(nm);
      }
      if (!sets.length) return ok(attachment.getById(db, id));
      sets.push('updated_at = ?');
      params.push(require('../db').now(), id);
      db.prepare(`UPDATE attachments SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      return ok(attachment.getById(db, id));
    }

    if (method === 'DELETE') {
      const purge = query.purge !== '0';
      return ok(attachment.remove(db, opts, id, purge));
    }
  }

  return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
};
