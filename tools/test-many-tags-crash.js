/**
 * 变量排查：标签数量多时，录入过程中抽屉是否会消失。
 *
 * 背景：排查前清理过数据库，tags 表为空，界面只剩 1 个 chip，
 * 与用户实际使用状态（有若干标签）不一致。此脚本造多标签后复测。
 *
 * 用法：先启动服务，再 node tools/test-many-tags-crash.js
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

(async () => {
  console.log('=== 多标签条件下的录入复测 ===\n');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const createdTagIds = [];

  /* 造 12 个标签 */
  const mkTag = async (name) => {
    const r = await fetch(BASE + '/api/tags', {
      method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ name })
    });
    const j = await r.json();
    if (j.data && j.data.id) createdTagIds.push(j.data.id);
    return j;
  };
  for (let i = 1; i <= 12; i++) await mkTag(`深测标签${tag}-${i}`);
  const tagCount = db.prepare('SELECT COUNT(*) AS n FROM tags').get().n;
  console.log(`当前库中标签数：${tagCount}（已新建 12 个）\n`);

  /* 多选字段也造几项，确保 chips 多 */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'tags-'));
  const PORT = 9330;
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1400,900', 'about:blank'],
  { stdio: 'ignore' });

  const results = [];
  const check = (name, pass, detail) => {
    results.push({ name, pass: !!pass, detail: detail || '' });
    console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
  };

  try {
    for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
    const tabInfo = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = new CDP(tabInfo.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');

    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/customers')}; 'ok'`);
    await sleep(4200);

    /* 打开抽屉，展开全部区块 */
    await cdp.js(`(async () => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('新增客户'));
      b.click(); await new Promise(r => setTimeout(r, 2000));
      const d = [...document.querySelectorAll('.drawer')].pop();
      for (const h of [...d.querySelectorAll('.form-block-head')]) {
        if (!h.classList.contains('open')) { h.click(); await new Promise(r => setTimeout(r, 40)); }
      }
      await new Promise(r => setTimeout(r, 600));
      return 'ok';
    })()`);

    const info = await cdp.js(`(() => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return JSON.stringify({ open: false });
      const tagField = [...d.querySelectorAll('.field')].find(x => (x.querySelector('.field-label')||{}).textContent.trim().startsWith('标签'));
      const chips = tagField ? [...tagField.querySelectorAll('.chip')] : [];
      const body = d.querySelector('.drawer-body');
      const r = body.getBoundingClientRect();
      return JSON.stringify({
        open: true,
        tagChips: chips.length,
        totalChips: d.querySelectorAll('.chip').length,
        bodyScrollH: body.scrollHeight,
        bodyClientH: body.clientHeight,
        needScroll: body.scrollHeight > body.clientHeight + 2,
        firstChipText: chips[0] ? chips[0].textContent.trim() : ''
      });
    })()`);
    const i = JSON.parse(info);
    check('多标签下抽屉正常打开', i.open, `标签 chip 数=${i.tagChips}，总 chip 数=${i.totalChips}，正文高=${i.bodyScrollH}/${i.bodyClientH}，需滚动=${i.needScroll}`);

    /* 逐个点击标签 chip（模拟用户连续点选） */
    cdp.errors.length = 0;
    const clickAll = await cdp.js(`(async () => {
      const d0 = [...document.querySelectorAll('.drawer')].pop();
      const tagField = [...d0.querySelectorAll('.field')].find(x => (x.querySelector('.field-label')||{}).textContent.trim().startsWith('标签'));
      const n = tagField.querySelectorAll('.chip').length;
      const log = [];
      for (let k = 0; k < Math.min(n, 12); k++) {
        const d = [...document.querySelectorAll('.drawer')].pop();
        if (!d) { log.push('第' + (k+1) + '次点击前抽屉已消失'); break; }
        const f = [...d.querySelectorAll('.field')].find(x => (x.querySelector('.field-label')||{}).textContent.trim().startsWith('标签'));
        if (!f) { log.push('第' + (k+1) + '次找不到标签字段'); break; }
        const chips = [...f.querySelectorAll('.chip')];
        if (!chips[k]) { log.push('第' + (k+1) + '次无该 chip'); break; }
        chips[k].click();
        await new Promise(r => setTimeout(r, 200));
      }
      const last = [...document.querySelectorAll('.drawer')].pop();
      return JSON.stringify({ log, stillOpen: !!last, selected: last ? last.querySelectorAll('.chip.on').length : 0 });
    })()`);
    const ca = JSON.parse(clickAll);
    check('连续点选 12 个标签 chip：抽屉不消失、无异常',
      ca.stillOpen && ca.log.length === 0 && cdp.errors.length === 0,
      `点选后选中数=${ca.selected}，抽屉仍在=${ca.stillOpen}，异常=${ca.log.join('；') || '无'}，JS错误=${cdp.errors.join(' | ') || '无'}`);

    /* 滚动到抽屉底部再滚动回来（模拟用户翻看长表单） */
    cdp.errors.length = 0;
    const scroll = await cdp.js(`(async () => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      const body = d.querySelector('.drawer-body');
      body.scrollTop = body.scrollHeight;
      await new Promise(r => setTimeout(r, 400));
      const afterDown = !![...document.querySelectorAll('.drawer')].pop();
      body.scrollTop = 0;
      await new Promise(r => setTimeout(r, 400));
      const afterUp = !![...document.querySelectorAll('.drawer')].pop();
      return JSON.stringify({ afterDown, afterUp });
    })()`);
    const sc = JSON.parse(scroll);
    check('长表单滚动到底再回顶：抽屉不消失',
      sc.afterDown && sc.afterUp && cdp.errors.length === 0,
      `滚到底后仍在=${sc.afterDown}，回顶后仍在=${sc.afterUp}，JS错误=${cdp.errors.join(' | ') || '无'}`);

    /* 在滚动位置点击字段并输入 */
    cdp.errors.length = 0;
    const scrollThenType = await cdp.js(`(async () => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      const body = d.querySelector('.drawer-body');
      body.scrollTop = 900;
      await new Promise(r => setTimeout(r, 350));
      const d2 = [...document.querySelectorAll('.drawer')].pop();
      if (!d2) return JSON.stringify({ err: '滚动后抽屉消失' });
      /* 找当前可见的某个输入框 */
      const ctls = [...d2.querySelectorAll('.field input, .field select, .field textarea')];
      const vis = ctls.find(c => { const r = c.getBoundingClientRect(); return r.top > 100 && r.bottom < innerHeight - 100 && r.width > 0; });
      if (!vis) return JSON.stringify({ err: '无可输入控件' });
      vis.focus();
      for (const ch of '滚动测试') await new Promise(r => setTimeout(() => { vis.value += ch; vis.dispatchEvent(new Event('input', { bubbles: true })); r(); }, 60));
      await new Promise(r => setTimeout(r, 400));
      const last = [...document.querySelectorAll('.drawer')].pop();
      return JSON.stringify({ open: !!last, label: (vis.closest('.field').querySelector('.field-label')||{}).textContent || '' });
    })()`);
    const st = JSON.parse(scrollThenType);
    check('滚动后聚焦字段并输入：抽屉不消失',
      !st.err && st.open && cdp.errors.length === 0,
      st.err || `在「${st.label.trim()}」输入，抽屉仍在=${st.open}，JS错误=${cdp.errors.join(' | ') || '无'}`);

    cdp.ws.close();
  } finally {
    child.kill();
    await sleep(500);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

    /* 清理：标签与测试客户 */
    for (const id of createdTagIds) {
      db.prepare('DELETE FROM customer_tags WHERE tag_id = ?').run(id);
      db.prepare('DELETE FROM tags WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM tags WHERE name LIKE ?').run(`深测标签${tag}%`);
    const rows = db.prepare('SELECT id FROM customers WHERE name LIKE ?').all(`%${tag}%`);
    for (const row of rows) {
      for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
        db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(row.id);
      }
      db.prepare('DELETE FROM customers WHERE id = ?').run(row.id);
    }
    const leftTags = db.prepare('SELECT COUNT(*) AS n FROM tags').get().n;
    check('测试数据已清理', leftTags === 0, `剩余标签 ${leftTags} 个（应为 0），清理客户 ${rows.length} 条`);
    db.close();
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
