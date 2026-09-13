/**
 * 阶段四路由：首页总览 / 备份恢复 / 导入导出 / 操作日志 / 设置项
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const crm = require('../services/crm');
const dashboard = require('../services/dashboard');
const backup = require('../services/backup');
const excel = require('../services/excel');
const { now } = require('../db');

module.exports = async function systemRoutes(ctx) {
  const { db, method, pathname, query, body } = ctx;
  const segments = pathname.split('/').filter(Boolean);
  const root = segments[1] || '';
  const sub = segments[2] || '';
  const ok = (data) => ({ ok: true, data });
  const fail = (status, code, message) => ({ ok: false, status, code, message });

  /* ================= 首页总览 ================= */
  if (root === 'dashboard') {
    if (method === 'GET') return ok(dashboard.dashboard(db));
    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ================= 设置项 ================= */
  if (root === 'settings') {
    if (method === 'GET') {
      const rows = db.prepare('SELECT key, value, remark FROM settings ORDER BY key').all();
      const settings = {};
      const meta = {};
      for (const r of rows) {
        settings[r.key] = r.value;
        meta[r.key] = r.remark;
      }
      return ok({ settings, meta });
    }
    if (method === 'PUT' || method === 'POST') {
      const payload = body || {};
      const ts = now();
      const allowed = new Set(
        db.prepare('SELECT key FROM settings').all().map((r) => r.key)
      );
      const updated = [];
      db.exec('BEGIN');
      try {
        for (const [k, v] of Object.entries(payload)) {
          if (!allowed.has(k)) continue;   // 只允许改已知键，防止写入垃圾数据
          db.prepare('UPDATE settings SET value = ?, updated_at = ? WHERE key = ?')
            .run(String(v === null || v === undefined ? '' : v), ts, k);
          updated.push(k);
        }
        if (updated.length) {
          crm.logActivity(db, 'settings', null, 'update',
            `修改系统设置：${updated.join('、')}`, null);
        }
        db.exec('COMMIT');
      } catch (e) {
        try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
        throw e;
      }
      return ok({ updated });
    }
    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ================= 备份与恢复 ================= */
  if (root === 'backup') {
    const dirs = ctx.backupPaths;   // { backupDir, mirrorDir, dbFile, dataDir }

    if (sub === 'list' || (!sub && method === 'GET')) {
      const main = backup.listBackups(dirs.backupDir);
      const mirror = backup.listBackups(dirs.mirrorDir);
      const settings = ctx.getSettings();
      return ok({
        backups: main,
        mirror,
        backupDir: dirs.backupDir,
        mirrorDir: dirs.mirrorDir,
        keep: Number(settings.backup_keep) || 30,
        mirrorKeep: Number(settings.backup_mirror_keep) || 7,
        autoEnabled: settings.backup_auto === '1',
        lastBackupAt: main[0] ? main[0].createdAt : null,
        hasToday: backup.hasBackupToday(dirs.backupDir)
      });
    }

    if (sub === 'create' && method === 'POST') {
      const settings = ctx.getSettings();
      const r = await backup.createBackup({
        db,
        dbFile: dirs.dbFile,
        backupDir: dirs.backupDir,
        mirrorDir: dirs.mirrorDir,
        keep: Number(settings.backup_keep) || 30,
        mirrorKeep: Number(settings.backup_mirror_keep) || 7,
        reason: (body && body.reason) || '手动备份'
      });
      crm.logActivity(db, 'backup', null, 'create',
        `创建备份：${r.name}（${Math.round(r.size / 1024)} KB）`, null);
      return ok({
        name: r.name,
        size: r.size,
        mirrorPath: r.mirrorPath,
        rotatedOut: r.rotatedOut,
        manifest: r.manifest
      });
    }

    if (sub === 'verify' && method === 'POST') {
      const name = String((body || {}).name || '');
      const file = safeBackupPath(dirs, name);
      if (!file) return fail(400, 'BAD_NAME', '备份文件名不合法');
      return ok(backup.verifyBackup(file));
    }

    if (sub === 'restore' && method === 'POST') {
      const payload = body || {};
      const name = String(payload.name || '');
      const file = safeBackupPath(dirs, name);
      if (!file) return fail(400, 'BAD_NAME', '备份文件名不合法');
      if (!fs.existsSync(file)) return fail(404, 'NOT_FOUND', '备份文件不存在');

      /* 第一步：只校验并返回预览，不动数据 */
      const check = backup.verifyBackup(file);
      if (!check.ok) return fail(400, 'BAD_BACKUP', check.error);
      if (!payload.confirm) {
        return ok({
          needConfirm: true,
          verify: check,
          name,
          willReplace: {
            customers: db.prepare('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL').get().n,
            projects: db.prepare('SELECT COUNT(*) AS n FROM projects WHERE deleted_at IS NULL').get().n,
            tasks: db.prepare('SELECT COUNT(*) AS n FROM tasks WHERE deleted_at IS NULL').get().n
          }
        });
      }

      /* 第二步：执行恢复
         1) 先给当前库做一份「恢复前」备份（后悔药）
         2) 关闭连接（含 WAL 检查点）
         3) 用备份文件覆盖当前库，并清掉 WAL/SHM 残留
         4) 返回成功，由调用方提示用户重启（服务自行退出，启动器会拉起） */
      const settings = ctx.getSettings();
      const safety = await backup.createBackup({
        db,
        dbFile: dirs.dbFile,
        backupDir: dirs.backupDir,
        mirrorDir: dirs.mirrorDir,
        keep: Number(settings.backup_keep) || 30,
        mirrorKeep: Number(settings.backup_mirror_keep) || 7,
        reason: `恢复「${name}」之前的自动备份`
      });

      ctx.prepareRestore();
      fs.copyFileSync(file, dirs.dbFile);
      for (const suffix of ['-wal', '-shm']) {
        const f = dirs.dbFile + suffix;
        try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch (_) { /* 忽略 */ }
      }
      return ok({
        restored: true,
        from: name,
        safetyBackup: safety.name,
        verify: check,
        needRestart: true
      });
    }

    if (sub === 'delete' && method === 'POST') {
      const name = String((body || {}).name || '');
      const file = safeBackupPath(dirs, name);
      if (!file || !fs.existsSync(file)) return fail(404, 'NOT_FOUND', '备份文件不存在');
      /* 只允许删非当日最新的一份，避免把最后一道保险删掉 */
      const list = backup.listBackups(dirs.backupDir);
      if (list.length && list[0].name === name) {
        return fail(400, 'KEEP_LATEST', '最新一份备份不允许删除（它是当前唯一的保险）');
      }
      fs.unlinkSync(file);
      const mf = file.replace(/\.db$/, '.json');
      try { if (fs.existsSync(mf)) fs.unlinkSync(mf); } catch (_) { /* 忽略 */ }
      const mirrorFile = path.join(dirs.mirrorDir, name);
      try { if (fs.existsSync(mirrorFile)) fs.unlinkSync(mirrorFile); } catch (_) { /* 忽略 */ }
      crm.logActivity(db, 'backup', null, 'delete', `删除备份：${name}`, null);
      return ok({ deleted: true, name });
    }

    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ================= 导入导出 ================= */
  if (root === 'data') {
    /* 列定义 / 模板（带字典可选值，供生成「可选值参考」页） */
    if (sub === 'template' && method === 'GET') {
      return ok(excel.getTemplate(db, query.entity || 'customer'));
    }

    /* 导出 */
    if (sub === 'export' && (method === 'GET' || method === 'POST')) {
      const entity = (method === 'POST' ? (body || {}).entity : query.entity) || 'customer';
      const opts = method === 'POST' ? (body || {}) : query;
      const r = excel.exportData(db, entity, opts);
      if (method === 'POST') {
        crm.logActivity(db, 'export', null, 'export',
          `导出${r.label}数据 ${r.count} 条`, null);
      }
      return ok(r);
    }

    /* 导入：预校验（duplicate_mode 决定重名行算"跳过"还是"更新"） */
    if (sub === 'preview' && method === 'POST') {
      const payload = body || {};
      return ok(excel.validateRows(db, payload.entity || 'customer', payload.rows || [], {
        duplicateMode: payload.duplicate_mode
      }));
    }

    /* 导入：执行 */
    if (sub === 'import' && method === 'POST') {
      const payload = body || {};
      const report = excel.runImport(db, payload.entity || 'customer', payload.rows || [], {
        duplicateMode: payload.duplicate_mode
      });
      return ok(report);
    }

    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  /* ================= 操作日志 ================= */
  if (root === 'logs') {
    if (method === 'GET') return ok(crm.listLogs(db, query));
    if (sub === 'clear' && method === 'POST') {
      const days = Number((body || {}).keepDays);
      if (!Number.isFinite(days) || days < 0) {
        return fail(400, 'BAD_PARAM', '请指定保留天数');
      }
      const info = db.prepare(
        `DELETE FROM activity_logs WHERE created_at < datetime('now','localtime', ?)`
      ).run(`-${days} days`);
      return ok({ removed: Number(info.changes || 0), keepDays: days });
    }
    return fail(404, 'API_NOT_FOUND', '接口不存在：' + pathname);
  }

  return null;
};

/** 防目录穿越：备份文件名必须是 data/backups 下的普通文件名 */
function safeBackupPath(dirs, name) {
  if (!name || typeof name !== 'string') return null;
  if (name.includes('/') || name.includes('\\') || name.includes('..')) return null;
  if (!name.endsWith('.db')) return null;
  const full = path.resolve(dirs.backupDir, name);
  const base = path.resolve(dirs.backupDir);
  if (!full.startsWith(base + path.sep)) return null;
  return full;
}
