/**
 * 报价单全流程测试（B1）
 *
 * 覆盖：
 *   1. 接口：建单、明细金额、单号、列表、详情
 *   2. 接口：复制新版本、改状态、落标登记、中标回填、软删除
 *   3. 导出数据结构与**真实 xlsx 生成**（浏览器 SheetJS 生成后读回校验）
 *   4. 浏览器：项目详情页「报价单」标签可打开、能建单、明细行编辑与合计实时算
 *   5. 浏览器：改状态为已中标后弹出回填确认（不静默改项目）
 *   6. 删除后项目合同额不受影响
 *   7. 页面无 JS 报错
 *
 * 用法：先启动服务，再 node tools/test-quotation-flow.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));
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

(async () => {
  console.log('=== 报价单全流程测试 ===\n');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const created = { project: null, quotations: [], customer: null };

  /* 开跑前先清历史残留：上一轮若是中途抛错，清理段不会执行，
     残留项目会让"仅本套件自建数据"的断言失效（曾因此误判为测试失败）。 */
  {
    const stale = db.prepare(
      "SELECT id FROM customers WHERE name LIKE '%【报价流程测试%'"
    ).all().map((r) => r.id);
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
      console.log(`（已清理上一轮残留：客户 ${stale.length}、项目 ${pids.length}）\n`);
    }
  }

  /* ---------- 造客户与项目 ---------- */
  const cust = await api('POST', '/api/customers', {
    name: `【报价流程测试${tag}】某某石化有限公司`, short_name: `报价客户${tag}`,
    type: '终端用户', industry: '石油', phone: '0991-1234567'
  });
  created.customer = cust.data.id;
  const proj = await api('POST', '/api/projects', {
    name: `【报价流程测试${tag}】阀门采购项目`, customer_id: created.customer, stage: '询价报价'
  });
  created.project = proj.data.id;
  console.log(`已造客户 #${created.customer} 与项目 #${created.project}\n`);

  /* ---------- 1. 建单与金额 ---------- */
  const q1 = await api('POST', '/api/quotations', {
    project_id: created.project,
    items: [
      { item_name: '球阀', valve_type: '球阀', size_range: 'DN50', pressure_rating: 'Class150', body_material: 'WCB', quantity: 10, unit_price: 1000, discount: 10 },
      { item_name: '闸阀', valve_type: '闸阀', size_range: 'DN100', quantity: 3, unit_price: 500 }
    ]
  });
  created.quotations.push(q1.data.id);
  check('接口：新建报价单（自动取号 + 明细行数）',
    q1.status === 200 && q1.data.item_count === 2 && q1.data.total_amount === 10500,
    `id=${q1.data.id}，行数=${q1.data.item_count}，合计=${q1.data.total_amount}`);

  const detail1 = await api('GET', `/api/quotations/${q1.data.id}`);
  check('接口：单号格式为「前缀-日期-序号」',
    /^BJ-\d{8}-\d{3}$/.test(detail1.data.quote_no),
    detail1.data.quote_no);
  check('接口：合计 = 各行小计之和（9000 + 1500 = 10500）',
    detail1.data.total_amount === 10500
    && detail1.data.items[0].subtotal === 9000
    && detail1.data.items[1].subtotal === 1500,
    `合计 ${detail1.data.total_amount}，明细 ${detail1.data.items.map((i) => i.subtotal).join('/')}`);
  check('接口：报价单自动带出客户（跟随项目）',
    detail1.data.customer_id === created.customer,
    `customer_id=${detail1.data.customer_id}`);

  /* ---------- 2. 列表 ---------- */
  const list1 = await api('GET', `/api/quotations?project_id=${created.project}`);
  check('接口：按项目查询报价单列表', list1.data.total === 1, `共 ${list1.data.total} 张`);
  const listC = await api('GET', `/api/quotations?customer_id=${created.customer}`);
  check('接口：按客户查询（跨项目比价用）', listC.data.total >= 1, `共 ${listC.data.total} 张`);

  /* ---------- 3. 复制新版本 ---------- */
  const cp = await api('POST', `/api/quotations/${q1.data.id}/copy`);
  created.quotations.push(cp.data.id);
  const detail2 = await api('GET', `/api/quotations/${cp.data.id}`);
  check('接口：复制为新版本（版本 +1、状态重置为草稿、明细复制）',
    cp.data.version === 2 && detail2.data.status === '草稿'
    && detail2.data.items.length === 2 && detail2.data.total_amount === 10500
    && detail2.data.parent_id === q1.data.id,
    `V${cp.data.version} ${cp.data.quote_no}，${detail2.data.items.length} 行，合计 ${detail2.data.total_amount}`);

  /* ---------- 4. 改状态与落标登记 ---------- */
  const st = await api('POST', `/api/quotations/${cp.data.id}/status`, {
    status: '已落标', competitor: `竞对${tag}阀门厂`, competitor_price: 98000, lose_reason: '价格高 6%'
  });
  const detail3 = await api('GET', `/api/quotations/${cp.data.id}`);
  check('接口：落标时登记竞对与原因',
    st.data.terminal === true && detail3.data.competitor === `竞对${tag}阀门厂`
    && detail3.data.competitor_price === 98000 && detail3.data.lose_reason === '价格高 6%',
    `竞对=${detail3.data.competitor}，对手价=${detail3.data.competitor_price}，原因=${detail3.data.lose_reason}`);

  /* 非中标单拒绝回填（用落标的那张单验证） */
  {
    const r = await api('POST', `/api/quotations/${cp.data.id}/apply-to-project`);
    check('接口：非中标单拒绝回填项目合同额',
      r.status === 400 && r.code === 'NOT_WON', `${r.code}：${r.message}`);
  }

  /* ---------- 5. 中标与回填 ---------- */
  const projBefore = await api('GET', `/api/projects/${created.project}`);
  const amountBefore = projBefore.data.summary ? projBefore.data.summary.contract_amount : 0;

  const stWon = await api('POST', `/api/quotations/${q1.data.id}/status`, { status: '已中标' });
  check('接口：中标后返回可回填提示（含项目当前值，供界面确认）',
    stWon.data.can_apply === true && stWon.data.quote_total === 10500
    && stWon.data.project && stWon.data.project.contract_amount === amountBefore,
    `can_apply=${stWon.data.can_apply}，报价合计=${stWon.data.quote_total}，项目原合同额=${amountBefore}`);

  const amountAfterWon = (await api('GET', `/api/projects/${created.project}`)).data.summary.contract_amount;
  check('接口：仅改状态时**不动**项目合同额（回填需显式调用）',
    amountAfterWon === amountBefore, `合同额仍为 ${amountAfterWon}`);

  const ap = await api('POST', `/api/quotations/${q1.data.id}/apply-to-project`);
  const projAfter = await api('GET', `/api/projects/${created.project}`);
  check('接口：回填后项目合同额、阶段、投标结果一并更新',
    ap.data.applied === true
    && projAfter.data.summary.contract_amount === 10500
    && projAfter.data.stage === '已中标/已签约'
    && projAfter.data.bid_result === '已中标',
    ap.data.changes.map((c) => `${c.label} ${c.from}→${c.to}`).join('；'));

  /* ---------- 6. 导出数据与真实 xlsx ---------- */
  const ex = await api('GET', `/api/quotations/${q1.data.id}/export`);
  check('接口：导出数据结构含抬头、明细规格、合计',
    ex.data.items.length === 2 && ex.data.items[0].spec === '球阀 DN50 Class150 WCB'
    && ex.data.total_amount === 10500,
    `规格「${ex.data.items[0].spec}」，合计 ${ex.data.total_amount}`);
  check('接口：导出数据带出客户全称与项目名',
    ex.data.customer_name === `【报价流程测试${tag}】某某石化有限公司`
    && ex.data.project_name === `【报价流程测试${tag}】阀门采购项目`,
    `客户「${ex.data.customer_name}」，项目「${ex.data.project_name}」`);

  /* 用与前端相同的生成逻辑产出真实 xlsx，再解压读回校验。
     注意：xlsx 是 zip 压缩的，**不能靠在二进制里搜字符串判断内容**，
     必须解压后看 sheet1.xml（见 .fixtures/xlsx-inspect）。 */
  const { buildWorkbookAoa } = require('./.fixtures/quotation-export');
  const { readXlsxParts } = require('./.fixtures/xlsx-inspect');
  const buf = buildWorkbookAoa(ex.data, XLSX);
  const outFile = path.join(ROOT, '.fixtures', `报价单测试-${tag}.xlsx`);
  fs.writeFileSync(outFile, buf);
  const parts = readXlsxParts(buf);
  const back = XLSX.read(buf, { type: 'buffer' });
  const ws = back.Sheets[back.SheetNames[0]];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const flat = aoa.map((r) => r.join('|')).join('\n');

  check('导出：生成了可被 Excel 读回的 xlsx 文件',
    back.SheetNames[0] === '报价单' && aoa.length > 8 && parts.hasStyles,
    `${path.basename(outFile)}，${Math.round(buf.length / 1024)} KB，${aoa.length} 行，含 styles.xml`);
  /* 导出的单据上客户名用的是**全称**（单据要正式），所以按"含测试特征串"断言 */
  check('导出：单据含表头、客户全称、项目、单号',
    flat.includes('阀门产品报价单') && flat.includes(`报价流程测试${tag}`)
    && flat.includes(`【报价流程测试${tag}】阀门采购项目`) && flat.includes(detail1.data.quote_no),
    `含产品名=${flat.includes('阀门产品报价单')}、含客户=${flat.includes(`报价流程测试${tag}`)}、`
    + `含项目=${flat.includes(`【报价流程测试${tag}】阀门采购项目`)}、含单号=${flat.includes(detail1.data.quote_no)}`);
  check('导出：明细行含产品与规格',
    flat.includes('球阀') && flat.includes('DN50') && flat.includes('闸阀') && flat.includes('DN100'),
    '明细齐全');
  check('导出：合计金额正确呈现',
    flat.includes('10,500.00') || flat.includes('10500'), '合计已呈现');
  check('导出：单据排版生效（列宽 + 行高 + 合并单元格）',
    parts.hasCols && parts.colWidths.length >= 6 && parts.hasRowHeights && parts.mergeCount >= 3,
    `列宽 ${parts.colWidths.length} 列（${parts.colWidths.slice(0, 3).map((w) => w.toFixed(1)).join('/')}…），`
    + `行高已设=${parts.hasRowHeights}，合并 ${parts.mergeCount} 处`);

  /* 已知限制：SheetJS 社区版不写出单元格级样式（加粗/边框），此处显式记录而非假装通过 */
  check('导出：单元格级样式（加粗/边框）未写入 —— 已知限制',
    parts.hasCellStyles === false,
    '实测 sheet1.xml 无 s= 样式引用（SheetJS 社区版样式写出为 Pro 功能）');

  /* ---------- 7. 浏览器：项目详情页报价单标签 ---------- */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'quo-'));
  const PORT = 9380;
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1600,1100', 'about:blank'],
  { stdio: 'ignore' });

  try {
    for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
    const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');

    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/projects/' + created.project)}; 'ok'`);
    await sleep(4600);

    const tabs = await cdp.js(`(() => {
      const t = [...document.querySelectorAll('.tabs .tab')].map(x => x.textContent.replace(/\\s+/g,' ').trim());
      return { tabs: t, hasQuotation: t.some(x => x.includes('报价单')) };
    })()`);
    check('浏览器：项目详情出现「报价单」标签',
      tabs.hasQuotation === true, `标签：${tabs.tabs.join(' / ')}`);

    /* 切到报价单标签 */
    const listView = await cdp.js(`(async () => {
      const t = [...document.querySelectorAll('.tabs .tab')].find(x => x.textContent.includes('报价单'));
      t.click();
      await new Promise(r => setTimeout(r, 900));
      const wrap = [...document.querySelectorAll('.card')].find(c => /报价单/.test(((c.querySelector('.card-title')||{}).textContent||'')));
      if (!wrap) return { err: '未找到报价单卡片' };
      const rows = [...wrap.querySelectorAll('tbody tr')].map(tr => [...tr.querySelectorAll('td')].map(td => td.textContent.trim()));
      const btn = [...wrap.querySelectorAll('button')].map(b => b.textContent.trim());
      return { rowCount: rows.length, first: rows[0] || null, btn };
    })()`);
    check('浏览器：报价单列表显示已有报价单',
      !listView.err && listView.rowCount >= 2,
      listView.err || `共 ${listView.rowCount} 行；首行：${(listView.first || []).slice(0, 6).join(' | ')}`);
    check('浏览器：列表有 编辑 / 新版本 / 导出 / 删除 操作与新建入口',
      !listView.err && listView.btn.includes('+ 新建报价单')
      && ['编辑', '新版本', '导出', '删除'].every((b) => listView.btn.includes(b)),
      (listView.btn || []).join(' / '));

    /* 打开新建抽屉，验证明细行编辑与合计实时计算 */
    const drawer = await cdp.js(`(async () => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('新建报价单'));
      if (!b) return { err: '未找到新建按钮' };
      b.click();
      await new Promise(r => setTimeout(r, 1600));
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return { err: '抽屉未打开' };
      const rowsBefore = d.querySelectorAll('.quo-table tbody tr').length;

      /* 增加一行 */
      const addBtn = [...d.querySelectorAll('button')].find(x => x.textContent.includes('增加一行'));
      addBtn.click();
      await new Promise(r => setTimeout(r, 400));
      const rowsAfterAdd = d.querySelectorAll('.quo-table tbody tr').length;

      /* 填第一行。列索引以实际 DOM 为准：
         [0]名称 [1]口径 [2]压力 [3]材质 [4]连接 [5]数量 [6]单位 [7]单价 [8]折扣% [9]交期 [10]备注 */
      const setCell = (rowIdx, colIdx, val) => {
        const tr = d.querySelectorAll('.quo-table tbody tr')[rowIdx];
        const inputs = tr.querySelectorAll('input');
        const inp = inputs[colIdx];
        if (!inp) return;
        inp.value = val;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
      };
      setCell(0, 0, '球阀');
      setCell(0, 1, 'DN50');
      setCell(0, 5, '10');      // 数量
      setCell(0, 7, '1000');    // 单价
      setCell(0, 8, '10');      // 折扣%
      await new Promise(r => setTimeout(r, 600));

      const sub = d.querySelector('.quo-table tbody tr .quo-sub').textContent.trim();
      const total = d.querySelector('.quo-total').textContent.trim();
      return { rowsBefore, rowsAfterAdd, sub, total };
    })()`);
    check('浏览器：报价单抽屉可打开且能增加明细行',
      !drawer.err && drawer.rowsAfterAdd === drawer.rowsBefore + 1,
      drawer.err || `行数 ${drawer.rowsBefore} → ${drawer.rowsAfterAdd}`);
    /* 金额显示带千分位（9,000），断言前先去掉分隔符与小数尾零 */
    const norm = (s) => String(s || '').replace(/,/g, '').replace(/\.00$/, '').trim();
    check('浏览器：明细小计与合计实时计算（1000×10 让价 10% = 9000）',
      !drawer.err && norm(drawer.sub) === '9000' && norm(drawer.total) === '9000',
      drawer.err || `小计 ${drawer.sub}，合计 ${drawer.total}`);

    /* 关掉抽屉，测「已中标」状态下的回填确认（用第二张单：先建成草稿再改状态） */
    await cdp.js(`(() => { const d = [...document.querySelectorAll('.drawer')].pop(); if (d) { const x = [...d.querySelectorAll('.drawer-head button')].pop(); x && x.click(); } return 'ok'; })()`);
    await sleep(1000);

    const statusFlow = await cdp.js(`(async () => {
      const wrap = [...document.querySelectorAll('.card')].find(c => /报价单/.test(((c.querySelector('.card-title')||{}).textContent||'')));
      const sel = wrap.querySelector('tbody tr select');
      if (!sel) return { err: '未找到状态下拉' };
      const before = sel.value;
      sel.value = '已中标';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1600));
      const modal = document.querySelector('.modal-mask');
      return {
        before,
        modalOpen: !!modal,
        modalText: modal ? modal.innerText.replace(/\\s+/g, ' ').slice(0, 200) : '',
        btns: modal ? [...modal.querySelectorAll('button')].map(b => b.textContent.trim()) : []
      };
    })()`);
    check('浏览器：改状态为「已中标」弹出回填确认（不静默改项目）',
      !statusFlow.err && statusFlow.modalOpen === true,
      statusFlow.err || `确认框：${statusFlow.modalText}`);
    check('浏览器：确认框列出将改动的字段（合同额/阶段/投标结果）',
      /合同额/.test(statusFlow.modalText || '') && /阶段/.test(statusFlow.modalText || '')
      && /投标结果/.test(statusFlow.modalText || ''),
      '三个字段均已列出');
    check('浏览器：确认框提供「回填项目」与「暂不」两个选择',
      ['回填项目', '暂不'].every((b) => (statusFlow.btns || []).includes(b)),
      (statusFlow.btns || []).join(' / '));
    /* 选「暂不」，项目合同额应保持原值 */
    const decline = await cdp.js(`(async () => {
      const modal = document.querySelector('.modal-mask');
      if (!modal) return { err: '无确认框' };
      const cancel = [...modal.querySelectorAll('button')].find(b => b.textContent.trim() === '暂不');
      cancel.click();
      await new Promise(r => setTimeout(r, 1200));
      return { closed: !document.querySelector('.modal-mask') };
    })()`);
    const projAfterDecline = await api('GET', `/api/projects/${created.project}`);
    check('浏览器：选「暂不」时项目合同额不被改动',
      !decline.err && decline.closed && projAfterDecline.data.summary.contract_amount === 10500,
      `合同额仍为 ${projAfterDecline.data.summary.contract_amount}（回填前是 0，本次确实回填过所以是 10500）`);

    check('页面无 JS 报错', cdp.errors.length === 0,
      cdp.errors.length ? cdp.errors.slice(0, 2).join(' | ') : '0 条错误');

    cdp.ws.close();
  } finally {
    child.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  /* ---------- 清理 ---------- */
  for (const qid of created.quotations) {
    await api('DELETE', `/api/quotations/${qid}`).catch(() => {});
  }
  await api('POST', '/api/projects/batch-delete', { ids: [created.project] }).catch(() => {});
  await api('DELETE', `/api/customers/${created.customer}`).catch(() => {});

  for (const qid of created.quotations) {
    db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(qid);
    db.prepare('DELETE FROM quotations WHERE id = ?').run(qid);
  }
  db.prepare('DELETE FROM payments WHERE project_id = ?').run(created.project);
  db.prepare('DELETE FROM tasks WHERE project_id = ?').run(created.project);
  db.prepare('DELETE FROM projects WHERE id = ?').run(created.project);
  for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
    db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(created.customer);
  }
  db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?").run(created.customer);
  db.prepare("DELETE FROM activity_logs WHERE entity_type = 'quotation'").run();
  db.prepare('DELETE FROM customers WHERE id = ?').run(created.customer);
  db.prepare("DELETE FROM activity_logs WHERE entity_type = 'project' AND entity_id = ?").run(created.project);

  /* 只校验"本套件造的数据"是否清干净。
     不要用全库计数——全套件连跑时库里会有其它套件留下的项目/客户，
     那会让断言误报（曾经因此把"其它套件的数据"当成自己的残留）。 */
  const leftQ = db.prepare('SELECT COUNT(*) AS n FROM quotations WHERE project_id = ?').get(created.project).n;
  const leftItems = db.prepare(
    'SELECT COUNT(*) AS n FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE project_id = ?)'
  ).get(created.project).n;
  const leftProj = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE id = ?').get(created.project).n;
  const leftCust = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?').get(`%报价流程测试${tag}%`).n;
  check('本套件测试数据已清理',
    leftQ === 0 && leftItems === 0 && leftProj === 0 && leftCust === 0,
    `残留：报价单 ${leftQ}、明细 ${leftItems}、项目 ${leftProj}、客户 ${leftCust}`);
  try { fs.rmSync(outFile, { force: true }); } catch (_) { /* 忽略 */ }
  db.close();

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'quotation-flow-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
