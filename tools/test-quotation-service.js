/**
 * 报价单服务层单元测试（内存库，不碰真实数据）
 * 用法：node tools/test-quotation-service.js
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const q = require(path.join(__dirname, '..', 'server', 'services', 'quotation.js'));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
};

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE quotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, customer_id INTEGER,
    quote_no TEXT, version INTEGER DEFAULT 1, parent_id INTEGER, quote_date TEXT,
    valid_until TEXT, currency TEXT DEFAULT '人民币', status TEXT DEFAULT '草稿',
    total_amount REAL DEFAULT 0, tax_note TEXT, delivery_note TEXT, payment_note TEXT,
    competitor TEXT, competitor_price REAL DEFAULT 0, lose_reason TEXT, remark TEXT,
    created_at TEXT, updated_at TEXT, deleted_at TEXT)`);
  db.exec(`CREATE TABLE quotation_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, quotation_id INTEGER, seq INTEGER,
    item_name TEXT, valve_type TEXT, size_range TEXT, pressure_rating TEXT,
    body_material TEXT, connection_type TEXT, quantity REAL, unit TEXT,
    unit_price REAL, discount REAL, subtotal REAL, delivery_days INTEGER,
    remark TEXT, created_at TEXT)`);
  db.exec(`CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, customer_id INTEGER, stage TEXT,
    bid_result TEXT, contract_amount REAL DEFAULT 0, deleted_at TEXT, updated_at TEXT)`);
  db.exec(`CREATE TABLE customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT, short_name TEXT,
    phone TEXT, deal_amount REAL DEFAULT 0)`);
  db.exec(`CREATE TABLE activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT, entity_id INTEGER,
    action TEXT, summary TEXT, detail TEXT, created_at TEXT)`);

  db.prepare("INSERT INTO customers (id, name, short_name) VALUES (1, '测试客户', '测试')").run();
  db.prepare("INSERT INTO projects (id, name, customer_id, stage, contract_amount) VALUES (1, '测试项目', 1, '投标中', 0)").run();
  return db;
}

console.log('=== 报价单服务层测试 ===\n');
const db = makeDb();

/* ---------- 1. 金额计算 ---------- */
const t1 = q.normalizeItem({ item_name: '球阀', quantity: 10, unit_price: 1000, discount: 10 }, 1);
check('折扣按百分比理解（填 10 = 让 10%）', t1.subtotal === 9000 && Math.abs(t1.discount - 0.1) < 1e-9,
  `小计 ${t1.subtotal}（应为 9000），规范化折扣 ${t1.discount}`);

const t2 = q.normalizeItem({ item_name: '闸阀', quantity: 3, unit_price: 500.5, discount: 0.05 }, 1);
check('折扣也接受小数比例（填 0.05）', t2.subtotal === 1426.43,
  `小计 ${t2.subtotal}（应为 1426.43）`);

const t3 = q.normalizeItem({ item_name: '无折扣', quantity: 2, unit_price: 333.33 }, 1);
check('无折扣时小计 = 数量 × 单价', t3.subtotal === 666.66, `小计 ${t3.subtotal}`);

const t4 = q.normalizeItem({ item_name: '浮点', quantity: 3, unit_price: 0.1 }, 1);
check('浮点误差被抹平（0.1×3 = 0.3 而非 0.30000000000000004）',
  t4.subtotal === 0.3, `小计 ${t4.subtotal}`);

const t5 = q.normalizeItem({ item_name: '非法值', quantity: 'abc', unit_price: null }, 1);
check('非法数字按 0 处理，不产生 NaN',
  t5.subtotal === 0 && t5.quantity === 0 && t5.unit_price === 0,
  `小计 ${t5.subtotal}`);

const t6 = q.normalizeItem({ item_name: '超额折扣', quantity: 1, unit_price: 100, discount: 150 }, 1);
check('折扣超过 100% 时封顶为全免（小计 0）', t6.subtotal === 0, `小计 ${t6.subtotal}`);

check('整行空内容被识别为空行',
  q.isBlankItem(q.normalizeItem({ item_name: '', quantity: 0, unit_price: 0 }, 1)) === true
  && q.isBlankItem(q.normalizeItem({ item_name: '有内容' }, 1)) === false,
  '空行判定正确');

