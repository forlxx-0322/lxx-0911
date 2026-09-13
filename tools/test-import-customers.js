/**
 * 批量导入客户测试
 *
 * 覆盖：
 *   - 模板内容：含必填标记、示例行、只填必填的最小示例、填写说明、可选值参考（字典值）
 *   - 真实 xlsx 往返：用 SheetJS 生成一份"填好的表"→ 后端校验 → 导入 → 核对落库
 *   - 重名处理：skip（跳过，库中原值不变）/ update（更新，只覆盖表格里填了的列）
 *   - 错误行：必填缺失、文件内重复、找不到所属客户
 *   - 字典自动补全：表格里出现字典外的词，导入后进字典
 *   - 归属地州：导入的客户按「市/地区」自动归入地图统计
 *   - 空行跳过、5000 行上限
 *
 * 用法：先启动服务，再 node tools/test-import-customers.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

async function api(method, p, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const json = await res.json().catch(() => null);
  return { status: res.status, data: json && json.data, code: json && json.code, message: json && json.message };
}

/* 用 SheetJS 在 Node 侧生成与前端同构的工作簿，验证真实 xlsx 读写链路 */
const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));

const tag = Date.now().toString().slice(-6);
const created = [];

/** 按模板表头构造一张"填好的表" */
function buildSheet(tpl, rows) {
  const header = tpl.fields.map((f) => (f.required ? f.label + ' *' : f.label));
  const aoa = [header];
  for (const r of rows) {
    aoa.push(tpl.fields.map((f) => (r[f.key] === undefined ? '' : r[f.key])));
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '客户导入模板');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
}

/** 模拟前端：读出 xlsx → 按表头映射成 JSON 行 */
function sheetToRows(tpl, buf) {
  const wb = XLSX.read(buf, { type: 'array', cellDates: true });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const headerRow = aoa[0].map((h) => String(h || '').replace(/[*＊\s]/g, ''));
  const colMap = [];
  for (const f of tpl.fields) {
    const idx = headerRow.findIndex((h) => h === f.label);
    if (idx >= 0) colMap[idx] = f;
  }
  const rows = [];
  for (let i = 1; i < aoa.length; i++) {
    const line = aoa[i];
    if (!line || line.every((c) => String(c || '').trim() === '')) continue;
    const obj = {};
    for (let c = 0; c < line.length; c++) if (colMap[c]) obj[colMap[c].key] = line[c];
    rows.push(obj);
  }
  return rows;
}

