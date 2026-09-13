'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const db = new DatabaseSync(path.resolve(__dirname, '..', 'data', 'crm.db'), { readOnly: true });
const n = (sql, ...p) => db.prepare(sql).get(...p).n;

console.log('=== 客户 ===');
for (const c of db.prepare('SELECT id, name, city, district, region_code, region_name, phone FROM customers ORDER BY id').all()) {
  console.log(`  #${c.id}  ${c.name}`);
  console.log(`      地址：${c.city || '—'} / ${c.district || '—'}   归属：${c.region_code || '—'} ${c.region_name || ''}`);
  console.log(`      联系人 ${n('SELECT COUNT(*) AS n FROM contacts WHERE customer_id = ?', c.id)}` +
    `  跟进 ${n('SELECT COUNT(*) AS n FROM followups WHERE customer_id = ?', c.id)}` +
    `  标签 ${n('SELECT COUNT(*) AS n FROM customer_tags WHERE customer_id = ?', c.id)}` +
    `  待办 ${n('SELECT COUNT(*) AS n FROM tasks WHERE customer_id = ?', c.id)}` +
    `  项目 ${n('SELECT COUNT(*) AS n FROM projects WHERE customer_id = ?', c.id)}`);
}
console.log('\n=== 表计数 ===');
for (const t of ['customers', 'contacts', 'followups', 'customer_tags', 'projects', 'payments', 'tasks', 'activity_logs', 'tags']) {
  console.log(`  ${t.padEnd(16)} ${n(`SELECT COUNT(*) AS n FROM ${t}`)}`);
}
console.log('\n=== 归属地州分布（地图应显示这个客户）===');
for (const r of db.prepare(`SELECT region_code, region_name, COUNT(*) AS n FROM customers
  WHERE deleted_at IS NULL AND region_code <> '' GROUP BY region_code ORDER BY n DESC`).all()) {
  console.log(`  ${r.region_code}  ${r.region_name}  ${r.n} 家`);
}
const un = n("SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL AND (region_code IS NULL OR region_code = '')");
console.log(`  未归属：${un} 家`);
db.close();
