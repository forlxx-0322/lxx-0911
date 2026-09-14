/**
 * 报价单「删列安全性」穷举测试
 *
 * 要回答的问题：**删掉任意一列（内置列或自定义列）之后，别的功能还能不能用？**
 *
 * 做法：把每一列**逐个删掉**，每删一列就把报价单这条线上的功能跑一遍：
 *   ① 新建报价单（明细填满）→ 金额由服务端算对不对
 *   ② 读回 → 行数、金额、其余各列的值是否完好
 *   ③ 覆盖保存（改数量）→ 金额更新、其它列的值不丢
 *   ④ 复制为新版本 → 明细一致
 *   ⑤ 从报价单沉淀为模板 → 成功
 *   ⑥ 套用该模板 → 行数正确、单价留空
 *   ⑦ 导出数据 + 真出一份 xlsx 读回 → 被删的列不进单据，小计/合计金额正确
 *   ⑧ 改状态「已中标」+ 回填项目合同额 → 项目与客户的金额跟着更新
 *   ⑨ 报价单总列表 / 汇总 / 状态计数 → 数字仍然算得对
 *   ⑩ 恢复该列 → 表格列视图恢复、历史值还在
 *
 * 另外还做一轮**跨模块冒烟**：把能删的列全删掉之后，
 * 首页总览、客户、项目、待办、操作日志、备份、回收站是否照常。
 *
 * 注意：四列「名称/阀种、数量、单价、小计」按设计不允许删除 ——
 * 这里同样逐个验证"删不掉且给出原因"，并确认拒绝之后功能一切正常。
 * 本套件会临时改动列配置，跑完在 finally 里**原样恢复**（含列名与已删列表）。
 *
 * 用法：先启动服务，再 node tools/test-quotation-delete-column-safety.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
};

async function api(method, p, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const j = await res.json().catch(() => null);
  return { status: res.status, data: j && j.data, code: j && j.code, message: j && j.message };
}

const tag = Date.now().toString().slice(-6);
const P = `【删列测试${tag}】`;
const LOCKED = ['item_name', 'quantity', 'unit_price', 'subtotal'];

(async () => {
  console.log('=== 报价单删列安全性 穷举测试 ===\n');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const created = { customer: null, project: null, quotations: [], templates: [], fields: [] };
  let labelsAtStart = null, hiddenAtStart = null;

  /** 造一单：明细填满（含所有启用的自定义列） */
  const mkItems = (extraIds, qtyBase) => [
    Object.assign({
      item_name: '球阀', valve_type: '球阀', size_range: 'DN80', pressure_rating: 'Class300',
      body_material: '316L', connection_type: '法兰', quantity: qtyBase, unit: '台',
      unit_price: 1000, discount: 10, delivery_days: 30, remark: '第一行'
    }, extraIds.length ? { extra: Object.fromEntries(extraIds.map((id, i) => [String(id), `V1-${i}`])) } : {}),
    Object.assign({
      item_name: '闸阀', valve_type: '闸阀', size_range: 'DN100', pressure_rating: 'Class150',
      body_material: 'WCB', connection_type: '对夹式', quantity: 2, unit: '台',
      unit_price: 500, discount: 0, delivery_days: 15, remark: '第二行'
    }, extraIds.length ? { extra: Object.fromEntries(extraIds.map((id, i) => [String(id), `V2-${i}`])) } : {})
  ];

  /** 一次性把某列删掉再跑一整套功能，返回失败项列表（空数组 = 全好） */
  async function battery(label, expect) {
    const bad = [];
    const note = (cond, what) => { if (!cond) bad.push(what); };

    const lf = await api('GET', '/api/quotation-fields');
    const visible = (lf.data.columns || []).filter((c) => c.enabled).map((c) => c.key);
    const customIds = (lf.data.list || []).filter((f) => f.enabled).map((f) => f.id);

    /* ① 新建 */
    const q = await api('POST', '/api/quotations', {
      project_id: created.project, remark: `删列测试-${label}`, items: mkItems(customIds, 3)
    });
    if (q.status !== 200) { bad.push(`新建失败(${q.status} ${q.code || ''})`); return bad; }
    created.quotations.push(q.data.id);
    /* 3×1000 让价 10% = 2700；2×500 = 1000 → 合计 3700 */
    note(q.data.total_amount === 3700, `合计应为 3700，实得 ${q.data.total_amount}`);

    /* ② 读回：其余各列的值完好 */
    const got = await api('GET', `/api/quotations/${q.data.id}`);
    note(got.status === 200 && got.data.items.length === 2, '读回行数不对');
    const it0 = (got.data.items || [])[0] || {};
    note(it0.size_range === 'DN80' && it0.pressure_rating === 'Class300' && it0.body_material === '316L'
      && it0.connection_type === '法兰' && it0.delivery_days === 30 && it0.remark === '第一行',
      '未删列的值丢了');
    note(Number(it0.discount) === 0.1, `折扣应保留 0.1，实得 ${it0.discount}`);
    /* 自定义列的值：只有"被删的那一列"是自定义列时才允许它自己消失，其余必须都在 */
    for (const c of (lf.data.columns || [])) {
      if (c.type !== 'custom' || !c.enabled) continue;
      if (c.key === expect.deletedKey) continue;
      const v = it0.extra ? it0.extra[String(c.id)] : undefined;
      note(v === 'V1-' + customIds.indexOf(c.id), `自定义列「${c.label}」的值丢了（${v}）`);
    }

    /* ③ 覆盖保存：改数量后金额更新，值不丢 */
    const edited = await api('PUT', `/api/quotations/${q.data.id}`, {
      project_id: created.project,
      items: got.data.items.map((x) => Object.assign({}, x, { quantity: Number(x.quantity) + 1 }))
    });
    note(edited.status === 200, `覆盖保存失败(${edited.status} ${edited.code || ''})`);
    const got2 = await api('GET', `/api/quotations/${q.data.id}`);
    /* 4×1000 让价 10% = 3600；3×500 = 1500 → 5100 */
    note(got2.data.total_amount === 5100, `改数量后合计应为 5100，实得 ${got2.data.total_amount}`);
    note(got2.data.items[0].size_range === 'DN80' && got2.data.items[0].remark === '第一行', '覆盖保存后列的值丢了');

    /* ④ 复制新版本 */
    const cp = await api('POST', `/api/quotations/${q.data.id}/copy`);
    note(cp.status === 200 && cp.data.version >= 2, `复制新版本失败(${cp.status})`);
    if (cp.status === 200) {
      created.quotations.push(cp.data.id);
      const cpGot = await api('GET', `/api/quotations/${cp.data.id}`);
      note(cpGot.data.items.length === 2 && cpGot.data.total_amount === 5100, '复制出来的明细/金额不对');
    }

    /* ⑤ 沉淀为模板 */
    const tpl = await api('POST', `/api/quotation-templates/from-quotation/${q.data.id}`, { name: `${P}模板-${label}` });
    note(tpl.status === 200, `沉淀模板失败(${tpl.status} ${tpl.code || ''})`);
    if (tpl.status === 200) created.templates.push(tpl.data.id);

    /* ⑥ 套用模板 */
    if (tpl.status === 200) {
      const ap = await api('POST', `/api/quotation-templates/${tpl.data.id}/apply`);
      note(ap.status === 200 && ap.data.items.length === 2, `套用模板失败(${ap.status})`);
      note(ap.status === 200 && ap.data.items.every((x) => x.unit_price === ''), '套用模板时价格应留空');
    }

    /* ⑦ 导出数据 + 真出 xlsx */
    const ex = await api('GET', `/api/quotations/${q.data.id}/export`);
    note(ex.status === 200 && !!ex.data, `导出数据失败(${ex.status})`);
    if (ex.status === 200) {
      try {
        const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));
        const { buildWorkbookAoa } = require('./.fixtures/quotation-export');
        const wb = XLSX.read(buildWorkbookAoa(ex.data, XLSX), { type: 'buffer' });
        const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
        const at = rows.findIndex((r) => r[0] === '序号');
        const head = (rows[at] || []).map(String);
        const first = (rows[at + 1] || []).map(String);
        const sumRow = rows.find((r) => r[0] === '合计') || [];
        const sumCol = head.indexOf('小计(元)');
        note(head.includes('小计(元)') && head.includes('单价(元)'), '单据缺少金额列');
        note(String(first[sumCol]) === '3,600.00', `单据首行小计应为 3,600.00，实得 ${first[sumCol]}`);
        note(String(sumRow[sumCol]) === '5,100.00', `单据合计应为 5,100.00，实得 ${sumRow[sumCol]}`);
        if (expect.deletedLabel) {
          /* 用**精确相等**判断：自定义列里可能叫「设计压力」，它包含「压力」二字，
             用 includes 会误报。被删的列要么整列不在表头里，
             要么（规格类字段）被并进「规格型号」——那种情况看下一项断言。 */
          note(!head.includes(expect.deletedLabel),
            `单据里仍出现了被删的列「${expect.deletedLabel}」`);
        }
        if (expect.specValue) {
          /* 被删的是并进「规格型号」的字段：它的值不应再出现在合并文本里 */
          const spec = String(first[head.indexOf('规格型号')] || '');
          note(!spec.includes(expect.specValue),
            `「规格型号」里仍带着被删字段的值 ${expect.specValue}（${spec}）`);
        }
      } catch (e) {
        bad.push('xlsx 生成/读取异常：' + (e.message || e));
      }
    }

    /* ⑧ 状态流转 + 回填项目合同额 */
    const st = await api('POST', `/api/quotations/${q.data.id}/status`, { status: '已中标' });
    note(st.status === 200 && st.data.can_apply === true, `改状态失败(${st.status} ${st.code || ''})`);
    const ap2 = await api('POST', `/api/quotations/${q.data.id}/apply-to-project`);
    note(ap2.status === 200 && ap2.data.applied === true, `回填项目失败(${ap2.status} ${ap2.code || ''})`);
    const proj = await api('GET', `/api/projects/${created.project}`);
    note(proj.status === 200 && Number(proj.data.contract_amount) === 5100,
      `项目合同额应为 5100，实得 ${proj.data && proj.data.contract_amount}`);

    /* ⑨ 列表 / 汇总 / 状态计数（总列表接口是 /api/quotations/overview） */
    const list = await api('GET', '/api/quotations/overview?page=1&pageSize=5');
    note(list.status === 200 && list.data && typeof list.data.summary.amount === 'number',
      `报价单总列表/汇总不可用(${list.status} ${list.code || ''})`);
    note(list.status === 200 && Array.isArray(list.data.list) && list.data.list.length >= 1,
      '报价单总列表没返回刚建的单');
    const sc2 = await api('GET', '/api/quotations/status-counts');
    note(sc2.status === 200 && (sc2.data.byStatus['已中标'] || 0) >= 1, '状态计数不含已中标');
    const sts = await api('GET', '/api/quotations/statuses');
    note(sts.status === 200 && Array.isArray(sts.data.list), '状态清单不可用');

    /* 清掉这一轮的报价单，避免影响下一轮的统计 */
    for (const qid of [q.data.id, cp.status === 200 ? cp.data.id : null].filter(Boolean)) {
      await api('DELETE', `/api/quotations/${qid}`).catch(() => {});
      try {
        db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(qid);
        db.prepare("DELETE FROM activity_logs WHERE entity_type = 'quotation' AND entity_id = ?").run(qid);
        db.prepare('DELETE FROM quotations WHERE id = ?').run(qid);
      } catch (_) { /* 忽略 */ }
    }
    created.quotations = created.quotations.filter((x) => x !== q.data.id);

    /* 项目合同额复原，免得影响下一轮断言 */
    try {
      db.prepare("UPDATE projects SET contract_amount = 0, stage = '询价报价', bid_result = '' WHERE id = ?")
        .run(created.project);
      db.prepare('UPDATE customers SET deal_amount = 0 WHERE id = ?').run(created.customer);
    } catch (_) { /* 忽略 */ }

    return bad;
  }

  const restoreConfig = async () => {
    try {
      const lf = await api('GET', '/api/quotation-fields');
      for (const c of (lf.data.columns || [])) {
        if (c.type === 'builtin' && !c.enabled) {
          await api('POST', '/api/quotation-fields/visibility', { key: c.key, visible: true });
        }
      }
      const allKeys = ['item_name', 'size_range', 'pressure_rating', 'body_material', 'connection_type',
        'quantity', 'unit', 'unit_price', 'discount', 'subtotal', 'delivery_days', 'remark'];
      for (const k of allKeys) {
        await api('POST', '/api/quotation-fields/rename',
          { key: k, label: (labelsAtStart || {})[k] || '' });
      }
      /* 使用者原本删掉的列，重新删掉 */
      for (const k of (hiddenAtStart || [])) {
        await api('POST', '/api/quotation-fields/visibility', { key: k, visible: false });
      }
    } catch (_) { /* 忽略 */ }
  };

  try {
    /* ---------- 记下使用者当前的列配置 ---------- */
    const lf0 = await api('GET', '/api/quotation-fields');
    labelsAtStart = lf0.data.labels || {};
    hiddenAtStart = lf0.data.hidden || [];
    console.log(`当前配置：自定义列 ${lf0.data.total} 个，改名列 ${Object.keys(labelsAtStart).length} 个，`
      + `已删列 ${hiddenAtStart.length} 个\n`);

    /* 先把使用者删掉的列恢复出来，这样每一列都能被逐一验证 */
    for (const k of hiddenAtStart) await api('POST', '/api/quotation-fields/visibility', { key: k, visible: true });

    /* 清上一轮残留 */
    {
      const stale = db.prepare('SELECT id FROM customers WHERE name LIKE ?').all('%【删列测试%').map((r) => r.id);
      for (const cid of stale) {
        const pids = db.prepare('SELECT id FROM projects WHERE customer_id = ?').all(cid).map((r) => r.id);
        for (const pid of pids) {
          db.prepare('DELETE FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE project_id = ?)').run(pid);
          db.prepare('DELETE FROM quotations WHERE project_id = ?').run(pid);
          db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
        }
        for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
          db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(cid);
        }
        db.prepare('DELETE FROM customers WHERE id = ?').run(cid);
      }
      const staleTpl = db.prepare('SELECT id FROM quotation_templates WHERE name LIKE ?').all(`%${P}%`).map((r) => r.id);
      for (const tid of staleTpl) {
        db.prepare('DELETE FROM quotation_template_items WHERE template_id = ?').run(tid);
        db.prepare('DELETE FROM quotation_templates WHERE id = ?').run(tid);
      }
      /* 套件自己建的临时自定义列 */
      const staleF = db.prepare('SELECT id FROM quotation_fields WHERE name LIKE ?').all('%【删列测试%').map((r) => r.id);
      for (const fid of staleF) {
        db.prepare('DELETE FROM activity_logs WHERE entity_type = ? AND entity_id = ?').run('quotation_field', fid);
        db.prepare('DELETE FROM quotation_fields WHERE id = ?').run(fid);
      }
    }

    /* ---------- 造基础数据 ---------- */
    const cust = await api('POST', '/api/customers', {
      name: `${P}某某石化`, short_name: `删列客户${tag}`, type: '终端用户', industry: '化工'
    });
    created.customer = cust.data.id;
    const proj = await api('POST', '/api/projects', {
      name: `${P}阀门采购`, customer_id: created.customer, stage: '询价报价'
    });
    created.project = proj.data.id;

    /* 一个临时自定义列（模拟"非内置列"被删的情形） */
    const tmpField = await api('POST', '/api/quotation-fields', { name: `${P}临时介质`, kind: 'text' });
    created.fields.push(tmpField.data.id);
    console.log(`已造客户 #${created.customer}、项目 #${created.project}、临时自定义列 #${tmpField.data.id}\n`);

    /* ================= 逐个删除内置列 ================= */
    const builtins = (lf0.data.builtins || []);
    console.log(`--- 逐个删除 ${builtins.length} 个内置列，每次都跑一遍报价单全流程 ---\n`);

    for (const b of builtins) {
      const isLocked = LOCKED.includes(b.key);

      if (isLocked) {
        /* 必需列：删不掉，但拒绝之后功能必须照常 */
        const del = await api('POST', '/api/quotation-fields/visibility', { key: b.key, visible: false });
        check(`必需列「${b.label}」删不掉，并且说明了原因`,
          del.status === 400 && del.code === 'COLUMN_REQUIRED' && String(del.message || '').length > 8,
          `${del.status} ${del.code}`);
        const bad = await battery(`锁定-${b.key}`, { deletedKey: null, deletedLabel: null });
        check(`（试图删「${b.label}」被拒后）报价单其它功能全部正常`,
          bad.length === 0, bad.length ? bad.slice(0, 3).join('；') : '保存/读回/改/复制/模板/导出/中标回填/列表 均正常');
        continue;
      }

      /* 可删的内置列：删掉 → 跑全套 → 恢复 */
      const del = await api('POST', '/api/quotation-fields/visibility', { key: b.key, visible: false });
      if (del.status !== 200) {
        check(`删除内置列「${b.label}」`, false, `${del.status} ${del.code} ${del.message || ''}`);
        continue;
      }
      const lfNow = await api('GET', '/api/quotation-fields');
      const colNow = (lfNow.data.columns || []).find((c) => c.key === b.key);
      check(`删除内置列「${b.label}」后，它确实从表格列里消失（列管理里仍可见）`,
        colNow && colNow.enabled === false, `enabled=${colNow && colNow.enabled}`);

      const bad = await battery(`内置-${b.key}`, {
        deletedKey: b.key,
        deletedLabel: colNow ? colNow.label : b.label,
        /* 并进「规格型号」的那几个字段：删掉后它的值不该再出现在合并文本里 */
        specValue: { size_range: 'DN80', pressure_rating: 'Class300', body_material: '316L', connection_type: '法兰' }[b.key] || null
      });
      check(`删掉「${b.label}」之后，报价单其它功能全部正常`,
        bad.length === 0,
        bad.length ? bad.slice(0, 3).join('；') : '新建/读回/改名保存/复制版本/沉淀模板/套用/导出/中标回填/列表统计 均正常');

      const back = await api('POST', '/api/quotation-fields/visibility', { key: b.key, visible: true });
      const lfBack = await api('GET', '/api/quotation-fields');
      const colBack = (lfBack.data.columns || []).find((c) => c.key === b.key);
      check(`恢复内置列「${b.label}」后回到表格里`,
        back.status === 200 && colBack && colBack.enabled === true, `enabled=${colBack && colBack.enabled}`);
    }

    /* ================= 删掉自定义列（非内置列） ================= */
    console.log('\n--- 删除自定义列（非内置列）---\n');
    {
      const before = await api('GET', '/api/quotation-fields');
      const tmp = (before.data.list || []).find((f) => f.name === `${P}临时介质`);
      check('临时自定义列建好了', !!tmp, tmp ? `#${tmp.id}` : '未找到');

      const bad = await battery('自定义列在用', { deletedKey: null, deletedLabel: null });
      check('（自定义列还在时）报价单全流程正常', bad.length === 0,
        bad.length ? bad.slice(0, 3).join('；') : '全部正常');

      const del = await api('DELETE', `/api/quotation-fields/${tmp.id}`);
      check('自定义列可以删除（软删除，返回影响面）',
        del.status === 200 && typeof del.data.used_in === 'number', `影响 ${del.data && del.data.used_in} 张报价单`);

      const bad2 = await battery('自定义列已删', { deletedKey: 'f:' + tmp.id, deletedLabel: tmp.name });
      check('删掉自定义列之后，报价单其它功能全部正常', bad2.length === 0,
        bad2.length ? bad2.slice(0, 3).join('；') : '新建/读回/保存/复制/模板/导出/中标回填/列表统计 均正常');

      /* 其余自定义列的值不受影响 */
      const lf = await api('GET', '/api/quotation-fields');
      const others = (lf.data.list || []).filter((f) => f.id !== tmp.id && f.enabled);
      if (others.length) {
        const q = await api('POST', '/api/quotations', {
          project_id: created.project,
          items: mkItems(others.map((f) => f.id), 1)
        });
        created.quotations.push(q.data.id);
        const g = await api('GET', `/api/quotations/${q.data.id}`);
        const okAll = others.every((f, i) => g.data.items[0].extra[String(f.id)] === `V1-${i}`);
        check(`删掉一列不影响其它 ${others.length} 个自定义列的值`,
          q.status === 200 && okAll,
          okAll ? '其余自定义列的值都完好' : JSON.stringify(g.data.items[0].extra));
        await api('DELETE', `/api/quotations/${q.data.id}`).catch(() => {});
        db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(q.data.id);
        db.prepare('DELETE FROM quotations WHERE id = ?').run(q.data.id);
      } else {
        check('删掉一列不影响其它自定义列的值（使用者当前没有别的自定义列）', true, '无其它自定义列可比');
      }
    }

    /* ================= 跨模块冒烟：能删的全删掉 ================= */
    console.log('\n--- 把能删的列全删掉后，其它模块冒烟 ---\n');
    {
      const lf = await api('GET', '/api/quotation-fields');
      const deletable = (lf.data.columns || []).filter((c) => c.type === 'builtin' && c.enabled && !LOCKED.includes(c.key));
      for (const c of deletable) await api('POST', '/api/quotation-fields/visibility', { key: c.key, visible: false });

      const lf2 = await api('GET', '/api/quotation-fields');
      const left = (lf2.data.columns || []).filter((c) => c.type === 'builtin' && c.enabled).map((c) => c.key);
      check('把能删的都删光后，只剩四列必需列在表格里',
        left.length === 4 && LOCKED.every((k) => left.includes(k)), `剩下 ${left.join('、')}`);

      const dash = await api('GET', '/api/dashboard');
      check('跨模块：首页总览照常', dash.status === 200 && !!dash.data.cards, `卡片 ${dash.data && Object.keys(dash.data.cards || {}).length} 张`);
      const cl = await api('GET', '/api/customers?page=1&pageSize=5');
      check('跨模块：客户列表照常', cl.status === 200 && typeof cl.data.total === 'number', `客户 ${cl.data && cl.data.total}`);
      const cd = await api('GET', `/api/customers/${created.customer}`);
      check('跨模块：客户详情照常', cd.status === 200 && cd.data.name === `${P}某某石化`, cd.data && cd.data.name);
      const pl = await api('GET', '/api/projects?page=1&pageSize=5');
      check('跨模块：项目列表照常', pl.status === 200 && typeof pl.data.total === 'number', `项目 ${pl.data && pl.data.total}`);
      const tk = await api('GET', '/api/tasks?view=all');
      check('跨模块：待办中心照常', tk.status === 200, `待办 ${(tk.data && tk.data.list && tk.data.list.length) || 0} 条`);
      const lg = await api('GET', '/api/logs?page=1&pageSize=5');
      check('跨模块：操作日志照常', lg.status === 200 && typeof lg.data.total === 'number', `日志 ${lg.data && lg.data.total} 条`);
      const tr = await api('GET', '/api/trash');
      check('跨模块：回收站照常', tr.status === 200, '可打开');
      const bk = await api('POST', '/api/backup/create', { reason: '删列安全性测试' });
      check('跨模块：备份仍能创建（列配置改动不影响备份）', bk.status === 200 && !!bk.data.name, bk.data && bk.data.name);
      const one = await api('GET', '/api/quotations/statuses');
      check('跨模块：报价单状态字典照常',
        one.status === 200 && Array.isArray(one.data.list) && one.data.list.length === 5,
        (one.data && one.data.list || []).join('/'));

      /* 全删状态下再跑一遍全流程 */
      const bad = await battery('全删', { deletedKey: null, deletedLabel: null });
      check('把所有能删的列都删掉之后，报价单全流程仍然正常', bad.length === 0,
        bad.length ? bad.slice(0, 3).join('；') : '新建/读回/保存/复制/模板/导出/中标回填/列表统计 均正常');
    }
  } finally {
    /* ---------- 恢复使用者的列配置 ---------- */
    await restoreConfig();

    /* ---------- 清理测试数据 ---------- */
    for (const qid of created.quotations) {
      await api('DELETE', `/api/quotations/${qid}`).catch(() => {});
      try {
        db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(qid);
        db.prepare("DELETE FROM activity_logs WHERE entity_type = 'quotation' AND entity_id = ?").run(qid);
        db.prepare('DELETE FROM quotations WHERE id = ?').run(qid);
      } catch (_) { /* 忽略 */ }
    }
    for (const tid of created.templates) {
      try {
        db.prepare('DELETE FROM quotation_template_items WHERE template_id = ?').run(tid);
        db.prepare('DELETE FROM quotation_templates WHERE id = ?').run(tid);
      } catch (_) { /* 忽略 */ }
    }
    try {
      db.prepare('DELETE FROM quotation_template_items WHERE template_id IN (SELECT id FROM quotation_templates WHERE name LIKE ?)').run(`%${P}%`);
      db.prepare('DELETE FROM quotation_templates WHERE name LIKE ?').run(`%${P}%`);
      const fids = db.prepare('SELECT id FROM quotation_fields WHERE name LIKE ?').all(`%${P}%`).map((r) => r.id);
      for (const fid of fids) {
        db.prepare('DELETE FROM activity_logs WHERE entity_type = ? AND entity_id = ?').run('quotation_field', fid);
        db.prepare('DELETE FROM quotation_fields WHERE id = ?').run(fid);
      }
      if (created.project) {
        db.prepare('DELETE FROM payments WHERE project_id = ?').run(created.project);
        db.prepare('DELETE FROM tasks WHERE project_id = ?').run(created.project);
        db.prepare('DELETE FROM projects WHERE id = ?').run(created.project);
      }
      if (created.customer) {
        for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
          db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(created.customer);
        }
        db.prepare('DELETE FROM customers WHERE id = ?').run(created.customer);
      }
    } catch (_) { /* 忽略 */ }

    const now = await api('GET', '/api/quotation-fields').catch(() => null);
    const labelsNow = (now && now.data.labels) || {};
    const hiddenNow = (now && now.data.hidden) || [];
    check('列配置（列名 + 已删列）已恢复成使用者原来的样子',
      JSON.stringify(labelsNow) === JSON.stringify(labelsAtStart || {})
      && JSON.stringify([...hiddenNow].sort()) === JSON.stringify([...(hiddenAtStart || [])].sort()),
      `改名列 ${Object.keys(labelsNow).length}（原 ${Object.keys(labelsAtStart || {}).length}），`
      + `已删列 ${hiddenNow.length}（原 ${(hiddenAtStart || []).length}）`);

    const leftCust = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?').get('%【删列测试%').n;
    const leftTpl = db.prepare('SELECT COUNT(*) AS n FROM quotation_templates WHERE name LIKE ?').get(`%${P}%`).n;
    const leftFld = db.prepare('SELECT COUNT(*) AS n FROM quotation_fields WHERE name LIKE ?').get(`%${P}%`).n;
    check('本套件测试数据已清理（使用者的列一个没动）',
      leftCust === 0 && leftTpl === 0 && leftFld === 0,
      `残留：客户 ${leftCust}、模板 ${leftTpl}、临时列 ${leftFld}`);
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
    path.join(ROOT, '.fixtures', 'quotation-delete-column-safety-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