/* ---------- 2. 建单 ---------- */
const r1 = q.saveQuotation(db, {
  project_id: 1,
  items: [
    { item_name: '球阀', valve_type: '球阀', size_range: 'DN50', pressure_rating: 'Class150', quantity: 10, unit_price: 1000, discount: 10 },
    { item_name: '闸阀', valve_type: '闸阀', size_range: 'DN100', quantity: 3, unit_price: 500, discount: 0 },
    { item_name: '', quantity: 0, unit_price: 0 }
  ]
}, { quote_no_prefix: 'BJ' });

const row1 = db.prepare('SELECT * FROM quotations WHERE id = ?').get(r1.id);
check('新建报价单：自动取号 + 自动带出客户',
  !!row1 && /^BJ-\d{8}-\d{3}$/.test(row1.quote_no) && row1.customer_id === 1,
  `单号 ${row1.quote_no}，客户 ${row1.customer_id}`);
check('合计由服务端计算且忽略空行',
  r1.total_amount === 10500 && r1.item_count === 2,
  `合计 ${r1.total_amount}（应为 10500），行数 ${r1.item_count}（空行已丢弃）`);
check('明细小计逐行落库', 
  db.prepare('SELECT subtotal FROM quotation_items WHERE quotation_id = ? ORDER BY seq').all(r1.id).map((x) => x.subtotal).join(',') === '9000,1500',
  '9000,1500');

/* 篡改 total_amount 应被忽略（以服务端算的为准） */
const r1b = q.saveQuotation(db, {
  id: r1.id, project_id: 1, total_amount: 999999,
  items: [{ item_name: '球阀', quantity: 10, unit_price: 1000, discount: 10 }]
}, {});
check('客户端提交的 total_amount 被忽略，仍以服务端计算为准',
  r1b.total_amount === 9000 && db.prepare('SELECT total_amount FROM quotations WHERE id = ?').get(r1.id).total_amount === 9000,
  `服务端合计 ${r1b.total_amount}（提交值 999999 被忽略）`);

/* 明细整体覆盖 */
check('修改时明细整体覆盖（旧行被清掉）',
  db.prepare('SELECT COUNT(*) AS n FROM quotation_items WHERE quotation_id = ?').get(r1.id).n === 1,
  `当前明细 ${db.prepare('SELECT COUNT(*) AS n FROM quotation_items WHERE quotation_id = ?').get(r1.id).n} 行`);

/* ---------- 3. 同一天多张单不重号 ---------- */
const r2 = q.saveQuotation(db, { project_id: 1, items: [{ item_name: '蝶阀', quantity: 1, unit_price: 100 }] }, { quote_no_prefix: 'BJ' });
const no1 = db.prepare('SELECT quote_no FROM quotations WHERE id = ?').get(r1.id).quote_no;
const no2 = db.prepare('SELECT quote_no FROM quotations WHERE id = ?').get(r2.id).quote_no;
check('同一天多张单自动递增序号、不重号', no1 !== no2 && no1 < no2, `${no1} / ${no2}`);

/* ---------- 4. 复制新版本 ---------- */
const r3 = q.copyAsNewVersion(db, r1.id);
const newQ = q.getOne(db, r3.id);
check('复制为新版本：版本号 +1、原单保留、明细一并复制',
  r3.version === 2 && newQ.version === 2 && newQ.parent_id === r1.id
  && newQ.items.length === 1 && newQ.total_amount === 9000
  && !!q.getOne(db, r1.id),
  `新单 V${r3.version} ${r3.quote_no}，原单仍在，明细 ${newQ.items.length} 行`);

/* ---------- 5. 状态流转与落标登记 ---------- */
const st1 = q.setStatus(db, r1.id, '已报出');
check('状态可流转到非终态', st1.status === '已报出' && st1.terminal === false, `status=${st1.status}`);

const st2 = q.setStatus(db, r2.id, '已落标', { competitor: '某某阀门厂', competitor_price: 88000, lose_reason: '价格高 8%' });
const lostQ = db.prepare('SELECT * FROM quotations WHERE id = ?').get(r2.id);
check('落标时登记竞对与原因（供后续落标分析）',
  st2.terminal === true && lostQ.competitor === '某某阀门厂'
  && lostQ.competitor_price === 88000 && lostQ.lose_reason === '价格高 8%',
  `竞对=${lostQ.competitor}，对手价=${lostQ.competitor_price}，原因=${lostQ.lose_reason}`);

