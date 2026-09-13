/**
 * 验证启动时对历史脏数据（region_code 存了地州名）的纠正。
 * 用法：node tools/test-region-legacy-fix.js
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const crm = require(path.resolve(__dirname, '..', 'server', 'services', 'crm.js'));

const db = new DatabaseSync(path.resolve(__dirname, '..', 'data', 'crm.db'));
const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');

/* 造 3 条脏数据：region_code 里放的是名字（含简称），另加 1 条本来就正确的 */
const BAD = [
  ['克拉玛依市', '650200'],
  ['巴州', '652800'],
  ['乌鲁木齐', '650100']
];
const ids = [];
for (const [name] of BAD) {
  const info = db.prepare(
    `INSERT INTO customers (name, short_name, type, industry, status, region_code, region_name, created_at, updated_at)
     VALUES (?, '', '终端用户', '石油', '潜在', ?, '', ?, ?)`
  ).run(`[脏数据验证] ${name}`, name, ts, ts);
  ids.push(Number(info.lastInsertRowid));
}
const okInfo = db.prepare(
  `INSERT INTO customers (name, short_name, type, industry, status, region_code, region_name, created_at, updated_at)
   VALUES ('[脏数据验证] 本来就正确', '', '终端用户', '石油', '潜在', '653100', '喀什地区', ?, ?)`
).run(ts, ts);
ids.push(Number(okInfo.lastInsertRowid));

console.log('纠正前：');
for (const id of ids) {
  const r = db.prepare('SELECT name, region_code, region_name FROM customers WHERE id = ?').get(id);
  console.log(`  ${r.name.padEnd(28, '　')} region_code=[${r.region_code}] region_name=[${r.region_name}]`);
}

const fixed = crm.fixLegacyRegionCodes(db);
console.log(`\nfixLegacyRegionCodes 纠正了 ${fixed} 条`);

console.log('\n纠正后：');
let pass = 0; let fail = 0;
for (let i = 0; i < ids.length; i++) {
  const r = db.prepare('SELECT name, region_code, region_name FROM customers WHERE id = ?').get(ids[i]);
  const expect = i < BAD.length ? BAD[i][1] : '653100';
  const good = r.region_code === expect;
  if (good) pass++; else fail++;
  console.log(`  ${good ? '✓' : '✗'} ${r.name.padEnd(26, '　')} region_code=[${r.region_code}] region_name=[${r.region_name}]  期望 ${expect}`);
}

/* 幂等性：再跑一次不应再改动任何行 */
const again = crm.fixLegacyRegionCodes(db);
console.log(`\n再次执行纠正了 ${again} 条（应为 0，说明幂等）`);
if (again !== 0) fail++;

/* 清理 */
for (const id of ids) db.prepare('DELETE FROM customers WHERE id = ?').run(id);
const left = db.prepare("SELECT COUNT(*) AS n FROM customers WHERE name LIKE '[脏数据验证]%'").get().n;
const cleanOk = left === 0;
console.log(`清理后残留 ${left} 条（应为 0）`);

db.close();

/* 汇总行格式与其它套件保持一致，便于 run-all-tests.js 解析 */
const total = ids.length + 2;                       // 每条断言 + 幂等 + 清理
const passCount = pass + (again === 0 ? 1 : 0) + (cleanOk ? 1 : 0);
const failCount = total - passCount;
console.log(`\n=== 汇总 ===\n通过 ${passCount} / ${total}，失败 ${failCount}`);
if (failCount) {
  console.log('\n失败项：');
  if (again !== 0) console.log(`  ✗ 幂等性：再次执行纠正了 ${again} 条（应为 0）`);
  if (!cleanOk) console.log(`  ✗ 测试数据未清理干净：残留 ${left} 条`);
}
process.exit(failCount ? 1 : 0);
