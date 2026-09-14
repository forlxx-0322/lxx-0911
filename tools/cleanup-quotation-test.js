/**
 * 清理报价单相关的测试数据（按名称特征，带预览）。
 * 用法：node tools/cleanup-quotation-test.js
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.resolve(__dirname, '..', 'data', 'crm.db'));

/* 1. 名称带测试特征的报价单 */
const qs = db.prepare(`SELECT q.id, q.quote_no, p.name AS project_name
  FROM quotations q LEFT JOIN projects p ON p.id = q.project_id
  WHERE q.status IN ('草稿','已报出') AND (p.name LIKE '%报价测试%' OR p.name LIKE '%测试%')`).all();
console.log(`匹配到报价单 ${qs.length} 张：`);
for (const q of qs) console.log(`  #${q.id} ${q.quote_no}  项目=${q.project_name || '-'}`);

/* 2. 名称带测试特征的项目 */
const ps = db.prepare("SELECT id, name FROM projects WHERE name LIKE '%报价测试%'").all();
console.log(`\n匹配到项目 ${ps.length} 个：`);
for (const p of ps) console.log(`  #${p.id} ${p.name}`);

if (!qs.length && !ps.length) { console.log('\n没有需要清理的数据。'); db.close(); process.exit(0); }

db.exec('BEGIN');
try {
  for (const q of qs) {
    db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(q.id);
    db.prepare('DELETE FROM quotations WHERE id = ?').run(q.id);
  }
  for (const p of ps) {
    db.prepare('DELETE FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE project_id = ?)').run(p.id);
    db.prepare('DELETE FROM quotations WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM payments WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM tasks WHERE project_id = ?').run(p.id);
    db.prepare('DELETE FROM projects WHERE id = ?').run(p.id);
  }
  db.prepare("DELETE FROM activity_logs WHERE entity_type IN ('quotation','project')").run();
  db.exec('COMMIT');
  console.log(`\n已清理：报价单 ${qs.length} 张、项目 ${ps.length} 个。`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('清理失败：' + e.message);
  db.close();
  process.exit(1);
}

console.log('\n当前状态：');
console.log('  报价单   ' + db.prepare('SELECT COUNT(*) AS n FROM quotations').get().n);
console.log('  报价明细 ' + db.prepare('SELECT COUNT(*) AS n FROM quotation_items').get().n);
console.log('  项目     ' + db.prepare('SELECT COUNT(*) AS n FROM projects').get().n);
console.log('  客户     ' + db.prepare('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL').get().n);
db.close();
