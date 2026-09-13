/**
 * 按客户 ID 精确导出（含关联数据），便于清理后原样回填。
 * 用法：node tools/export-customer-by-id.js 10129 [输出文件名]
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const ID = Number(process.argv[2]);
const OUT_NAME = process.argv[3] || `客户备份-id${ID}.json`;
const OUT = path.join(ROOT, '.fixtures', OUT_NAME);

if (!ID) {
  console.error('用法：node tools/export-customer-by-id.js <客户ID> [输出文件名]');
  process.exit(2);
}

const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'), { readOnly: true });
const plain = (r) => (r ? Object.assign({}, r) : r);

const c = db.prepare('SELECT * FROM customers WHERE id = ?').get(ID);
if (!c) { console.log(`没有找到 id=${ID} 的客户。`); db.close(); process.exit(1); }

const dump = {
  exported_at: new Date().toISOString(),
  customer: plain(c),
  contacts: db.prepare('SELECT * FROM contacts WHERE customer_id = ?').all(ID).map(plain),
  followups: db.prepare('SELECT * FROM followups WHERE customer_id = ?').all(ID).map(plain),
  customer_tags: db.prepare('SELECT * FROM customer_tags WHERE customer_id = ?').all(ID).map(plain),
  tasks: db.prepare('SELECT * FROM tasks WHERE customer_id = ?').all(ID).map(plain),
  projects: db.prepare('SELECT * FROM projects WHERE customer_id = ?').all(ID).map(plain)
};

fs.writeFileSync(OUT, JSON.stringify(dump, null, 2), 'utf8');
console.log(`已导出客户 #${ID}：${c.name}`);
console.log(`  地址：${c.city || '—'} / ${c.district || '—'}   归属：${c.region_code || '—'} ${c.region_name || ''}`);
console.log(`  软删除标记：${c.deleted_at || '（未删除）'}`);
console.log(`  关联：联系人 ${dump.contacts.length}、跟进 ${dump.followups.length}、标签 ${dump.customer_tags.length}、待办 ${dump.tasks.length}、项目 ${dump.projects.length}`);
console.log(`  → ${path.relative(ROOT, OUT)}`);
db.close();
