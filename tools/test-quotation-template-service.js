/**
 * 报价模板服务层测试（内存库，不碰真实数据）
 *
 * 覆盖：
 *   1. 明细归一化与空行丢弃
 *   2. 新建 / 修改 / 明细整体覆盖
 *   3. **模板不含价格**（结构性约束，必须成立）
 *   4. 从报价单沉淀为模板（只带规格）
 *   5. 套用模板（返回明细、不含价格、记录使用次数）
 *   6. 停用的模板不可套用
 *   7. 排序上移/下移与边界
 *   8. 软删除与列表过滤（关键词、类别）
 *   9. 必填校验与错误码
 *
 * 用法：node tools/test-quotation-template-service.js
 */
'use strict';

const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const tpl = require(path.join(__dirname, '..', 'server', 'services', 'quotation-template'));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
};

function makeDb() {
  const db = new DatabaseSync(':memory:');
  db.exec(`CREATE TABLE quotation_templates (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, category TEXT NOT NULL DEFAULT '',
    description TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT '台',
    use_count INTEGER NOT NULL DEFAULT 0, last_used_at TEXT NOT NULL DEFAULT '',
    sort INTEGER NOT NULL DEFAULT 0, enabled INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`);
  db.exec(`CREATE TABLE quotation_template_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, template_id INTEGER NOT NULL, seq INTEGER NOT NULL DEFAULT 1,
    item_name TEXT NOT NULL DEFAULT '', valve_type TEXT NOT NULL DEFAULT '',
    size_range TEXT NOT NULL DEFAULT '', pressure_rating TEXT NOT NULL DEFAULT '',
    body_material TEXT NOT NULL DEFAULT '', connection_type TEXT NOT NULL DEFAULT '',
    quantity REAL NOT NULL DEFAULT 1, unit TEXT NOT NULL DEFAULT '台',
    delivery_days INTEGER NOT NULL DEFAULT 0, remark TEXT NOT NULL DEFAULT '',
    extra TEXT NOT NULL DEFAULT '{}', created_at TEXT NOT NULL)`);
  /* 报价自定义列的列定义表（v7 起）：按真实结构建出来，保证测的是真实路径 */
  db.exec(`CREATE TABLE quotation_fields (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, kind TEXT NOT NULL DEFAULT 'text',
    options TEXT NOT NULL DEFAULT '', unit TEXT NOT NULL DEFAULT '', sort INTEGER NOT NULL DEFAULT 0,
    enabled INTEGER NOT NULL DEFAULT 1, remark TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, deleted_at TEXT)`);
  db.exec(`CREATE TABLE quotations (
    id INTEGER PRIMARY KEY AUTOINCREMENT, project_id INTEGER, customer_id INTEGER,
    quote_no TEXT, version INTEGER DEFAULT 1, status TEXT DEFAULT '草稿',
    total_amount REAL DEFAULT 0, deleted_at TEXT)`);
  db.exec(`CREATE TABLE quotation_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, quotation_id INTEGER, seq INTEGER,
    item_name TEXT, valve_type TEXT, size_range TEXT, pressure_rating TEXT,
    body_material TEXT, connection_type TEXT, quantity REAL, unit TEXT,
    unit_price REAL, discount REAL, subtotal REAL, delivery_days INTEGER, remark TEXT,
    extra TEXT NOT NULL DEFAULT '{}')`);
  db.exec(`CREATE TABLE activity_logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT, entity_type TEXT, entity_id INTEGER,
    action TEXT, summary TEXT, detail TEXT, created_at TEXT)`);
  return db;
}

console.log('=== 报价模板服务层测试 ===\n');
const db = makeDb();

/* ---------- 1. 明细归一化 ---------- */
const it1 = tpl.normalizeItem({ item_name: '  球阀  ', size_range: 'DN50', quantity: '2' }, 1);
check('明细归一化：去空格、数量转数字',
  it1.item_name === '球阀' && it1.size_range === 'DN50' && it1.quantity === 2,
  `name="${it1.item_name}" qty=${it1.quantity}（${typeof it1.quantity}）`);

