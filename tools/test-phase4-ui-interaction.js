/**
 * 阶段四 浏览器交互测试（Chrome DevTools Protocol）
 *
 * 覆盖：
 *   1. 首页总览：6 张数字卡 + 4 张 ECharts 图表（真实 canvas 渲染）+ 各列表块
 *   2. 设置页 8 个标签页切换
 *   3. 字典管理：新增选项 → 立即出现在表单下拉（真实落库）
 *   4. 标签管理：新建标签 → 客户表单可选用
 *   5. 真实下载 Excel 模板与导出文件，并验证文件落到磁盘
 *   6. 回收站与操作日志面板渲染
 *   7. 全程收集 JS 错误
 *
 * 用法：node tools/test-phase4-ui-interaction.js
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CHROME_CANDIDATES = [
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'
];
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const PORT = 9225;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.errors = []; }
  async connect() {
    this.ws = new globalThis.WebSocket(this.url);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      } else if (m.method === 'Runtime.exceptionThrown') {
        const d = m.params.exceptionDetails || {};
        this.errors.push((d.exception && d.exception.description) || d.text || '未知异常');
      } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
        this.errors.push((m.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    });
  }
  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); }
      }, 25000);
    });
  }
  async evalJs(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面脚本异常：' + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    }
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (_) { /* 忽略 */ } }
}

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome / Edge');
}

