/**
 * 造几位待跟进客户用于截图与人工查看（用后可 node tools/cleanup-test-data.js 清理）。
 * 用法：node tools/seed-remind-demo.js
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.resolve(__dirname, '..', 'data', 'crm.db'));
const p = (n) => String(n).padStart(2, '0');
const off = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`; };
const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');

const ins = db.prepare(`INSERT INTO customers
  (name, short_name, type, industry, level, status, owner, city, next_follow_at, follow_count, created_at, updated_at)
  VALUES (?, ?, '终端用户', '石油', ?, '跟进中', '我', '乌鲁木齐市', ?, ?, ?, ?)`);

const rows = [
  ['某某石化有限公司', '某某石化', 'A 重点客户', off(-6) + ' 10:00:00', 4],
  ['某某设计研究院', '某某设计院', 'B 一般客户', off(0) + ' 09:30:00', 2],
  ['某某工程有限公司', '某某工程', '', off(2) + ' 14:00:00', 0]
];
const ids = [];
for (const [name, short, level, next, cnt] of rows) {
  const r = ins.run(`【演示】${name}`, short, level, next, cnt, ts, ts);
  ids.push(Number(r.lastInsertRowid));
}

db.prepare(`INSERT INTO contacts (customer_id, name, mobile, position, is_primary, created_at, updated_at)
            VALUES (?, '王经理', '13900001111', '采购经理', 1, ?, ?)`).run(ids[0], ts, ts);
db.prepare(`INSERT INTO contacts (customer_id, name, mobile, position, is_primary, created_at, updated_at)
            VALUES (?, '李工', '13900002222', '设计负责人', 1, ?, ?)`).run(ids[1], ts, ts);

console.log(`已造 ${ids.length} 位演示客户（逾期 / 今天 / 临近），id=${ids.join(',')}`);
console.log('清理：node tools/cleanup-test-data.js');
db.close();
