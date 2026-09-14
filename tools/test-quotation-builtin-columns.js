/**
 * 报价内置列「改名 / 删除」全流程测试
 *
 * 需求：报价单明细**不固定** —— 内置列也要能改名、能删（不只是自定义列）。
 * 例外：「名称/阀种、数量、单价、小计」四列**可以改名、可以移动，但不能删**——
 * 它们分别负责"认出报的是什么"和"算得出金额"。
 *
 * 覆盖：
 *   A. 接口：内置列改名（含超长、不存在、清空恢复默认、改名不丢值）
 *   B. 接口：内置列删除（隐藏）与恢复（值保留）、列视图随之变化
 *   C. 接口：必需列的删除保护（400 + 明确原因），但仍可改名/移动
 *   D. 浏览器：列管理里能改内置列名、能删内置列，明细表头即时跟着变
 *   E. 导出：改名后的列名进单据；删掉的列不进单据；合并列「规格型号」不再带被删字段
 *
 * 注意：列名与"哪些列被删"都是**使用者的真实配置**，所以本套件
 * 开跑前先记下原状，跑完在 finally 里逐条恢复并断言恢复成功。
 *
 * 用法：先启动服务，再 node tools/test-quotation-builtin-columns.js
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
const CUSTOMER_NAME = `【内置列测试${tag}】某某化工`;

/** 用于测试的内置列（都不在必需名单里） */
const CAN_DELETE = ['discount', 'unit', 'delivery_days', 'remark', 'size_range', 'pressure_rating', 'body_material', 'connection_type'];
const LOCKED = ['item_name', 'quantity', 'unit_price', 'subtotal'];

