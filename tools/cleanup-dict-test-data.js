/**
 * 清理验收测试遗留的字典脏数据：
 * 把验收/探针期间被「停用」「软删除」的自定义字典项恢复为启用状态，
 * 使字典回到测试前的样子（不影响系统内置项与真实业务数据）。
 *
 * 用法：node tools/cleanup-dict-test-data.js
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));

const rows = db.prepare(
  `SELECT id, category, value, enabled, deleted_at FROM dict
   WHERE is_system = 0 AND (deleted_at IS NOT NULL OR enabled = 0)
   ORDER BY id`
).all();

if (!rows.length) {
  console.log('没有需要恢复的自定义字典项。');
} else {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  for (const r of rows) {
    db.prepare('UPDATE dict SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?').run(ts, r.id);
  }
  console.log(`已恢复 ${rows.length} 个自定义字典项为「启用」：`);
  for (const r of rows) console.log(`  ${r.id}\t${r.category}\t${r.value}`);
}

const left = db.prepare(
  'SELECT COUNT(*) AS n FROM dict WHERE is_system = 0 AND (deleted_at IS NOT NULL OR enabled = 0)'
).get().n;
console.log(`剩余未启用的自定义项：${left}（应为 0）`);
db.close();