const it2 = tpl.normalizeItem({ item_name: '闸阀' }, 1);
check('明细归一化：未填数量时默认 1、单位默认「台」',
  it2.quantity === 1 && it2.unit === '台', `qty=${it2.quantity} unit=${it2.unit}`);

check('空行识别：整行无内容才算空行',
  tpl.isBlankItem(tpl.normalizeItem({ item_name: '', size_range: '' }, 1)) === true
  && tpl.isBlankItem(tpl.normalizeItem({ item_name: '有内容' }, 1)) === false,
  '判定正确');

/* ---------- 2. 新建 ---------- */
const r1 = tpl.saveTemplate(db, {
  name: '炼化常用球阀组合',
  category: '球阀',
  description: '新疆炼化项目常用',
  items: [
    { item_name: '球阀', valve_type: '球阀', size_range: 'DN50', pressure_rating: 'Class150', body_material: 'WCB', connection_type: '法兰', quantity: 2 },
    { item_name: '球阀', valve_type: '球阀', size_range: 'DN80', pressure_rating: 'Class300', body_material: '316L', connection_type: '法兰', quantity: 1 },
    { item_name: '', quantity: 0 }                       // 空行应被丢弃
  ]
});
const t1 = tpl.getTemplate(db, r1.id);
check('新建模板：明细落库且丢弃空行',
  r1.created === true && t1.items.length === 2 && r1.item_count === 2,
  `id=${r1.id}，明细 ${t1.items.length} 行（提交 3 行含 1 空行）`);

check('新建模板：启用状态与使用次数为初始值',
  t1.enabled === 1 && t1.use_count === 0 && t1.last_used_at === '',
  `enabled=${t1.enabled} use_count=${t1.use_count}`);

check('新建模板：自动分配排序值（便于列表稳定）',
  typeof t1.sort === 'number' && t1.sort > 0, `sort=${t1.sort}`);

/* ---------- 3. 结构性约束：模板不含价格 ---------- */
const cols = db.prepare('PRAGMA table_info(quotation_template_items)').all().map((c) => c.name);
check('结构性约束：模板明细表没有价格列',
  !cols.includes('unit_price') && !cols.includes('discount') && !cols.includes('subtotal'),
  `列：${cols.filter((c) => ['unit_price', 'discount', 'subtotal'].includes(c)).join('、') || '无价格列'}`);

/* ---------- 4. 修改与明细整体覆盖 ---------- */
const r2 = tpl.saveTemplate(db, {
  id: r1.id,
  name: '炼化常用球阀组合（改）',
  items: [{ item_name: '蝶阀', size_range: 'DN100' }]
});
const t2 = tpl.getTemplate(db, r1.id);
check('修改模板：名称更新且明细整体覆盖',
  t2.name === '炼化常用球阀组合（改）' && t2.items.length === 1 && t2.items[0].item_name === '蝶阀',
  `名称「${t2.name}」，明细 ${t2.items.length} 行`);

check('修改模板：created 标记为 false（与新建区分）', r2.created === false, `created=${r2.created}`);

/* ---------- 5. 必填校验 ---------- */
try {
  tpl.saveTemplate(db, { name: '  ', items: [{ item_name: 'x' }] });
  check('名称为空时拒绝保存', false, '未报错');
} catch (e) { check('名称为空时拒绝保存', e.code === 'NAME_REQUIRED', e.message); }

try {
  tpl.saveTemplate(db, { name: '没有明细的模板', items: [] });
  check('明细为空时拒绝保存', false, '未报错');
} catch (e) { check('明细为空时拒绝保存', e.code === 'ITEMS_REQUIRED', e.message); }

try {
  tpl.saveTemplate(db, { name: '全是空行', items: [{ item_name: '', quantity: 0 }] });
  check('明细全是空行时拒绝保存', false, '未报错');
} catch (e) { check('明细全是空行时拒绝保存', e.code === 'ITEMS_REQUIRED', e.message); }

/* ---------- 6. 从报价单沉淀 ---------- */
db.prepare(`INSERT INTO quotations (id, project_id, customer_id, quote_no, version, status, total_amount)
            VALUES (1, 10, 20, 'BJ-20260914-001', 1, '已报出', 10500)`).run();
