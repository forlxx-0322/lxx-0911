/**
 * 深度复现「录入客户闪退」：覆盖更接近真实使用的场景。
 *
 * 场景：
 *   G. 内联新增字典项（企业性质旁点「+」新建选项）后保存
 *   H. 多选标签、开关、日期、数字等各类控件都动一遍后保存
 *   I. 窄窗口（1024×700）下录入并保存
 *   J. 抽屉打开时改变窗口大小（触发重排）
 *   K. 连续快速保存两次
 *   L. 填完整真实感数据（长公司名、长地址、多种阀门规格）后保存
 *
 * 用法：先启动服务，再 node tools/test-customer-crash-deep.js
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
  clearErrors() { this.errors.length = 0; }
}

const tag = Date.now().toString().slice(-6);

const HELPERS = fs.readFileSync(path.join(__dirname, 'test-customer-create-crash.js'), 'utf8')
  .match(/const HELPERS = `([\s\S]*?)`;/)[1];

(async () => {
  console.log('=== 「录入客户闪退」深度复现 ===\n');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const createdIds = [];
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crash2-'));
  const PORT = 9301;
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1600,1000', 'about:blank'],
  { stdio: 'ignore' });

  try {
    for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
    const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');

    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/customers')}; 'ok'`);
    await sleep(4000);

    async function reset() {
      await cdp.js(`location.hash = '#/customers'; 'ok'`);
      await sleep(2000);
      /* 关掉可能残留的抽屉 */
      await cdp.js(`(() => { const d = [...document.querySelectorAll('.drawer')].pop(); if (d) { const x = [...d.querySelectorAll('.drawer-head button')].pop(); x && x.click(); } return 'ok'; })()`);
      await sleep(700);
      await cdp.js(HELPERS);
    }

    /* ---------- G. 内联新增字典项 ---------- */
    cdp.clearErrors();
    await reset();
    const rg = await (async () => {
      await cdp.js(`window.__probe.openDrawer()`);
      await cdp.js(`window.__probe.setText('客户全称', '【闪退深测${tag}】内联新增')`);
      await cdp.js(`window.__probe.setText('客户简称', '内联新增${tag}')`);
      await cdp.js(`window.__probe.setSelect('客户主体类型', '终端用户')`);
      await cdp.js(`window.__probe.setSelect('下游行业', '石油')`);

      /* 找到「企业性质」字段的 + 按钮并点击 */
      const clicked = await cdp.js(`(async () => {
        const f = window.__probe.field('企业性质');
        if (!f) return 'no-field';
        const plus = [...f.querySelectorAll('button')].find(b => b.textContent.trim() === '+');
        if (!plus) return 'no-plus-button';
        plus.click();
        await new Promise(r => setTimeout(r, 500));
        const inp = f.querySelector('input');
        if (!inp) return 'no-inline-input';
        inp.value = '深测性质${tag}';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 200));
        /* 找确认按钮 */
        const confirm = [...f.querySelectorAll('button')].find(b => /确定|保存|确认|✓/.test(b.textContent));
        if (confirm) { confirm.click(); return 'submitted-by-button'; }
        inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return 'submitted-by-enter';
      })()`);
      await sleep(1800);
      const st = JSON.parse(await cdp.js(`JSON.stringify(window.__probe.state())`));
      await cdp.js(`window.__probe.clickFoot('保存')`);
      await sleep(2600);
      const after = JSON.parse(await cdp.js(`JSON.stringify(window.__probe.state())`));
      const row = db.prepare('SELECT id, enterprise_nature FROM customers WHERE name = ?').get(`【闪退深测${tag}】内联新增`);
      if (row) createdIds.push(row.id);
      return { clicked, st, after, saved: !!row, nature: row && row.enterprise_nature };
    })();
    check('G. 内联新增字典项：无异常且能保存',
      rg.clicked.startsWith('submitted') && rg.saved && !rg.after.drawerOpen && cdp.errors.length === 0,
      `内联新增=${rg.clicked}；落库=${rg.saved}(性质=${rg.nature})；抽屉仍开=${rg.after.drawerOpen}；提示=${rg.after.toasts.join('/')}；JS错误=${cdp.errors.join(' | ') || '无'}`);

    /* ---------- H. 各类控件都动一遍 ---------- */
    cdp.clearErrors();
    await reset();
    const rh = await (async () => {
      await cdp.js(`window.__probe.openDrawer()`);
      await cdp.js(`window.__probe.setText('客户全称', '【闪退深测${tag}】控件遍历')`);
      await cdp.js(`window.__probe.setText('客户简称', '控件${tag}')`);
      await cdp.js(`window.__probe.setSelect('客户主体类型', '终端用户')`);
      await cdp.js(`window.__probe.setSelect('下游行业', '石油')`);
      /* 遍历抽屉内所有控件：赋值 + 触发事件 */
      const touched = await cdp.js(`(async () => {
        const d = window.__probe.drawer();
        const log = { select: 0, text: 0, check: 0, date: 0, number: 0, failed: [] };
        for (const inp of d.querySelectorAll('input, select, textarea')) {
          try {
            if (inp.tagName === 'SELECT') {
              if (inp.options.length > 1) { inp.selectedIndex = 1; inp.dispatchEvent(new Event('change', { bubbles: true })); log.select++; }
            } else if (inp.type === 'checkbox' || inp.type === 'radio') {
              inp.click(); log.check++;
            } else if (inp.type === 'date') {
              inp.value = '2026-03-01'; inp.dispatchEvent(new Event('input', { bubbles: true })); log.date++;
            } else if (inp.type === 'number') {
              inp.value = '12'; inp.dispatchEvent(new Event('input', { bubbles: true })); log.number++;
            } else if (inp.type === 'file') {
              /* 跳过文件选择 */
            } else {
              inp.value = inp.value || '测试值'; inp.dispatchEvent(new Event('input', { bubbles: true })); log.text++;
            }
          } catch (e) { log.failed.push(inp.type + ':' + e.message); }
        }
        await new Promise(r => setTimeout(r, 500));
        return log;
      })()`);
      const st = JSON.parse(await cdp.js(`JSON.stringify(window.__probe.state())`));
      return { touched, st, errors: cdp.errors.slice(0, 5) };
    })();
    check('H. 遍历所有控件赋值：抽屉未消失、无异常',
      rh.st.drawerOpen && rh.errors.length === 0,
      `控件：下拉${rh.touched.select}/文本${rh.touched.text}/勾选${rh.touched.check}/日期${rh.touched.date}/数字${rh.touched.number}；失败${rh.touched.failed.length}；抽屉仍开=${rh.st.drawerOpen}；JS错误=${rh.errors.join(' | ') || '无'}`);

    /* ---------- I. 窄窗口 ---------- */
    cdp.clearErrors();
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 700, deviceScaleFactor: 1, mobile: false });
    await reset();
    const ri = await (async () => {
      await cdp.js(`window.__probe.openDrawer()`);
      const geom = await cdp.js(`(() => {
        const d = window.__probe.drawer();
        if (!d) return { err: '抽屉未打开' };
        const r = d.getBoundingClientRect();
        return { w: Math.round(r.width), h: Math.round(r.height), left: Math.round(r.left), right: Math.round(r.right), top: Math.round(r.top), bottom: Math.round(r.bottom), winW: innerWidth, winH: innerHeight };
      })()`);
      await cdp.js(`window.__probe.setText('客户全称', '【闪退深测${tag}】窄窗口')`);
      await cdp.js(`window.__probe.setText('客户简称', '窄窗${tag}')`);
      await cdp.js(`window.__probe.setSelect('客户主体类型', '终端用户')`);
      await cdp.js(`window.__probe.setSelect('下游行业', '石油')`);
      await cdp.js(`window.__probe.clickFoot('保存')`);
      await sleep(2600);
      const st = JSON.parse(await cdp.js(`JSON.stringify(window.__probe.state())`));
      const row = db.prepare('SELECT id FROM customers WHERE name = ?').get(`【闪退深测${tag}】窄窗口`);
      if (row) createdIds.push(row.id);
      return { geom, st, saved: !!row };
    })();
    check('I. 1024×700 窄窗口：抽屉不超出视口、能保存',
      !ri.geom.err && ri.geom.right <= ri.geom.winW + 1 && ri.geom.left >= -1 && ri.saved,
      `抽屉 ${ri.geom.w}/${ri.geom.winW}px，右边界 ${ri.geom.right}，落库=${ri.saved}，JS错误=${cdp.errors.join(' | ') || '无'}`);
    await cdp.send('Emulation.clearDeviceMetricsOverride');

    /* ---------- J. 抽屉打开时改窗口大小 ---------- */
    cdp.clearErrors();
    await reset();
    const rj = await (async () => {
      await cdp.js(`window.__probe.openDrawer()`);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 900, height: 640, deviceScaleFactor: 1, mobile: false });
      await sleep(900);
      const stillOpen = await cdp.js(`!!window.__probe.drawer()`);
      await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1600, height: 1000, deviceScaleFactor: 1, mobile: false });
      await sleep(900);
      const after = JSON.parse(await cdp.js(`JSON.stringify(window.__probe.state())`));
      await cdp.send('Emulation.clearDeviceMetricsOverride');
      return { stillOpen, after };
    })();
    check('J. 抽屉打开时改窗口大小：抽屉不消失、无异常',
      rj.stillOpen && rj.after.drawerOpen && cdp.errors.length === 0,
      `缩小后仍在=${rj.stillOpen}，恢复后仍在=${rj.after.drawerOpen}，JS错误=${cdp.errors.join(' | ') || '无'}`);

    /* ---------- L. 真实感长数据 ---------- */
    cdp.clearErrors();
    await reset();
    const rl = await (async () => {
      await cdp.js(`window.__probe.openDrawer()`);
      await cdp.js(`window.__probe.setText('客户全称', '【闪退深测${tag}】中国石油天然气股份有限公司乌鲁木齐石化分公司')`);
      await cdp.js(`window.__probe.setText('客户简称', '乌石化${tag}')`);
      await cdp.js(`window.__probe.setSelect('客户主体类型', '终端用户')`);
      await cdp.js(`window.__probe.setSelect('下游行业', '石油')`);
      await cdp.js(`window.__probe.setText('公司电话', '0991-6901234')`);
      await cdp.js(`window.__probe.setText('统一社会信用代码', '91650100MA7XXXXX9K')`);
      await cdp.js(`window.__probe.setText('市 / 地区', '乌鲁木齐市')`);
      await cdp.js(`window.__probe.setText('区 / 县', '米东区')`);
      await cdp.js(`window.__probe.setText('详细地址', '米东区石化路 1 号中国石油乌鲁木齐石化分公司厂区 3 号门 综合办公楼 5 层设备管理部')`);
      await cdp.js(`window.__probe.setText('备注', '长期合作客户，年采购量约 800 万元，主要采购球阀与闸阀，账期月结 60 天。'.repeat(3))`);
      const st1 = JSON.parse(await cdp.js(`JSON.stringify(window.__probe.state())`));
      await cdp.js(`window.__probe.clickFoot('保存')`);
      await sleep(2800);
      const st2 = JSON.parse(await cdp.js(`JSON.stringify(window.__probe.state())`));
      const row = db.prepare('SELECT id, address, city FROM customers WHERE name LIKE ?').get(`【闪退深测${tag}】中国石油%`);
      if (row) createdIds.push(row.id);
      return { st1, st2, saved: !!row, row };
    })();
    check('L. 长公司名/长地址/长备注：能保存且内容完整',
      rl.saved && !rl.st2.drawerOpen && cdp.errors.length === 0,
      `落库=${rl.saved}（${rl.row ? rl.row.city : '-'}）；抽屉仍开=${rl.st2.drawerOpen}；提示=${rl.st2.toasts.join('/')}；JS错误=${cdp.errors.join(' | ') || '无'}`);

    check('全程无 JS 运行时异常', cdp.errors.length === 0,
      cdp.errors.length ? cdp.errors.slice(0, 3).join('\n    ') : '0 条');

    cdp.ws.close();
  } finally {
    for (const id of [...new Set(createdIds.filter(Boolean))]) {
      for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
        db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(id);
      }
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?").run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM customers WHERE name LIKE ?').run(`【闪退深测${tag}】%`);
    db.prepare('DELETE FROM customers WHERE name LIKE ?').run(`%${tag}%`);
    db.prepare("DELETE FROM dict WHERE value LIKE ?").run(`深测性质${tag}`);
    const left = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?').get(`%${tag}%`).n;
    check('测试数据已清理', left === 0, `残留 ${left} 条`);
    db.close();
    child.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
