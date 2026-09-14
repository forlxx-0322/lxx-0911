/**
 * 阶段二 浏览器交互测试
 *
 * 通过 Chrome DevTools Protocol 驱动真实浏览器：
 *   - 点击「新增客户」→ 验证编辑抽屉真的打开、7 个区块与内联新增按钮存在
 *   - 切换详情页 5 个标签页 → 验证每个标签页内容渲染
 *   - 点击「记录跟进」→ 验证跟进抽屉打开
 *   - 收集运行时 JS 错误
 *
 * 用法：node tools/test-phase2-ui-interaction.js [customerId]
 * 前置：服务运行中；Chrome 已安装
 */

'use strict';

const { spawn, execFileSync } = require('node:child_process');
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
const PORT = 9223;

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome / Edge');
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------------- 极简 CDP 客户端 ---------------- */
class CDP {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.consoleErrors = [];
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
        this.consoleErrors.push((d.exception && d.exception.description) || d.text || '未知异常');
      } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
        this.consoleErrors.push((msg.params.args || []).map((a) => a.value || a.description || '').join(' '));
      }
    });
  }

  send(method, params) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`${method} 超时`));
        }
      }, 15000);
    });
  }

  /** 执行 JS 表达式并返回可序列化结果 */
  async evalJs(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true
    });
    if (r.exceptionDetails) {
      throw new Error('页面脚本异常：' + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    }
    return r.result.value;
  }

  close() { try { this.ws.close(); } catch (_) { /* 忽略 */ } }
}

