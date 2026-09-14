/**
 * 跟进提醒（软件内）界面测试
 *
 * 覆盖：
 *   1. 顶栏有提醒铃铛；无数据时不显示角标
 *   2. 造出逾期/今天/临近三种客户后，角标数量正确
 *   3. 面板打开后按紧急度分组展示（逾期含客户名、天数文案、联系人）
 *   4. 点「稍后」当日不再显示该客户（localStorage 生效）
 *   5. 点客户行可跳转到客户详情
 *   6. 点「记跟进」能打开跟进抽屉
 *   7. 已成交客户不出现在提醒里
 *   8. 页面无 JS 报错
 *
 * 用法：先启动服务，再 node tools/test-remind-ui.js
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

const tag = Date.now().toString().slice(-6);
const ymd = (d) => {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const offset = (n) => { const d = new Date(); d.setDate(d.getDate() + n); return ymd(d); };

(async () => {
  console.log('=== 跟进提醒界面测试 ===\n');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const created = [];

  /* ---------- 造数据：逾期 / 今天 / 临近 / 已成交 ---------- */
  const ins = db.prepare(`INSERT INTO customers
    (name, short_name, type, industry, level, status, owner, city, next_follow_at, follow_count, created_at, updated_at)
    VALUES (?, ?, '终端用户', '石油', ?, ?, '我', '乌鲁木齐市', ?, ?, ?, ?)`);
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  const mk = (nm, short, level, status, days, followCount) => {
    const r = ins.run(`【提醒测试${tag}】${nm}`, short, level, status, `${offset(days)} 10:00:00`, followCount, ts, ts);
    created.push(Number(r.lastInsertRowid));
    return Number(r.lastInsertRowid);
  };
  const overdueId = mk('逾期客户', `逾期${tag}`, 'A 重点客户', '跟进中', -4, 3);
  const todayId = mk('今天客户', `今天${tag}`, 'B 一般客户', '跟进中', 0, 1);
  const soonId = mk('临近客户', `临近${tag}`, '', '潜在', 2, 0);
  const closedId = mk('已成交客户', `已成交${tag}`, '', '已成交', -1, 5);
  const cid = db.prepare('SELECT id FROM customers WHERE short_name = ?').get(`逾期${tag}`).id;
  db.prepare(`INSERT INTO contacts (customer_id, name, mobile, is_primary, created_at, updated_at)
              VALUES (?, '王经理', '13900001111', 1, ?, ?)`).run(cid, ts, ts);

  console.log(`已造 4 位客户：逾期/今天/临近/已成交（tag ${tag}）\n`);

  /* 接口层先确认判定正确 */
  const dueRes = await (await fetch(`${BASE}/api/reminders/due`)).json();
  const mine = dueRes.data.items.filter((i) => i.short_name.includes(tag));
  const levels = mine.map((i) => `${i.short_name}=${i.level}`).join('，');
  check('接口：三种级别判定正确，已成交被排除',
    mine.length === 3
    && mine.some((i) => i.customer_id === overdueId && i.level === 'overdue')
    && mine.some((i) => i.customer_id === todayId && i.level === 'today')
    && mine.some((i) => i.customer_id === soonId && i.level === 'soon')
    && !mine.some((i) => i.customer_id === closedId),
    levels);

  const ov = mine.find((i) => i.customer_id === overdueId);
  check('接口：逾期天数与文案正确',
    ov && ov.days_left === -4 && ov.days_text === '逾期 4 天',
    ov ? `days_left=${ov.days_left} text=「${ov.days_text}」` : '未找到');
  check('接口：带出主联系人',
    ov && ov.contact === '王经理' && ov.mobile === '13900001111',
    ov ? `${ov.contact} ${ov.mobile}` : '未找到');

  /* ---------- 浏览器 ---------- */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'remind-'));
  const PORT = 9350;
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1500,950', 'about:blank'],
  { stdio: 'ignore' });

  try {
    for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
    const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');

    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/home')}; 'ok'`);
    await sleep(4500);

    /* 1. 铃铛存在 */
    const bell = await cdp.js(`(() => {
      const b = document.querySelector('.remind-bell');
      return { exists: !!b, badge: b ? (b.querySelector('.remind-badge') || {}).textContent : null };
    })()`);
    check('顶栏有提醒铃铛', bell.exists === true, bell.exists ? '存在' : '未找到');
    check('角标显示待提醒总数（含本次造的 3 位）',
      bell.badge && Number(bell.badge) >= 3,
      `角标 = ${bell.badge}`);

    /* 2. 打开面板 */
    const panel = await cdp.js(`(async () => {
      /* 若已自动弹出则直接复用 */
      let p = document.querySelector('.remind-panel');
      if (!p) {
        document.querySelector('.remind-bell').click();
        await new Promise(r => setTimeout(r, 800));
        p = document.querySelector('.remind-panel');
      }
      if (!p) return { err: '面板未打开' };
      const items = [...p.querySelectorAll('.remind-item')].map(el => ({
        cls: el.className,
        name: (el.querySelector('.ri-name') || {}).textContent.trim(),
        meta: (el.querySelector('.ri-meta') || {}).textContent.replace(/\\s+/g, ' ').trim(),
        ops: [...el.querySelectorAll('.ri-ops button')].map(b => b.textContent.trim())
      }));
      return {
        title: (p.querySelector('.remind-title') || {}).textContent,
        sub: (p.querySelector('.remind-sub') || {}).textContent.replace(/\\s+/g, ' ').trim(),
        items,
        soonToggle: !!p.querySelector('.remind-soon-toggle')
      };
    })()`);

    check('提醒面板可打开', !panel.err, panel.err || `标题「${panel.title}」，摘要「${panel.sub}」`);

    if (!panel.err) {
      const overdueItem = panel.items.find((i) => i.name.includes(`逾期${tag}`));
      const todayItem = panel.items.find((i) => i.name.includes(`今天${tag}`));
      check('面板按级别分组展示（逾期项带红色左边条样式）',
        !!overdueItem && /lv-overdue/.test(overdueItem.cls),
        overdueItem ? `class=${overdueItem.cls}` : '未找到逾期项');
      check('逾期项显示天数与联系人',
        overdueItem && /逾期 4 天/.test(overdueItem.meta) && /王经理/.test(overdueItem.meta),
        overdueItem ? overdueItem.meta : '-');
      check('今天项以橙色样式展示',
        !!todayItem && /lv-today/.test(todayItem.cls),
        todayItem ? todayItem.cls : '未找到今天项');
      check('临近项默认折叠（有展开入口）',
        panel.soonToggle === true && !panel.items.some((i) => i.name.includes(`临近${tag}`)),
        `展开入口=${panel.soonToggle}，临近项是否已直接展示=${panel.items.some((i) => i.name.includes(`临近${tag}`))}`);
      check('提醒项都带「记跟进」与「稍后」操作',
        panel.items.length > 0 && panel.items.every((i) => i.ops.includes('记跟进') && i.ops.includes('稍后')),
        panel.items[0] ? panel.items[0].ops.join('/') : '-');
      check('已成交客户不在面板中',
        !panel.items.some((i) => i.name.includes(`已成交${tag}`)),
        '已过滤');

      /* 3. 展开临近项 */
      const expanded = await cdp.js(`(async () => {
        const b = document.querySelector('.remind-soon-toggle button');
        if (!b) return { err: '无展开按钮' };
        b.click();
        await new Promise(r => setTimeout(r, 500));
        const names = [...document.querySelectorAll('.remind-item .ri-name')].map(e => e.textContent.trim());
        return { names };
      })()`);
      check('展开后可见临近客户',
        !expanded.err && expanded.names.some((n) => n.includes(`临近${tag}`)),
        expanded.err || `共 ${expanded.names.length} 项`);

      /* 4. 「稍后」当日不再显示 */
      const snooze = await cdp.js(`(async () => {
        const items = [...document.querySelectorAll('.remind-item')];
        const target = items.find(el => el.querySelector('.ri-name').textContent.includes('逾期${tag}'));
        if (!target) return { err: '未找到逾期项' };
        const btn = [...target.querySelectorAll('.ri-ops button')].find(b => b.textContent.trim() === '稍后');
        btn.click();
        await new Promise(r => setTimeout(r, 700));
        const names = [...document.querySelectorAll('.remind-item .ri-name')].map(e => e.textContent.trim());
        const badge = (document.querySelector('.remind-badge') || {}).textContent;
        return { names, badge, stored: localStorage.getItem('crm_remind_snooze') };
      })()`);
      check('点「稍后」后该客户从面板消失',
        !snooze.err && !snooze.names.some((n) => n.includes(`逾期${tag}`)),
        snooze.err || `剩余 ${snooze.names.length} 项，角标 ${snooze.badge}`);
      check('「稍后」记录写入 localStorage（按天失效）',
        !!snooze.stored && snooze.stored.includes(String(overdueId)),
        snooze.stored ? snooze.stored.slice(0, 90) : '未写入');

      /* 5. 点「记跟进」打开跟进抽屉 */
      const follow = await cdp.js(`(async () => {
        const items = [...document.querySelectorAll('.remind-item')];
        const target = items.find(el => el.querySelector('.ri-name').textContent.includes('今天${tag}'));
        if (!target) return { err: '未找到今天项' };
        const btn = [...target.querySelectorAll('.ri-ops button')].find(b => b.textContent.trim() === '记跟进');
        btn.click();
        await new Promise(r => setTimeout(r, 1500));
        const d = [...document.querySelectorAll('.drawer')].pop();
        return { opened: !!d, sub: d ? ((d.querySelector('.drawer-sub') || {}).textContent || '') : '' };
      })()`);
      check('点「记跟进」打开跟进抽屉并带出客户',
        !follow.err && follow.opened && follow.sub.includes(`今天${tag}`),
        follow.err || `抽屉副标题「${follow.sub.trim()}」`);

      /* 关掉抽屉 */
      await cdp.js(`(() => { const d = [...document.querySelectorAll('.drawer')].pop(); if (d) { const x = [...d.querySelectorAll('.drawer-head button')].pop(); x && x.click(); } return 'ok'; })()`);
      await sleep(800);

      /* 6. 点客户行跳转详情 */
      const nav = await cdp.js(`(async () => {
        const b = document.querySelector('.remind-bell');
        if (b && !document.querySelector('.remind-panel')) { b.click(); await new Promise(r => setTimeout(r, 700)); }
        const items = [...document.querySelectorAll('.remind-item')];
        const target = items.find(el => el.querySelector('.ri-name').textContent.includes('今天${tag}'));
        if (!target) return { err: '未找到今天项' };
        target.querySelector('.ri-main').click();
        await new Promise(r => setTimeout(r, 2600));
        return { hash: location.hash, hasDetail: !!document.querySelector('.content') };
      })()`);
      check('点客户行跳转到该客户详情',
        !nav.err && nav.hash === `#/customers/${todayId}`,
        nav.err || `地址 = ${nav.hash}`);
    }

    check('页面无 JS 报错', cdp.errors.length === 0,
      cdp.errors.length ? cdp.errors.slice(0, 2).join(' | ') : '0 条错误');

    cdp.ws.close();
  } finally {
    child.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

    /* 清理 */
    for (const id of created) {
      for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
        db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(id);
      }
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?").run(id);
      db.prepare('DELETE FROM customers WHERE id = ?').run(id);
    }
    db.prepare('DELETE FROM customers WHERE name LIKE ?').run(`【提醒测试${tag}】%`);
    const left = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?').get(`%${tag}%`).n;
    check('测试数据已清理', left === 0, `残留 ${left} 条`);
    db.close();
  }

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'remind-ui-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
