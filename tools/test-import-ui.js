/**
 * 批量导入界面测试（真实浏览器 + 真实 xlsx 文件）
 *
 * 覆盖：
 *   - 客户列表页有「批量导入」入口，点开是导入抽屉
 *   - 抽屉第 1 步可下载模板（真实触发下载并校验文件内容）
 *   - 把真实 xlsx 文件「拖」进抽屉 → 解析 → 预览 → 导入 → 结果
 *   - 功能设置 → 导入导出面板在重构后仍可用（模板下载按钮点了不报错）
 *
 * 用法：先启动服务，再 node tools/test-import-ui.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error(method + ' 超时')); } }, 60000);
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
  console.log('=== 批量导入界面测试 ===\n');

  /* 造一份填好的 xlsx（与模板同构） */
  const tplRes = await (await fetch(BASE + '/api/data/template?entity=customer')).json();
  const tpl = tplRes.data;
  const header = tpl.fields.map((f) => (f.required ? f.label + ' *' : f.label));
  const rows = [
    { name: `【界面导入${tag}】一`, short_name: `界一${tag}`, type: '终端用户', industry: '石油', city: '乌鲁木齐市', district: '天山区', address: '天山区某路 1 号' },
    { name: `【界面导入${tag}】二`, short_name: `界二${tag}`, type: '设计院', industry: '化工', city: '克拉玛依市', district: '独山子区' }
  ];
  const aoa = [header].concat(rows.map((r) => tpl.fields.map((f) => (r[f.key] === undefined ? '' : r[f.key]))));
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '客户导入模板');
  const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const xlsxB64 = Buffer.from(xlsxBuf).toString('base64');
  console.log(`已生成测试文件：${rows.length} 行，${Math.round(xlsxBuf.length / 1024)} KB\n`);

  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'impui-'));
  const PORT = 9290;
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1600,1000', 'about:blank'],
  { stdio: 'ignore' });

  try {
    for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
    const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: os.tmpdir() }).catch(() => {});

    /* ---------- 1. 入口 ---------- */
    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/customers')}; 'ok'`);
    await sleep(3600);

    const entry = await cdp.js(`(() => {
      const btns = [...document.querySelectorAll('button')].map(b => b.textContent.trim());
      return { hasImport: btns.some(t => t.includes('批量导入')), hasTemplate: btns.some(t => t.includes('下载模板')) };
    })()`);
    check('客户列表页有「批量导入」入口', entry.hasImport, `按钮：${entry.hasImport ? '存在' : '缺失'}`);

    /* ---------- 2. 打开抽屉 → 第 1 步 ---------- */
    const step1 = await cdp.js(`(async () => {
      const b = [...document.querySelectorAll('button')].find(x => x.textContent.includes('批量导入'));
      if (!b) return { err: '未找到按钮' };
      b.click();
      await new Promise(r => setTimeout(r, 1200));
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return { err: '抽屉未打开' };
      const text = d.innerText;
      return {
        title: (d.querySelector('.drawer-title') || {}).textContent || '',
        hasTplBtn: [...d.querySelectorAll('button')].some(x => x.textContent.includes('下载导入模板')),
        hasDropZone: !!d.querySelector('.drop-zone'),
        mentionsNotes: text.includes('填写说明') && text.includes('可选值参考')
      };
    })()`);
    check('导入抽屉第 1 步：有模板下载与拖放区',
      !step1.err && step1.hasTplBtn && step1.hasDropZone && step1.mentionsNotes,
      step1.err ? step1.err : `标题「${step1.title}」，模板按钮=${step1.hasTplBtn}，拖放区=${step1.hasDropZone}，提示含说明页=${step1.mentionsNotes}`);

    /* ---------- 3. 真实拖入 xlsx → 解析预览 ---------- */
    const drop = await cdp.js(`(async () => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      const zone = d.querySelector('.drop-zone');
      if (!zone) return { err: '未找到拖放区' };

      /* 用真实字节构造 File，模拟用户拖入文件 */
      const b64 = ${JSON.stringify(xlsxB64)};
      const bin = atob(b64);
      const arr = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i);
      const file = new File([arr], '客户导入.xlsx',
        { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
      const dt = new DataTransfer();
      dt.items.add(file);

      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      await new Promise(r => setTimeout(r, 3000));

      const dd = [...document.querySelectorAll('.drawer')].pop();
      const text = dd.innerText;
      const stats = [...dd.querySelectorAll('.stat')].map(s => ({
        n: (s.querySelector('.n') || {}).textContent,
        l: (s.querySelector('.l') || {}).textContent
      }));
      return {
        stats,
        step2: text.includes('校验预览'),
        hasModeSelect: !!dd.querySelector('select'),
        hasImportBtn: [...dd.querySelectorAll('button')].some(x => x.textContent.includes('开始导入')),
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
      };
    })()`);
    check('拖入真实 xlsx 后进入预览步骤并显示统计',
      !drop.err && drop.step2 && drop.stats.length >= 3,
      drop.err ? drop.err : `统计：${drop.stats.map((s) => s.l + '=' + s.n).join('，')}；提示：${(drop.toasts || []).join(' / ')}`);
    check('预览步骤有「遇到同名客户」处理选项与开始导入按钮',
      !drop.err && drop.hasModeSelect && drop.hasImportBtn,
      `下拉=${drop.hasModeSelect}，开始导入按钮=${drop.hasImportBtn}`);

    /* ---------- 4. 执行导入 ---------- */
    const done = await cdp.js(`(async () => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      const b = [...d.querySelectorAll('.drawer-foot button')].find(x => x.textContent.includes('开始导入'));
      if (!b) return { err: '未找到开始导入按钮' };
      b.click();
      await new Promise(r => setTimeout(r, 4000));
      const dd = [...document.querySelectorAll('.drawer')].pop();
      const text = dd.innerText;
      const stats = [...dd.querySelectorAll('.stat')].map(s => ({
        n: (s.querySelector('.n') || {}).textContent,
        l: (s.querySelector('.l') || {}).textContent
      }));
      return {
        step3: text.includes('完成'),
        stats,
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
      };
    })()`);
    check('导入执行完成并显示结果统计',
      !done.err && done.step3,
      done.err ? done.err : `统计：${done.stats.map((s) => s.l + '=' + s.n).join('，')}；提示：${(done.toasts || []).join(' / ')}`);

    const row1 = db.prepare('SELECT id, name, city, region_code, address FROM customers WHERE name = ?')
      .get(`【界面导入${tag}】一`);
    const row2 = db.prepare('SELECT id, name, city, region_code FROM customers WHERE name = ?')
      .get(`【界面导入${tag}】二`);
    check('界面导入的客户已落库并自动归属地州',
      !!row1 && !!row2 && row1.region_code === '650100' && row2.region_code === '650200',
      row1 && row2
        ? `一：${row1.region_code}；二：${row2.region_code}`
        : '未找到导入的客户');

    /* ---------- 5. 管理页（重构后）仍可用 ---------- */
    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/settings')}; 'ok'`);
    await sleep(3600);
    const settings = await cdp.js(`(async () => {
      const t = [...document.querySelectorAll('.settings-tabs .tab')].find(x => x.textContent.includes('导入导出'));
      if (!t) return { err: '未找到导入导出标签页' };
      t.click();
      await new Promise(r => setTimeout(r, 1800));
      const c = document.querySelector('.content');
      const btns = [...c.querySelectorAll('button')].map(b => b.textContent.trim());
      return {
        /* 面板里的按钮文案是「下载客户导入模板」（entity 不同会变），按关键词匹配 */
        hasTpl: btns.some(x => /下载.*导入模板/.test(x)),
        hasExport: btns.some(x => x.includes('导出')),
        btns
      };
    })()`);
    check('功能设置 → 导入导出面板重构后仍可用',
      !settings.err && settings.hasTpl && settings.hasExport,
      settings.err ? settings.err
        : `模板按钮=${settings.hasTpl}，导出按钮=${settings.hasExport}；按钮：${(settings.btns || []).slice(0, 8).join(' / ')}`);

    check('页面无 JS 报错', cdp.errors.length === 0,
      cdp.errors.length ? cdp.errors.slice(0, 2).join(' | ') : '0 条错误');

    cdp.ws.close();
  } finally {
    for (const nm of [`【界面导入${tag}】一`, `【界面导入${tag}】二`]) {
      const r = db.prepare('SELECT id FROM customers WHERE name = ?').get(nm);
      if (r) {
        for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
          db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(r.id);
        }
        db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?").run(r.id);
        db.prepare('DELETE FROM customers WHERE id = ?').run(r.id);
      }
    }
    db.prepare('DELETE FROM customers WHERE name LIKE ?').run(`【界面导入${tag}】%`);
    db.prepare("DELETE FROM activity_logs WHERE entity_type = 'import' AND summary LIKE ?").run(`%${tag}%`);
    const left = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?').get(`【界面导入${tag}】%`).n;
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
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'import-ui-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
    'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
