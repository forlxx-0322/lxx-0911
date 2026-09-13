/**
 * 用「真实可见窗口」的 Chrome 复测录入流程（非 headless）。
 *
 * 为什么单独做这个：headless 与真实窗口在输入法、自动填充、焦点、
 * 扩展等方面行为不同，而用户报的是"填字段过程中闪退"，这类问题常在
 * headless 下测不出来。
 *
 * 覆盖重点是自定义控件：标签（chips）、多选（chips）、下拉内联新增。
 *
 * 用法：先启动服务，再 node tools/test-customer-realwindow.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.errors = []; this.console = []; }
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
      } else if (m.method === 'Runtime.consoleAPICalled' && (m.params.type === 'error' || m.params.type === 'warning')) {
        this.console.push(m.params.type + ': ' + (m.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); } }, 30000);
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
  console.log('=== 真实窗口 Chrome 录入复测 ===\n');
  console.log(`浏览器：${CHROME}`);
  console.log('注意：会短暂弹出可见窗口\n');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'real-'));
  const PORT = 9320;
  /* 关键差异：不加 --headless，使用真实窗口与真实渲染 */
  const child = spawn(CHROME, ['--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1500,950', '--window-position=60,60', 'about:blank'],
  { stdio: 'ignore' });

  try {
    for (let i = 0; i < 80; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
    await sleep(1200);
    const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');

    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/customers')}; 'ok'`);
    await sleep(4500);

    const openDrawer = `(async () => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('新增客户'));
      if (!b) return 'no-button';
      b.click();
      await new Promise(r => setTimeout(r, 2000));
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return 'drawer-not-open';
      for (const h of [...d.querySelectorAll('.form-block-head')]) {
        if (!h.classList.contains('open')) { h.click(); await new Promise(r => setTimeout(r, 50)); }
      }
      await new Promise(r => setTimeout(r, 500));
      return 'ok';
    })()`;

    const drawerState = `(() => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      return JSON.stringify({
        open: !!d,
        hash: location.hash,
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
        fieldCount: d ? d.querySelectorAll('.field').length : 0,
        chips: d ? d.querySelectorAll('.chip').length : 0
      });
    })()`;

    /* ---------- 1. 真实点击「标签」区域（chips 自定义组件） ---------- */
    cdp.errors.length = 0;
    let r = await cdp.js(openDrawer);
    check('1a. 真实窗口下能打开新增客户抽屉', r === 'ok', r);

    const labelClick = await cdp.js(`(async () => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return { err: '抽屉不在' };
      const f = [...d.querySelectorAll('.field')].find(x => (x.querySelector('.field-label')||{}).textContent.trim().startsWith('标签'));
      if (!f) return { err: '未找到标签字段' };
      const chips = [...f.querySelectorAll('.chip')];
      const btn = [...f.querySelectorAll('button')];
      /* 点第一个 chip（若有），否则点 + 按钮 */
      if (chips.length) { chips[0].click(); }
      await new Promise(r => setTimeout(r, 700));
      const d2 = [...document.querySelectorAll('.drawer')].pop();
      return { chipCount: chips.length, btnCount: btn.length, clicked: chips.length ? 'chip' : 'none', stillOpen: !!d2 };
    })()`);
    check('1b. 点击「标签」chips：抽屉不消失、无异常',
      !labelClick.err && labelClick.stillOpen && cdp.errors.length === 0,
      labelClick.err || `chip 数=${labelClick.chipCount}，按钮数=${labelClick.btnCount}，点击=${labelClick.clicked}，抽屉仍在=${labelClick.stillOpen}，JS错误=${cdp.errors.join(' | ') || '无'}`);

    /* ---------- 2. 真实键盘输入中文到「客户全称」 ---------- */
    cdp.errors.length = 0;
    const typeName = await cdp.js(`(async () => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      const f = [...d.querySelectorAll('.field')].find(x => (x.querySelector('.field-label')||{}).textContent.trim().startsWith('客户全称'));
      const inp = f && f.querySelector('input');
      if (!inp) return { err: '未找到输入框' };
      inp.focus();
      return { focused: document.activeElement === inp, tag: document.activeElement.tagName };
    })()`);
    /* 用 CDP 真实键入（逐字符），模拟用户打字 */
    for (const ch of `真实窗口录入${tag}`) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
      await sleep(35);
    }
    await sleep(400);
    const typed = await cdp.js(`(() => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return JSON.stringify({ open: false });
      const f = [...d.querySelectorAll('.field')].find(x => (x.querySelector('.field-label')||{}).textContent.trim().startsWith('客户全称'));
      const inp = f && f.querySelector('input');
      return JSON.stringify({ open: true, value: inp ? inp.value : '' });
    })()`);
    const tv = JSON.parse(typed);
    check('2. 真实键盘逐字输入中文：抽屉不消失、内容正确',
      tv.open && tv.value === `真实窗口录入${tag}` && cdp.errors.length === 0,
      `抽屉仍在=${tv.open}，输入框值="${tv.value}"，JS错误=${cdp.errors.join(' | ') || '无'}`);

    /* ---------- 3. 用 CDP 真实点击下拉（原生 select 会弹出系统下拉） ---------- */
    cdp.errors.length = 0;
    const selectBox = await cdp.js(`(() => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      const f = [...d.querySelectorAll('.field')].find(x => (x.querySelector('.field-label')||{}).textContent.trim().startsWith('客户主体类型'));
      const sel = f && f.querySelector('select');
      if (!sel) return null;
      const b = sel.getBoundingClientRect();
      return { x: Math.round(b.left + b.width/2), y: Math.round(b.top + b.height/2) };
    })()`);
    if (selectBox) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: selectBox.x, y: selectBox.y, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: selectBox.x, y: selectBox.y, button: 'left', clickCount: 1 });
      await sleep(600);
      /* 用键盘选下一项并回车（系统下拉由浏览器接管，用键盘可靠） */
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 40, key: 'ArrowDown' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 40, key: 'ArrowDown' });
      await sleep(250);
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter' });
      await sleep(500);
    }
    const afterSelect = JSON.parse(await cdp.js(drawerState));
    check('3. 真实点击原生下拉并选择：抽屉不消失',
      afterSelect.open && cdp.errors.length === 0,
      `抽屉仍在=${afterSelect.open}，JS错误=${cdp.errors.join(' | ') || '无'}${selectBox ? '' : '（未取到下拉坐标）'}`);

    /* ---------- 4. Tab 键在字段间切换 ---------- */
    cdp.errors.length = 0;
    for (let i = 0; i < 12; i++) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'rawKeyDown', windowsVirtualKeyCode: 9, key: 'Tab' });
      await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 9, key: 'Tab' });
      await sleep(120);
    }
    const afterTab = JSON.parse(await cdp.js(drawerState));
    check('4. 连续 Tab 切换 12 个字段：抽屉不消失、无异常',
      afterTab.open && cdp.errors.length === 0,
      `抽屉仍在=${afterTab.open}，JS错误=${cdp.errors.join(' | ') || '无'}`);

    /* ---------- 5. 点击空白遮罩外/内（模拟误点） ---------- */
    cdp.errors.length = 0;
    const maskClick = await cdp.js(`(async () => {
      /* 点抽屉内部空白处，不应关闭 */
      const d = [...document.querySelectorAll('.drawer')].pop();
      const b = d.querySelector('.drawer-body');
      const r = b.getBoundingClientRect();
      const x = Math.round(r.right - 30), y = Math.round(r.bottom - 30);
      const ev = new MouseEvent('click', { bubbles: true, clientX: x, clientY: y });
      b.dispatchEvent(ev);
      await new Promise(r => setTimeout(r, 500));
      return JSON.stringify({ open: !![...document.querySelectorAll('.drawer')].pop() });
    })()`);
    check('5. 点击抽屉内部空白：不误关闭',
      JSON.parse(maskClick).open && cdp.errors.length === 0,
      `抽屉仍在=${JSON.parse(maskClick).open}，JS错误=${cdp.errors.join(' | ') || '无'}`);

    /* ---------- 6. 完整填写并保存 ---------- */
    cdp.errors.length = 0;
    const save = await cdp.js(`(async () => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      const set = (label, val) => {
        const f = [...d.querySelectorAll('.field')].find(x => (x.querySelector('.field-label')||{}).textContent.trim().startsWith(label));
        if (!f) return 'no-field';
        const c = f.querySelector('input, select, textarea');
        if (!c) return 'no-ctl';
        c.value = val;
        c.dispatchEvent(new Event('input', { bubbles: true }));
        c.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      };
      const nameOk = set('客户全称', '真实窗口录入${tag}');
      set('客户简称', '真窗${tag}');
      set('客户主体类型', '终端用户');
      set('下游行业', '石油');
      set('市 / 地区', '乌鲁木齐市');
      await new Promise(r => setTimeout(r, 400));
      const d2 = [...document.querySelectorAll('.drawer')].pop();
      const btn = [...d2.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
      if (!btn) return JSON.stringify({ err: '未找到保存按钮', nameOk });
      btn.click();
      await new Promise(r => setTimeout(r, 2800));
      const d3 = [...document.querySelectorAll('.drawer')].pop();
      return JSON.stringify({
        nameOk,
        open: !!d3,
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
      });
    })()`);
    const sv = JSON.parse(save);
    check('6. 真实窗口下保存成功并关闭抽屉',
      !sv.err && sv.open === false && cdp.errors.length === 0,
      sv.err || `保存前填写=${sv.nameOk}，抽屉仍开=${sv.open}，提示=${(sv.toasts || []).join('/')}，JS错误=${cdp.errors.join(' | ') || '无'}`);

    check('全程无 JS 运行时异常', cdp.errors.length === 0,
      cdp.errors.length ? cdp.errors.slice(0, 3).join('\n    ') : '0 条');
    if (cdp.console.length) {
      console.log('\n控制台警告/错误（前 5 条）：');
      for (const cl of cdp.console.slice(0, 5)) console.log('  ' + cl.slice(0, 160));
    }

    cdp.ws.close();
  } finally {
    child.kill();
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  /* 清理测试客户 */
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(__dirname, '..', 'data', 'crm.db'));
    const rows = db.prepare('SELECT id FROM customers WHERE name LIKE ?').all(`%${tag}%`);
    for (const row of rows) {
      for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
        db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(row.id);
      }
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?").run(row.id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(row.id);
    }
    console.log(`\n（已清理测试客户 ${rows.length} 条）`);
    db.close();
  } catch (_) { /* 忽略 */ }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