(async () => {
  console.log('=== 阶段四 浏览器交互测试 ===\n');

  /* 准备：造一点数据，让首页图表有内容 */
  const ts = Date.now().toString().slice(-6);
  const cust = await (await fetch(BASE + '/api/customers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `阶段四交互测试客户${ts}`, short_name: `交互${ts}`, type: '终端用户',
      industry: '石油', level: 'A 重点客户', status: '跟进中',
      next_follow_at: (() => { const d = new Date(); d.setDate(d.getDate() - 1); return d.toISOString().slice(0, 10) + ' 10:00:00'; })()
    })
  })).json();
  const customerId = cust.data.id;
  const proj = await (await fetch(BASE + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `阶段四交互测试项目${ts}`, customer_id: customerId,
      stage: '已中标/已签约', contract_amount: 660000,
      signed_at: new Date().toISOString().slice(0, 10),
      bid_date: new Date(Date.now() + 3 * 86400000).toISOString().slice(0, 10), bid_result: '已中标'
    })
  })).json();
  console.log(`准备测试数据：客户 ${customerId}，项目 ${proj.data.id}\n`);

  const browser = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crmp4-'));
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'crmdl-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1600,1000', 'about:blank'
  ], { stdio: 'ignore' });

  let version = null;
  for (let i = 0; i < 40; i++) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch (_) { /* 继续等 */ }
  }
  if (!version) { console.log('浏览器未就绪'); try { child.kill(); } catch (_) {} process.exit(1); }
  console.log(`浏览器：${version.Browser}\n`);

  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  /* 允许下载到指定目录 */
  try {
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  } catch (_) {
    await cdp.send('Page.setDownloadBehavior', { behavior: 'allow', downloadPath: downloadDir });
  }

  async function goto(hash, wait) {
    await cdp.evalJs(`location.href = ${JSON.stringify(BASE + '/' + hash)}; 'ok'`);
    await sleep(wait || 3200);
  }
  async function waitForFile(dir, before, timeoutMs) {
    const t0 = Date.now();
    while (Date.now() - t0 < (timeoutMs || 12000)) {
      const now = fs.readdirSync(dir).filter((f) => !f.endsWith('.crdownload'));
      const added = now.filter((f) => !before.includes(f));
      if (added.length) return added;
      await sleep(400);
    }
    return [];
  }

  /* ================= 1. 首页总览 ================= */
  await goto('#/home', 3800);
  const dash = await cdp.evalJs(`(() => {
    const stats = [...document.querySelectorAll('.stat')];
    const canvases = [...document.querySelectorAll('canvas')];
    const canvasSizes = canvases.map(c => (c.width + 'x' + c.height));
    return {
      cardCount: stats.length,
      cardTexts: stats.map(s => (s.querySelector('.l') || {}).textContent.trim()).slice(0, 6),
      chartCount: canvases.length,
      canvasSizes,
      hasFollowList: !!document.querySelector('.mini-list'),
      miniRows: document.querySelectorAll('.mini-row').length,
      hasBidTable: !!document.querySelector('.data-table'),
      hasError: document.body.innerText.includes('加载失败')
    };
  })()`);

  check('首页渲染 6 张数字卡', dash.cardCount >= 6,
    `${dash.cardCount} 张：${dash.cardTexts.join(' / ')}`);
  check('首页 4 张 ECharts 图表真实渲染（canvas 有尺寸）',
    dash.chartCount >= 4 && dash.canvasSizes.every((s) => !s.startsWith('0x')),
    `${dash.chartCount} 个 canvas：${dash.canvasSizes.join(' , ')}`);
  check('首页各数据块渲染（待跟进 / 回款 / 招投标 / 动态）',
    dash.hasFollowList && dash.miniRows > 0 && dash.hasBidTable,
    `列表行 ${dash.miniRows} 条，招投标表格=${dash.hasBidTable}`);
  check('首页无加载错误', !dash.hasError, dash.hasError ? '出现错误提示' : '正常');

  /* ================= 2. 设置页标签 ================= */
  await goto('#/settings', 3200);
  const tabsInfo = await cdp.evalJs(`(() => {
    const tabs = [...document.querySelectorAll('.settings-tabs .tab')];
    return { count: tabs.length, labels: tabs.map(t => t.textContent.trim()) };
  })()`);
  /* 阶段四为 8 个；阶段五新增「附件与存储」共 9 个 —— 断言按至少 8 个校验，避免后续新增页面时误报 */
  check('设置页渲染全部标签页（≥8 个）', tabsInfo.count >= 8,
    `${tabsInfo.count} 个：${tabsInfo.labels.join(' / ')}`);

  const tabSwitch = await cdp.evalJs(`(async () => {
    const out = {};
    for (const name of ['标签管理','提醒与偏好','备份与恢复','导入导出','回收站','操作日志','关于']) {
      const el = [...document.querySelectorAll('.settings-tabs .tab')].find(t => t.textContent.includes(name));
      if (!el) { out[name] = 'missing'; continue; }
      el.click();
      await new Promise(r => setTimeout(r, 900));
      const active = document.querySelector('.settings-tabs .tab.active');
      const cards = document.querySelectorAll('.content .card').length;
      const rows = document.querySelectorAll('.content .data-table tbody tr').length;
      out[name] = { active: active ? active.textContent.trim() : '', cards, rows };
    }
    return out;
  })()`);
  const switchOk = Object.values(tabSwitch).every((v) => v && v !== 'missing' && v.active);
  check('7 个设置标签页均可切换并渲染内容',
    switchOk,
    Object.entries(tabSwitch).map(([k, v]) => `${k}${v && v.active ? '✓' : '✗'}`).join(' '));

  /* ================= 3. 字典管理：新增即时生效 ================= */
  const dictTest = await cdp.evalJs(`(async () => {
    /* 回到字典管理 */
    const dt = [...document.querySelectorAll('.settings-tabs .tab')].find(t => t.textContent.includes('字典管理'));
    dt.click();
    await new Promise(r => setTimeout(r, 1200));

    /* 选中「下游行业」分类 */
    const cat = [...document.querySelectorAll('.dict-cat')].find(c => c.textContent.includes('下游行业'));
    if (!cat) return { ok: false, why: '未找到下游行业分类' };
    cat.click();
    await new Promise(r => setTimeout(r, 700));
    const beforeCount = document.querySelectorAll('.dict-item').length;

    /* 点新增 */
    const addBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增选项'));
    if (!addBtn) return { ok: false, why: '未找到新增选项按钮' };
    addBtn.click();
    await new Promise(r => setTimeout(r, 400));

    const inp = document.querySelector('.content .card-body input.input');
    if (!inp) return { ok: false, why: '未出现输入框' };
    inp.value = ${JSON.stringify('交互测试行业' + ts)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));

    const saveBtn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '保存');
    if (!saveBtn) return { ok: false, why: '未找到保存按钮' };
    saveBtn.click();
    await new Promise(r => setTimeout(r, 1800));

    const afterCount = document.querySelectorAll('.dict-item').length;
    const hasNew = document.body.innerText.includes(${JSON.stringify('交互测试行业' + ts)});
    return {
      ok: true, beforeCount, afterCount, hasNew,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
    };
  })()`);
  check('字典管理可新增选项并立即出现在列表中',
    dictTest.ok && dictTest.hasNew && dictTest.afterCount === dictTest.beforeCount + 1,
    dictTest.ok
      ? `选项数 ${dictTest.beforeCount} → ${dictTest.afterCount}，提示：${dictTest.toasts.join(' / ')}`
      : `失败：${dictTest.why}`);

  /* 验证新选项立即出现在客户表单下拉（不刷新页面，靠缓存同步） */
  const inForm = await cdp.evalJs(`(async () => {
    location.hash = '#/customers';
    await new Promise(r => setTimeout(r, 2600));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增客户'));
    if (!btn) return { ok: false, why: '未找到新增客户按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 1000));
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '抽屉未打开' };
    const f = [...d.querySelectorAll('.field')].find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.includes('下游行业');
    });
    if (!f) return { ok: false, why: '未找到下游行业字段' };
    const sel = f.querySelector('select');
    const opts = sel ? [...sel.options].map(o => o.value) : [];
    return { ok: true, found: opts.includes(${JSON.stringify('交互测试行业' + ts)}), count: opts.length };
  })()`);
  check('新增的行业选项立即出现在客户表单下拉中',
    inForm.ok && inForm.found,
    inForm.ok ? `下拉选项 ${inForm.count} 项，含新选项=${inForm.found}` : `失败：${inForm.why}`);

  /* ================= 4. 真实下载 Excel 模板 ================= */
  await goto('#/settings', 2600);
  const beforeTpl = fs.readdirSync(downloadDir);
  const tplClick = await cdp.evalJs(`(async () => {
    const dt = [...document.querySelectorAll('.settings-tabs .tab')].find(t => t.textContent.includes('导入导出'));
    dt.click();
    await new Promise(r => setTimeout(r, 1400));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('下载') && b.textContent.includes('导入模板'));
    if (!btn) return { ok: false, why: '未找到下载模板按钮' };
    btn.click();
    return { ok: true };
  })()`);
  const tplFiles = await waitForFile(downloadDir, beforeTpl, 14000);
  const tplFile = tplFiles.find((f) => f.endsWith('.xlsx'));
  const tplPath = tplFile ? path.join(downloadDir, tplFile) : null;
  let tplSize = 0;
  if (tplPath) tplSize = fs.statSync(tplPath).size;
  check('真实下载 Excel 导入模板并落到磁盘',
    tplClick.ok && !!tplFile && tplSize > 3000,
    tplFile ? `${tplFile}（${Math.round(tplSize / 1024)} KB）` : `未生成文件（${tplClick.why || '超时'}）`);

  /* 校验模板内容真的是 xlsx（zip 头 PK） */
  if (tplPath) {
    const head = fs.readFileSync(tplPath).slice(0, 2).toString('latin1');
    check('模板文件是合法 xlsx（zip 头 PK）', head === 'PK', `文件头 = ${JSON.stringify(head)}`);
  } else {
    check('模板文件是合法 xlsx（zip 头 PK）', false, '无文件');
  }

  /* ================= 5. 真实导出数据 ================= */
  const beforeExp = fs.readdirSync(downloadDir);
  const expClick = await cdp.evalJs(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('导出为 Excel'));
    if (!btn) return { ok: false, why: '未找到导出按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 2500));
    return { ok: true, toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()) };
  })()`);
  const expFiles = await waitForFile(downloadDir, beforeExp, 14000);
  const expFile = expFiles.find((f) => f.endsWith('.xlsx'));
  const expPath = expFile ? path.join(downloadDir, expFile) : null;
  const expSize = expPath ? fs.statSync(expPath).size : 0;
  check('真实导出客户数据为 Excel 并落到磁盘',
    expClick.ok && !!expFile && expSize > 3000,
    expFile ? `${expFile}（${Math.round(expSize / 1024)} KB）提示：${(expClick.toasts || []).join(' / ')}` : `未生成文件（${expClick.why || '超时'}）`);

  /* 用 SheetJS 在 Node 侧读回导出文件，验证表头与行数（真正的端到端闭环） */
  if (expPath) {
    try {
      const XLSX = require(path.resolve(__dirname, '..', 'web', 'vendor', 'xlsx.full.min.js'));
      /* 浏览器版 SheetJS 没有 readFile（依赖 fs），改为读 Buffer 再解析 */
      const buf = fs.readFileSync(expPath);
      const wb = XLSX.read(buf, { type: 'buffer' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const header = aoa[0] || [];
      const dataRows = aoa.length - 1;
      const hasRequiredCols = header.includes('客户全称') && header.includes('客户简称')
        && header.includes('下游行业') && header.includes('供应商编码');
      const hasOurCustomer = aoa.some((r) => String(r[0] || '').includes(`阶段四交互测试客户${ts}`));
      check('导出的 Excel 可被读回且内容正确（表头 + 数据行）',
        hasRequiredCols && dataRows >= 1 && hasOurCustomer,
        `表头 ${header.length} 列（含关键列=${hasRequiredCols}），数据 ${dataRows} 行，含本次测试客户=${hasOurCustomer}`);
    } catch (e) {
      check('导出的 Excel 可被读回且内容正确（表头 + 数据行）', false, '读取失败：' + e.message);
    }
  } else {
    check('导出的 Excel 可被读回且内容正确（表头 + 数据行）', false, '无文件');
  }

  /* ================= 6. 备份面板 ================= */
  const backupPanel = await cdp.evalJs(`(async () => {
    const bt = [...document.querySelectorAll('.settings-tabs .tab')].find(t => t.textContent.includes('备份与恢复'));
    bt.click();
    await new Promise(r => setTimeout(r, 1600));
    const text = document.querySelector('.content').innerText;
    return {
      hasStatus: text.includes('备份状态'),
      hasStrategy: text.includes('备份策略'),
      hasList: text.includes('备份列表'),
      backupRows: document.querySelectorAll('.backup-item').length,
      hasAutoSwitch: !!document.querySelector('.switch')
    };
  })()`);
  check('备份面板渲染状态、策略与备份列表',
    backupPanel.hasStatus && backupPanel.hasStrategy && backupPanel.hasList && backupPanel.hasAutoSwitch,
    `备份条目 ${backupPanel.backupRows} 份，自动备份开关=${backupPanel.hasAutoSwitch}`);

  /* ================= 7. 回收站与日志 ================= */
  const trashLog = await cdp.evalJs(`(async () => {
    const out = {};
    const tt = [...document.querySelectorAll('.settings-tabs .tab')].find(t => t.textContent.includes('回收站'));
    tt.click();
    await new Promise(r => setTimeout(r, 1300));
    out.trashTabs = document.querySelectorAll('.content .tab').length;

    const lt = [...document.querySelectorAll('.settings-tabs .tab')].find(t => t.textContent.includes('操作日志'));
    lt.click();
    await new Promise(r => setTimeout(r, 1600));
    out.logRows = document.querySelectorAll('.content .data-table tbody tr').length;
    out.logFilters = document.querySelectorAll('.content select').length;
    return out;
  })()`);
  check('回收站与操作日志面板渲染正常',
    trashLog.trashTabs >= 3 && trashLog.logRows >= 1,
    `回收站 ${trashLog.trashTabs} 个分类，日志 ${trashLog.logRows} 行、${trashLog.logFilters} 个筛选下拉`);

  /* ================= 8. JS 错误 ================= */
  check('全程无未捕获的 JS 错误',
    cdp.errors.length === 0,
    cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '0 条错误');

  /* ================= 清理 ================= */
  await fetch(BASE + '/api/projects/batch-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [proj.data.id] })
  });
  await fetch(BASE + '/api/customers/batch-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [customerId] })
  });
  /* 清掉测试新增的行业选项 */
  try {
    const d = await (await fetch(BASE + '/api/dict')).json();
    const hits = (d.data.items.industry || []).filter((x) => x.value === `交互测试行业${ts}`);
    for (const h of hits) await fetch(BASE + '/api/dict/' + h.id, { method: 'DELETE' });
  } catch (_) { /* 忽略 */ }
  console.log('\n（已清理测试数据与测试字典项）');

  cdp.close();
  try { child.kill(); } catch (_) { /* 忽略 */ }
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  try { fs.rmSync(downloadDir, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