try {
  q.setStatus(db, r1.id, '乱七八糟');
  check('非法状态被拒绝', false, '未报错');
} catch (e) { check('非法状态被拒绝', e.code === 'BAD_STATUS', e.message); }

/* ---------- 6. 中标回填 ---------- */
try {
  q.applyToProject(db, r1.id);
  check('未中标时拒绝回填', false, '未报错');
} catch (e) {
  check('未中标时拒绝回填项目合同额', e.code === 'NOT_WON', e.message);
}

const st3 = q.setStatus(db, r1.id, '已中标');
check('中标后返回可回填提示（can_apply）',
  st3.can_apply === true && st3.quote_total === 9000 && st3.project.contract_amount === 0,
  `can_apply=${st3.can_apply}，报价合计=${st3.quote_total}，项目原合同额=${st3.project.contract_amount}`);

const ap = q.applyToProject(db, r1.id);
const proj = db.prepare('SELECT * FROM projects WHERE id = 1').get();
check('回填：合同额、阶段、投标结果一并更新',
  ap.applied === true && proj.contract_amount === 9000
  && proj.stage === '已中标/已签约' && proj.bid_result === '已中标',
  ap.changes.map((c) => `${c.label} ${c.from}→${c.to}`).join('；'));

check('回填同步客户累计成交额',
  db.prepare('SELECT deal_amount FROM customers WHERE id = 1').get().deal_amount === 9000,
  `客户成交额 = ${db.prepare('SELECT deal_amount FROM customers WHERE id = 1').get().deal_amount}`);

const ap2 = q.applyToProject(db, r1.id);
check('重复回填不产生多余改动',
  ap2.applied === false && ap2.changes.length === 0, ap2.message);

check('回填写入了操作日志（可追溯）',
  db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE action = 'apply_quote'").get().n === 1,
  '日志 1 条');

/* ---------- 7. 导出数据结构 ---------- */
/* 注意：上面 r1 的明细已被"覆盖"用例改成了单项，所以这里单独建一张带完整规格的单来验导出 */
const rExp = q.saveQuotation(db, {
  project_id: 1,
  items: [{
    item_name: '球阀', valve_type: '球阀', size_range: 'DN50', pressure_rating: 'Class150',
    body_material: 'WCB', connection_type: '法兰', quantity: 10, unit_price: 1000, discount: 10
  }]
}, {});
const ex = q.exportData(db, rExp.id, { company_name: '某某阀门有限公司', quote_contact: '张经理' });
check('导出数据：抬头公司名与行规格拼接正确',
  ex.company === '某某阀门有限公司' && ex.items.length === 1
  && ex.items[0].spec === '球阀 DN50 Class150 WCB 法兰' && ex.total_amount === 9000,
  `抬头「${ex.company}」，规格「${ex.items[0].spec}」，合计 ${ex.total_amount}`);
check('导出数据带客户与项目名（供单据表头）',
  ex.customer_name === '测试客户' && ex.project_name === '测试项目' && /^BJ-\d{8}-\d{3}$/.test(ex.quote_no),
  `${ex.customer_name} / ${ex.project_name} / ${ex.quote_no}`);
check('导出用公司名回退到设置里的我方公司名',
  q.exportData(db, rExp.id, { company_name: '回退公司' }).company === '回退公司',
  '回退正常');

/* ---------- 8. 删除 ---------- */
const beforeCount = q.listByProject(db, 1).list.length;
q.removeQuotation(db, r2.id);
check('软删除后不在列表里',
  q.listByProject(db, 1).list.length === beforeCount - 1
  && q.listByProject(db, 1).list.every((x) => x.id !== r2.id)
  && db.prepare('SELECT deleted_at FROM quotations WHERE id = ?').get(r2.id).deleted_at !== null,
  `删除前 ${beforeCount} 张，删除后 ${q.listByProject(db, 1).list.length} 张`);

check('按项目查询返回全部版本（含被复制的链）',
  q.listByProject(db, 1).list.length === beforeCount - 1,
  `共 ${q.listByProject(db, 1).list.length} 张（r1 与其 V2、以及导出用例新建的单）`);
check('按客户查询（跨项目比价用）',
  q.listByCustomer(db, 1).total === beforeCount - 1,
  `共 ${q.listByCustomer(db, 1).total} 张`);

db.close();

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
}
process.exit(fail ? 1 : 0);
