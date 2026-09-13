/**
 * 界面截图工具：用 CDP 打开各页面并整页截图，供 UI 评审。
 *
 * 用法：
 *   node tools/screenshot.js                    截取默认页面（1600x1000）
 *   node tools/screenshot.js --width 1920 --height 1080
 *   node tools/screenshot.js --theme dark       深色主题
 *   node tools/screenshot.js --only home        只截指定页面
 *   node tools/screenshot.js --tag before        输出到 .shots/before/
 *   node tools/screenshot.js --list             列出可用页面
 *
 * 输出目录：.shots/<tag>/<name>.png
 */
'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';

const argv = process.argv.slice(2);
const arg = (name, def) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 ? argv[i + 1] : def;
};
const has = (name) => argv.includes('--' + name);

const WIDTH = Number(arg('width', 1600));
const HEIGHT = Number(arg('height', 1000));
const THEME = arg('theme', 'light');
const TAG = arg('tag', 'current');
const ONLY = arg('only', '');

const OUT_DIR = path.join(ROOT, '.shots', TAG);

/* 页面清单：name → { hash, wait, full, prep } */
const PAGES = [
  { name: '01-home', hash: '#/home', wait: 5200, full: true },
  { name: '02-customers', hash: '#/customers', wait: 3800, full: true },
  { name: '02b-customers-import', hash: '#/customers', wait: 3800, full: false,
    prep: `(async () => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('批量导入'));
      if (b) b.click();
      await new Promise(r => setTimeout(r, 1600));
      return 'ok';
    })()` },
  { name: '03-customers-advanced', hash: '#/customers', wait: 3800, full: false,
    prep: `(async () => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('高级筛选'));
      if (b) b.click();
      await new Promise(r => setTimeout(r, 900));
      return 'ok';
    })()` },
  { name: '04-customer-detail', hash: null, wait: 4200, full: true,
    resolveHash: true },
  { name: '05-projects', hash: '#/projects', wait: 4200, full: true },
  { name: '06-projects-list', hash: '#/projects', wait: 4200, full: true,
    prep: `(async () => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '列表');
      if (b) b.click();
      await new Promise(r => setTimeout(r, 1500));
      return 'ok';
    })()` },
  { name: '07-project-detail', hash: null, wait: 4200, full: true, resolveProject: true },
  { name: '08-tasks', hash: '#/tasks', wait: 3800, full: true },
  { name: '09-collect-review', hash: '#/collect', wait: 4200, full: true },
  { name: '09b-collect-source', hash: '#/collect', wait: 4200, full: true,
    prep: `(async () => {
      const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes('采集来源'));
      if (t) t.click();
      await new Promise(r => setTimeout(r, 1600));
      return 'ok';
    })()` },
  { name: '09c-collect-logs', hash: '#/collect', wait: 4200, full: true,
    prep: `(async () => {
      const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes('采集记录'));
      if (t) t.click();
      await new Promise(r => setTimeout(r, 1600));
      return 'ok';
    })()` },
  { name: '09d-collect-source-form', hash: '#/collect', wait: 4200, full: false,
    prep: `(async () => {
      const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes('采集来源'));
      if (t) t.click();
      await new Promise(r => setTimeout(r, 1400));
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('新增来源'));
      if (b) b.click();
      await new Promise(r => setTimeout(r, 1400));
      return 'ok';
    })()` },
  { name: '10-settings-dict', hash: '#/settings', wait: 4000, full: true },
  { name: '11-settings-backup', hash: '#/settings', wait: 4000, full: false,
    prep: `(async () => {
      const t = [...document.querySelectorAll('.settings-tabs .tab')].find(x => x.textContent.includes('备份'));
      if (t) t.click();
      await new Promise(r => setTimeout(r, 1800));
      return 'ok';
    })()` },
  { name: '12-customer-form', hash: '#/customers', wait: 3600, full: false,
    prep: `(async () => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('新增客户'));
      if (b) b.click();
      await new Promise(r => setTimeout(r, 1800));
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (d) { for (const h of d.querySelectorAll('.form-block-head')) { if (!h.classList.contains('open')) { h.click(); await new Promise(r=>setTimeout(r,90)); } } }
      await new Promise(r => setTimeout(r, 900));
      return 'ok';
    })()` }
];