const qItems = [
  { item_name: '球阀', valve_type: '球阀', size_range: 'DN50', pressure_rating: 'Class150', body_material: 'WCB', connection_type: '法兰', quantity: 10, unit: '台', unit_price: 1000, discount: 0.1, subtotal: 9000, delivery_days: 30, remark: '' },
  { item_name: '闸阀', valve_type: '闸阀', size_range: 'DN100', pressure_rating: 'Class150', body_material: 'WCB', connection_type: '法兰', quantity: 3, unit: '台', unit_price: 500, discount: 0, subtotal: 1500, delivery_days: 20, remark: '急件' }
];
for (let i = 0; i < qItems.length; i++) {
  const it = qItems[i];
  db.prepare(`INSERT INTO quotation_items
    (quotation_id, seq, item_name, valve_type, size_range, pressure_rating, body_material,
     connection_type, quantity, unit, unit_price, discount, subtotal, delivery_days, remark)
    VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(i + 1, it.item_name, it.valve_type, it.size_range, it.pressure_rating, it.body_material,
      it.connection_type, it.quantity, it.unit, it.unit_price, it.discount, it.subtotal, it.delivery_days, it.remark);
}

const r3 = tpl.saveFromQuotation(db, 1, { name: '来自报价单的模板' });
const t3 = tpl.getTemplate(db, r3.id);
check('从报价单沉淀为模板：规格与数量带过来',
  r3.item_count === 2 && t3.items[0].size_range === 'DN50' && t3.items[0].quantity === 10
  && t3.items[1].remark === '急件',
  `明细 ${t3.items.length} 行，首行 ${t3.items[0].size_range} × ${t3.items[0].quantity}`);

/* 不传名称时应自动生成带单号的名字，便于辨认来源 */
const r3b = tpl.saveFromQuotation(db, 1, {});
const t3b = tpl.getTemplate(db, r3b.id);
check('从报价单沉淀：不传名称时自动生成可辨识的名字（含单号）',
  /^来自报价单 BJ-20260914-001/.test(t3b.name), `名称「${t3b.name}」`);

check('从报价单沉淀：说明里留下来源单号（可追溯）',
  String(t3b.description || '').includes('BJ-20260914-001'),
  `说明「${t3b.description}」`);

check('从报价单沉淀：**不带价格**（模板结构性无价格列，明细也不含价格字段）',
  t3.items.every((it) => it.unit_price === undefined && it.subtotal === undefined && it.discount === undefined),
  '明细对象无 unit_price / discount / subtotal 字段');

try {
  db.prepare(`INSERT INTO quotations (id, project_id, quote_no, status) VALUES (2, 10, 'BJ-X', '草稿')`).run();
  tpl.saveFromQuotation(db, 2, {});
  check('报价单没有明细时拒绝沉淀', false, '未报错');
} catch (e) { check('报价单没有明细时拒绝沉淀', e.code === 'NO_ITEMS', e.message); }

/* ---------- 7. 套用模板 ---------- */
const before = tpl.getTemplate(db, r1.id);
const applied = tpl.applyTemplate(db, r1.id);
const after = tpl.getTemplate(db, r1.id);
check('套用模板：返回可直接插入报价单的明细行',
  applied.items.length === before.items.length
  && applied.items[0].item_name === '蝶阀' && applied.items[0].size_range === 'DN100',
  `返回 ${applied.items.length} 行，首行 ${applied.items[0].item_name} ${applied.items[0].size_range}`);

check('套用模板：**单价留空**由使用者填（模板不带价）',
  applied.items.every((it) => it.unit_price === '' && it.discount === 0),
  `unit_price=${JSON.stringify(applied.items[0].unit_price)} discount=${applied.items[0].discount}`);

check('套用模板：记录使用次数与最近使用时间',
  after.use_count === before.use_count + 1 && after.last_used_at !== '',
  `use_count ${before.use_count} → ${after.use_count}，last_used_at=${after.last_used_at}`);

check('套用模板：返回模板身份信息（便于界面提示）',
  applied.template && applied.template.id === r1.id && !!applied.template.name,
  `template=${JSON.stringify(applied.template)}`);

/* ---------- 8. 停用模板不可套用 ---------- */
tpl.saveTemplate(db, { id: r1.id, enabled: 0, name: t2.name, items: t2.items });
try {
  tpl.applyTemplate(db, r1.id);
  check('停用的模板拒绝套用', false, '未报错');
} catch (e) { check('停用的模板拒绝套用', e.code === 'DISABLED', e.message); }
tpl.saveTemplate(db, { id: r1.id, enabled: 1, name: t2.name, items: t2.items });
check('重新启用后可再次套用',
  tpl.applyTemplate(db, r1.id).items.length > 0, '套用成功');

/* ---------- 9. 排序 ---------- */
const r4 = tpl.saveTemplate(db, { name: '第二个模板', category: '闸阀', items: [{ item_name: '闸阀' }] });
const r5 = tpl.saveTemplate(db, { name: '第三个模板', category: '截止阀', items: [{ item_name: '截止阀' }] });
const list0 = tpl.listTemplates(db).list.map((t) => t.name);
check('新模板排在列表末尾（sort 递增）',
  list0[list0.length - 1] === '第三个模板', list0.join(' → '));

const mv = tpl.moveTemplate(db, r5.id, 'up');
const list1 = tpl.listTemplates(db).list.map((t) => t.name);
check('上移后顺序变化',
  mv.moved === true && list1.indexOf('第三个模板') < list1.indexOf('第二个模板'),
  list1.join(' → '));

const mvTop = tpl.moveTemplate(db, list1.indexOf('炼化常用球阀组合（改）') >= 0
  ? tpl.listTemplates(db).list[0].id : r1.id, 'up');
check('已在最前面时上移给出明确提示',
  mvTop.moved === false && /最前/.test(mvTop.message), mvTop.message);

const last = tpl.listTemplates(db).list.slice(-1)[0];
const mvBottom = tpl.moveTemplate(db, last.id, 'down');
check('已在最后面时下移给出明确提示',
  mvBottom.moved === false && /最后/.test(mvBottom.message), mvBottom.message);

/* ---------- 10. 筛选 ---------- */
const byCat = tpl.listTemplates(db, { category: '闸阀' });
check('按类别筛选', byCat.list.length === 1 && byCat.list[0].name === '第二个模板',
  `命中 ${byCat.list.length} 个`);

const byKw = tpl.listTemplates(db, { keyword: '炼化' });
check('按关键词搜索（匹配名称与说明）', byKw.list.length === 1 && /炼化/.test(byKw.list[0].name),
  `命中 ${byKw.list.length} 个：${byKw.list.map((t) => t.name).join('、')}`);

const enabledOnly = tpl.listTemplates(db, { enabledOnly: true });
check('只看启用的模板', enabledOnly.list.every((t) => t.enabled === 1),
  `返回 ${enabledOnly.list.length} 个，全部启用`);

check('列表带出类别清单（供筛选下拉）',
  tpl.listTemplates(db).categories.length >= 3,
  tpl.listTemplates(db).categories.join('、'));

/* ---------- 11. 删除 ---------- */
tpl.removeTemplate(db, r4.id);
check('软删除后不在列表里',
  tpl.listTemplates(db).list.every((t) => t.id !== r4.id)
  && db.prepare('SELECT deleted_at FROM quotation_templates WHERE id = ?').get(r4.id).deleted_at !== null,
  '已软删除');

check('软删除的模板查详情返回 null', tpl.getTemplate(db, r4.id) === null, 'null');

try {
  tpl.applyTemplate(db, r4.id);
  check('套用已删除的模板报错', false, '未报错');
} catch (e) { check('套用已删除的模板报错', e.code === 'NOT_FOUND', e.message); }

/* ---------- 12. 操作日志 ---------- */
const logCount = db.prepare("SELECT COUNT(*) AS n FROM activity_logs WHERE entity_type = 'quotation_template'").get().n;
check('模板的增删改都写入操作日志（可追溯）', logCount >= 4, `${logCount} 条日志`);

db.close();

const pass = results.filter((r) => r.pass).length;
const fail = results.length - pass;
console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
if (fail) {
  console.log('\n失败项：');
  for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
}
process.exit(fail ? 1 : 0);
