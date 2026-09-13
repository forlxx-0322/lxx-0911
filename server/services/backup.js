/**
 * 备份与恢复服务
 *
 * 策略（方案第 5、8 节）：
 *   1. 每日首次启动自动备份一次；当天已备份则跳过
 *   2. 主备份目录 data/backups 保留最近 N 份（默认 30）
 *   3. 同时写一份到 data/backups/mirror 保留最近 M 份（默认 7）——双份副本防误删与硬盘故障
 *   4. 每份备份附一个 .json 清单，记录时间、结构版本、各表行数，便于核对完整性
 *   5. 从备份恢复前，先自动备份当前库，再替换并校验，避免「恢复把数据搞丢」
 *
 * 备份用 SQLite 官方 backup API（node:sqlite 的 db.backup），
 * 它是页级一致性快照，比直接复制文件更安全（无需担心 WAL 未落盘）。
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync, backup: sqliteBackup } = require('node:sqlite');
const { now } = require('../db');

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

/**
 * 备份文件名时间戳：精确到毫秒，并带一个短随机后缀。
 *
 * 为什么必须精确到毫秒：备份文件名原来只到秒。
 * 恢复流程会「先给当前库做一份兜底备份、再用选中的备份覆盖数据库」——
 * 若两者落在同一秒，兜底备份会覆盖掉恢复源文件，
 * 恢复出错时后悔药就没了（实测踩到过）。
 */
function stamp(d) {
  const t = d || new Date();
  const p = (n, w = 2) => String(n).padStart(w, '0');
  const ms = String(t.getMilliseconds()).padStart(3, '0');
  const rnd = Math.floor(Math.random() * 256).toString(16).padStart(2, '0');
  return `${t.getFullYear()}${p(t.getMonth() + 1)}${p(t.getDate())}`
    + `-${p(t.getHours())}${p(t.getMinutes())}${p(t.getSeconds())}-${ms}${rnd}`;
}

function humanTime(iso) {
  return String(iso || '').replace('T', ' ').slice(0, 19);
}

