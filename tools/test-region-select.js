/**
 * 验证「归属地州」下拉修复：
 * 下拉显示地州名，但提交的必须是地州编码（地图按编码聚合）。
 * 这里直接在真实浏览器里操作下拉，模拟用户选择，再核对落库的值。
 *
 * 用法：先启动服务，再 node tools/test-region-select.js
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
}

(async () => {
  console.log('=== 归属地州下拉（名称显示 / 编码提交）验证 ===\n');

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'regsel-'));
  const PORT = 9270;
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1600,1000', 'about:blank'],
  { stdio: 'ignore' });
  for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');

  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const tag = Date.now().toString().slice(-6);
  let createdId = null;

  try {
    /* 打开新增客户抽屉 */
    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/customers')}; 'ok'`);
    await sleep(3600);

    const probe = await cdp.js(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增客户'));
      if (!btn) return { err: '未找到新增客户按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 1800));
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return { err: '抽屉未打开' };

      const field = (label) => [...d.querySelectorAll('.field')].find(x =>
        (x.querySelector('.field-label') || {}).textContent.startsWith(label));

      /* 归属地州下拉的选项文本与值 */
      const f = field('归属地州');
      if (!f) return { err: '未找到归属地州字段' };
      const sel = f.querySelector('select');
      if (!sel) return { err: '未找到下拉' };
      const opts = [...sel.options].map(o => ({ value: o.value, text: o.textContent.trim() }));

      /* 选择「克拉玛依市」 */
      const target = [...sel.options].find(o => o.textContent.trim() === '克拉玛依市');
      if (!target) return { err: '下拉里没有克拉玛依市', opts: opts.slice(0, 5) };
      const chosenValue = target.value;
      sel.value = chosenValue;
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 600));

      /* 填必填项 */
      const setText = (label, value) => {
        const fl = field(label);
        if (!fl) return false;
        const inp = fl.querySelector('input, select');
        inp.value = value;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      setText('客户全称', '【下拉验证${tag}】归属地州测试');
      setText('客户简称', '下拉验证${tag}');
      const typeField = field('客户主体类型');
      if (typeField) {
        const ts = typeField.querySelector('select');
        const to = [...ts.options].find(o => o.value === '终端用户');
        if (to) { ts.value = '终端用户'; ts.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      const indField = field('下游行业');
      if (indField) {
        const is = indField.querySelector('select');
        const io = [...is.options].find(o => o.value === '石油');
        if (io) { is.value = '石油'; is.dispatchEvent(new Event('change', { bubbles: true })); }
      }
      await new Promise(r => setTimeout(r, 500));

      const footSave = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
      footSave.click();
      await new Promise(r => setTimeout(r, 2400));

      return {
        optionSample: opts.slice(0, 3),
        chosenValue,
        chosenText: target.textContent.trim(),
        drawerGone: !document.querySelector('.drawer'),
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
      };
    })()`);

    if (probe.err) {
      check('打开新增客户抽屉并定位归属地州下拉', false, probe.err + (probe.opts ? ' 选项：' + JSON.stringify(probe.opts) : ''));
    } else {
      /* 排除空选项（"（按地址自动匹配）"），只看真正的地州项 */
      const realOpts = probe.optionSample.filter((o) => o.value !== '');
      check('打开新增客户抽屉并定位归属地州下拉', true,
        `选项样例：${realOpts.map((o) => `${o.text}→${o.value}`).join('，')}`);
      check('下拉显示地州名、值为地州编码',
        realOpts.length > 0 && realOpts.every((o) => /^\d{6}$/.test(o.value) && /[\u4e00-\u9fa5]/.test(o.text)),
        `选中「${probe.chosenText}」提交值 = ${probe.chosenValue}`);
      check('保存后表单关闭', probe.drawerGone === true, (probe.toasts || []).join(' / '));

      /* 核对落库的 region_code 是编码而不是名字 */
      const row = db.prepare('SELECT id, name, city, district, region_code, region_name FROM customers WHERE name LIKE ?')
        .get(`【下拉验证${tag}】%`);
      createdId = row ? row.id : null;
      check('落库的归属地州是编码（不是地州名）',
        !!row && /^\d{6}$/.test(row.region_code) && row.region_code === probe.chosenValue,
        row ? `region_code=[${row.region_code}] region_name=[${row.region_name}]` : '未找到该客户');

      /* 地图统计应包含它 */
      const dist = await (await fetch(BASE + '/api/map/distribution')).json();
      const klmy = dist.data.cities.find((c) => c.code === '650200');
      check('地图统计包含该客户所属地州',
        !!klmy && klmy.customer_count >= 1,
        `克拉玛依市 客户数 = ${klmy ? klmy.customer_count : '未找到'}`);

      /* 编辑态回显：应显示地州名而不是编码 */
      await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/customers/' + createdId)}; 'ok'`);
      await sleep(3600);
      const echo = await cdp.js(`(async () => {
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('编辑资料'));
        if (!btn) return { err: '未找到编辑资料按钮' };
        btn.click();
        await new Promise(r => setTimeout(r, 1800));
        const d = [...document.querySelectorAll('.drawer')].pop();
        const f = [...d.querySelectorAll('.field')].find(x =>
          (x.querySelector('.field-label') || {}).textContent.startsWith('归属地州'));
        if (!f) return { err: '未找到归属地州字段' };
        const sel = f.querySelector('select');
        return { value: sel.value, text: sel.options[sel.selectedIndex] ? sel.options[sel.selectedIndex].textContent.trim() : '' };
      })()`);
      check('编辑时下拉正确回显地州名（不是裸编码）',
        !echo.err && echo.text === probe.chosenText,
        echo.err ? echo.err : `回显「${echo.text}」（值 ${echo.value}）`);
    }

    check('页面无 JS 报错', cdp.errors.length === 0,
      cdp.errors.length ? cdp.errors.slice(0, 2).join(' | ') : '0 条错误');
  } finally {
    if (createdId) {
      db.prepare('DELETE FROM contacts WHERE customer_id = ?').run(createdId);
      db.prepare('DELETE FROM followups WHERE customer_id = ?').run(createdId);
      db.prepare('DELETE FROM customer_tags WHERE customer_id = ?').run(createdId);
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?").run(createdId);
      db.prepare('DELETE FROM customers WHERE id = ?').run(createdId);
    }
    const left = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?').get(`【下拉验证${tag}】%`).n;
    check('测试数据已清理', left === 0, `残留 ${left} 条`);
    db.close();
    cdp.ws.close();
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
    path.join(ROOT, '.fixtures', 'region-select-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
    'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
