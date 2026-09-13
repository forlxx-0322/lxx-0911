/**
 * 复现并验证「详细地址保存后自动清空」。
 *
 * 覆盖两条路径：
 *   A. 接口层：直接 POST/PUT 带 address，看后端是否落库
 *   B. 界面层：在真实浏览器里填写详细地址并保存，看是否落库
 *
 * 用法：先启动服务，再 node tools/test-customer-address.js
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
  return { status: res.status, data: json && json.data, code: json && json.code };
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

const ADDR = '克拉玛依市独山子区北京路6号炼油厂西门';

(async () => {
  console.log('=== 详细地址保存验证 ===\n');

  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const tag = Date.now().toString().slice(-6);
  const created = [];

  try {
    /* ---------- A. 接口层 ---------- */
    const a = await api('POST', '/api/customers', {
      name: `【地址验证${tag}】接口新增`,
      short_name: `地址${tag}`,
      type: '终端用户', industry: '石油',
      city: '克拉玛依市', district: '独山子区',
      address: ADDR
    });
    created.push(a.data && a.data.id);
    const aRow = await api('GET', `/api/customers/${a.data.id}`);
    check('接口 · 新增客户时详细地址被保存',
      aRow.data.address === ADDR,
      `提交「${ADDR}」→ 读回「${aRow.data.address || '（空）'}」`);

    /* 局部更新（只改等级）不应清空地址 */
    await api('PUT', `/api/customers/${a.data.id}`, { level: 'A 重点客户' });
    const aRow2 = await api('GET', `/api/customers/${a.data.id}`);
    check('接口 · 局部更新其它字段不会清空详细地址',
      aRow2.data.address === ADDR,
      `读回「${aRow2.data.address || '（空）'}」`);

    /* 更新地址本身 */
    const ADDR2 = '克拉玛依市独山子区大庆路12号';
    await api('PUT', `/api/customers/${a.data.id}`, { address: ADDR2 });
    const aRow3 = await api('GET', `/api/customers/${a.data.id}`);
    check('接口 · 修改详细地址生效',
      aRow3.data.address === ADDR2,
      `读回「${aRow3.data.address}」`);

    /* 同时改地址与市/区：应同时保留 */
    await api('PUT', `/api/customers/${a.data.id}`, {
      city: '喀什地区', district: '喀什市', address: '喀什市人民东路1号'
    });
    const aRow4 = await api('GET', `/api/customers/${a.data.id}`);
    check('接口 · 同时改地址与市/区时详细地址保留',
      aRow4.data.address === '喀什市人民东路1号' && aRow4.data.region_code === '653100',
      `地址「${aRow4.data.address}」，归属 ${aRow4.data.region_code}`);

    /* ---------- B. 界面层 ---------- */
    const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'addr-'));
    const PORT = 9280;
    const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1600,1000', 'about:blank'],
    { stdio: 'ignore' });
    for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
    const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');

    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/customers')}; 'ok'`);
    await sleep(3600);

    const uiRes = await cdp.js(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增客户'));
      if (!btn) return { err: '未找到新增客户按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 1800));
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return { err: '抽屉未打开' };

      const field = (label) => [...d.querySelectorAll('.field')].find(x =>
        (x.querySelector('.field-label') || {}).textContent.trim().startsWith(label));
      /* 展开所有折叠区块，确保地址信息可见 */
      for (const h of [...d.querySelectorAll('.form-block-head')]) {
        if (!h.classList.contains('open')) { h.click(); await new Promise(r => setTimeout(r, 80)); }
      }
      await new Promise(r => setTimeout(r, 600));

      const setText = (label, value) => {
        const f = field(label);
        if (!f) return 'no-field';
        const inp = f.querySelector('input, textarea, select');
        if (!inp) return 'no-input';
        inp.value = value;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      };
      const setSelect = (label, value) => {
        const f = field(label);
        if (!f) return 'no-field';
        const sel = f.querySelector('select');
        if (!sel) return 'no-select';
        sel.value = value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      };

      const steps = {
        name: setText('客户全称', '【地址验证${tag}】界面新增'),
        short: setText('客户简称', '界面${tag}'),
        type: setSelect('客户主体类型', '终端用户'),
        industry: setSelect('下游行业', '石油'),
        city: setText('市 / 地区', '克拉玛依市'),
        district: setText('区 / 县', '独山子区'),
        address: setText('详细地址', ${JSON.stringify(ADDR)})
      };
      await new Promise(r => setTimeout(r, 500));

      /* 复查输入框里确实有值（排除 setText 没生效） */
      const addrField = field('详细地址');
      const addrInput = addrField ? addrField.querySelector('input, textarea') : null;
      const valueBeforeSave = addrInput ? addrInput.value : '（未取到输入框）';

      const footSave = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
      if (!footSave) return { err: '未找到保存按钮', steps };
      footSave.click();
      await new Promise(r => setTimeout(r, 2600));

      return {
        steps, valueBeforeSave,
        drawerGone: !document.querySelector('.drawer'),
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
      };
    })()`);

    if (uiRes.err) {
      check('界面 · 填写详细地址并保存', false, uiRes.err + ' 步骤：' + JSON.stringify(uiRes.steps || {}));
    } else {
      check('界面 · 详细地址已填入输入框',
        uiRes.valueBeforeSave === ADDR,
        `保存前输入框值「${uiRes.valueBeforeSave}」；各字段写入结果 ${JSON.stringify(uiRes.steps)}`);
      check('界面 · 保存后表单关闭',
        uiRes.drawerGone === true, (uiRes.toasts || []).join(' / '));

      const row = db.prepare('SELECT id, name, city, district, address FROM customers WHERE name LIKE ?')
        .get(`【地址验证${tag}】界面新增%`);
      if (row) created.push(row.id);
      check('界面 · 保存后详细地址落库',
        !!row && row.address === ADDR,
        row ? `库中 address=「${row.address || '（空）'}」` : '未找到该客户');

      /* 再从详情页读一次，确认显示正常 */
      if (row) {
        const detail = await api('GET', `/api/customers/${row.id}`);
        check('界面 · 详情接口返回的详细地址正确',
          detail.data.address === ADDR,
          `详情 address=「${detail.data.address || '（空）'}」`);

        /* 编辑态回显 */
        await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/customers/' + row.id)}; 'ok'`);
        await sleep(3600);
        const echo = await cdp.js(`(async () => {
          const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('编辑资料'));
          if (!btn) return { err: '未找到编辑资料按钮' };
          btn.click();
          await new Promise(r => setTimeout(r, 2000));
          const d = [...document.querySelectorAll('.drawer')].pop();
          for (const h of [...d.querySelectorAll('.form-block-head')]) {
            if (!h.classList.contains('open')) { h.click(); await new Promise(r => setTimeout(r, 80)); }
          }
          await new Promise(r => setTimeout(r, 600));
          const f = [...d.querySelectorAll('.field')].find(x =>
            (x.querySelector('.field-label') || {}).textContent.trim().startsWith('详细地址'));
          if (!f) return { err: '未找到详细地址字段' };
          const inp = f.querySelector('input, textarea');
          return { value: inp ? inp.value : '（无输入框）' };
        })()`);
        check('界面 · 编辑时详细地址正确回显',
          !echo.err && echo.value === ADDR,
          echo.err ? echo.err : `回显「${echo.value}」`);
      }
    }

    check('页面无 JS 报错', cdp.errors.length === 0,
      cdp.errors.length ? cdp.errors.slice(0, 2).join(' | ') : '0 条错误');

    /* ---------- C. 关键路径：从列表页的「编辑」按钮进入 ----------
       列表行不一定会带回所有字段，若表单拿列表行当初始值再整体保存，
       缺失的字段就会被写成空值（这正是"详细地址保存后自动清空"的成因）。 */
    const listEdit = await cdp.js(`(async () => {
      location.hash = '#/customers';
      await new Promise(r => setTimeout(r, 3400));
      const inp = document.querySelector('.search-box input');
      if (!inp) return { err: '未找到搜索框' };
      inp.value = '地址验证${tag}';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const sbtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '搜索');
      if (sbtn) sbtn.click();
      await new Promise(r => setTimeout(r, 2000));

      const rows = [...document.querySelectorAll('.data-table tbody tr')];
      if (!rows.length) return { err: '搜索结果为空' };
      const editBtn = [...rows[0].querySelectorAll('button')].find(b => b.textContent.includes('编辑'));
      if (!editBtn) return { err: '未找到编辑按钮' };
      editBtn.click();
      await new Promise(r => setTimeout(r, 2000));

      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return { err: '抽屉未打开' };
      for (const h of [...d.querySelectorAll('.form-block-head')]) {
        if (!h.classList.contains('open')) { h.click(); await new Promise(r => setTimeout(r, 80)); }
      }
      await new Promise(r => setTimeout(r, 600));
      const f = [...d.querySelectorAll('.field')].find(x =>
        (x.querySelector('.field-label') || {}).textContent.trim().startsWith('详细地址'));
      const inp2 = f ? f.querySelector('input, textarea') : null;
      const valueInForm = inp2 ? inp2.value : '（未取到）';

      /* 不改任何东西，直接保存：这一步不该改动任何已有字段 */
      const footSave = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
      if (!footSave) return { err: '未找到保存按钮', valueInForm };
      footSave.click();
      await new Promise(r => setTimeout(r, 2600));

      return { valueInForm, drawerGone: !document.querySelector('.drawer') };
    })()`);

    if (listEdit.err) {
      check('列表页「编辑」打开表单时详细地址已回显', false, listEdit.err);
    } else {
      check('列表页「编辑」打开表单时详细地址已回显',
        listEdit.valueInForm === ADDR,
        `表单里详细地址=「${listEdit.valueInForm}」`);

      /* 不改动任何字段直接保存，地址必须保持不变 */
      const afterNoop = db.prepare('SELECT address FROM customers WHERE name LIKE ?')
        .get(`【地址验证${tag}】界面新增%`);
      check('列表页「编辑」→ 直接保存 不会清空详细地址',
        afterNoop && afterNoop.address === ADDR,
        afterNoop ? `保存后库中 address=「${afterNoop.address || '（空）'}」` : '未找到该客户');
    }

    cdp.ws.close();
    child.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  } finally {
    for (const id of created.filter(Boolean)) {
      await api('DELETE', `/api/customers/${id}`).catch(() => {});
      db.prepare('DELETE FROM contacts WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM followups WHERE customer_id = ?').run(id);
      db.prepare('DELETE FROM customer_tags WHERE customer_id = ?').run(id);
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?").run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    }
    const left = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?').get(`【地址验证${tag}】%`).n;
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
    path.join(ROOT, '.fixtures', 'customer-address-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
    'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