/** 列出目录中的备份文件（按时间倒序） */
function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.db'))
    .map((f) => {
      const full = path.join(dir, f);
      let st = null;
      try { st = fs.statSync(full); } catch (_) { return null; }
      const manifestFile = full.replace(/\.db$/, '.json');
      let manifest = null;
      try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch (_) { manifest = null; }
      return {
        name: f,
        path: full,
        size: st.size,
        createdAt: st.mtime.toISOString(),
        createdAtText: humanTime(st.mtime.toISOString()),
        manifest
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** 按保留份数轮转删除旧备份 */
function rotate(dir, keep) {
  const files = listBackups(dir);
  const removed = [];
  for (const f of files.slice(keep)) {
    try {
      fs.unlinkSync(f.path);
      const mf = f.path.replace(/\.db$/, '.json');
      if (fs.existsSync(mf)) fs.unlinkSync(mf);
      removed.push(f.name);
    } catch (_) { /* 忽略单个文件失败 */ }
  }
  return removed;
}

/** 统计各表行数，写入清单便于核对 */
function tableStats(db) {
  const tables = db.prepare(
    `SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  ).all().map((r) => r.name);
  const stats = {};
  for (const t of tables) {
    try { stats[t] = db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n; } catch (_) { stats[t] = -1; }
  }
  return stats;
}

/* ------------------------------------------------------------------ */
/* 创建备份                                                            */
/* ------------------------------------------------------------------ */

/**
 * 创建一份备份
 * @param {object} opts
 *   db        当前数据库连接
 *   dbFile    数据库文件路径
 *   backupDir 主备份目录
 *   mirrorDir 镜像备份目录（可空）
 *   keep      主目录保留份数
 *   mirrorKeep 镜像保留份数
 *   reason    备份原因备注（如「每日自动」「手动」「迁移前」）
 * @returns {Promise<{name, path, mirrorPath, size, manifest}>}
 */
async function createBackup(opts) {
  const { db, dbFile, backupDir, mirrorDir, keep, mirrorKeep, reason } = opts;
  fs.mkdirSync(backupDir, { recursive: true });

  const name = `crm-${stamp()}.db`;
  const target = path.join(backupDir, name);

  /* 双保险：即便时间戳算法将来变化，也不允许覆盖已有备份 */
  if (fs.existsSync(target)) {
    let n = 1;
    let alt;
    do {
      alt = target.replace(/\.db$/, `-${n}.db`);
      n++;
    } while (fs.existsSync(alt) && n < 1000);
    fs.renameSync(target, alt);   // 理论上不会走到这里
  }

  /* 页级一致性快照。
     注意：node:sqlite 的备份是**模块级函数** backup(db, destPath)，
     不是 db.backup(path) 实例方法（实测实例上没有该方法）。 */
  await sqliteBackup(db, target);

  const st = fs.statSync(target);
  const manifest = {
    createdAt: new Date().toISOString(),
    createdAtText: humanTime(new Date().toISOString()),
    reason: reason || '手动备份',
    schemaVersion: (() => {
      try { return db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v; } catch (_) { return null; }
    })(),
    tables: tableStats(db),
    appVersion: '1.0.0'
  };
  fs.writeFileSync(target.replace(/\.db$/, '.json'), JSON.stringify(manifest, null, 2), 'utf8');

  /* 镜像副本（第二份，防误删与硬盘故障） */
  let mirrorPath = null;
  if (mirrorDir) {
    try {
      fs.mkdirSync(mirrorDir, { recursive: true });
      mirrorPath = path.join(mirrorDir, name);
      fs.copyFileSync(target, mirrorPath);
      fs.writeFileSync(mirrorPath.replace(/\.db$/, '.json'), JSON.stringify(manifest, null, 2), 'utf8');
      rotate(mirrorDir, Math.max(1, Number(mirrorKeep) || 7));
    } catch (e) {
      mirrorPath = null;
    }
  }

  const removed = rotate(backupDir, Math.max(1, Number(keep) || 30));

  return {
    name,
    path: target,
    mirrorPath,
    size: st.size,
    manifest,
    rotatedOut: removed.length
  };
}

/** 当天是否已经备份过 */
function hasBackupToday(backupDir) {
  const list = listBackups(backupDir);
  if (!list.length) return false;
  const today = new Date().toISOString().slice(0, 10);
  return list.some((b) => String(b.createdAt).slice(0, 10) === today);
}

/**
 * 启动时调用：当天没备份过就自动备份一次
 * @returns {Promise<object|null>} 备份结果，跳过时返回 null
 */
async function autoBackupOnStart(opts) {
  const { backupDir, enabled } = opts;
  if (!enabled) return { skipped: true, reason: '自动备份已关闭' };
  if (hasBackupToday(backupDir)) return { skipped: true, reason: '今天已经备份过了' };
  const r = await createBackup(Object.assign({}, opts, { reason: '每日自动备份' }));
  return Object.assign({ skipped: false }, r);
}

/* ------------------------------------------------------------------ */
/* 从备份恢复                                                          */
/* ------------------------------------------------------------------ */

/**
 * 校验备份文件是否为可用的数据库
 * @returns {{ok:boolean, error?:string, tables?:number, customers?:number, version?:number}}
 */
function verifyBackup(file) {
  if (!fs.existsSync(file)) return { ok: false, error: '备份文件不存在' };
  let probe = null;
  try {
    probe = new DatabaseSync(file, { readOnly: true });
    const integrity = probe.prepare('PRAGMA integrity_check').get();
    if (!integrity || integrity.integrity_check !== 'ok') {
      return { ok: false, error: '备份文件完整性校验未通过：' + JSON.stringify(integrity) };
    }
    const hasCustomers = probe.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='customers'"
    ).get().n;
    if (!hasCustomers) return { ok: false, error: '备份文件缺少 customers 表，可能不是本软件的备份' };
    const tables = probe.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"
    ).get().n;
    const customers = probe.prepare('SELECT COUNT(*) AS n FROM customers').get().n;
    let version = null;
    try { version = probe.prepare('SELECT MAX(version) AS v FROM schema_version').get().v; } catch (_) { /* 旧库可能无此表 */ }
    return { ok: true, tables, customers, version };
  } catch (e) {
    return { ok: false, error: '无法读取备份文件：' + e.message };
  } finally {
    try { if (probe) probe.close(); } catch (_) { /* 忽略 */ }
  }
}

module.exports = {
  listBackups,
  createBackup,
  hasBackupToday,
  autoBackupOnStart,
  verifyBackup,
  rotate,
  tableStats,
  humanTime
};