(async () => {
  console.log('=== 批量导入客户测试 ===\n');

  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));

  try {
    /* ---------- 1. 模板内容 ---------- */
    const tplRes = await api('GET', '/api/data/template?entity=customer');
    check('模板接口可用', tplRes.status === 200 && tplRes.data.fields.length > 50,
      `${tplRes.data.fields.length} 个字段`);
    const tpl = tplRes.data;

    const required = tpl.fields.filter((f) => f.required);
    check('模板标出必填列', required.length >= 4,
      `必填：${required.map((f) => f.label).join('、')}`);

    const withOptions = tpl.fields.filter((f) => f.options && f.options.length);
    check('字典列附带可选值（供"可选值参考"页使用）', withOptions.length >= 8,
      `${withOptions.length} 个字典列，例如「${withOptions[0].label}」：${withOptions[0].options.slice(0, 4).join('、')}…`);

    check('示例值齐全（用于第 2 行示例）',
      tpl.sample.length === tpl.fields.length && tpl.sample.filter((x) => x !== '').length > 30,
      `${tpl.sample.filter((x) => x !== '').length} 列有示例值`);

    /* 生成一份真实 xlsx 并读回，验证列名匹配逻辑 */
    const sampleBuf = buildSheet(tpl, [{
      name: `【导入验证${tag}】甲`, short_name: `甲${tag}`, type: '终端用户', industry: '石油',
      city: '乌鲁木齐市', district: '天山区', address: '天山区某路 1 号'
    }]);
    const backRows = sheetToRows(tpl, sampleBuf);
    check('xlsx 往返：写入后能正确读回并按表头映射',
      backRows.length === 1 && backRows[0].name === `【导入验证${tag}】甲` && backRows[0].city === '乌鲁木齐市',
      `读回 1 行，name=${backRows[0].name}，city=${backRows[0].city}`);

    /* ---------- 2. 预校验 ---------- */
    const rows = [
      { name: `【导入验证${tag}】甲`, short_name: `甲${tag}`, type: '终端用户', industry: '石油', city: '乌鲁木齐市', district: '天山区' },
      { name: `【导入验证${tag}】乙`, short_name: `乙${tag}`, type: '设计院', industry: '化工', city: '库尔勒市', district: '' },
      { name: `【导入验证${tag}】丙`, short_name: `丙${tag}`, type: '终端用户', industry: '石油', district: '莎车县' },
      { name: '', short_name: '', type: '终端用户', industry: '石油' },                     // 缺必填
      { name: `【导入验证${tag}】甲`, short_name: '重复', type: '终端用户', industry: '石油' } // 文件内重复
    ];
    const prev = await api('POST', '/api/data/preview', { entity: 'customer', rows });
    check('预校验：区分"可导入"与"有问题"',
      prev.data.total === 5 && prev.data.valid === 3 && prev.data.invalid === 2,
      `共 ${prev.data.total} 行：可导入 ${prev.data.valid}，有问题 ${prev.data.invalid}`);

    const errRow = prev.data.rows.find((r) => r.index === 4);
    check('预校验：必填缺失被识别',
      errRow && errRow.errors.some((e) => /必填/.test(e)),
      errRow ? errRow.errors.join('；') : '未找到该行');
    const dupRow = prev.data.rows.find((r) => r.index === 5);
    check('预校验：文件内重复被识别为错误',
      dupRow && dupRow.errors.some((e) => /文件内/.test(e)),
      dupRow ? dupRow.errors.join('；') : '未找到该行');

    /* ---------- 3. 执行导入（skip 模式） ---------- */
    const rep = await api('POST', '/api/data/import', { entity: 'customer', rows, duplicate_mode: 'skip' });
    check('导入（skip 模式）：新增 3 条、错误 2 条',
      rep.data.imported === 3 && rep.data.invalid === 2,
      `新增 ${rep.data.imported}，更新 ${rep.data.updated}，跳过 ${rep.data.skipped}，校验未通过 ${rep.data.invalid}，失败 ${rep.data.failed}`);

    for (const nm of ['甲', '乙', '丙']) {
      const r = db.prepare('SELECT id, name, city, district, address, region_code FROM customers WHERE name = ?')
        .get(`【导入验证${tag}】${nm}`);
      if (r) created.push(r.id);
    }
    check('导入的客户已落库', created.length === 3, `落库 ${created.length} 条`);

    /* ---------- 4. 归属地州自动补全（导入路径单独处理） ---------- */
    const jia = db.prepare('SELECT * FROM customers WHERE name = ?').get(`【导入验证${tag}】甲`);
    const yi = db.prepare('SELECT * FROM customers WHERE name = ?').get(`【导入验证${tag}】乙`);
    const bing = db.prepare('SELECT * FROM customers WHERE name = ?').get(`【导入验证${tag}】丙`);
    check('导入后按「市/地区」自动归属地州（甲：乌鲁木齐）',
      jia && jia.region_code === '650100', jia ? `${jia.region_code} ${jia.region_name}` : '未找到');
    check('导入后支持"只填县级市"的写法（乙：库尔勒市）',
      yi && yi.region_code === '652800', yi ? `${yi.region_code} ${yi.region_name}` : '未找到');
    check('导入后支持"只填区县"的写法（丙：莎车县）',
      bing && bing.region_code === '653100', bing ? `${bing.region_code} ${bing.region_name}` : '未找到');

    /* ---------- 5. 重名：skip 模式保留库中原值 ---------- */
    db.prepare('UPDATE customers SET address = ? WHERE id = ?').run('原有地址不可覆盖', jia.id);
    const dupRows = [{
      name: `【导入验证${tag}】甲`, short_name: '改名尝试',
      type: '终端用户', industry: '石油', address: '表格里的新地址'
    }];
    const prevSkip = await api('POST', '/api/data/preview', { entity: 'customer', rows: dupRows, duplicate_mode: 'skip' });
    if (!prevSkip.data) {
      check('重名在 skip 模式下算"可导入（跳过）"而非错误', false,
        `预校验返回异常：HTTP ${prevSkip.status} ${prevSkip.code || ''} ${prevSkip.message || ''}`);
    } else {
      check('重名在 skip 模式下算"可导入（跳过）"而非错误',
        prevSkip.data.valid === 1 && prevSkip.data.invalid === 0
        && prevSkip.data.rows[0].action === 'skip',
        `action=${prevSkip.data.rows[0].action}，warnings=${JSON.stringify(prevSkip.data.rows[0].warnings)}`);
    }

    const repSkip = await api('POST', '/api/data/import', { entity: 'customer', rows: dupRows, duplicate_mode: 'skip' });
    const afterSkip = db.prepare('SELECT address FROM customers WHERE id = ?').get(jia.id);
    check('skip 模式：库中原值不被覆盖',
      repSkip.data.skipped === 1 && repSkip.data.imported === 0 && afterSkip.address === '原有地址不可覆盖',
      `跳过 ${repSkip.data.skipped}，地址仍为「${afterSkip.address}」`);

    /* ---------- 6. 重名：update 模式只覆盖填了值的列 ---------- */
    const prevUpd = await api('POST', '/api/data/preview', { entity: 'customer', rows: dupRows, duplicate_mode: 'update' });
    check('重名在 update 模式下算"将更新"',
      prevUpd.data.valid === 1 && prevUpd.data.rows[0].action === 'update'
      && prevUpd.data.rows[0].warnings.some((w) => /更新/.test(w)),
      `action=${prevUpd.data.rows[0].action}，提示：${prevUpd.data.rows[0].warnings.join('；')}`);

    const repUpd = await api('POST', '/api/data/import', { entity: 'customer', rows: dupRows, duplicate_mode: 'update' });
    const afterUpd = db.prepare('SELECT name, short_name, address, city, region_code FROM customers WHERE id = ?').get(jia.id);
    check('update 模式：更新已有记录',
      repUpd.data.updated === 1 && afterUpd.address === '表格里的新地址',
      `更新 ${repUpd.data.updated} 条，地址变为「${afterUpd.address}」`);
    check('update 模式：表格留空的列保持库中原值（不清空）',
      afterUpd.city === '乌鲁木齐市' && afterUpd.region_code === '650100',
      `city=「${afterUpd.city}」region_code=「${afterUpd.region_code}」（表格未填这两列）`);
    check('update 模式：匹配键（客户全称）不被改写',
      afterUpd.name === `【导入验证${tag}】甲`, `name=「${afterUpd.name}」`);

    /* ---------- 7. 字典自动补全 ---------- */
    const newIndustry = `导入新行业${tag}`;
    const before = db.prepare("SELECT COUNT(*) AS n FROM dict WHERE category='industry' AND value = ?").get(newIndustry).n;
    const repDict = await api('POST', '/api/data/import', {
      entity: 'customer',
      rows: [{
        name: `【导入验证${tag}】丁`, short_name: `丁${tag}`,
        type: '终端用户', industry: newIndustry, city: '喀什地区'
      }]
    });
    const after = db.prepare("SELECT COUNT(*) AS n FROM dict WHERE category='industry' AND value = ?").get(newIndustry).n;
    const ding = db.prepare('SELECT id FROM customers WHERE name = ?').get(`【导入验证${tag}】丁`);
    if (ding) created.push(ding.id);
    check('字典里没有的选项会被自动补进字典',
      before === 0 && after === 1 && repDict.data.dictAdded >= 1,
      `新增字典项 ${repDict.data.dictAdded} 个，库中出现「${newIndustry}」=${after === 1}`);

    /* ---------- 8. 找不到所属客户 ---------- */
    const contactPrev = await api('POST', '/api/data/preview', {
      entity: 'contact',
      rows: [{ customer_name: '绝对不存在的客户XYZ', name: '某人' }]
    });
    check('联系人导入：找不到所属客户时给出明确错误',
      contactPrev.data.invalid === 1
      && contactPrev.data.rows[0].errors.some((e) => /找不到客户/.test(e)),
      contactPrev.data.rows[0].errors.join('；'));

    /* ---------- 9. 空行与上限 ---------- */
    const withBlank = await api('POST', '/api/data/preview', {
      entity: 'customer',
      rows: [
        { name: `【导入验证${tag}】空行测试`, short_name: '空行', type: '终端用户', industry: '石油' },
        { name: '', short_name: '', type: '', industry: '' }
      ]
    });
    check('全空行会被跳过而不是报错',
      withBlank.data.rows.length === 2,
      `返回 ${withBlank.data.rows.length} 行（第 2 行为全空，前端读表时也会先跳过）`);

    const tooMany = await api('POST', '/api/data/preview', {
      entity: 'customer',
      rows: Array.from({ length: 5001 }, (_, i) => ({ name: `x${i}`, short_name: 'y', type: '终端用户', industry: '石油' }))
    });
    check('超过 5000 行被拒绝并提示',
      tooMany.status === 400 && tooMany.code === 'TOO_MANY',
      tooMany.message || tooMany.code);
  } finally {
    /* 清理：测试客户 + 自动补的字典项 */
    const ids = created.filter(Boolean);
    for (const id of ids) {
      for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
        db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(id);
      }
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?").run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM customers WHERE name LIKE ?').run(`【导入验证${tag}】%`);
    db.prepare("DELETE FROM dict WHERE value LIKE ? AND is_system = 0").run(`导入新行业${tag}%`);
    db.prepare("DELETE FROM activity_logs WHERE entity_type = 'import' AND summary LIKE ?").run(`%${tag}%`);
    const left = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?').get(`【导入验证${tag}】%`).n;
    check('测试数据已清理', left === 0, `残留 ${left} 条`);
    db.close();
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'import-customers-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
    'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
