/**
 * 专测「标签字段 + 新建标签」路径，以及请求失败时的表现。
 *
 * 为什么测这个：
 *   1. 此前只测了点击已有标签 chip，没测点「+」新建标签的完整流程；
 *   2. 新建标签会发起一次请求（POST /api/tags + 重新加载标签），
 *      是所有字段操作里唯一带网络往返的，出错面更大；
 *   3. 若请求失败时前端未捕获，可能表现为界面异常。
 *
 * 用法：先启动服务，再 node tools/test-tag-new-crash.js
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
const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
};

(async () => {
  console.log('=== 标签「+」新建路径复测 ===\n');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tagnew-'));
  const PORT = 9340;
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1500,1000', 'about:blank'],
  { stdio: 'ignore' });

  try {
    for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
    const tabInfo = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = new CDP(tabInfo.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');

    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/customers')}; 'ok'`);
    await sleep(4200);

    const open = await cdp.js(`(async () => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('新增客户'));
      b.click(); await new Promise(r => setTimeout(r, 2000));
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return 'drawer-not-open';
      for (const h of [...d.querySelectorAll('.form-block-head')]) {
        if (!h.classList.contains('open')) { h.click(); await new Promise(r => setTimeout(r, 40)); }
      }
      await new Promise(r => setTimeout(r, 400));
      return 'ok';
    })()`);
    check('打开新增抽屉', open === 'ok', open);

    /* 找到标签字段的 + 按钮 */
    const plus = await cdp.js(`(async () => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      const f = [...d.querySelectorAll('.field')].find(x => (x.querySelector('.field-label')||{}).textContent.trim().startsWith('标签'));
      if (!f) return { err: '未找到标签字段' };
      const btns = [...f.querySelectorAll('button')].map(b => ({ text: b.textContent.trim(), cls: b.className }));
      const plusBtn = [...f.querySelectorAll('button')].find(b => b.textContent.trim() === '+' || b.className.includes('add'));
      if (!plusBtn) return { err: '未找到 + 按钮', btns };
      plusBtn.click();
      await new Promise(r => setTimeout(r, 600));
      const d2 = [...document.querySelectorAll('.drawer')].pop();
      const inp = d2 ? d2.querySelector('.chip-input') : null;
      return { clicked: true, hasInput: !!inp, btns };
    })()`);
    check('点击标签「+」后出现输入框', !plus.err && plus.clicked && plus.hasInput,
      plus.err || `按钮：${(plus.btns || []).map((b) => b.text).join('/')}`);

    /* 输入标签名并用 Enter 提交（真实键盘） */
    cdp.errors.length = 0;
    const newTagName = `新建标签${tag}`;
    await cdp.js(`(() => { const d = [...document.querySelectorAll('.drawer')].pop(); const i = d.querySelector('.chip-input'); i.focus(); return 'ok'; })()`);
    for (const ch of newTagName) {
      await cdp.send('Input.dispatchKeyEvent', { type: 'char', text: ch });
      await sleep(30);
    }
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', windowsVirtualKeyCode: 13, key: 'Enter' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', windowsVirtualKeyCode: 13, key: 'Enter' });
    await sleep(2200);

    const afterEnter = await cdp.js(`(() => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      return JSON.stringify({
        open: !!d,
        hash: location.hash,
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
        chipCount: d ? d.querySelectorAll('.chip').length : 0,
        onCount: d ? d.querySelectorAll('.chip.on').length : 0
      });
    })()`);
    const ae = JSON.parse(afterEnter);
    const tagRow = db.prepare('SELECT id, name FROM tags WHERE name = ?').get(newTagName);
    check('Enter 新建标签：抽屉不消失、标签已创建',
      ae.open && !!tagRow && cdp.errors.length === 0,
      `抽屉仍在=${ae.open}，标签落库=${!!tagRow}，chip 数=${ae.chipCount}，选中=${ae.onCount}，提示=${ae.toasts.join('/')}，JS错误=${cdp.errors.join(' | ') || '无'}`);

    /* 清掉输入框内容后再测一次（边界：同名标签） */
    cdp.errors.length = 0;
    const dupSubmit = await cdp.js(`(async () => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return JSON.stringify({ err: '抽屉不在' });
      const f = [...d.querySelectorAll('.field')].find(x => (x.querySelector('.field-label')||{}).textContent.trim().startsWith('标签'));
      const plusBtn = [...f.querySelectorAll('button')].find(b => b.textContent.trim() === '+');
      if (plusBtn) plusBtn.click();
      await new Promise(r => setTimeout(r, 500));
      const i = d.querySelector('.chip-input');
      if (!i) return JSON.stringify({ err: '无输入框' });
      i.value = ${JSON.stringify(newTagName)};
      i.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
      const okBtn = [...f.querySelectorAll('button')].find(b => /确定|保存|✓/.test(b.textContent));
      if (okBtn) okBtn.click();
      await new Promise(r => setTimeout(r, 1800));
      const last = [...document.querySelectorAll('.drawer')].pop();
      return JSON.stringify({ open: !!last, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()) });
    })()`);
    const ds = JSON.parse(dupSubmit);
    check('重复新建同名标签：抽屉不消失、无异常',
      !ds.err && ds.open && cdp.errors.length === 0,
      ds.err || `抽屉仍在=${ds.open}，提示=${(ds.toasts || []).join('/')}，JS错误=${cdp.errors.join(' | ') || '无'}`);

    /* 最终保存 */
    cdp.errors.length = 0;
    const finalSave = await cdp.js(`(async () => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      const set = (label, val) => {
        const f = [...d.querySelectorAll('.field')].find(x => (x.querySelector('.field-label')||{}).textContent.trim().startsWith(label));
        if (!f) return 'no-field';
        const c = f.querySelector('input, select, textarea');
        if (!c) return 'no-ctl';
        c.value = val; c.dispatchEvent(new Event('input', { bubbles: true })); c.dispatchEvent(new Event('change', { bubbles: true }));
        return 'ok';
      };
      set('客户全称', '标签新建复测${tag}');
      set('客户简称', '标签复测${tag}');
      set('客户主体类型', '终端用户');
      set('下游行业', '石油');
      await new Promise(r => setTimeout(r, 400));
      const d2 = [...document.querySelectorAll('.drawer')].pop();
      const btn = [...d2.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
      btn.click();
      await new Promise(r => setTimeout(r, 2600));
      return JSON.stringify({ open: !![...document.querySelectorAll('.drawer')].pop(), toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()) });
    })()`);
    const fsr = JSON.parse(finalSave);
    const custRow = db.prepare('SELECT id FROM customers WHERE name = ?').get(`标签新建复测${tag}`);
    check('带新建标签保存客户：成功且抽屉关闭',
      fsr.open === false && !!custRow && cdp.errors.length === 0,
      `抽屉仍开=${fsr.open}，客户落库=${!!custRow}，提示=${(fsr.toasts || []).join('/')}，JS错误=${cdp.errors.join(' | ') || '无'}`);

    check('全程无 JS 运行时异常', cdp.errors.length === 0,
      cdp.errors.length ? cdp.errors.slice(0, 3).join('\n    ') : '0 条');

    cdp.ws.close();
  } finally {
    child.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    const rows = db.prepare('SELECT id FROM customers WHERE name LIKE ?').all(`%${tag}%`);
    for (const row of rows) {
      for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
        db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(row.id);
      }
      db.prepare('DELETE FROM customers WHERE id = ?').run(row.id);
    }
    db.prepare('DELETE FROM customer_tags WHERE tag_id IN (SELECT id FROM tags WHERE name LIKE ?)').run(`%${tag}%`);
    db.prepare('DELETE FROM tags WHERE name LIKE ?').run(`%${tag}%`);
    check('测试数据已清理',
      db.prepare('SELECT COUNT(*) AS n FROM tags WHERE name LIKE ?').get(`%${tag}%`).n === 0,
      `清理客户 ${rows.length} 条、标签若干`);
    db.close();
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
