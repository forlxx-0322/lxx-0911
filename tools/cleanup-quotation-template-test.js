/**
 * 清理报价模板的测试数据（按名称特征，带预览）。
 * 用法：node tools/cleanup-quotation-template-test.js
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.resolve(__dirname, '..', 'data', 'crm.db'));

const PATTERNS = ['%测试%', '%探针%', '%验收%', '%演示%', '%模板测试%', '%常用球阀组合%', '%报价模板%'];
const ids = new Set();
const rows = [];
for (const p of PATTERNS) {
  for (const r of db.prepare('SELECT id, name FROM quotation_templates WHERE name LIKE ? OR description LIKE ?').all(p, p)) {
    if (!ids.has(r.id)) { ids.add(r.id); rows.push(r); }
  }
}

console.log(`匹配到模板 ${rows.length} 个：`);
for (const r of rows) console.log(`  #${r.id} ${r.name}`);

if (!rows.length) { console.log('\n没有需要清理的模板。'); db.close(); process.exit(0); }

db.exec('BEGIN');
try {
  for (const r of rows) {
    db.prepare('DELETE FROM quotation_template_items WHERE template_id = ?').run(r.id);
    db.prepare('DELETE FROM quotation_templates WHERE id = ?').run(r.id);
  }
  db.prepare("DELETE FROM activity_logs WHERE entity_type = 'quotation_template'").run();
  db.exec('COMMIT');
  console.log(`\n已清理模板 ${rows.length} 个。`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('清理失败：' + e.message);
  db.close();
  process.exit(1);
}

console.log('\n当前状态：');
console.log('  模板       ' + db.prepare('SELECT COUNT(*) AS n FROM quotation_templates').get().n);
console.log('  模板明细   ' + db.prepare('SELECT COUNT(*) AS n FROM quotation_template_items').get().n);
console.log('  报价单     ' + db.prepare('SELECT COUNT(*) AS n FROM quotations').get().n);
console.log('  客户       ' + db.prepare('SELECT COUNT(*) AS n FROM customers WHERE deleted_at IS NULL').get().n);
db.close();
