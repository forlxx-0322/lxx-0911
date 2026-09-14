/**
 * 清理报价单流程测试的残留数据（按 tag 精确匹配，带预览）。
 * 用法：node tools/cleanup-quotation-flow.js [tag]
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.resolve(__dirname, '..', 'data', 'crm.db'));
const tag = process.argv[2] || '';

/* 找出测试造的客户与项目 */
const custs = db.prepare(
  `SELECT id, name FROM customers WHERE name LIKE ?`
).all(tag ? `%${tag}%` : '%【报价流程测试%');
console.log(`匹配客户 ${custs.length} 个：`);
for (const c of custs) console.log(`  #${c.id} ${c.name}`);

const ids = custs.map((c) => c.id);
const projs = ids.length
  ? db.prepare(`SELECT id, name FROM projects WHERE customer_id IN (${ids.map(() => '?').join(',')})`).all(...ids)
  : db.prepare("SELECT id, name FROM projects WHERE name LIKE '%【报价流程测试%'").all();
console.log(`\n匹配项目 ${projs.length} 个：`);
for (const p of projs) console.log(`  #${p.id} ${p.name}`);

const pids = projs.map((p) => p.id);
const qs = pids.length
  ? db.prepare(`SELECT id, quote_no FROM quotations WHERE project_id IN (${pids.map(() => '?').join(',')})`).all(...pids)
  : [];
console.log(`\n匹配报价单 ${qs.length} 张：`);
for (const q of qs) console.log(`  #${q.id} ${q.quote_no}`);

if (!custs.length && !projs.length && !qs.length) {
  console.log('\n没有残留数据。');
  db.close();
  process.exit(0);
}

db.exec('BEGIN');
try {
  const qids = qs.map((q) => q.id);
  if (qids.length) {
    db.prepare(`DELETE FROM quotation_items WHERE quotation_id IN (${qids.map(() => '?').join(',')})`).run(...qids);
    db.prepare(`DELETE FROM quotations WHERE id IN (${qids.map(() => '?').join(',')})`).run(...qids);
  }
  if (pids.length) {
    const marks = pids.map(() => '?').join(',');
    /* 项目关联的报价单、回款、待办一并清掉，避免留下孤儿数据 */
    db.prepare(`DELETE FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE project_id IN (${marks}))`).run(...pids);
    db.prepare(`DELETE FROM quotations WHERE project_id IN (${marks})`).run(...pids);
    db.prepare(`DELETE FROM payments WHERE project_id IN (${marks})`).run(...pids);
    db.prepare(`DELETE FROM tasks WHERE project_id IN (${marks})`).run(...pids);
    db.prepare(`DELETE FROM projects WHERE id IN (${marks})`).run(...pids);
  }
  if (ids.length) {
    const marks = ids.map(() => '?').join(',');
    db.prepare(`DELETE FROM contacts WHERE customer_id IN (${marks})`).run(...ids);
    db.prepare(`DELETE FROM followups WHERE customer_id IN (${marks})`).run(...ids);
    db.prepare(`DELETE FROM customer_tags WHERE customer_id IN (${marks})`).run(...ids);
    db.prepare(`DELETE FROM tasks WHERE customer_id IN (${marks})`).run(...ids);
    db.prepare(`DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id IN (${marks})`).run(...ids);
    db.prepare(`DELETE FROM customers WHERE id IN (${marks})`).run(...ids);
  }
  db.prepare("DELETE FROM activity_logs WHERE entity_type IN ('quotation','project')").run();
  db.exec('COMMIT');
  console.log(`\n已清理：客户 ${ids.length}、项目 ${pids.length}、报价单 ${qs.length}。`);
} catch (e) {
  db.exec('ROLLBACK');
  console.error('清理失败：' + e.message);
  db.close();
  process.exit(1);
}

console.log('\n当前状态：');
for (const t of ['customers', 'projects', 'quotations', 'quotation_items', 'tasks', 'payments']) {
  console.log(`  ${t.padEnd(18)} ${db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n}`);
}
db.close();
