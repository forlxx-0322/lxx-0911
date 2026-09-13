/**
 * 在备份里找回被误删的客户数据。
 * 只读扫描各备份，报告哪些备份仍含该客户及其关联数据，不做任何写入。
 *
 * 用法：node tools/find-customer-in-backups.js [关键字]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const KEYWORD = process.argv[2] || '独山子石化';
const DIRS = [path.join(ROOT, 'data', 'backups'), path.join(ROOT, 'data', 'backups', 'mirror')];

const files = [];
for (const d of DIRS) {
  if (!fs.existsSync(d)) continue;
  for (const f of fs.readdirSync(d)) {
    if (f.endsWith('.db')) files.push({ dir: d, file: f, full: path.join(d, f), mtime: fs.statSync(path.join(d, f)).mtimeMs });
  }
}
files.sort((a, b) => b.mtime - a.mtime);

console.log(`扫描 ${files.length} 个备份，查找含「${KEYWORD}」的客户…\n`);

const hits = [];
for (const f of files) {
  let db = null;
  try {
    db = new DatabaseSync(f.full, { readOnly: true });
    const rows = db.prepare(
      'SELECT id, name, short_name, city, district, region_code, region_name, phone, longitude, latitude FROM customers WHERE name LIKE ? OR short_name LIKE ?'
    ).all(`%${KEYWORD}%`, `%${KEYWORD}%`);
    if (rows.length) {
      for (const r of rows) {
        /* 统计关联数据，判断恢复价值 */
        const n = (sql, ...p) => { try { return db.prepare(sql).get(...p).n; } catch (_) { return -1; } };
        hits.push({
          file: f.file,
          dir: path.basename(f.dir),
          when: new Date(f.mtime).toLocaleString('zh-CN'),
          customer: r,
          contacts: n('SELECT COUNT(*) AS n FROM contacts WHERE customer_id = ?', r.id),
          followups: n('SELECT COUNT(*) AS n FROM followups WHERE customer_id = ?', r.id),
          projects: n('SELECT COUNT(*) AS n FROM projects WHERE customer_id = ?', r.id),
          tasks: n('SELECT COUNT(*) AS n FROM tasks WHERE customer_id = ?', r.id),
          attachments: n("SELECT COUNT(*) AS n FROM attachments WHERE owner_type='customer' AND owner_id = ?", r.id),
          tags: n('SELECT COUNT(*) AS n FROM customer_tags WHERE customer_id = ?', r.id)
        });
      }
    }
  } catch (e) {
    console.log(`  （${f.file} 读取失败：${e.message}）`);
  } finally {
    if (db) { try { db.close(); } catch (_) { /* 忽略 */ } }
  }
}

if (!hits.length) {
  console.log('所有备份中都没有找到该客户。');
  process.exit(1);
}

console.log(`找到 ${hits.length} 处记录：\n`);
for (const h of hits) {
  const c = h.customer;
  console.log(`备份 ${h.file}（${h.dir}，${h.when}）`);
  console.log(`  客户 #${c.id}  ${c.name}`);
  console.log(`  地址：${c.city || '—'} / ${c.district || '—'}   归属：${c.region_code || '—'} ${c.region_name || ''}`);
  console.log(`  关联：联系人 ${h.contacts}、跟进 ${h.followups}、项目 ${h.projects}、待办 ${h.tasks}、附件 ${h.attachments}、标签 ${h.tags}`);
  console.log('');
}

/* 给出恢复建议 */
const best = hits.reduce((a, b) => {
  const score = (x) => x.contacts + x.followups + x.projects + x.tasks + x.attachments + x.tags;
  return score(b) > score(a) ? b : a;
});
console.log(`关联数据最多的是：${best.file}（${best.when}）`);
console.log(`恢复方式（任选其一）：`);
console.log(`  1) 界面「设置 → 备份与恢复」选该备份执行恢复（会整库回滚到该时刻）`);
console.log(`  2) 只取回这一家客户：node tools/restore-customer-from-backup.js ${best.file}`);