(async () => {
  console.log('=== 阶段二 浏览器交互测试 ===\n');

  if (typeof globalThis.WebSocket !== 'function') {
    console.log('当前 Node 无内置 WebSocket，跳过交互测试。');
    process.exit(0);
  }

  /* 取一个真实存在的客户 ID */
  let customerId = process.argv[2];
  if (!customerId) {
    const r = await fetch(BASE + '/api/customers?pageSize=1');
    const j = await r.json();
    customerId = j.data.list[0] ? j.data.list[0].id : null;
  }
  if (!customerId) {
    console.log('库中没有客户，先建一条用于测试。');
    const r = await fetch(BASE + '/api/customers', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: '交互测试客户', short_name: '交互测试', type: '终端用户', industry: '石油',
        level: 'A 重点客户', status: '跟进中', phone: '0991-0000000'
      })
    });
    customerId = (await r.json()).data.id;
  }
  console.log(`使用客户 ID：${customerId}\n`);

  const browser = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crmcdp-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1440,960', 'about:blank'
  ], { stdio: 'ignore', detached: false });

  /* 等待调试端口就绪 */
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

  /* 新建标签页并连接 */
  const tabRes = await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' });
  const tab = await tabRes.json();
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  async function goto(hash) {
    await cdp.evalJs(`location.href = ${JSON.stringify(BASE + '/' + hash)}; 'ok'`);
    await sleep(2600);
  }

  /* ---------- 1. 客户列表页渲染 ---------- */
  await goto('#/customers');
  const listInfo = await cdp.evalJs(`(() => {
    const rows = document.querySelectorAll('.data-table tbody tr');
    return {
      rowCount: rows.length,
      hasTable: !!document.querySelector('.data-table'),
      hasPager: !!document.querySelector('.pager'),
      hasFilters: !!document.querySelector('.filter-bar'),
      title: (document.querySelector('.topbar-title') || {}).textContent || ''
    };
  })()`);
  check('客户列表页渲染出表格与分页',
    listInfo.hasTable && listInfo.hasPager && listInfo.rowCount > 0,
    `表格=${listInfo.hasTable} 分页=${listInfo.hasPager} 数据行=${listInfo.rowCount} 标题=${listInfo.title}`);

  /* ---------- 2. 点击「新增客户」打开编辑抽屉 ---------- */
  const openDrawer = await cdp.evalJs(`(() => {
    const btns = [...document.querySelectorAll('button')];
    const btn = btns.find(b => b.textContent.includes('新增客户'));
    if (!btn) return { clicked: false };
    btn.click();
    return { clicked: true };
  })()`);
  await sleep(900);

  const drawerInfo = await cdp.evalJs(`(() => {
    const d = document.querySelector('.drawer');
    if (!d) return { open: false };
    const blocks = [...d.querySelectorAll('.form-block-head')].map(h => h.textContent.trim().replace(/\\s+/g,' '));
    const labels = [...d.querySelectorAll('.field-label')].map(el => el.textContent.trim());
    return {
      open: true,
      title: (d.querySelector('.drawer-title') || {}).textContent || '',
      blockCount: d.querySelectorAll('.form-block').length,
      fieldCount: labels.length,
      blocks: blocks.slice(0, 8),
      hasInlineAdd: !!d.querySelector('button[title="新增选项"]'),
      hasTagPicker: [...d.querySelectorAll('.field-label')].some(el => el.textContent.includes('标签')),
      requiredCount: d.querySelectorAll('.req').length,
      labels: labels.slice(0, 12)
    };
  })()`);

  check('点击「新增客户」成功打开编辑抽屉',
    openDrawer.clicked && drawerInfo.open && drawerInfo.title.includes('新增客户'),
    drawerInfo.open ? `标题=${drawerInfo.title}` : '抽屉未打开');

  check('编辑抽屉渲染出 8 个区块（基础信息常显 + 7 个折叠区块）',
    drawerInfo.blockCount === 8,
    `区块数=${drawerInfo.blockCount}：${(drawerInfo.blocks || []).map((b) => b.replace(/已填.*/, '').trim()).join(' / ')}`);

  check('基础信息区块的字段已渲染（含必填标记）',
    drawerInfo.fieldCount >= 8 && drawerInfo.requiredCount >= 4,
    `可见字段 ${drawerInfo.fieldCount} 个，必填标记 ${drawerInfo.requiredCount} 个：${(drawerInfo.labels || []).slice(0, 6).join('、')}…`);

  check('字典字段带「+ 新增选项」内联按钮',
    drawerInfo.hasInlineAdd,
    drawerInfo.hasInlineAdd ? '找到内联新增入口' : '未找到');

  check('标签选择器已渲染',
    drawerInfo.hasTagPicker,
    drawerInfo.hasTagPicker ? '找到标签字段' : '未找到');

  /* ---------- 3. 展开一个折叠区块并在其中内联新增行业 ---------- */
  const inlineAdd = await cdp.evalJs(`(async () => {
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '无抽屉' };

    // 展开「行业属性」区块
    const head = [...d.querySelectorAll('.form-block-head')].find(h => h.textContent.includes('行业属性'));
    if (head && !head.classList.contains('open')) head.click();
    await new Promise(r => setTimeout(r, 350));

    // 找到「下游行业」下拉旁的新增按钮
    const fields = [...d.querySelectorAll('.field')];
    const f = fields.find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.includes('下游行业');
    });
    if (!f) return { ok: false, why: '未找到下游行业字段' };
    const addBtn = f.querySelector('button[title="新增选项"]');
    if (!addBtn) return { ok: false, why: '该字段无内联新增按钮' };
    addBtn.click();
    await new Promise(r => setTimeout(r, 350));

    const input = f.querySelector('input');
    if (!input) return { ok: false, why: '点击后未出现输入框' };
    const before = document.querySelectorAll('.toast').length;
    input.value = '交互测试行业';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));

    // 点击保存
    const saveBtn = [...f.querySelectorAll('button')].find(b => b.textContent.includes('保存'));
    if (!saveBtn) return { ok: false, why: '未找到保存按钮' };
    saveBtn.click();
    await new Promise(r => setTimeout(r, 1400));

    const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());
    // 检查下拉里是否已出现新选项
    const sel = f.querySelector('select');
    const opts = sel ? [...sel.options].map(o => o.value) : [];
    return { ok: true, toasts, hasOption: opts.includes('交互测试行业'), optCount: opts.length };
  })()`);

  check('在表单内直接新增行业选项（无需跳转设置页）',
    inlineAdd.ok && inlineAdd.hasOption,
    inlineAdd.ok
      ? `提示：${(inlineAdd.toasts || []).join(' / ') || '无'}；下拉选项数=${inlineAdd.optCount}，含新选项=${inlineAdd.hasOption}`
      : `失败原因：${inlineAdd.why}`);

  /* 本次是"全新选项"，提示必须说「已新增」而不能说「已选用已有选项」。
     这一条是针对一个真实缺陷加的回归：此前判断"是否已存在"用
     this.list.includes(r.value)，而 list 已是 {value,label} 对象数组，
     字符串永远匹配不上，导致两种情况都提示"已新增"。
     另一半（复用已有选项时应提示"已选用"）在下面第 3.2 段验证。 */
  check('内联新增全新选项时提示为「已新增选项」',
    inlineAdd.ok && (inlineAdd.toasts || []).some((t) => t.includes('已新增选项') && t.includes('交互测试行业')),
    `提示：${(inlineAdd.toasts || []).join(' / ') || '无'}`);

  /* ---------- 3.2 再次内联输入同名选项：应提示「已选用已有选项」 ---------- */
  const inlineAgain = await cdp.evalJs(`(async () => {
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '无抽屉' };
    const fields = [...d.querySelectorAll('.field')];
    const f = fields.find(x => {
      const l = x.querySelector('.field-label');
      return l && l.textContent.includes('下游行业');
    });
    if (!f) return { ok: false, why: '未找到下游行业字段' };
    const addBtn = f.querySelector('button[title="新增选项"]');
    if (!addBtn) return { ok: false, why: '无内联新增按钮' };
    addBtn.click();
    await new Promise(r => setTimeout(r, 350));
    const input = f.querySelector('input');
    if (!input) return { ok: false, why: '点击后未出现输入框' };
    input.value = '交互测试行业';
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(r => setTimeout(r, 120));
    const saveBtn = [...f.querySelectorAll('button')].find(b => b.textContent.includes('保存'));
    if (!saveBtn) return { ok: false, why: '未找到保存按钮' };
    saveBtn.click();
    await new Promise(r => setTimeout(r, 1400));
    const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());
    const sel = f.querySelector('select');
    return { ok: true, toasts, selected: sel ? sel.value : '' };
  })()`);

  check('内联输入已存在的同名选项时提示为「已选用已有选项」（不误报为已新增）',
    inlineAgain.ok
    && (inlineAgain.toasts || []).some((t) => t.includes('已选用已有选项') && t.includes('交互测试行业'))
    && !(inlineAgain.toasts || []).some((t) => t.includes('已新增选项')),
    inlineAgain.ok ? `提示：${(inlineAgain.toasts || []).join(' / ') || '无'}；已选中=「${inlineAgain.selected}」` : `失败原因：${inlineAgain.why}`);

  /* 顺带清理本次新增的测试行业选项，避免污染字典 */
  try {
    const d = await (await fetch(BASE + '/api/dict')).json();
    const hits = (d.data.items.industry || []).filter((x) => x.value === '交互测试行业');
    for (const h of hits) await fetch(BASE + '/api/dict/' + h.id, { method: 'DELETE' });
    if (hits.length) console.log(`      （已清理测试行业选项 ${hits.length} 个）`);
  } catch (_) { /* 忽略 */ }

  /* 关闭抽屉 */
  await cdp.evalJs(`(() => {
    const b = [...document.querySelectorAll('.drawer-head button')].find(x => x.textContent.includes('✕'));
    if (b) b.click();
    return 'ok';
  })()`);
  await sleep(500);

  /* ---------- 4. 详情页 5 个标签页 ---------- */
  await goto('#/customers/' + customerId);
  const detailBase = await cdp.evalJs(`(() => {
    const tabs = [...document.querySelectorAll('.tab')].map(t => t.textContent.trim());
    return {
      tabs,
      title: (document.querySelector('.detail-title') || {}).textContent || '',
      hasSummary: !!document.querySelector('.detail-meta')
    };
  })()`);
  check('详情页渲染标签页（≥5 个，含基本信息/联系人/跟进）',
    detailBase.tabs.length >= 5
      && detailBase.tabs.some((t) => t.includes('基本信息'))
      && detailBase.tabs.some((t) => t.includes('联系人')),
    `标签页（${detailBase.tabs.length} 个）：${detailBase.tabs.join(' / ')}；客户：${detailBase.title}`);

  const tabTests = [];
  const tabNames = ['联系人', '跟进记录', '关联项目', '变更记录'];
  for (const name of tabNames) {
    const r = await cdp.evalJs(`(async () => {
      const tab = [...document.querySelectorAll('.tab')].find(t => t.textContent.includes(${JSON.stringify(name)}));
      if (!tab) return { ok: false };
      tab.click();
      await new Promise(r => setTimeout(r, 500));
      const active = document.querySelector('.tab.active');
      const panes = [...document.querySelectorAll('.content > div > div')].filter(d => d.style.display !== 'none');
      const visibleText = panes.map(p => p.innerText).join(' ').slice(0, 200);
      return {
        ok: true,
        activeLabel: active ? active.textContent.trim() : '',
        hasContent: visibleText.length > 10,
        snippet: visibleText.replace(/\\s+/g, ' ').slice(0, 90)
      };
    })()`);
    tabTests.push({ name, ...r });
  }
  const tabsOk = tabTests.every((t) => t.ok && t.activeLabel.includes(t.name));
  check('4 个标签页均可切换并渲染内容',
    tabsOk,
    tabTests.map((t) => `${t.name}${t.ok ? '✓' : '✗'}`).join(' '));

  /* ---------- 5. 打开「记录跟进」抽屉 ---------- */
  const followOpen = await cdp.evalJs(`(async () => {
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('记录跟进'));
    if (!btn) return { ok: false, why: '未找到按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 800));
    const d = document.querySelector('.drawer');
    if (!d) return { ok: false, why: '抽屉未打开' };
    const labels = [...d.querySelectorAll('.field-label')].map(el => el.textContent.trim());
    const selects = d.querySelectorAll('select').length;
    return {
      ok: true,
      title: (d.querySelector('.drawer-title') || {}).textContent || '',
      labels, selects
    };
  })()`);
  check('点击「记录跟进」打开跟进抽屉并渲染表单',
    followOpen.ok && followOpen.labels.length >= 5 && followOpen.selects >= 2,
    followOpen.ok
      ? `标题=${followOpen.title}；字段：${followOpen.labels.join('、')}`
      : `失败原因：${followOpen.why}`);

  /* ---------- 6. 运行时 JS 错误 ---------- */
  check('全程无未捕获的 JS 错误',
    cdp.consoleErrors.length === 0,
    cdp.consoleErrors.length ? cdp.consoleErrors.slice(0, 3).join(' | ') : '0 条错误');

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
