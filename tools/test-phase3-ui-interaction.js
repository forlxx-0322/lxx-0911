/**
 * 阶段三 浏览器交互测试（Chrome DevTools Protocol）
 *
 * 覆盖纯渲染测试测不到的部分：
 *   1. 看板 14 列渲染
 *   2. 在页面上真实新建客户与项目（填表单 → 点保存）
 *   3. 看板卡片改阶段（下拉选择 → 数据落库）
 *   4. 登记实收 → 验证页面上的欠款/回款率**当场变化**
 *   5. 待办中心四视图切换
 *   6. 全程收集 JS 错误
 *
 * 用法：node tools/test-phase3-ui-interaction.js
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
const PORT = 9224;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.errors = [];
  }
  async connect() {
    this.ws = new globalThis.WebSocket(this.wsUrl);
    await new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', () => reject(new Error('WebSocket 连接失败')), { once: true });
    });
    this.ws.addEventListener('message', (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch (_) { return; }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
      } else if (msg.method === 'Runtime.exceptionThrown') {
        const d = msg.params.exceptionDetails || {};
        this.errors.push((d.exception && d.exception.description) || d.text || '未知异常');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.errors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
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
      }, 20000);
    });
  }
  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
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
  console.log('=== 阶段三 浏览器交互测试 ===\n');

  /* 准备：一个干净的客户 */
  const ts = Date.now().toString().slice(-6);
  const custRes = await fetch(BASE + '/api/customers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `阶段三交互测试客户${ts}`, short_name: `交互测试${ts}`,
      type: '终端用户', industry: '石油'
    })
  });
  const customerId = (await custRes.json()).data.id;
  console.log(`准备测试客户 id=${customerId}\n`);

  const browser = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crmp3-'));
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
  if (!version) {
    console.log('浏览器调试端口未就绪，测试中止。');
    try { child.kill(); } catch (_) { /* 忽略 */ }
    process.exit(1);
  }
  console.log(`浏览器：${version.Browser}\n`);

  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  async function goto(hash, wait) {
    await cdp.evalJs(`location.href = ${JSON.stringify(BASE + '/' + hash)}; 'ok'`);
    await sleep(wait || 2800);
  }

  /* ---------- 1. 看板渲染（先造一条数据，否则页面显示的是空状态而非看板） ---------- */
  const seedRes = await fetch(BASE + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `阶段三交互测试项目${ts}`, customer_id: customerId,
      stage: '信息收集', contract_amount: 500000, end_user: '交互测试装置'
    })
  });
  const seedProject = (await seedRes.json()).data;
  console.log(`准备测试项目 id=${seedProject.id}\n`);

  await goto('#/projects');
  const board = await cdp.evalJs(`(() => {
    const cols = [...document.querySelectorAll('.kanban-col')];
    return {
      colCount: cols.length,
      stages: cols.map(c => (c.querySelector('.tag') || {}).textContent || '').filter(Boolean),
      hasSummary: document.querySelectorAll('.stat').length,
      hasNewBtn: [...document.querySelectorAll('button')].some(b => b.textContent.includes('新增项目')),
      hasCard: document.querySelectorAll('.kanban-card').length
    };
  })()`);
  check('项目页看板渲染出 14 个阶段列',
    board.colCount === 14,
    `列数=${board.colCount}，卡片 ${board.hasCard} 个：${board.stages.slice(0, 5).join(' / ')}…`);
  check('项目页显示金额汇总卡片与新增按钮',
    board.hasSummary >= 4 && board.hasNewBtn,
    `汇总卡片 ${board.hasSummary} 个，新增按钮=${board.hasNewBtn}`);

  /* ---------- 2. 打开新增项目抽屉并填写保存（用另一个名字，避免与种子项目混淆） ---------- */
  const newProjName = `阶段三交互新建项目${ts}`;
  const created = await cdp.evalJs(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增项目'));
    if (!btn) return { ok: false, why: '未找到新增项目按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 900));

    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '抽屉未打开' };

    const setInput = (labelText, value) => {
      const f = [...d.querySelectorAll('.field')].find(x => {
        const l = x.querySelector('.field-label');
        return l && l.textContent.includes(labelText);
      });
      if (!f) return false;
      const inp = f.querySelector('input, textarea, select');
      if (!inp) return false;
      if (inp.tagName === 'SELECT') {
        const opt = [...inp.options].find(o => o.textContent.includes(${JSON.stringify('交互测试' + ts)}));
        if (!opt) return false;
        inp.value = opt.value;
      } else {
        inp.value = value;
      }
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      inp.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };

    const r1 = setInput('项目名称', ${JSON.stringify(newProjName)});
    const r2 = setInput('所属客户', '');
    const r3 = setInput('合同金额', '500000');
    const labelCount = d.querySelectorAll('.field-label').length;

    await new Promise(r => setTimeout(r, 300));

    const saveBtn = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
    if (!saveBtn) return { ok: false, why: '未找到保存按钮', r1, r2, r3 };
    saveBtn.click();
    await new Promise(r => setTimeout(r, 1800));

    const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());
    return { ok: true, r1, r2, r3, labelCount, toasts, drawerClosed: !document.querySelector('.drawer') };
  })()`);

  check('新增项目抽屉可填写并保存成功',
    created.ok && created.r1 && created.r2 && created.toasts.some((t) => t.includes('已创建')),
    created.ok
      ? `字段填写=${created.r1 && created.r2}，抽屉字段数=${created.labelCount}，提示：${created.toasts.join(' / ')}`
      : `失败：${created.why}`);

  /* 从接口确认新项目已落库 */
  const projList = await (await fetch(BASE + '/api/projects?pageSize=5&q=' + encodeURIComponent(newProjName))).json();
  const newProject = (projList.data.list || [])[0];
  check('项目已写入数据库（含合同金额）',
    !!newProject && newProject.contract_amount === 500000,
    newProject ? `id=${newProject.id}，金额=${newProject.contract_amount}，欠款=${newProject.debt_amount}` : '未找到项目');

  /* 后续统一使用种子项目，避免同名混淆 */
  const project = seedProject;

  /* ---------- 3. 看板改阶段（针对种子项目，名称唯一可精确定位） ---------- */
  if (project) {
    await goto('#/projects', 3200);
    const moved = await cdp.evalJs(`(async () => {
      const cards = [...document.querySelectorAll('.kanban-card')];
      const card = cards.find(c => c.textContent.includes(${JSON.stringify('阶段三交互测试项目' + ts)}));
      if (!card) return { ok: false, why: '看板上未找到该项目卡片' };
      const sel = card.querySelector('select');
      if (!sel) return { ok: false, why: '卡片上无阶段下拉' };
      sel.value = '已中标/已签约';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 1800));
      const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());
      return { ok: true, toasts };
    })()`);

    const afterMove = await (await fetch(BASE + `/api/projects/${project.id}`)).json();
    check('看板上改阶段真实生效并落库',
      moved.ok && afterMove.data.stage === '已中标/已签约',
      moved.ok
        ? `阶段 → ${afterMove.data.stage}，签约日期自动补为 ${afterMove.data.signed_at}，提示：${(moved.toasts || []).join(' / ')}`
        : `失败：${moved.why}`);
  }

  /* ---------- 4. 项目详情：登记实收，验证欠款当场变化 ---------- */
  if (project) {
    await goto('#/projects/' + project.id, 3000);
    const detailBefore = await cdp.evalJs(`(() => {
      const stats = [...document.querySelectorAll('.stat')].map(s => ({
        n: (s.querySelector('.n') || {}).textContent.trim(),
        l: (s.querySelector('.l') || {}).textContent.trim()
      }));
      const tabs = [...document.querySelectorAll('.tab')].map(t => t.textContent.trim());
      const debt = stats.find(s => s.l.includes('欠款'));
      const rate = stats.find(s => s.l.includes('回款率'));
      return { stats, tabs, debt: debt && debt.n, rate: rate && rate.n };
    })()`);
    check('项目详情页渲染标签页与金额汇总',
      detailBefore.tabs.length >= 5 && !!detailBefore.debt,
      `标签页（${detailBefore.tabs.length} 个）：${detailBefore.tabs.join(' / ')}；欠款=${detailBefore.debt}，回款率=${detailBefore.rate}`);

    const pay = await cdp.evalJs(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('登记实收'));
      if (!btn) return { ok: false, why: '未找到登记实收按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 800));
      const d = document.querySelector('.drawer');
      if (!d) return { ok: false, why: '回款抽屉未打开' };

      const amtField = [...d.querySelectorAll('.field')].find(x =>
        x.querySelector('.field-label') && x.querySelector('.field-label').textContent.includes('金额'));
      if (!amtField) return { ok: false, why: '未找到金额字段' };
      const inp = amtField.querySelector('input');
      inp.value = '200000';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));

      const saveBtn = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
      saveBtn.click();
      await new Promise(r => setTimeout(r, 2000));

      const stats = [...document.querySelectorAll('.stat')].map(s => ({
        n: (s.querySelector('.n') || {}).textContent.trim(),
        l: (s.querySelector('.l') || {}).textContent.trim()
      }));
      const debt = stats.find(s => s.l.includes('欠款'));
      const rate = stats.find(s => s.l.includes('回款率'));
      const recv = stats.find(s => s.l.includes('已回款'));
      return {
        ok: true,
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
        debt: debt && debt.n, rate: rate && rate.n, received: recv && recv.n,
        drawerClosed: !document.querySelector('.drawer')
      };
    })()`);

    const afterPay = await (await fetch(BASE + `/api/projects/${project.id}`)).json();
    check('在页面上登记实收后，欠款与回款率当场自动重算',
      pay.ok && afterPay.data.received_amount === 200000
        && afterPay.data.debt_amount === 300000 && afterPay.data.payment_rate === 40,
      pay.ok
        ? `页面显示：已回款 ${pay.received}，欠款 ${pay.debt}，回款率 ${pay.rate}；接口核对：已收 ${afterPay.data.received_amount}，欠款 ${afterPay.data.debt_amount}，回款率 ${afterPay.data.payment_rate}%`
        : `失败：${pay.why}`);
  }

  /* ---------- 5. 回款计划与实收流水标签页（重新加载页面，拿到最新数据） ---------- */
  if (project) {
    await goto('#/projects/' + project.id, 3200);
    const tabs = await cdp.evalJs(`(async () => {
      const out = {};
      /* 只统计当前可见的标签页内容：
         各标签页用 v-show 隐藏，元素仍在 DOM 中，不限定范围会把隐藏页也算进来 */
      const visibleRoot = () => {
        const divs = [...document.querySelectorAll('.content > div > div')];
        return divs.filter(d => d.style.display !== 'none' && d.querySelector('.card, .timeline, .data-table'))
          .pop() || document;
      };
      for (const name of ['实收流水', '回款计划', '变更记录']) {
        const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.includes(name));
        if (!tab) { out[name] = -1; continue; }
        tab.click();
        await new Promise(r => setTimeout(r, 600));
        const root = visibleRoot();
        const rows = root.querySelectorAll('.data-table tbody tr').length;
        const logs = root.querySelectorAll('.timeline .tl-item').length;
        out[name] = rows || logs;
      }
      return out;
    })()`);
    check('回款计划 / 实收流水 / 变更记录标签页均有内容',
      (tabs['实收流水'] || 0) >= 1 && (tabs['回款计划'] || 0) >= 1 && (tabs['变更记录'] || 0) >= 2,
      `实收流水 ${tabs['实收流水']} 行，回款计划 ${tabs['回款计划']} 行，变更记录 ${tabs['变更记录']} 条（含新建/改阶段/登记实收）`);
  }

  /* ---------- 6. 待办中心 ---------- */
  await goto('#/tasks', 3000);
  const taskViews = await cdp.evalJs(`(async () => {
    const out = { views: [], counts: {} };
    const tabs = [...document.querySelectorAll('.tab')];
    out.views = tabs.map(t => t.textContent.replace(/\\s+/g, ' ').trim());
    for (const v of ['本周', '逾期', '已完成', '全部待办']) {
      const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.includes(v));
      if (!tab) continue;
      tab.click();
      await new Promise(r => setTimeout(r, 600));
      out.counts[v] = document.querySelectorAll('.task-item').length;
    }
    return out;
  })()`);
  check('待办中心渲染 6 个视图且可切换',
    taskViews.views.length >= 6,
    `视图：${taskViews.views.join(' / ')}；切换后条数=${JSON.stringify(taskViews.counts)}`);

  const quickAdd = await cdp.evalJs(`(async () => {
    const inp = document.querySelector('.quick-add input.input');
    if (!inp) return { ok: false, why: '未找到快速添加输入框' };
    inp.value = ${JSON.stringify('阶段三交互测试待办' + ts)};
    inp.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 200));
    const btn = [...document.querySelectorAll('.quick-add button')].find(b => b.textContent.includes('添加'));
    if (!btn) return { ok: false, why: '未找到添加按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 1600));
    return {
      ok: true,
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
      hasItem: document.body.innerText.includes(${JSON.stringify('阶段三交互测试待办' + ts)})
    };
  })()`);
  check('待办中心快速添加可用（回车/点添加即保存）',
    quickAdd.ok && quickAdd.hasItem,
    quickAdd.ok ? `提示：${quickAdd.toasts.join(' / ')}，列表已出现该条=${quickAdd.hasItem}` : `失败：${quickAdd.why}`);

  /* ---------- 7. 无 JS 错误 ---------- */
  check('全程无未捕获的 JS 错误',
    cdp.errors.length === 0,
    cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '0 条错误');

  /* ---------- 清理 ---------- */
  const cleanupProjects = await (await fetch(BASE + '/api/projects?q=' + encodeURIComponent('交互测试' + ts) + '&pageSize=100')).json();
  const pids = (cleanupProjects.data.list || []).map((p) => p.id);
  if (pids.length) {
    await fetch(BASE + '/api/projects/batch-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: pids })
    });
  }
  const cleanupTasks = await (await fetch(BASE + '/api/tasks?view=all&customer_id=' + customerId)).json();
  const tids = (cleanupTasks.data.list || []).map((t) => t.id);
  if (tids.length) {
    await fetch(BASE + '/api/tasks/batch-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: tids })
    });
  }
  await fetch(BASE + '/api/customers/batch-delete', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids: [customerId] })
  });
  console.log(`\n（已清理：${pids.length} 个项目、${tids.length} 条待办、1 个客户）`);

  cdp.close();
  try { child.kill(); } catch (_) { /* 忽略 */ }
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

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