(async () => {
  console.log('=== 报价内置列 改名 / 删除 全流程测试 ===\n');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const created = { customer: null, project: null, quotations: [] };
  let cdp = null, child = null, profile = null;
  let labelsAtStart = null, hiddenAtStart = null;

  const restoreConfig = async () => {
    /* 1) 全部恢复显示 2) 列名逐个还原 */
    try {
      for (const k of CAN_DELETE) await api('POST', '/api/quotation-fields/visibility', { key: k, visible: true });
      for (const [k, label] of Object.entries(labelsAtStart || {})) {
        await api('POST', '/api/quotation-fields/rename', { key: k, label });
      }
      /* 原来没改过名的，恢复成默认名 */
      const all = ['item_name', 'size_range', 'pressure_rating', 'body_material', 'connection_type',
        'quantity', 'unit', 'unit_price', 'discount', 'subtotal', 'delivery_days', 'remark'];
      for (const k of all) {
        if (!(labelsAtStart || {})[k]) await api('POST', '/api/quotation-fields/rename', { key: k, label: '' });
      }
    } catch (_) { /* 忽略 */ }
  };

  try {
    /* ---------- 记下使用者当前的内置列配置 ---------- */
    const lf0 = await api('GET', '/api/quotation-fields');
    labelsAtStart = lf0.data.labels || {};
    hiddenAtStart = lf0.data.hidden || [];
    console.log(`原配置：改过名的列 ${Object.keys(labelsAtStart).length} 个，被删的列 ${hiddenAtStart.length} 个`
      + `（${hiddenAtStart.join('、') || '无'}）\n`);

    /* 清上一轮残留 */
    {
      const stale = db.prepare('SELECT id FROM customers WHERE name LIKE ?').all('%【内置列测试%').map((r) => r.id);
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
      if (stale.length) console.log(`（已清理上一轮残留：客户 ${stale.length}）\n`);
    }

    /* ================= A. 内置列改名 ================= */
    check('接口：内置列带「必需」标注与原因（四列：名称/数量/单价/小计）',
      LOCKED.every((k) => {
        const b = (lf0.data.builtins || []).find((x) => x.key === k);
        return b && b.locked === true && String(b.lock_reason || '').length > 4;
      }) && (lf0.data.builtins || []).filter((b) => b.locked).length === 4,
      (lf0.data.builtins || []).filter((b) => b.locked).map((b) => b.label).join('、'));

    const ren = await api('POST', '/api/quotation-fields/rename', { key: 'size_range', label: '公称通径' });
    check('接口：内置列可以改名（口径 → 公称通径）',
      ren.status === 200 && ren.data.renamed === true && ren.data.label === '公称通径'
      && ren.data.default_label === '口径',
      `${ren.data && ren.data.default_label} → ${ren.data && ren.data.label}`);

    const afterRen = await api('GET', '/api/quotation-fields');
    const renamedCol = (afterRen.data.columns || []).find((c) => c.key === 'size_range');
    check('接口：列视图里用的是新列名，同时保留默认名（便于恢复）',
      renamedCol.label === '公称通径' && renamedCol.default_label === '口径' && renamedCol.renamed === true,
      `${renamedCol.label}（默认 ${renamedCol.default_label}）`);

    const tooLong = await api('POST', '/api/quotation-fields/rename', { key: 'size_range', label: 'x'.repeat(21) });
    check('接口：列名超长被拒（400 NAME_TOO_LONG）',
      tooLong.status === 400 && tooLong.code === 'NAME_TOO_LONG', `${tooLong.status} ${tooLong.code}`);

    const badKey = await api('POST', '/api/quotation-fields/rename', { key: 'no_such', label: 'x' });
    check('接口：给不存在的列改名被拒（404）',
      badKey.status === 404 && badKey.code === 'NOT_FOUND', `${badKey.status} ${badKey.code}`);

    const renameLocked = await api('POST', '/api/quotation-fields/rename', { key: 'quantity', label: '台数' });
    check('接口：必需列也能改名（数量 → 台数）',
      renameLocked.status === 200 && renameLocked.data.label === '台数', renameLocked.data && renameLocked.data.label);

    /* ================= B. 内置列删除与恢复 ================= */
    const delDiscount = await api('POST', '/api/quotation-fields/visibility', { key: 'discount', visible: false });
    check('接口：内置列可以删除（折扣%）',
      delDiscount.status === 200 && delDiscount.data.visible === false && delDiscount.data.hidden.includes('discount'),
      `当前已删：${(delDiscount.data.hidden || []).join('、')}`);

    const afterHide = await api('GET', '/api/quotation-fields');
    check('接口：删掉的列不再出现在表格列视图里（列管理里仍列出以便恢复）',
      !afterHide.data.columns.filter((c) => c.key === 'discount' && c.enabled).length
      && afterHide.data.columns.some((c) => c.key === 'discount' && !c.enabled),
      `隐藏 ${afterHide.data.hidden.length} 列`);

    /* 全删一遍（除必需列） */
    for (const k of CAN_DELETE) await api('POST', '/api/quotation-fields/visibility', { key: k, visible: false });
    const allHidden = await api('GET', '/api/quotation-fields');
    const visibleBuiltins = allHidden.data.columns.filter((c) => c.type === 'builtin' && c.enabled).map((c) => c.key);
    check('接口：把能删的都删掉后，只剩必需列 + 自定义列',
      visibleBuiltins.length === 4 && LOCKED.every((k) => visibleBuiltins.includes(k)),
      `剩下 ${visibleBuiltins.join('、')}`);

    const restoreOne = await api('POST', '/api/quotation-fields/visibility', { key: 'size_range', visible: true });
    check('接口：删掉的列可以随时恢复',
      restoreOne.status === 200 && restoreOne.data.visible === true
      && !restoreOne.data.hidden.includes('size_range'),
      `仍隐藏 ${restoreOne.data.hidden.length} 列`);

    /* ================= C. 必需列的删除保护 ================= */
    for (const k of LOCKED) {
      const r = await api('POST', '/api/quotation-fields/visibility', { key: k, visible: false });
      check(`接口：必需列「${k}」不允许删除（400 并说明原因）`,
        r.status === 400 && r.code === 'COLUMN_REQUIRED' && /不能删除/.test(r.message || ''),
        `${r.status} ${r.code}：${String(r.message || '').slice(0, 46)}`);
    }

    /* 就算直接篡改设置项，必需列也不会真的被隐藏 */
    {
      const raw = db.prepare("SELECT value FROM settings WHERE key = 'quotation_column_hidden'").get();
      const cur = raw ? JSON.parse(raw.value) : [];
      db.prepare(`INSERT INTO settings (key, value, remark, updated_at) VALUES ('quotation_column_hidden', ?, '', ?)
                  ON CONFLICT(key) DO UPDATE SET value = excluded.value`)
        .run(JSON.stringify([...cur, 'quantity', 'subtotal']), new Date().toISOString().slice(0, 19).replace('T', ' '));
      const probe = await api('GET', '/api/quotation-fields');
      check('接口：必需列即使被写进设置项也不会真的隐藏（服务端兜底）',
        !probe.data.hidden.includes('quantity') && !probe.data.hidden.includes('subtotal'),
        `hidden=${probe.data.hidden.join('、') || '（空）'}`);
      await api('POST', '/api/quotation-fields/visibility', { key: 'discount', visible: true });
    }

    const mvLocked = await api('POST', '/api/quotation-fields/move', { key: 'quantity', dir: 'left' });
    check('接口：必需列仍然可以移动位置（只是不能删）',
      mvLocked.status === 200 && mvLocked.data.moved === true, mvLocked.data.message);

    /* ================= 造数据 ================= */
    /* 先把配置恢复成"干净"状态，方便下面的表格与单据断言 */
    await restoreConfig();
    await api('POST', '/api/quotation-fields/rename', { key: 'size_range', label: '公称通径' });
    await api('POST', '/api/quotation-fields/rename', { key: 'quantity', label: '台数' });
    await api('POST', '/api/quotation-fields/visibility', { key: 'discount', visible: false });
    await api('POST', '/api/quotation-fields/visibility', { key: 'remark', visible: false });

    const cust = await api('POST', '/api/customers', {
      name: CUSTOMER_NAME, short_name: `内置列客户${tag}`, type: '终端用户', industry: '化工'
    });
    created.customer = cust.data.id;
    const proj = await api('POST', '/api/projects', {
      name: `【内置列测试${tag}】采购项目`, customer_id: created.customer, stage: '询价报价'
    });
    created.project = proj.data.id;
    const quo = await api('POST', '/api/quotations', {
      project_id: created.project,
      items: [
        { item_name: '球阀', valve_type: '球阀', size_range: 'DN80', pressure_rating: 'Class300', body_material: '316L', connection_type: '法兰', quantity: 3, unit_price: 1200, discount: 10 },
        { item_name: '闸阀', valve_type: '闸阀', size_range: 'DN100', pressure_rating: 'Class150', body_material: 'WCB', connection_type: '对夹式', quantity: 2, unit_price: 800 }
      ]
    });
    created.quotations.push(quo.data.id);
    console.log(`\n已造客户 #${created.customer}、项目 #${created.project}、报价单 #${quo.data.id}\n`);

    const got = await api('GET', `/api/quotations/${quo.data.id}`);
    check('接口：列改名/删除后，报价单数据一切正常（金额仍由服务端算）',
      got.status === 200 && got.data.items.length === 2 && got.data.total_amount === 3240 + 1600,
      `合计 ${got.data.total_amount}（3×1200 让价 10% = 3240，2×800 = 1600）`);
    check('接口：被删掉的「折扣%」值仍留在单据里（只是不显示）',
      Number(got.data.items[0].discount) === 0.1, `首行折扣 ${got.data.items[0].discount}`);
    check('接口：改名后的列对应的值照常读写（口径 → 公称通径）',
      got.data.items[0].size_range === 'DN80' && got.data.items[1].size_range === 'DN100',
      `${got.data.items[0].size_range} / ${got.data.items[1].size_range}`);

    /* ================= D. 导出 ================= */
    {
      const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));
      const { buildWorkbookAoa } = require('./.fixtures/quotation-export');
      const ex = await api('GET', `/api/quotations/${quo.data.id}/export`);
      check('接口：导出数据带回列名覆盖与被删列清单',
        ex.data.column_labels && ex.data.column_labels.size_range === '公称通径'
        && Array.isArray(ex.data.hidden_columns) && ex.data.hidden_columns.includes('discount'),
        `labels=${JSON.stringify(ex.data.column_labels)}，hidden=${ex.data.hidden_columns.join('、')}`);

      const buf = buildWorkbookAoa(ex.data, XLSX);
      const wb = XLSX.read(buf, { type: 'buffer' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
      const at = rows.findIndex((r) => r[0] === '序号');
      const head = (rows[at] || []).map(String);
      const first = (rows[at + 1] || []).map(String);
      check('导出：改过名的内置列用新名字进单据（台数）',
        head.includes('台数') && !head.includes('数量'), `单据表头：${head.join(' | ')}`);
      check('导出：删掉的「折扣」不进单据',
        !head.includes('折扣') && !head.some((h) => h.includes('折扣')), `表头 ${head.length} 列`);
      check('导出：「规格型号」仍合并展示（口径仍在启用列里）',
        head.includes('规格型号') && String(first[head.indexOf('规格型号')]).includes('DN80'),
        `规格型号 = ${first[head.indexOf('规格型号')]}`);
      check('导出：金额列照常（小计与合计）',
        String(first[head.indexOf('小计(元)')]) === '3,240.00',
        `首行小计 ${first[head.indexOf('小计(元)')]}`);
    }

    /* 再把「口径」删掉：规格型号里不应再出现它 */
    await api('POST', '/api/quotation-fields/visibility', { key: 'size_range', visible: false });
    {
      const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));
      const { buildWorkbookAoa } = require('./.fixtures/quotation-export');
      const ex = await api('GET', `/api/quotations/${quo.data.id}/export`);
      const wb = XLSX.read(buildWorkbookAoa(ex.data, XLSX), { type: 'buffer' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
      const at = rows.findIndex((r) => r[0] === '序号');
      const head = (rows[at] || []).map(String);
      const first = (rows[at + 1] || []).map(String);
      const spec = String(first[head.indexOf('规格型号')] || '');
      check('导出：删掉「口径」后，规格型号里不再出现它（DN80 消失、其余规格保留）',
        !spec.includes('DN80') && spec.includes('Class300') && spec.includes('316L'),
        `规格型号 = ${spec}`);
    }
    await api('POST', '/api/quotation-fields/visibility', { key: 'size_range', visible: true });

    /* ================= E. 浏览器 ================= */
    if (!CHROME) {
      check('浏览器：找到 Chrome 可执行文件', false, '未找到 chrome.exe');
    } else {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'builtincol-'));
      const PORT = 9414;
      child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1760,1100', 'about:blank'],
      { stdio: 'ignore' });
      for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
      const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
      cdp = new CDP(tab.webSocketDebuggerUrl);
      await cdp.connect();
      await cdp.send('Runtime.enable');

      await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/projects/' + created.project)}; 'ok'`);
      await sleep(4200);

      /* 打开报价单编辑抽屉：改名后的列名应出现在表头，删掉的列不该出现 */
      const before = await cdp.js(`(async () => {
        const t = [...document.querySelectorAll('.tabs .tab')].find(x => x.textContent.includes('报价单'));
        if (!t) return { err: '未找到报价单标签' };
        t.click();
        await new Promise(r => setTimeout(r, 1200));
        const edit = [...document.querySelectorAll('.content button')].find(b => b.textContent.trim() === '编辑');
        if (!edit) return { err: '没有可编辑的报价单' };
        edit.click();
        await new Promise(r => setTimeout(r, 2400));
        const d = [...document.querySelectorAll('.drawer')].pop();
        if (!d) return { err: '抽屉未打开' };
        const heads = [...d.querySelectorAll('.quo-table thead th')]
          .map(x => x.textContent.replace(/[◀▶]/g, '').trim()).slice(1, -1);
        return { heads };
      })()`);
      check('浏览器：明细表头用的是改后的列名（台数 / 公称通径）',
        !before.err && before.heads.includes('台数') && before.heads.includes('公称通径'),
        before.err || before.heads.slice(0, 8).join(' / '));
      check('浏览器：删掉的列不出现在明细表里（折扣%、备注）',
        !before.err && !before.heads.some((h) => h.includes('折扣')) && !before.heads.includes('备注'),
        `表头 ${(before.heads || []).length} 列`);

      /* 打开列管理：内置列名可编辑、必需列有「必需」标注与禁用删除 */
      const mgr = await cdp.js(`(async () => {
        const d = [...document.querySelectorAll('.drawer')].pop();
        const btn = [...d.querySelectorAll('button')].find(x => x.textContent.includes('自定义列'));
        btn.click();
        await new Promise(r => setTimeout(r, 1800));
        const m = [...document.querySelectorAll('.drawer')]
          .find(x => ((x.querySelector('.drawer-title') || {}).textContent || '').includes('报价自定义列'));
        if (!m) return { err: '列管理抽屉未打开' };
        const rows = [...m.querySelectorAll('.qf-table tbody tr')];
        const findRow = (label) => rows.find(r => {
          const inp = r.querySelector('input');
          return inp && inp.value === label;
        });
        const qtyRow = findRow('台数');
        const discountRow = findRow('折扣%') || rows.find(r => /折扣/.test(r.textContent));
        return {
          hasEditableBuiltin: !!findRow('公称通径'),
          qtyLockedTag: qtyRow ? /必需/.test(qtyRow.textContent) : false,
          qtyDeleteDisabled: qtyRow ? !qtyRow.querySelector('.icon-btn.danger') : false,
          hiddenRowShown: !!discountRow,
          hiddenRowMarked: discountRow ? /已删除/.test(discountRow.textContent) : false
        };
      })()`);
      check('浏览器：列管理里内置列的列名是可编辑输入框',
        !mgr.err && mgr.hasEditableBuiltin === true, mgr.err || '公称通径 这一行可编辑');
      check('浏览器：必需列标着「必需」且没有删除按钮',
        !mgr.err && mgr.qtyLockedTag === true && mgr.qtyDeleteDisabled === true,
        `必需标注=${mgr.qtyLockedTag}，删除按钮不可用=${mgr.qtyDeleteDisabled}`);
      check('浏览器：被删掉的列仍列在列管理里并标为「已删除」（可再恢复）',
        !mgr.err && mgr.hiddenRowShown === true && mgr.hiddenRowMarked === true,
        `已删除标注=${mgr.hiddenRowMarked}`);

      /* 在界面上恢复「备注」：明细表头应立即多一列 */
      const restoreUi = await cdp.js(`(async () => {
        const m = [...document.querySelectorAll('.drawer')]
          .find(x => ((x.querySelector('.drawer-title') || {}).textContent || '').includes('报价自定义列'));
        const rows = [...m.querySelectorAll('.qf-table tbody tr')];
        const row = rows.find(r => (r.querySelector('input') || {}).value === '备注');
        if (!row) return { err: '列管理里找不到「备注」' };
        const tag = [...row.querySelectorAll('.tag')].find(t => t.textContent.includes('已删除'));
        if (!tag) return { err: '「备注」没有显示为已删除' };
        tag.click();
        await new Promise(r => setTimeout(r, 1800));
        /* 列管理抽屉在 DOM 里排在页面抽屉之后，取「带明细表」的那个才对 */
        const d = [...document.querySelectorAll('.drawer')].find(x => x.querySelector('.quo-table'));
        if (!d) return { err: '找不到明细表所在的抽屉' };
        const heads = [...d.querySelectorAll('.quo-table thead th')]
          .map(x => x.textContent.replace(/[◀▶]/g, '').trim());
        return { heads };
      })()`);
      check('浏览器：在列管理里点一下就能把删掉的列恢复出来（表头即时多一列）',
        !restoreUi.err && restoreUi.heads.includes('备注'),
        restoreUi.err || `表头 ${(restoreUi.heads || []).length} 列`);

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
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'quotation_field' AND entity_id = 0").run();
    } catch (_) { /* 忽略 */ }

    const now = await api('GET', '/api/quotation-fields').catch(() => null);
    const labelsNow = (now && now.data.labels) || {};
    const hiddenNow = (now && now.data.hidden) || [];
    check('列配置（改名 + 删除）已恢复成使用者原来的样子',
      JSON.stringify(labelsNow) === JSON.stringify(labelsAtStart || {})
      && JSON.stringify([...hiddenNow].sort()) === JSON.stringify([...(hiddenAtStart || [])].sort()),
      `改名列 ${Object.keys(labelsNow).length} 个（原 ${Object.keys(labelsAtStart || {}).length}），`
      + `隐藏列 ${hiddenNow.length} 个（原 ${(hiddenAtStart || []).length}）`);

    const leftCust = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?').get('%【内置列测试%').n;
    check('本套件测试数据已清理', leftCust === 0, `残留客户 ${leftCust}`);
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
    path.join(ROOT, '.fixtures', 'quotation-builtin-columns-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
