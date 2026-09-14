/**
 * 报价模板 + 报价单管理 全流程测试
 *
 * 覆盖：
 *   A. 接口：模板 CRUD、排序、筛选、停用
 *   B. 接口：从报价单沉淀为模板、套用模板
 *   C. 接口：报价单总列表（跨项目）、筛选、汇总、状态计数
 *   D. 浏览器：设置页「报价模板」标签可管理模板（新建/编辑/删除）
 *   E. 浏览器：报价单独立页可打开、汇总卡与状态筛选生效
 *   F. 浏览器：报价单抽屉里能套用模板（带出规格且单价留空）
 *   G. 浏览器：客户详情页「报价记录」区显示跨项目报价
 *
 * 用法：先启动服务，再 node tools/test-quotation-template-flow.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.errors = []; }
  async connect() {
    this.ws = new globalThis.WebSocket(this.url);
    await new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', () => rej(new Error('CDP 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        this.errors.push((d.exception && d.exception.description) || d.text || '未知异常');
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); } }, 40000);
    });
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
  }
}

const tag = Date.now().toString().slice(-6);
const TPL_NAME = `流程测试模板${tag}`;
const TPL_NAME2 = `流程测试模板B${tag}`;

(async () => {
  console.log('=== 报价模板 + 报价单管理 全流程测试 ===\n');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const created = { customer: null, project: null, quotations: [], templates: [], templatesB: [] };

  /* 开跑前先清上一轮残留：套件中途抛错时清理段不会执行，
     残留模板会让"按关键词筛选命中数"这类断言失真（曾因此误报）。 */
  {
    const stale = db.prepare("SELECT id FROM customers WHERE name LIKE '%【模板流程测试%'").all().map((r) => r.id);
    if (stale.length) {
      const marks = stale.map(() => '?').join(',');
      const pids = db.prepare(`SELECT id FROM projects WHERE customer_id IN (${marks})`).all(...stale).map((r) => r.id);
      if (pids.length) {
        const pm = pids.map(() => '?').join(',');
        db.prepare(`DELETE FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE project_id IN (${pm}))`).run(...pids);
        db.prepare(`DELETE FROM quotations WHERE project_id IN (${pm})`).run(...pids);
        db.prepare(`DELETE FROM payments WHERE project_id IN (${pm})`).run(...pids);
        db.prepare(`DELETE FROM tasks WHERE project_id IN (${pm})`).run(...pids);
        db.prepare(`DELETE FROM projects WHERE id IN (${pm})`).run(...pids);
      }
      for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
        db.prepare(`DELETE FROM ${t} WHERE customer_id IN (${marks})`).run(...stale);
      }
      db.prepare(`DELETE FROM customers WHERE id IN (${marks})`).run(...stale);
    }
    const staleTpl = db.prepare("SELECT id FROM quotation_templates WHERE name LIKE '%流程测试模板%' OR name LIKE '%沉淀模板%'").all().map((r) => r.id);
    if (staleTpl.length) {
      const tm = staleTpl.map(() => '?').join(',');
      db.prepare(`DELETE FROM quotation_template_items WHERE template_id IN (${tm})`).run(...staleTpl);
      db.prepare(`DELETE FROM quotation_templates WHERE id IN (${tm})`).run(...staleTpl);
    }
    if (stale.length || staleTpl.length) {
      console.log(`（已清理上一轮残留：客户 ${stale.length}、模板 ${staleTpl.length}）\n`);
    }
  }

  /* ---------- 造基础数据 ---------- */
  const cust = await api('POST', '/api/customers', {
    name: `【模板流程测试${tag}】某某石化`, short_name: `模板客户${tag}`,
    type: '终端用户', industry: '石油', phone: `0991${tag}`
  });
  created.customer = cust.data.id;
  const proj = await api('POST', '/api/projects', {
    name: `【模板流程测试${tag}】阀门采购`, customer_id: created.customer, stage: '询价报价'
  });
  created.project = proj.data.id;
  console.log(`已造客户 #${created.customer} 与项目 #${created.project}\n`);

  /* ================= A. 模板 CRUD ================= */
  const t1 = await api('POST', '/api/quotation-templates', {
    name: TPL_NAME, category: '球阀', description: '流程测试用',
    items: [
      { item_name: '球阀', valve_type: '球阀', size_range: 'DN50', pressure_rating: 'Class150', body_material: 'WCB', connection_type: '法兰', quantity: 2, delivery_days: 30 },
      { item_name: '球阀', valve_type: '球阀', size_range: 'DN80', pressure_rating: 'Class300', body_material: '316L', connection_type: '法兰', quantity: 1, delivery_days: 45 }
    ]
  });
  created.templates.push(t1.data.id);
  check('接口：新建模板（含明细行数）',
    t1.status === 200 && t1.data.item_count === 2, `id=${t1.data.id}，行数=${t1.data.item_count}`);

  const tplDetail = await api('GET', `/api/quotation-templates/${t1.data.id}`);
  check('接口：模板详情返回明细且**不含价格字段**',
    tplDetail.data.items.length === 2
    && tplDetail.data.items.every((it) => it.unit_price === undefined && it.subtotal === undefined),
    `明细 ${tplDetail.data.items.length} 行，首行 ${tplDetail.data.items[0].size_range}`);

  const t2 = await api('POST', '/api/quotation-templates', {
    name: TPL_NAME2, category: '闸阀', items: [{ item_name: '闸阀', size_range: 'DN100', quantity: 1 }]
  });
  created.templatesB.push(t2.data.id);

  /* 关键词筛选：只应命中本次造的两个模板。
     注意断言用"命中数等于 2"，所以要确保库中没有同名残留（上面已清理）。 */
  const tplList = await api('GET', `/api/quotation-templates?q=${encodeURIComponent('流程测试模板')}`);
  check('接口：模板列表按关键词筛选',
    tplList.data.total === 2 && tplList.data.list.every((x) => x.name.includes('流程测试模板')),
    `命中 ${tplList.data.total} 个：${tplList.data.list.map((x) => x.name).join('、')}`);

  const mv = await api('POST', `/api/quotation-templates/${t2.data.id}/move`, { dir: 'up' });
  check('接口：模板排序可调整', mv.data.moved === true, mv.data.message);

  const dis = await api('PUT', `/api/quotation-templates/${t2.data.id}`, {
    name: TPL_NAME2, category: '闸阀', enabled: 0, items: [{ item_name: '闸阀', size_range: 'DN100' }]
  });
  const en = await api('GET', '/api/quotation-templates?enabledOnly=1');
  check('接口：停用的模板不出现在「仅启用」列表里',
    dis.status === 200 && !en.data.list.some((x) => x.id === t2.data.id),
    `仅启用列表 ${en.data.list.length} 个`);

  /* 停用模板不可套用：直接看响应（不要用 try/catch 判断，那样会把"没报错"误判成失败） */
  {
    const r = await api('POST', `/api/quotation-templates/${t2.data.id}/apply`);
    check('接口：停用的模板不可套用，并给出明确原因',
      r.status === 400 && r.code === 'DISABLED' && /已停用/.test(r.message || ''),
      `${r.code}：${r.message}`);
  }

  /* ================= B. 沉淀与套用 ================= */
  const q1 = await api('POST', '/api/quotations', {
    project_id: created.project,
    items: [
      { item_name: '蝶阀', valve_type: '蝶阀', size_range: 'DN200', pressure_rating: 'Class150', body_material: 'WCB', quantity: 4, unit_price: 2000, discount: 5 },
      { item_name: '止回阀', valve_type: '止回阀', size_range: 'DN100', quantity: 6, unit_price: 800 }
    ]
  });
  created.quotations.push(q1.data.id);
  check('接口：先建一张报价单（用于沉淀模板）',
    q1.status === 200 && q1.data.item_count === 2 && q1.data.total_amount === 12400,
    `行数 ${q1.data.item_count}，合计 ${q1.data.total_amount}`);

  const from = await api('POST', `/api/quotation-templates/from-quotation/${q1.data.id}`, {
    name: `沉淀模板${tag}`
  });
  created.templates.push(from.data.id);
  const fromDetail = await api('GET', `/api/quotation-templates/${from.data.id}`);
  check('接口：从报价单沉淀为模板（规格带过来）',
    from.data.item_count === 2 && fromDetail.data.items[0].size_range === 'DN200',
    `行数 ${from.data.item_count}，首行 ${fromDetail.data.items[0].size_range}`);
  check('接口：沉淀的模板不含价格',
    fromDetail.data.items.every((it) => it.unit_price === undefined),
    '明细无价格字段');

  const applied = await api('POST', `/api/quotation-templates/${t1.data.id}/apply`);
  check('接口：套用模板返回明细行、单价留空',
    applied.data.items.length === 2
    && applied.data.items.every((it) => it.unit_price === '')
    && applied.data.items[0].size_range === 'DN50',
    `${applied.data.items.length} 行；unit_price=${JSON.stringify(applied.data.items[0].unit_price)}`);

  const t1After = await api('GET', `/api/quotation-templates/${t1.data.id}`);
  check('接口：套用后使用次数与时间被记录',
    t1After.data.use_count >= 1 && t1After.data.last_used_at !== '',
    `use_count=${t1After.data.use_count}，last_used_at=${t1After.data.last_used_at}`);

  /* ================= C. 报价单总列表 ================= */
  const ov = await api('GET', '/api/quotations/overview');
  check('接口：报价单总列表可跨项目查询',
    ov.status === 200 && ov.data.total >= 1 && ov.data.list.some((x) => x.id === q1.data.id),
    `共 ${ov.data.total} 张`);
  check('接口：列表带出客户与项目名（便于识别）',
    ov.data.list.some((x) => x.id === q1.data.id && x.customer_name && x.project_name),
    '客户与项目名齐全');
  check('接口：汇总含合计金额与中标统计',
    ov.data.summary && typeof ov.data.summary.amount === 'number'
    && typeof ov.data.summary.won === 'number' && 'win_rate' in ov.data.summary,
    `合计 ${ov.data.summary.amount}，中标 ${ov.data.summary.won}，中标率 ${ov.data.summary.win_rate}`);

  const ovFiltered = await api('GET', `/api/quotations/overview?q=${encodeURIComponent(`模板流程测试${tag}`)}`);
  check('接口：总列表支持关键词筛选',
    ovFiltered.data.total >= 1 && ovFiltered.data.list.every((x) =>
      String(x.quote_no).includes(`模板流程测试${tag}`) || String(x.project_name || '').includes(`模板流程测试${tag}`)
      || String(x.customer_name || '').includes(`模板流程测试${tag}`)),
    `命中 ${ovFiltered.data.total} 张`);

  const sc = await api('GET', '/api/quotations/status-counts');
  check('接口：状态计数可用（供筛选标签）',
    sc.status === 200 && typeof sc.data.total === 'number' && sc.data.byStatus,
    `总数 ${sc.data.total}，草稿 ${sc.data.byStatus['草稿'] || 0}`);

  /* ================= 浏览器 ================= */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tplflow-'));
  const PORT = 9400;
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1600,1100', 'about:blank'],
  { stdio: 'ignore' });

  try {
    for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
    const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');

    /* ---------- D. 设置页模板管理 ---------- */
    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/settings')}; 'ok'`);
    await sleep(4600);

    const settingsTab = await cdp.js(`(async () => {
      const t = [...document.querySelectorAll('.settings-tabs .tab')].find(x => x.textContent.includes('报价模板'));
      if (!t) return { err: '未找到「报价模板」标签' };
      t.click();
      await new Promise(r => setTimeout(r, 2200));
      const c = document.querySelector('.content');
      const rows = [...c.querySelectorAll('tbody tr')];
      const text = c.innerText;
      return {
        tabExists: true,
        rowCount: rows.length,
        hasCreateBtn: [...c.querySelectorAll('button')].some(b => b.textContent.includes('新建模板')),
        mentionsNoPrice: /只存规格，不存价格/.test(text),
        names: rows.map(tr => (tr.querySelector('.tpl-name') || {}).textContent || '').filter(Boolean)
      };
    })()`);
    check('浏览器：设置页有「报价模板」标签且可打开',
      !settingsTab.err && settingsTab.tabExists, settingsTab.err || '已打开');
    check('浏览器：模板列表显示已有模板',
      !settingsTab.err && settingsTab.rowCount >= 2,
      `${(settingsTab.names || []).join(' / ')}`);
    check('浏览器：页面上说明了「模板只存规格不存价格」',
      settingsTab.mentionsNoPrice === true, '说明已展示');
    check('浏览器：有「新建模板」入口', settingsTab.hasCreateBtn === true, '存在');

    /* 通过界面新建一个模板 */
    const tplCreate = await cdp.js(`(async () => {
      const c = document.querySelector('.content');
      const btn = [...c.querySelectorAll('button')].find(b => b.textContent.includes('新建模板'));
      btn.click();
      await new Promise(r => setTimeout(r, 1600));
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return { err: '抽屉未打开' };

      const setField = (label, val) => {
        const f = [...d.querySelectorAll('.field')].find(x =>
          ((x.querySelector('.field-label') || {}).textContent || '').trim().startsWith(label));
        if (!f) return 'no-field';
        const inp = f.querySelector('input, textarea');
        if (!inp) return 'no-input';
        inp.value = val;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      };
      const nameOk = setField('模板名称', ${JSON.stringify(`${TPL_NAME}-界面`)});
      setField('类别', '球阀');

      /* 填第一行明细 */
      const tr = d.querySelector('.quo-table tbody tr');
      const inputs = [...tr.querySelectorAll('input')];
      const put = (i, v) => { inputs[i].value = v; inputs[i].dispatchEvent(new Event('input', { bubbles: true })); };
      put(0, '球阀'); put(1, 'DN300'); put(2, 'Class600'); put(3, '316L'); put(4, '法兰'); put(5, '3');
      await new Promise(r => setTimeout(r, 400));

      const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存模板'));
      if (!save) return { err: '未找到保存按钮', nameOk };
      save.click();
      await new Promise(r => setTimeout(r, 2600));
      return {
        nameOk,
        drawerGone: ![...document.querySelectorAll('.drawer')].some(x => x.querySelector('.quo-table')),
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
      };
    })()`);
    check('浏览器：可在界面新建模板（含明细行）',
      !tplCreate.err && tplCreate.nameOk === 'ok' && tplCreate.drawerGone,
      tplCreate.err || `提示：${(tplCreate.toasts || []).join(' / ')}`);

    const uiTpl = db.prepare('SELECT id, name FROM quotation_templates WHERE name = ?').get(`${TPL_NAME}-界面`);
    if (uiTpl) created.templates.push(uiTpl.id);
    const uiTplItems = uiTpl
      ? db.prepare('SELECT * FROM quotation_template_items WHERE template_id = ? ORDER BY seq').all(uiTpl.id)
      : [];
    check('浏览器：界面新建的模板已落库且明细正确',
      !!uiTpl && uiTplItems.length === 1 && uiTplItems[0].size_range === 'DN300'
      && uiTplItems[0].pressure_rating === 'Class600' && uiTplItems[0].quantity === 3,
      uiTpl ? `模板 #${uiTpl.id}，明细 ${uiTplItems.length} 行：${uiTplItems[0] ? uiTplItems[0].size_range + ' ' + uiTplItems[0].pressure_rating + ' ×' + uiTplItems[0].quantity : '-'}` : '未落库');

    /* ---------- E. 报价单独立页 ---------- */
    await cdp.js(`location.hash = '#/quotations'; 'ok'`);
    await sleep(3800);
    const quoPage = await cdp.js(`(() => {
      const c = document.querySelector('.content');
      const stats = [...c.querySelectorAll('.stat')].map(s => ({
        l: (s.querySelector('.l') || {}).textContent,
        n: (s.querySelector('.n') || {}).textContent
      }));
      const chips = [...c.querySelectorAll('.quick-chips .chip')].map(x => x.textContent.replace(/\\s+/g,' ').trim());
      const rows = [...c.querySelectorAll('tbody tr')].length;
      return { stats, chips, rows };
    })()`);
    check('浏览器：报价单独立页可打开且有汇总卡',
      quoPage.stats.length >= 5, `${quoPage.stats.map((s) => s.l + '=' + s.n).join('，')}`);
    check('浏览器：有状态快捷筛选标签',
      quoPage.chips.length >= 5 && quoPage.chips.some((x) => x.includes('已中标')),
      quoPage.chips.join(' / '));

    /* ---------- F. 报价单抽屉里套用模板 ---------- */
    await cdp.js(`location.hash = ${JSON.stringify('#/projects/' + created.project)}; 'ok'`);
    await sleep(4000);
    const applyTpl = await cdp.js(`(async () => {
      /* 切到报价单标签并打开新建 */
      const t = [...document.querySelectorAll('.tabs .tab')].find(x => x.textContent.includes('报价单'));
      if (!t) return { err: '未找到报价单标签' };
      t.click();
      await new Promise(r => setTimeout(r, 900));
      const nb = [...document.querySelectorAll('button')].find(x => x.textContent.includes('新建报价单'));
      if (!nb) return { err: '未找到新建报价单按钮' };
      nb.click();
      await new Promise(r => setTimeout(r, 1800));
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return { err: '抽屉未打开' };

      const bar = d.querySelector('.tpl-apply-bar');
      if (!bar) return { err: '抽屉里没有「套用模板」条' };
      const sel = bar.querySelector('select');
      if (!sel) return { err: '没有模板下拉' };
      const opts = [...sel.options].map(o => o.textContent.trim());
      /* 选中流程测试模板 */
      const target = [...sel.options].find(o => o.textContent.includes(${JSON.stringify(TPL_NAME)}));
      if (!target) return { err: '下拉里没有本次测试的模板', opts };
      sel.value = target.value;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));

      const btn = [...bar.querySelectorAll('button')].find(b => b.textContent.includes('带出规格'));
      if (!btn) return { err: '未找到带出规格按钮', opts };
      btn.click();
      await new Promise(r => setTimeout(r, 2200));

      /* 若弹出"替换/追加"确认，选替换 */
      const modal = document.querySelector('.modal-mask');
      if (modal) {
        const ok = [...modal.querySelectorAll('button')].find(b => b.textContent.trim() === '替换');
        if (ok) ok.click();
        await new Promise(r => setTimeout(r, 1600));
      }

      const d2 = [...document.querySelectorAll('.drawer')].pop();
      const trs = [...d2.querySelectorAll('.quo-table tbody tr')];
      const first = trs[0] ? [...trs[0].querySelectorAll('input')].map(i => i.value) : [];
      return {
        opts,
        rowCount: trs.length,
        firstRow: { name: first[0], size: first[1], pressure: first[2], material: first[3], qty: first[5], price: first[7] },
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
      };
    })()`);
    check('浏览器：报价单抽屉里有「套用模板」条与模板下拉',
      !applyTpl.err && (applyTpl.opts || []).length > 0,
      applyTpl.err || `下拉 ${applyTpl.opts.length} 个选项`);
    check('浏览器：套用模板后明细被带出（规格完整、行数正确）',
      !applyTpl.err && applyTpl.rowCount === 2
      && applyTpl.firstRow.size === 'DN50' && applyTpl.firstRow.pressure === 'Class150'
      && applyTpl.firstRow.material === 'WCB' && applyTpl.firstRow.qty === '2',
      applyTpl.err || `行数 ${applyTpl.rowCount}，首行 ${applyTpl.firstRow.name} ${applyTpl.firstRow.size} ${applyTpl.firstRow.pressure} ${applyTpl.firstRow.material} × ${applyTpl.firstRow.qty}`);
    check('浏览器：套用后**单价留空**（模板不带价，等使用者填）',
      !applyTpl.err && applyTpl.firstRow.price === '',
      applyTpl.err || `单价字段值=${JSON.stringify(applyTpl.firstRow.price)}；提示：${(applyTpl.toasts || []).join(' / ')}`);

    /* 填入单价并保存，验证套用后的数据可用 */
    const saveQuo = await cdp.js(`(async () => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      const setField = (label, val) => {
        const f = [...d.querySelectorAll('.field')].find(x =>
          ((x.querySelector('.field-label') || {}).textContent || '').trim().startsWith(label));
        if (!f) return 'no-field';
        const inp = f.querySelector('input');
        if (!inp) return 'no-input';
        inp.value = val;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        return 'ok';
      };
      const trs = [...d.querySelectorAll('.quo-table tbody tr')];
      trs.forEach((tr, i) => {
        const inputs = [...tr.querySelectorAll('input')];
        inputs[7].value = String(1000 + i * 100);   // 单价
        inputs[7].dispatchEvent(new Event('input', { bubbles: true }));
      });
      await new Promise(r => setTimeout(r, 500));
      const total = d.querySelector('.quo-total').textContent.trim();
      const save = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存报价单'));
      if (!save) return { err: '未找到保存按钮', total };
      save.click();
      await new Promise(r => setTimeout(r, 2800));
      return {
        total,
        drawerGone: ![...document.querySelectorAll('.drawer')].some(x => x.querySelector('.quo-table')),
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
      };
    })()`);
    check('浏览器：套用模板后填价保存成功（合计实时计算）',
      !saveQuo.err && saveQuo.drawerGone,
      saveQuo.err || `合计 ${saveQuo.total}；提示：${(saveQuo.toasts || []).join(' / ')}`);

    const newQ = db.prepare(
      'SELECT id, total_amount FROM quotations WHERE project_id = ? ORDER BY id DESC LIMIT 1'
    ).get(created.project);
    const newQItems = newQ
      ? db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY seq').all(newQ.id)
      : [];
    if (newQ) created.quotations.push(newQ.id);
    check('浏览器：套用模板生成的报价单已落库且明细来自模板',
      !!newQ && newQItems.length === 2 && newQItems[0].size_range === 'DN50'
      && newQItems[0].unit_price === 1000 && newQItems[1].unit_price === 1100,
      newQ ? `报价单 #${newQ.id}，合计 ${newQ.total_amount}，明细 ${newQItems.length} 行（单价 ${newQItems.map((i) => i.unit_price).join('/')}）` : '未落库');

    /* ---------- G. 客户详情页报价记录 ---------- */
    await cdp.js(`location.hash = ${JSON.stringify('#/customers/' + created.customer)}; 'ok'`);
    await sleep(4000);
    const custQuo = await cdp.js(`(async () => {
      const t = [...document.querySelectorAll('.tabs .tab')].find(x => x.textContent.includes('报价记录'));
      if (!t) return { err: '未找到「报价记录」标签' };
      t.click();
      await new Promise(r => setTimeout(r, 900));
      const c = document.querySelector('.content');
      const rows = [...c.querySelectorAll('tbody tr')];
      const text = c.innerText;
      return {
        rows: rows.length,
        mentionsCrossProject: /全部项目/.test(text),
        hasExport: [...c.querySelectorAll('button')].some(b => b.textContent.includes('导出'))
      };
    })()`);
    check('浏览器：客户详情页有「报价记录」区',
      !custQuo.err && custQuo.rows >= 2,
      custQuo.err || `显示 ${custQuo.rows} 张报价单`);
    check('浏览器：说明该区汇总了「全部项目」的报价',
      custQuo.mentionsCrossProject === true, '说明已展示');
    check('浏览器：报价记录可导出', custQuo.hasExport === true, '有导出按钮');

    check('页面无 JS 报错', cdp.errors.length === 0,
      cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '0 条错误');

    cdp.ws.close();
  } finally {
    child.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  /* ================= 清理 ================= */
  for (const qid of created.quotations) {
    await api('DELETE', `/api/quotations/${qid}`).catch(() => {});
    db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(qid);
    db.prepare("DELETE FROM activity_logs WHERE entity_type = 'quotation' AND entity_id = ?").run(qid);
    db.prepare('DELETE FROM quotations WHERE id = ?').run(qid);
  }
  for (const tid of [...created.templates, ...created.templatesB]) {
    if (!tid) continue;
    db.prepare('DELETE FROM quotation_template_items WHERE template_id = ?').run(tid);
    db.prepare('DELETE FROM quotation_templates WHERE id = ?').run(tid);
  }
  db.prepare("DELETE FROM quotation_template_items WHERE template_id IN (SELECT id FROM quotation_templates WHERE name LIKE ?)").run(`%${tag}%`);
  db.prepare('DELETE FROM quotation_templates WHERE name LIKE ?').run(`%${tag}%`);
  db.prepare('DELETE FROM payments WHERE project_id = ?').run(created.project);
  db.prepare('DELETE FROM tasks WHERE project_id = ?').run(created.project);
  db.prepare('DELETE FROM projects WHERE id = ?').run(created.project);
  for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
    db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(created.customer);
  }
  db.prepare('DELETE FROM customers WHERE id = ?').run(created.customer);
  db.prepare("DELETE FROM activity_logs WHERE entity_type IN ('quotation_template','project')").run();

  const leftTpl = db.prepare('SELECT COUNT(*) AS n FROM quotation_templates WHERE name LIKE ?').get(`%${tag}%`).n;
  const leftQuo = db.prepare('SELECT COUNT(*) AS n FROM quotations WHERE project_id = ?').get(created.project).n;
  const leftProj = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE id = ?').get(created.project).n;
  const leftCust = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE id = ?').get(created.customer).n;
  check('本套件测试数据已清理',
    leftTpl === 0 && leftQuo === 0 && leftProj === 0 && leftCust === 0,
    `残留：模板 ${leftTpl}、报价单 ${leftQuo}、项目 ${leftProj}、客户 ${leftCust}`);
  db.close();

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'quotation-template-flow-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
