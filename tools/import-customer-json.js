/**
 * 从 JSON 备份回填客户及其关联数据（配合 export-customer-by-id.js 使用）。
 *
 * 与「整库恢复」的区别：只回填这一家客户，不动其它数据。
 * 回填时会清掉 deleted_at（让数据重新可用），并重新计算归属地州。
 *
 * 用法：
 *   node tools/import-customer-json.js .fixtures/客户备份-独山子石化.json          预演
 *   node tools/import-customer-json.js .fixtures/客户备份-独山子石化.json --apply  实际写入
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const FILE = process.argv[2];
const APPLY = process.argv.includes('--apply');

if (!FILE) {
  console.error('用法：node tools/import-customer-json.js <备份JSON> [--apply]');
  process.exit(2);
}
const abs = path.isAbsolute(FILE) ? FILE : path.join(ROOT, FILE);
if (!fs.existsSync(abs)) { console.error('找不到文件：' + abs); process.exit(2); }

const dump = JSON.parse(fs.readFileSync(abs, 'utf8'));
const src = dump.customer;

const now = () => {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);

function insert(table, row) {
  const dst = cols(table);
  const o = Object.assign({}, row);
  delete o.id;
  if ('deleted_at' in o) o.deleted_at = null;      // 回填的目的是让数据可用
  const keys = Object.keys(o).filter((k) => dst.includes(k));
  const info = db.prepare(
    `INSERT INTO ${table} (${keys.join(', ')}) VALUES (${keys.map(() => '?').join(', ')})`
  ).run(...keys.map((k) => o[k]));
  return Number(info.lastInsertRowid);
}

console.log('=== 从 JSON 回填客户 ===');
console.log(`来源文件：${path.relative(ROOT, abs)}`);
console.log(`客户：${src.name}（原 id=${src.id}，软删除标记=${src.deleted_at || '无'}）`);
console.log(`关联：联系人 ${dump.contacts.length}、跟进 ${dump.followups.length}、标签 ${dump.customer_tags.length}、待办 ${dump.tasks.length}、项目 ${dump.projects.length}`);
console.log(`模式：${APPLY ? '实际写入' : '预演（不写入）'}\n`);

/* 同名检查 */
const dup = db.prepare('SELECT id, deleted_at FROM customers WHERE name = ?').all(src.name);
if (dup.length && APPLY) {
  console.log(`库中已有同名客户 ${dup.length} 条，先删除再回填：`);
  db.exec('BEGIN');
  try {
    for (const d of dup) {
      for (const t of ['contacts', 'followups', 'customer_tags', 'tasks', 'projects']) {
        db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(d.id);
      }
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?").run(d.id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(d.id);
      console.log(`  已删除 #${d.id}`);
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    console.error('失败：' + e.message);
    process.exit(1);
  }
}

if (!APPLY) {
  console.log('这是预演。确认后加 --apply 执行：');
  console.log(`  node tools/import-customer-json.js ${path.relative(ROOT, abs)} --apply`);
  db.close();
  process.exit(0);
}

const ts = now();
db.exec('BEGIN');
try {
  const newId = insert('customers', Object.assign({}, src, { updated_at: ts }));
  let nC = 0; let nF = 0; let nT = 0; let nK = 0; let nP = 0;
  for (const r of dump.contacts) { insert('contacts', Object.assign({}, r, { customer_id: newId })); nC++; }
  for (const r of dump.followups) { insert('followups', Object.assign({}, r, { customer_id: newId })); nF++; }
  for (const r of dump.customer_tags) {
    /* 标签可能已不存在，跳过孤儿引用 */
    const tag = db.prepare('SELECT id FROM tags WHERE id = ?').get(r.tag_id);
    if (tag) { insert('customer_tags', Object.assign({}, r, { customer_id: newId })); nT++; }
  }
  for (const r of dump.tasks) { insert('tasks', Object.assign({}, r, { customer_id: newId })); nK++; }
  for (const r of dump.projects) { insert('projects', Object.assign({}, r, { customer_id: newId })); nP++; }

  db.prepare(
    `INSERT INTO activity_logs (entity_type, entity_id, action, summary, detail, created_at)
     VALUES ('customer', ?, 'restore_extra', ?, ?, ?)`
  ).run(newId, `从 JSON 备份回填客户：${src.name}`,
    JSON.stringify({ from: path.basename(abs), source_id: src.id }), ts);

  db.exec('COMMIT');

  /* 重新计算归属地州，保证与当前匹配逻辑一致 */
  try {
    const crm = require(path.join(ROOT, 'server', 'services', 'crm.js'));
    crm.syncCustomerRegion(db, newId);
  } catch (_) { /* 忽略 */ }

  const after = db.prepare('SELECT region_code, region_name FROM customers WHERE id = ?').get(newId);
  console.log(`✓ 已回填客户 #${newId}：${src.name}`);
  console.log(`  联系人 ${nC}、跟进 ${nF}、标签 ${nT}、待办 ${nK}、项目 ${nP}`);
  console.log(`  归属地州：${after.region_code || '（空）'} ${after.region_name || ''}`);
} catch (e) {
  try { db.exec('ROLLBACK'); } catch (_) { /* 忽略 */ }
  console.error('✗ 回填失败，已回滚：' + e.message);
  db.close();
  process.exit(1);
}
db.close();
