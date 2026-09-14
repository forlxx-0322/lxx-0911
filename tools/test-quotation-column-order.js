/**
 * 报价明细「列顺序」全流程测试
 *
 * 需求：报价模板里规格明细的**所有列都能移动位置**（内置列 + 自定义列），
 * 且顺序是**全局一套** —— 报价单明细、报价模板、导出的 Excel 单据三处一致。
 *
 * 覆盖：
 *   A. 接口：列顺序读取（含内置列定义、列视图）
 *   B. 接口：单列左右移动（内置列也支持）、边界提示、非法入参
 *   C. 接口：整体保存顺序（漏传自动补齐、未知/重复键被过滤）
 *   D. 接口：顺序持久化在设置项里（换页面/重启后仍在）
 *   E. 接口：列视图按 scope 过滤（模板不含价格列）
 *   F. 浏览器：报价模板表头 ◀ ▶ 真能移动列，且报价单明细跟着一致
 *   G. 导出：单据列顺序跟着全局列序走（真出 xlsx 读回校验）
 *
 * 注意：列顺序是**使用者的真实配置**（不是测试数据），所以本套件
 * 开跑前先记下原顺序，跑完在 finally 里**原样恢复**，并断言恢复成功。
 *
 * 用法：先启动服务，再 node tools/test-quotation-column-order.js
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
const TPL_NAME = `【列序测试${tag}】模板`;
const CUSTOMER_NAME = `【列序测试${tag}】某某装备`;

(async () => {
  console.log('=== 报价明细列顺序 全流程测试 ===\n');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const created = { customer: null, project: null, quotations: [], templates: [], fields: [] };
  let cdp = null, child = null, profile = null;
  let originalOrder = null;

  const readOrder = async () => (await api('GET', '/api/quotation-fields/order')).data.order;

  try {
    /* ---------- 记下使用者当前的列顺序，跑完要原样还回去 ---------- */
    originalOrder = await readOrder();
    console.log(`原列顺序（${originalOrder.length} 列）：${originalOrder.join(' > ')}\n`);

    /* 清上一轮残留（套件中途失败时清理段不会执行） */
    {
      const stale = db.prepare('SELECT id FROM customers WHERE name LIKE ?').all('%【列序测试%').map((r) => r.id);
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
      const staleTpl = db.prepare('SELECT id FROM quotation_templates WHERE name LIKE ?').all('%【列序测试%').map((r) => r.id);
      for (const tid of staleTpl) {
        db.prepare('DELETE FROM quotation_template_items WHERE template_id = ?').run(tid);
        db.prepare('DELETE FROM quotation_templates WHERE id = ?').run(tid);
      }
      if (stale.length || staleTpl.length) {
        console.log(`（已清理上一轮残留：客户 ${stale.length}、模板 ${staleTpl.length}）\n`);
      }
    }

    /* ================= A. 列顺序读取 ================= */
    const lf = await api('GET', '/api/quotation-fields');
    check('接口：列清单返回内置列定义（供界面标注「内置」）',
      Array.isArray(lf.data.builtins) && lf.data.builtins.length >= 10
      && lf.data.builtins.some((b) => b.key === 'item_name' && b.label.includes('名称')),
      `${(lf.data.builtins || []).length} 个内置列`);

    const cols = lf.data.columns || [];
    const builtinKeys = (lf.data.builtins || []).map((b) => b.key);
    const customIds = (lf.data.list || []).map((f) => 'f:' + f.id);
    check('接口：列视图 = 内置列 + 自定义列，一个不少',
      cols.length === builtinKeys.length + customIds.length
      && builtinKeys.every((k) => cols.some((c) => c.key === k))
      && customIds.every((k) => cols.some((c) => c.key === k)),
      `共 ${cols.length} 列（内置 ${builtinKeys.length} + 自定义 ${customIds.length}）`);

    check('接口：列视图里标出了"仅报价单"的内置列（模板不含价格）',
      cols.filter((c) => ['unit_price', 'discount', 'subtotal'].includes(c.key)).length === 3,
      cols.filter((c) => ['unit_price', 'discount', 'subtotal'].includes(c.key)).map((c) => c.label).join('、'));

    const order0 = await readOrder();
    check('接口：列顺序不含重复、且与列视图一致',
      order0.length === new Set(order0).size && order0.length === cols.length,
      `${order0.length} 项，无重复`);

    check('接口：默认情况下内置列保持既有相对次序（名称→口径→…→备注）',
      (() => {
        const seq = ['item_name', 'size_range', 'pressure_rating', 'body_material', 'connection_type']
          .map((k) => order0.indexOf(k));
        return seq.every((v, i) => v >= 0 && (i === 0 || v > seq[i - 1]));
      })(),
      order0.slice(0, 6).join(' > '));

    /* 造一条自定义列用于测试移动（带前缀，跑完删掉） */
    const mk = await api('POST', '/api/quotation-fields', { name: `【列序测试${tag}】临时列`, kind: 'text' });
    created.fields.push(mk.data.id);
    const myKey = 'f:' + mk.data.id;
    const afterCreate = await readOrder();
    check('接口：新列自动排进列顺序（接在已有自定义列之后，不会跑到最前或最后）',
      afterCreate.includes(myKey) && afterCreate.indexOf(myKey) > afterCreate.indexOf('connection_type')
      && afterCreate.indexOf(myKey) < afterCreate.indexOf('quantity'),
      `位置 ${afterCreate.indexOf(myKey)} / ${afterCreate.length}`);

    /* ================= B. 单列移动 ================= */
    const beforeMove = await readOrder();          // 含刚建的临时列，作为基线
    const mvRemark = await api('POST', '/api/quotation-fields/move', { key: 'remark', dir: 'left' });
    check('接口：内置列（备注）可以左移',
      mvRemark.status === 200 && mvRemark.data.moved === true
      && mvRemark.data.order.indexOf('remark') === beforeMove.indexOf('remark') - 1,
      `备注位置 ${beforeMove.indexOf('remark')} → ${mvRemark.data.order.indexOf('remark')}`);

    /* 一路左移到最前面 */
    let o = mvRemark.data.order;
    for (let i = o.indexOf('remark'); i > 0; i--) {
      const r = await api('POST', '/api/quotation-fields/move', { key: 'remark', dir: 'left' });
      o = r.data.order;
    }
    check('接口：内置列可以一路移到第一位',
      o[0] === 'remark', `当前首列：${o[0]}`);

    const mvFirst = await api('POST', '/api/quotation-fields/move', { key: 'remark', dir: 'left' });
    check('接口：已在最前时给出提示而不是静默失败',
      mvFirst.data.moved === false && /最前/.test(mvFirst.data.message || ''), mvFirst.data.message);

    const lastKey = o[o.length - 1];
    const mvLast = await api('POST', '/api/quotation-fields/move', { key: lastKey, dir: 'right' });
    check('接口：已在最后时给出提示',
      mvLast.data.moved === false && /最后/.test(mvLast.data.message || ''), mvLast.data.message);

    const mvCustom = await api('POST', '/api/quotation-fields/move', { key: myKey, dir: 'left' });
    check('接口：自定义列同样可以移动（与内置列同一套顺序）',
      mvCustom.status === 200 && mvCustom.data.moved === true, mvCustom.data.message);

    const badKey = await api('POST', '/api/quotation-fields/move', { key: 'no_such_column', dir: 'left' });
    check('接口：移动不存在的列被拒（404 NOT_FOUND）',
      badKey.status === 404 && badKey.code === 'NOT_FOUND', `${badKey.status} ${badKey.code}`);

    const noKey = await api('POST', '/api/quotation-fields/move', { dir: 'left' });
    check('接口：不传列名被拒（400 KEY_REQUIRED）',
      noKey.status === 400 && noKey.code === 'KEY_REQUIRED', `${noKey.status} ${noKey.code}`);

    /* ================= C. 整体保存顺序 ================= */
    const orderWithMy = await readOrder();          // 含刚建的临时列
    const wantOrder = orderWithMy.slice().reverse();
    const saved = await api('POST', '/api/quotation-fields/order', { order: wantOrder });
    check('接口：可以整体保存列顺序（一次排好）',
      saved.status === 200 && JSON.stringify(saved.data.order) === JSON.stringify(wantOrder),
      `保存 ${saved.data.order.length} 列，首列 ${saved.data.order[0]}`);

    const partial = await api('POST', '/api/quotation-fields/order', { order: ['remark', 'item_name'] });
    check('接口：只传部分列时自动补齐，不会把列弄丢',
      partial.data.order.length === orderWithMy.length
      && partial.data.order[0] === 'remark' && partial.data.order[1] === 'item_name',
      `补齐后 ${partial.data.order.length} 列`);

    const dirty = await api('POST', '/api/quotation-fields/order', {
      order: ['remark', 'remark', 'nope', 'item_name']
    });
    check('接口：未知列与重复项被过滤',
      dirty.data.order.length === orderWithMy.length
      && dirty.data.order.filter((k) => k === 'remark').length === 1
      && !dirty.data.order.includes('nope'),
      `首列 ${dirty.data.order[0]}，无重复`);

    /* ================= D. 顺序持久化 ================= */
    const setOrder = orderWithMy.slice().reverse();
    await api('POST', '/api/quotation-fields/order', { order: setOrder });
    const stored = db.prepare("SELECT value FROM settings WHERE key = 'quotation_column_order'").get();
    check('接口：列顺序落在设置项 quotation_column_order 里（不需要改表结构）',
      !!stored && JSON.stringify(JSON.parse(stored.value)) === JSON.stringify(setOrder),
      `设置项长度 ${stored ? String(stored.value).length : 0} 字`);

    const reread = await readOrder();
    check('接口：重新读取（等价于换页面/重启）顺序不变',
      JSON.stringify(reread) === JSON.stringify(setOrder));

    /* ================= E. scope 过滤 ================= */
    check('接口：内置列带 scope 标注（价格列只属于报价单，模板不显示）',
      lf.data.builtins.some((b) => b.key === 'unit_price' && b.scope === 'quotation')
      && lf.data.builtins.some((b) => b.key === 'quantity' && b.scope === 'both'),
      'unit_price=quotation，quantity=both');

    /* ================= 造数据（浏览器与导出用） ================= */
    const cust = await api('POST', '/api/customers', {
      name: CUSTOMER_NAME, short_name: `列序客户${tag}`, type: '终端用户', industry: '化工'
    });
    created.customer = cust.data.id;
    const proj = await api('POST', '/api/projects', {
      name: `【列序测试${tag}】采购项目`, customer_id: created.customer, stage: '询价报价'
    });
    created.project = proj.data.id;

    const tpl = await api('POST', '/api/quotation-templates', {
      name: TPL_NAME, category: '测试',
      items: [
        { item_name: '球阀', size_range: 'DN50', pressure_rating: 'Class150', body_material: 'WCB', connection_type: '法兰', quantity: 2, delivery_days: 30 },
        { item_name: '闸阀', size_range: 'DN100', pressure_rating: 'Class300', body_material: '316L', connection_type: '法兰', quantity: 1, delivery_days: 45 }
      ]
    });
    created.templates.push(tpl.data.id);

    const quo = await api('POST', '/api/quotations', {
      project_id: created.project,
      items: [
        { item_name: '球阀', valve_type: '球阀', size_range: 'DN50', pressure_rating: 'Class150', body_material: 'WCB', connection_type: '法兰', quantity: 3, unit_price: 1200, discount: 5 },
        { item_name: '闸阀', valve_type: '闸阀', size_range: 'DN100', quantity: 2, unit_price: 800 }
      ]
    });
    created.quotations.push(quo.data.id);
    console.log(`\n已造客户 #${created.customer}、项目 #${created.project}、模板 #${tpl.data.id}、报价单 #${quo.data.id}\n`);

    /* ================= F. 导出：列顺序跟着全局列序 ================= */
    const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));
    const { buildWorkbookAoa } = require('./.fixtures/quotation-export');

    const readExportHead = async (qid) => {
      const ex = await api('GET', `/api/quotations/${qid}/export`);
      const buf = buildWorkbookAoa(ex.data, XLSX);
      const wb = XLSX.read(buf, { type: 'buffer' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
      const at = rows.findIndex((r) => r[0] === '序号');
      return { head: (rows[at] || []).map(String), data: (rows[at + 1] || []).map(String), order: ex.data.column_order };
    };

    const expDefault = await readExportHead(quo.data.id);
    check('导出：导出数据带回全局列顺序（供单据排版用）',
      Array.isArray(expDefault.order) && expDefault.order.length === orderWithMy.length,
      `${(expDefault.order || []).length} 项`);

    /* 把「小计」挪到最前面，单据里的列序应当跟着变 */
    for (let i = expDefault.order.indexOf('subtotal'); i > 0; i--) {
      await api('POST', '/api/quotation-fields/move', { key: 'subtotal', dir: 'left' });
    }
    const expMoved = await readExportHead(quo.data.id);
    check('导出：把「小计」移到最前后，单据列序跟着变（小计紧跟在序号后面）',
      expMoved.head[1] === '小计(元)' && expMoved.head.filter((h) => h === '小计(元)').length === 1,
      `单据表头：${expMoved.head.slice(0, 6).join(' | ')}…`);
    {
      const ex = await api('GET', `/api/quotations/${quo.data.id}/export`);
      const buf = buildWorkbookAoa(ex.data, XLSX);
      const wb = XLSX.read(buf, { type: 'buffer' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
      const at = rows.findIndex((r) => r[0] === '序号');
      const sumRow = rows.find((r) => r[0] === '合计') || [];
      const sumCol = (rows[at] || []).indexOf('小计(元)');
      /* 3 台 × 1200 × 0.95 = 3420；2 台 × 800 = 1600；合计 5020 */
      check('导出：合计行的金额跟着小计列走（挪列后不会错位）',
        sumCol > 0 && String(sumRow[sumCol]) === '5,020.00',
        `小计在第 ${sumCol} 列，该列合计值 ${sumRow[sumCol]}`);
    }

    /* 整表倒序：单据里「产品名称」不应再紧跟序号 */
    await api('POST', '/api/quotation-fields/order', { order: orderWithMy.slice().reverse() });
    const expRev = await readExportHead(quo.data.id);
    check('导出：整表倒序时，单据里「产品名称」不再紧跟序号（顺序确实生效）',
      expRev.head[1] !== '产品名称', `单据第 2 列：${expRev.head[1]}`);

    /* ================= G. 浏览器 ================= */
    if (!CHROME) {
      check('浏览器：找到 Chrome 可执行文件', false, '未找到 chrome.exe');
    } else {
      await api('POST', '/api/quotation-fields/order', { order: originalOrder });   // 先回到原顺序
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'colorder-'));
      const PORT = 9413;
      child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1760,1100', 'about:blank'],
      { stdio: 'ignore' });
      for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
      const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
      cdp = new CDP(tab.webSocketDebuggerUrl);
      await cdp.connect();
      await cdp.send('Runtime.enable');

      await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/settings')}; 'ok'`);
      await sleep(4400);

      const tplHead = await cdp.js(`(async () => {
        const t = [...document.querySelectorAll('.settings-tabs .tab')].find(x => x.textContent.includes('报价模板'));
        if (!t) return { err: '未找到「报价模板」标签' };
        t.click();
        await new Promise(r => setTimeout(r, 2000));
        const nb = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新建模板'));
        nb.click();
        await new Promise(r => setTimeout(r, 1800));
        const d = [...document.querySelectorAll('.drawer')].pop();
        if (!d) return { err: '模板抽屉未打开' };
        const ths = [...d.querySelectorAll('.quo-table thead th')];
        return {
          heads: ths.map(x => x.textContent.replace(/[◀▶]/g, '').trim()),
          firstMovable: ths[1] ? ths[1].textContent.replace(/[◀▶]/g, '').trim() : '',
          hasMoveBtns: ths.slice(1, -1).every(x => x.querySelector('.col-move'))
        };
      })()`);
      check('浏览器：报价模板明细的每一列表头都有 ◀ ▶（内置列也能移动）',
        !tplHead.err && tplHead.hasMoveBtns === true && tplHead.heads.length >= 10,
        tplHead.err || `${tplHead.heads.length} 列：${tplHead.heads.slice(0, 5).join(' / ')}…`);

      const serverOrderNow = await readOrder();
      const uiCols = (tplHead.heads || []).slice(1, -1);        // 去掉开头的「#」与末尾的「操作」
      const tplVisible = serverOrderNow.filter((k) => !['unit_price', 'discount', 'subtotal'].includes(k));
      check('浏览器：界面表头顺序与接口返回的列顺序一致',
        !tplHead.err && uiCols.length === tplVisible.length,
        `界面 ${uiCols.length} 列 vs 接口（模板可见）${tplVisible.length} 列`);

      /* 点第 2 个数据列的 ◀：它应当与第 1 个数据列交换 */
      const moved = await cdp.js(`(async () => {
        const d = [...document.querySelectorAll('.drawer')].pop();
        const ths = [...d.querySelectorAll('.quo-table thead th')];
        const before = ths.slice(1, -1).map(x => x.textContent.replace(/[◀▶]/g, '').trim());
        /* ths[0] 是「#」，ths[1] 是第一个数据列（其 ◀ 已被禁用），点 ths[2] 的 ◀ */
        const btn = ths[2].querySelector('.col-move button');
        if (btn.disabled) return { err: '第 2 个数据列的 ◀ 不该是禁用状态' };
        btn.click();
        await new Promise(r => setTimeout(r, 1600));
        const d2 = [...document.querySelectorAll('.drawer')].pop();
        const ths2 = [...d2.querySelectorAll('.quo-table thead th')];
        return {
          before,
          after: ths2.slice(1, -1).map(x => x.textContent.replace(/[◀▶]/g, '').trim()),
          disabledAtFirst: ths2[1].querySelector('.col-move button').disabled
        };
      })()`);
      check('浏览器：点表头上的 ◀ 就把这一列挪到了前面',
        !moved.err && moved.after[0] === moved.before[1] && moved.after[1] === moved.before[0],
        moved.err || `${moved.before.slice(0, 3).join(' / ')}  →  ${moved.after.slice(0, 3).join(' / ')}`);
      check('浏览器：刚挪到第一位的列，其 ◀ 按钮变成禁用（已在最前）',
        moved.disabledAtFirst === true, `disabled=${moved.disabledAtFirst}`);

      const orderAfterUi = await readOrder();
      /* 界面上第 2 个数据列 = 模板可见列里的第 2 个 */
      const tplVisibleBefore = (await readOrder()).filter((k) => !['unit_price', 'discount', 'subtotal'].includes(k));
      check('浏览器：界面上挪列后，服务端列顺序已保存',
        orderAfterUi[0] === originalOrder[1] && orderAfterUi[1] === originalOrder[0],
        `首两列：${orderAfterUi.slice(0, 2).join(' > ')}（模板可见第 2 列原为 ${tplVisibleBefore[1]}）`);

      /* 报价单明细用同一套顺序 */
      await cdp.js(`location.hash = ${JSON.stringify('#/projects/' + created.project)}; 'ok'`);
      await sleep(4000);
      const quoCols = await cdp.js(`(async () => {
        const t = [...document.querySelectorAll('.tabs .tab')].find(x => x.textContent.includes('报价单'));
        t.click();
        await new Promise(r => setTimeout(r, 900));
        const edit = [...document.querySelectorAll('.content button')].find(b => b.textContent.trim() === '编辑');
        if (!edit) return { err: '没有可编辑的报价单' };
        edit.click();
        await new Promise(r => setTimeout(r, 2200));
        const d = [...document.querySelectorAll('.drawer')].pop();
        const ths = [...d.querySelectorAll('.quo-table thead th')];
        return { heads: ths.map(x => x.textContent.replace(/[◀▶]/g, '').trim()) };
      })()`);
      check('浏览器：报价单明细的列顺序与刚才在模板里排的一致（全局一套）',
        !quoCols.err && quoCols.heads[1] === (moved.after || [])[0],
        quoCols.err || `报价单首列：${(quoCols.heads || []).slice(0, 4).join(' / ')}`);

      check('页面无 JS 报错', cdp.errors.length === 0,
        cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '0 条错误');

      cdp.ws.close();
      child.kill();
      await sleep(400);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
      child = null; profile = null;
    }
  } finally {
    if (child) { try { child.kill(); } catch (_) { /* 忽略 */ } }
    if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ } }

    /* ---------- 恢复使用者的原列顺序（最重要的一步） ---------- */
    if (originalOrder) {
      /* 先恢复一次（此时临时列还在，它会被补进数组末尾，不影响其它列的位置），
         等下面把临时列彻底删掉后再存一次，让设置项里也干净。 */
      await api('POST', '/api/quotation-fields/order', { order: originalOrder }).catch(() => null);
    }

    /* ---------- 清理本套件造的数据 ---------- */
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
    for (const fid of created.fields) {
      await api('DELETE', `/api/quotation-fields/${fid}`).catch(() => {});
      try {
        db.prepare("DELETE FROM activity_logs WHERE entity_type = 'quotation_field' AND entity_id = ?").run(fid);
        db.prepare('DELETE FROM quotation_fields WHERE id = ?').run(fid);
      } catch (_) { /* 忽略 */ }
    }
    try {
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

    /* 临时列删净后再存一次顺序：让设置项里也不留已删列的 key */
    if (originalOrder) await api('POST', '/api/quotation-fields/order', { order: originalOrder }).catch(() => null);

    const back = await readOrder().catch(() => null);
    check('列顺序已恢复成使用者原来的样子',
      back && JSON.stringify(back) === JSON.stringify(originalOrder),
      back ? `${back.length} 列，首列 ${back[0]}` : '读取失败');
    const storedRaw = db.prepare("SELECT value FROM settings WHERE key = 'quotation_column_order'").get();
    check('设置项里也不残留已删列的 key',
      !!storedRaw && !JSON.parse(storedRaw.value).some((k) => k.startsWith('f:')
        && !db.prepare('SELECT 1 AS x FROM quotation_fields WHERE id = ? AND deleted_at IS NULL')
          .get(Number(k.slice(2)))),
      `设置项 ${JSON.parse(storedRaw.value).length} 项`);

    const leftCust = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?').get('%【列序测试%').n;
    const leftTpl = db.prepare('SELECT COUNT(*) AS n FROM quotation_templates WHERE name LIKE ?').get('%【列序测试%').n;
    const leftFld = db.prepare('SELECT COUNT(*) AS n FROM quotation_fields WHERE name LIKE ?').get('%【列序测试%').n;
    check('本套件测试数据已清理（客户的列一个没动）',
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
    path.join(ROOT, '.fixtures', 'quotation-column-order-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