if (has('list')) {
  console.log('可用页面：');
  for (const p of PAGES) console.log('  ' + p.name);
  process.exit(0);
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); } }, 60000);
    });
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    }
    return r.result.value;
  }
}

const CHROME = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'
].find((p) => fs.existsSync(p));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  if (!CHROME) { console.error('未找到 Chrome'); process.exit(1); }
  try {
    const h = await fetch(BASE + '/api/health');
    if (!h.ok) throw new Error();
  } catch (_) {
    console.error(`服务未运行（${BASE}），请先启动。`);
    process.exit(2);
  }

  fs.mkdirSync(OUT_DIR, { recursive: true });

  /* 先取用于详情页的真实 id */
  const custList = await (await fetch(BASE + '/api/customers?pageSize=1&sort=annual_demand&order=desc')).json();
  const customerId = custList.data.list[0] ? custList.data.list[0].id : null;
  const projList = await (await fetch(BASE + '/api/projects?pageSize=1')).json();
  const projectId = (projList.data.list || projList.data)[0] ? (projList.data.list || projList.data)[0].id : null;

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'shot-'));
  const PORT = 9260;
  const child = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run', '--hide-scrollbars',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    `--window-size=${WIDTH},${HEIGHT}`, 'about:blank'
  ], { stdio: 'ignore' });

  let ver = null;
  for (let i = 0; i < 60; i++) {
    await sleep(300);
    try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { ver = await r.json(); break; } } catch (_) { /* 等 */ }
  }
  if (!ver) { console.error('浏览器未就绪'); child.kill(); process.exit(1); }
  console.log(`浏览器：${ver.Browser}`);

  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  /* 深色主题：先落地页面，再用主题接口切换并强制整页重载（保证首屏即深色） */
  if (THEME === 'dark') {
    await cdp.js(`location.href='${BASE}/#/home'; 'ok'`);
    await sleep(2600);
    const ok = await cdp.js(`(() => { if (!window.CRM || !CRM.theme) return false; CRM.theme.set('dark'); return CRM.theme.isDark(); })()`);
    if (!ok) { console.error('主题接口不可用，无法截取深色主题'); process.exit(1); }
    await cdp.js(`location.reload(); 'ok'`);
    await sleep(1200);
  }

  const done = [];
  for (const p of PAGES) {
    if (ONLY && p.name !== ONLY && !p.name.includes(ONLY)) continue;

    let hash = p.hash;
    if (p.resolveHash) hash = `#/customers/${customerId}`;
    if (p.resolveProject) hash = `#/projects/${projectId}`;
    if (!hash) { console.log(`- 跳过 ${p.name}（无可用 id）`); continue; }

    await cdp.js(`location.href = ${JSON.stringify(BASE + '/' + hash)}; 'ok'`);
    await sleep(p.wait);

    if (p.prep) { try { await cdp.js(p.prep); } catch (e) { console.log(`  （预处理失败：${e.message}）`); } }

    /* 整页截图需要临时放大视口 */
    const metrics = await cdp.send('Page.getLayoutMetrics');
    const fullH = Math.ceil(metrics.cssContentSize ? metrics.cssContentSize.height : HEIGHT);
    const clipH = p.full ? Math.min(fullH, 4200) : HEIGHT;

    const shot = await cdp.send('Page.captureScreenshot', {
      format: 'png',
      captureBeyondViewport: !!p.full,
      clip: { x: 0, y: 0, width: WIDTH, height: clipH, scale: 1 }
    });

    const file = path.join(OUT_DIR, p.name + '.png');
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    const kb = Math.round(fs.statSync(file).size / 1024);
    console.log(`✓ ${p.name}.png  ${WIDTH}x${clipH}  ${kb} KB`);
    done.push(p.name);
  }

  if (cdp.errors.length) {
    console.log(`\n⚠ 页面有 ${cdp.errors.length} 条 JS 错误：`);
    for (const e of cdp.errors.slice(0, 3)) console.log('   ' + String(e).split('\n')[0]);
  } else {
    console.log('\n页面无 JS 错误。');
  }

  cdp.ws.close();
  child.kill();
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  console.log(`共 ${done.length} 张截图 → ${path.relative(ROOT, OUT_DIR)}`);
  process.exit(0);
})().catch((e) => { console.error('截图失败：', e.stack || e); process.exit(1); });
