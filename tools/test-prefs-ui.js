/**
 * 设置页「提醒与偏好」验证：新增的邮件配置区可用，且原有设置项未受影响。
 * 用法：先启动服务，再 node tools/test-prefs-ui.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn } = require('node:child_process');

const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
};

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

(async () => {
  console.log('=== 设置页「提醒与偏好」验证 ===\n');
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'prefs-'));
  const PORT = 9360;
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1500,1000', 'about:blank'],
  { stdio: 'ignore' });

  try {
    for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
    const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');

    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/settings')}; 'ok'`);
    await sleep(4600);

    const r = await cdp.js(`(async () => {
      const t = [...document.querySelectorAll('.settings-tabs .tab')].find(x => x.textContent.includes('提醒与偏好'));
      if (!t) return { err: '未找到「提醒与偏好」标签' };
      t.click();
      await new Promise(r => setTimeout(r, 2200));

      const c = document.querySelector('.content');
      const cards = [...c.querySelectorAll('.card')];
      const titles = cards.map(x => ((x.querySelector('.card-title') || {}).textContent || '').trim());
      const text = c.innerText;

      /* 原有设置项是否还在 */
      const hasFollow = text.includes('跟进提醒提前天数');
      const hasPayment = text.includes('回款提醒提前天数');
      const hasBirthday = text.includes('生日提醒');
      const hasPageSize = text.includes('列表每页条数');
      const hasCompany = text.includes('我方公司名称');

      /* 新增的邮件配置区 */
      const emailCard = cards.find(x => /邮件提醒/.test(((x.querySelector('.card-title') || {}).textContent || '')));
      const emailText = emailCard ? emailCard.innerText : '';
      const fields = emailCard ? [...emailCard.querySelectorAll('.field-label')].map(x => x.textContent.trim()) : [];
      const selects = emailCard ? [...emailCard.querySelectorAll('select')].map(s => ({
        value: s.value, options: [...s.options].map(o => o.textContent.trim())
      })) : [];
      const buttons = emailCard ? [...emailCard.querySelectorAll('button')].map(b => b.textContent.trim()) : [];

      return {
        titles, hasFollow, hasPayment, hasBirthday, hasPageSize, hasCompany,
        hasEmailCard: !!emailCard,
        emailTextPreview: emailText.slice(0, 220),
        fields, selects, buttons
      };
    })()`);

    check('「提醒与偏好」标签可打开且卡片齐全',
      !r.err && r.titles.length >= 3,
      r.err || `卡片：${r.titles.join(' / ')}`);

    check('原有设置项均保留（跟进/回款/生日/分页/公司名）',
      r.hasFollow && r.hasPayment && r.hasBirthday && r.hasPageSize && r.hasCompany,
      `跟进=${r.hasFollow} 回款=${r.hasPayment} 生日=${r.hasBirthday} 分页=${r.hasPageSize} 公司名=${r.hasCompany}`);

    check('新增「邮件提醒」配置卡片',
      r.hasEmailCard === true, r.hasEmailCard ? '存在' : '未找到');

    check('邮件配置区字段齐全（开关/时间/服务商/服务器/端口/账号/授权码/收件地址）',
      ['启用邮件提醒', '每天发送时间', '邮箱服务商', 'SMTP 服务器', '端口', '邮箱账号', '邮箱授权码', '收件地址']
        .every((f) => r.fields.some((x) => x.includes(f))),
      r.fields.join(' / '));

    check('服务商下拉包含国内常见邮箱',
      r.selects.length > 0 && r.selects[0].options.length >= 6
      && r.selects[0].options.some((o) => o.includes('QQ'))
      && r.selects[0].options.some((o) => o.includes('163')),
      r.selects.length ? r.selects[0].options.join('、') : '未找到下拉');

    check('有「测试发送」与「立即发送当日提醒」按钮',
      r.buttons.includes('测试发送') && r.buttons.includes('立即发送当日提醒'),
      r.buttons.join(' / '));

    check('提示了「关闭时不联网」与「只发给自己」',
      /关闭时不产生任何外部网络请求/.test(r.emailTextPreview) && /只会发给你自己/.test(r.emailTextPreview),
      '安全说明已展示');

    /* 保存邮件设置（不启用，仅验证接口连通） */
    const saveRes = await cdp.js(`(async () => {
      const c = document.querySelector('.content');
      const emailCard = [...c.querySelectorAll('.card')].find(x => /邮件提醒/.test(((x.querySelector('.card-title') || {}).textContent || '')));
      if (!emailCard) return { err: '未找到邮件卡片' };
      /* 改一下发送时间以产生"未保存"状态 */
      const timeInput = emailCard.querySelector('input[type="time"]');
      if (timeInput) {
        timeInput.value = '07:45';
        timeInput.dispatchEvent(new Event('input', { bubbles: true }));
      }
      await new Promise(r => setTimeout(r, 300));
      const btn = [...emailCard.querySelectorAll('button')].find(b => b.textContent.includes('保存邮件提醒设置'));
      if (!btn) return { err: '未找到保存按钮' };
      const disabledBefore = btn.disabled;
      btn.click();
      await new Promise(r => setTimeout(r, 2000));
      const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());
      return { disabledBefore, toasts };
    })()`);
    check('邮件设置可保存（改时间后按钮启用并保存成功）',
      !saveRes.err && saveRes.disabledBefore === false
      && saveRes.toasts.some((t) => /已保存/.test(t)),
      saveRes.err || `保存前按钮可用=${!saveRes.disabledBefore}；提示：${(saveRes.toasts || []).join(' / ')}`);

    /* 还原发送时间，避免留下测试痕迹 */
    const restore = await fetch(`${BASE}/api/reminders/settings`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ remind_email_time: '08:30' })
    });
    check('测试造成的设置改动已还原', restore.ok, `HTTP ${restore.status}`);

    check('页面无 JS 报错', cdp.errors.length === 0,
      cdp.errors.length ? cdp.errors.slice(0, 2).join(' | ') : '0 条错误');

    cdp.ws.close();
  } finally {
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
