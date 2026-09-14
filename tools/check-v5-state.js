'use strict';
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const db = new DatabaseSync(path.resolve(__dirname, '..', 'data', 'crm.db'), { readOnly: true });
const n = (s) => db.prepare(s).get().n;

console.log('=== 结构 ===');
console.log('  schema_version   v' + db.prepare('SELECT MAX(version) AS v FROM schema_version').get().v);
console.log('  表数量           ' + db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n);

console.log('\n=== 报价单（v5 新增）===');
console.log('  quotations       ' + n('SELECT COUNT(*) AS n FROM quotations') + ' 行');
console.log('  quotation_items  ' + n('SELECT COUNT(*) AS n FROM quotation_items') + ' 行');
const statuses = db.prepare("SELECT value FROM dict WHERE category = 'quotation_status' AND deleted_at IS NULL ORDER BY sort").all();
console.log('  状态字典         ' + statuses.map((s) => s.value).join('、'));

console.log('\n=== 新设置项 ===');
const keys = ['follow_remind_days', 'follow_remind_time', 'follow_remind_quiet', 'follow_remind_on_start',
  'remind_email_on', 'remind_email_time', 'remind_email_to', 'smtp_provider', 'smtp_host', 'smtp_port',
  'smtp_user', 'smtp_pass', 'quote_no_prefix', 'quote_company', 'quote_contact'];
for (const k of keys) {
  const r = db.prepare('SELECT value FROM settings WHERE key = ?').get(k);
  const v = r ? r.value : '【缺失】';
  console.log('  ' + k.padEnd(24) + '= ' + (v === '' ? '(空)' : v));
}

console.log('\n=== 业务数据（应与迁移前一致）===');
for (const t of ['customers', 'contacts', 'followups', 'tasks', 'projects', 'payments', 'activity_logs', 'attachments', 'tags']) {
  console.log('  ' + t.padEnd(16) + n(`SELECT COUNT(*) AS n FROM ${t}`));
}
const c = db.prepare("SELECT id, name, address, region_code, region_name FROM customers WHERE deleted_at IS NULL").get();
if (c) {
  console.log('\n  客户：' + c.name);
  console.log('    详细地址：' + c.address);
  console.log('    归属：' + c.region_code + ' ' + c.region_name);
}
db.close();
