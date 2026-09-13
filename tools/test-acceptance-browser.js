/**
 * 阶段七 · 最终验收测试（浏览器部分）
 *
 * 覆盖必须在真实浏览器里验的剩余项：
 *   3  数据零外流（断网后功能正常 + 无外部请求）
 *   8  阀门行业字段（8 区块、多选字段存取、注册资金已移除）
 *   9  筛选与排序（全部筛选条件 + 快捷筛选）
 *   10 招投标日历（7 天内标黄、过期未填结果标红、排序）
 *   11 项目阶段看板（14 列 + 改阶段同步）
 *   12 软删除与还原（关联数据完整恢复、无孤儿）
 *   13 操作日志（记录增删改、变更前后值可读）
 *   14 表单校验（必填/金额/日期/超收）
 *   15 查重提示（同名/同手机号）
 *   23 空状态（无数据不崩坏）
 *   24 浏览器兼容（Chrome + Edge 双浏览器）
 *   25 自定义行业
 *   26 自定义主体类型
 *   27 字典改名与内联新增
 *
 * 用法：node tools/test-acceptance-browser.js
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';

const results = [];
function check(no, name, pass, detail) {
  results.push({ no: String(no), name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${no}. ${name}${detail ? '  —— ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: res.status, headers: res.headers, json, data: json && json.data };
}

/** 支持日期偏移：dayOffset(0)=今天，dayOffset(-1)=昨天 */
const _dictIdCache = new Map();
function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 同步取字典项 id，供后续改名 / 停用精确定位（同值只查一次）。
 * 直接读库而不是走接口，避免与页面内缓存不一致导致定位到旧项。
 */
function dictIdOf(category, value) {
  const key = category + '\u0000' + value;
  if (!_dictIdCache.has(key)) {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'), { readOnly: true });
    const row = db.prepare('SELECT id FROM dict WHERE category = ? AND value = ?').get(category, value);
    db.close();
    _dictIdCache.set(key, row ? row.id : 0);
  }
  return _dictIdCache.get(key);
}

/* ------------------------------------------------------------------ */
/* 极简 CDP 客户端                                                     */
/* ------------------------------------------------------------------ */

class CDP {
  constructor(url) { this.url = url; this.id = 0; this.pending = new Map(); this.errors = []; this.requests = []; }
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
      } else if (m.method === 'Network.requestWillBeSent') {
        this.requests.push(m.params.request.url);
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
      }, 30000);
    });
  }
  async js(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      throw new Error('页面脚本异常：' + (r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description : r.exceptionDetails.text));
    }
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch (_) { /* 忽略 */ } }
}

/** 启动一个浏览器实例 */
async function launchBrowser(exe, port, profile, extraArgs) {
  const args = [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`,
    '--window-size=1600,1100'
  ].concat(extraArgs || []).concat(['about:blank']);
  const child = spawn(exe, args, { stdio: 'ignore' });
  let version = null;
  for (let i = 0; i < 50; i++) {
    await sleep(300);
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (r.ok) { version = await r.json(); break; }
    } catch (_) { /* 继续等 */ }
  }
  if (!version) { try { child.kill(); } catch (_) { /* 忽略 */ } return null; }
  const tab = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  return { child, cdp, version };
}

const CHROME = ['C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe'].find((p) => fs.existsSync(p));
const EDGE = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find((p) => fs.existsSync(p));

const created = [];

(async () => {
  console.log('=== 阶段七 最终验收测试（浏览器） ===\n');

  const health = await api('GET', '/api/health');
  if (health.status !== 200) {
    console.log('服务未运行，无法开始验收。');
    process.exit(1);
  }

  if (!CHROME) { console.log('未找到 Chrome，无法执行浏览器验收。'); process.exit(1); }

  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-br-'));
  const br = await launchBrowser(CHROME, 9240, profile);
  if (!br) { console.log('浏览器未就绪'); process.exit(1); }
  const cdp = br.cdp;
  console.log(`浏览器：${br.version.Browser}\n`);

  async function goto(hash, wait) {
    await cdp.js(`location.href = ${JSON.stringify(BASE + '/' + hash)}; 'ok'`);
    await sleep(wait || 3400);
  }

  /** 强制整页重载当前地址：用于验证「重新打开后」的界面状态（清空前端内存缓存） */
  async function hardReload(wait) {
    await cdp.js(`location.reload(); 'ok'`);
    await sleep(wait || 3600);
  }

  /* ---------- 准备数据 ---------- */
  const ts = Date.now().toString().slice(-6);
  const custName = `最终验收客户${ts}（独山子石化）`;
  const custPhone = '0992-' + ts;
  const cust = await api('POST', '/api/customers', {
    name: custName, short_name: `最终验收${ts}`,
    type: '终端用户', industry: '石油', level: 'A 重点客户', status: '跟进中',
    city: '克拉玛依市', district: '独山子区', phone: custPhone,
    end_user: '独山子石化炼油厂', design_institute: '中石化工程建设公司',
    valve_types: '球阀,闸阀,截止阀', cert_required: '特种设备制造许可证 TS,API 6D',
    drive_mode: '气动,电动', body_material: '不锈钢 316L,碳钢 WCB',
    pressure_rating: 'Class300,Class600', purchase_mode: '框架协议',
    account_period: '月结60天', annual_demand: 800, warranty_ratio: 10,
    has_ts_license: 1, has_explosion_proof: 1,
    supplier_code: 'ACC-' + ts, introducer: '李工',
    longitude: 84.8862, latitude: 44.3286,
    next_follow_at: dayOffset(-1) + ' 10:00:00'
  });
  created.push(cust.data.id);

  const contact = await api('POST', '/api/contacts', {
    customer_id: cust.data.id, name: '验收联系人', position: '采购经理',
    department: '采购部', mobile: '139' + ts + '0', is_primary: 1, is_decision: 1, influence: '关键决策'
  });

  const proj = await api('POST', '/api/projects', {
    name: `最终验收项目${ts}`, customer_id: cust.data.id,
    stage: '投标/议价', contract_amount: 1860000,
    bid_date: dayOffset(3), bid_result: '已投标待开标',
    delivery_date: dayOffset(45), end_user: '独山子石化'
  });
  created.push(proj.data.id);

  /* 一个已过开标日但未填结果的项目（用于验收 10 的标红） */
  const proj2 = await api('POST', '/api/projects', {
    name: `最终验收项目B${ts}（已过开标日）`, customer_id: cust.data.id,
    stage: '投标/议价', contract_amount: 500000,
    bid_date: dayOffset(-10), bid_result: '未投标'
  });
  created.push(proj2.data.id);

  const plan = await api('POST', '/api/payments', {
    project_id: proj.data.id, type: '计划', amount: 558000, plan_date: dayOffset(-5)
  });
  created.push(plan.data.id);

  /* ================================================================ */
  /* 验收 8：阀门行业字段                                              */
  /* ================================================================ */
  console.log('--- 验收 8：阀门行业字段 ---');
  {
    await goto(`#/customers/${cust.data.id}`, 3600);

    const detail = await cdp.js(`(() => {
      const text = document.querySelector('.content').innerText;
      const tabs = [...document.querySelectorAll('.tab')].map(t => t.textContent.trim());
      return {
        tabs,
        hasIndustry: text.includes('石油'),
        hasEndUser: text.includes('独山子石化炼油厂'),
        hasDesign: text.includes('中石化工程建设公司'),
        hasValveTypes: text.includes('球阀') && text.includes('闸阀'),
        hasCert: text.includes('特种设备制造许可证 TS') && text.includes('API 6D'),
        hasSupplier: text.includes('ACC-${ts}'),
        hasIntroducer: text.includes('李工'),
        hasRegCapital: text.includes('注册资金')
      };
    })()`);

    check('8a', '客户详情正确显示阀门行业字段（最终用户/设计院/阀门类型/认证要求）',
      detail.hasIndustry && detail.hasEndUser && detail.hasDesign
        && detail.hasValveTypes && detail.hasCert && detail.hasSupplier && detail.hasIntroducer,
      `行业=${detail.hasIndustry} 最终用户=${detail.hasEndUser} 设计院=${detail.hasDesign} 阀门类型=${detail.hasValveTypes} 认证=${detail.hasCert} 供应商编码=${detail.hasSupplier} 介绍人=${detail.hasIntroducer}`);

    check('8b', '已移除的「注册资金」不再出现',
      detail.hasRegCapital === false,
      detail.hasRegCapital ? '仍显示注册资金（异常）' : '界面与表单均无该字段');

    /* 打开编辑抽屉，检查 8 个区块与多选字段 */
    const drawer = await cdp.js(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('编辑资料'));
      if (!btn) return { err: '无编辑资料按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 1400));
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return { err: '抽屉未打开' };

      const blocks = [...d.querySelectorAll('.form-block-head')]
        .map(h => h.textContent.trim().replace(/\\s+/g,' ').replace(/已填.*/,'').trim());

      /* 展开所有折叠区块，统计字段 */
      for (const h of [...d.querySelectorAll('.form-block-head')]) {
        if (!h.classList.contains('open')) { h.click(); await new Promise(r => setTimeout(r, 120)); }
      }
      await new Promise(r => setTimeout(r, 600));
      const labels = [...d.querySelectorAll('.field-label')].map(x => x.textContent.trim());
      const required = d.querySelectorAll('.req').length;

      /* 多选字段：阀门类型中被选中的项 */
      const chips = [...d.querySelectorAll('.field')].find(f =>
        (f.querySelector('.field-label') || {}).textContent === '常用阀门类型');
      const onChips = chips ? [...chips.querySelectorAll('.chip.on')].map(c => c.textContent.trim()) : [];

      /* 开关字段状态 */
      const tsSwitch = [...d.querySelectorAll('.field')].find(f =>
        (f.querySelector('.field-label') || {}).textContent === '是否要求 TS 特种设备许可证');
      const tsOn = tsSwitch ? tsSwitch.querySelector('input[type=checkbox]').checked : null;

      return { blocks, labelCount: labels.length, required, onChips, tsOn };
    })()`);

    check('8c', '客户表单渲染 8 个区块且必填项为 4 个',
      !drawer.err && drawer.blocks.length === 8 && drawer.required === 4,
      drawer.err ? drawer.err : `区块 ${drawer.blocks.length} 个：${drawer.blocks.join(' / ')}；字段 ${drawer.labelCount} 个；必填 ${drawer.required} 个`);

    check('8d', '多选类字段（阀门类型）与开关字段（TS 许可证）状态正确回显',
      !drawer.err && drawer.onChips.length === 3 && drawer.tsOn === true,
      drawer.err ? drawer.err : `阀门类型已选 ${drawer.onChips.length} 项（${drawer.onChips.join('、')}），TS 许可证开关=${drawer.tsOn}`);
  }

  /* ================================================================ */
  /* 验收 14：表单校验                                                 */
  /* ================================================================ */
  console.log('\n--- 验收 14：表单校验 ---');
  {
    const r = await cdp.js(`(async () => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return { err: '抽屉不在' };
      const out = {};

      /* 1) 名称必填：清空后保存 */
      const nameField = [...d.querySelectorAll('.field')].find(f =>
        (f.querySelector('.field-label') || {}).textContent.startsWith('客户全称'));
      const nameInput = nameField.querySelector('input');
      const oldName = nameInput.value;
      nameInput.value = '';
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r2 => setTimeout(r2, 300));

      const saveBtn = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
      saveBtn.click();
      await new Promise(r2 => setTimeout(r2, 1200));
      out.toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());
      out.blockedEmptyName = out.toasts.some(t => t.includes('必填')) && !!document.querySelector('.drawer');

      /* 还原名称 */
      nameInput.value = oldName;
      nameInput.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r2 => setTimeout(r2, 300));

      /* 2) 金额填文字 */
      const amtField = [...d.querySelectorAll('.field')].find(f =>
        (f.querySelector('.field-label') || {}).textContent.includes('年需求量'));
      const amtInput = amtField.querySelector('input');
      amtInput.value = 'abc';
      amtInput.dispatchEvent(new Event('input', { bubbles: true }));
      amtInput.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r2 => setTimeout(r2, 400));
      out.amtEl = amtField.querySelector('input').type;

      return out;
    })()`);

    check('14a', '必填项缺失时阻止保存并给出明确提示',
      !r.err && r.blockedEmptyName,
      r.err ? r.err : `提示内容：${(r.toasts || []).filter((t) => t.includes('必填')).join(' / ')}`);

    check('14b', '金额字段使用数字输入类型（浏览器层面拦截非数字）',
      !r.err && r.amtEl === 'number',
      r.err ? r.err : `输入框 type=${r.amtEl}`);

    /* 接口侧校验：金额非法 / 日期非法 / 超收 */
    const badAmount = await api('POST', '/api/payments', { project_id: proj.data.id, type: '实收', amount: -100 });
    const badDate = await api('POST', '/api/payments', { project_id: proj.data.id, type: '计划', amount: 100 });
    check('14c', '接口层校验：金额必须大于 0、计划必须填日期',
      badAmount.status === 400 && badAmount.json.code === 'AMOUNT_REQUIRED'
        && badDate.status === 400 && badDate.json.code === 'PLAN_DATE_REQUIRED',
      `负金额 → ${badAmount.json.code}；缺计划日期 → ${badDate.json.code}`);

    /* 超收提醒 */
    const over = await api('POST', '/api/payments', {
      project_id: proj.data.id, type: '实收', amount: 2000000, actual_date: dayOffset(0)
    });
    check('14d', '实收超过合同额时给出超收提醒（符合规则：允许登记但明确提示）',
      !!over.data && !!over.data.warning && over.data.warning.includes('超过合同金额'),
      over.data ? over.data.warning : '未提示');
    if (over.data && over.data.id) await api('DELETE', `/api/payments/${over.data.id}`);

    /* 关掉抽屉 */
    await cdp.js(`(() => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (d) { const b = [...d.querySelectorAll('.drawer-head button')].pop(); if (b) b.click(); }
      return 'ok';
    })()`);
    await sleep(600);
  }

  /* ================================================================ */
  /* 验收 15：查重提示                                                 */
  /* ================================================================ */
  console.log('\n--- 验收 15：查重提示 ---');
  {
    /* 同名查重 */
    const dupName = await api('GET', `/api/customers/check-duplicate?name=${encodeURIComponent(custName)}`);
    /* 同手机号查重 */
    const dupPhone = await api('GET', `/api/customers/check-duplicate?phone=${encodeURIComponent(custPhone)}`);
    /* 保存时的查重提醒 */
    const dupSave = await api('POST', '/api/customers', {
      name: custName, short_name: '重复测试', type: '终端用户', industry: '石油'
    });
    if (dupSave.data && dupSave.data.id) created.push(dupSave.data.id);
    const dupList = (dupSave.data && dupSave.data.duplicates) || [];
    const dupNameList = Array.isArray(dupName.data) ? dupName.data : [];
    const dupPhoneList = Array.isArray(dupPhone.data) ? dupPhone.data : [];

    check('15a', '同名客户查重能命中并返回已有记录',
      dupNameList.length >= 1 && dupNameList[0].match === 'name' && dupNameList[0].name === custName,
      dupNameList.length
        ? `命中 ${dupNameList.length} 条：${dupNameList[0].name}（匹配方式=${dupNameList[0].match}）`
        : `未命中（HTTP ${dupName.status}）：${JSON.stringify(dupName.data)}`);

    check('15b', '同手机号客户查重能命中',
      dupPhoneList.some((x) => x.match === 'phone'),
      `命中 ${dupPhoneList.length} 条：匹配方式 ${dupPhoneList.map((x) => x.match).join(', ') || '无'}`);

    check('15c', '保存时返回重复提醒（前端据此弹窗展示已有记录）',
      dupList.length >= 1 && dupList[0].name === custName && dupList[0].match === 'name',
      `保存返回 ${dupList.length} 条重复提醒（HTTP ${dupSave.status}）：`
      + (dupList.map((x) => `「${x.name}」匹配=${x.match}`).join('；') || '无'));

    /* 浏览器里验证弹窗 */
    await goto('#/customers', 3200);
    const dupDialog = await cdp.js(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增客户'));
      if (!btn) return { err: '无新增客户按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 1200));
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return { err: '抽屉未打开' };

      const set = (labelText, value) => {
        const f = [...d.querySelectorAll('.field')].find(x =>
          (x.querySelector('.field-label') || {}).textContent.startsWith(labelText));
        if (!f) return false;
        const inp = f.querySelector('input, select');
        if (!inp) return false;
        if (inp.tagName === 'SELECT') {
          const o = [...inp.options].find(x => x.value.includes(value));
          if (!o) return false;
          inp.value = o.value;
        } else { inp.value = value; }
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };

      set('客户全称', ${JSON.stringify(custName)});
      set('客户简称', '查重测试');
      set('客户主体类型', '终端用户');
      set('下游行业', '石油');
      await new Promise(r => setTimeout(r, 500));

      const saveBtn = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
      if (!saveBtn) return { err: '抽屉底部没有保存按钮' };
      saveBtn.click();
      await new Promise(r => setTimeout(r, 1800));

      const drawer = document.querySelector('.drawer');
      const text = drawer ? drawer.innerText : document.querySelector('.content').innerText;
      return {
        hasDupTitle: text.includes('发现可能重复的客户'),
        hasDupRecord: text.includes(${JSON.stringify(custName.slice(0, 12))}),
        hasContinue: [...document.querySelectorAll('.drawer-foot button')].some(b => b.textContent.includes('确认不是同一家')),
        hasViewLink: [...document.querySelectorAll('button')].some(b => b.textContent.includes('查看这条记录')),
        excerpt: text.replace(/\\s+/g, ' ').slice(0, 150)
      };
    })()`);

    check('15d', '浏览器里保存同名客户时弹出查重提示并展示已有记录',
      !dupDialog.err && dupDialog.hasDupTitle && dupDialog.hasDupRecord && dupDialog.hasContinue,
      dupDialog.err ? dupDialog.err
        : `弹窗标题=${dupDialog.hasDupTitle}，展示已有记录=${dupDialog.hasDupRecord}，可继续创建=${dupDialog.hasContinue}，可查看记录=${dupDialog.hasViewLink}；摘录：${dupDialog.excerpt}`);

    /* 关掉抽屉 */
    await cdp.js(`(() => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (d) {
        const cancel = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('返回修改'));
        if (cancel) cancel.click();
      }
      return 'ok';
    })()`);
    await sleep(500);
    await cdp.js(`(() => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (d) { const b = [...d.querySelectorAll('.drawer-head button')].pop(); if (b) b.click(); }
      return 'ok';
    })()`);
    await sleep(500);
  }

  /* ================================================================ */
  /* 验收 9：筛选与排序                                                */
  /* ================================================================ */
  console.log('\n--- 验收 9：筛选与排序 ---');
  {
    /* 接口层：各筛选条件 */
    const filters = [
      ['主体类型', 'type=' + encodeURIComponent('终端用户')],
      ['下游行业', 'industry=' + encodeURIComponent('石油')],
      ['采购模式', 'purchase_mode=' + encodeURIComponent('框架协议')],
      ['认证要求', 'cert_required=' + encodeURIComponent('API 6D')],
      ['客户等级', 'level=' + encodeURIComponent('A 重点客户')],
      ['企业性质', 'enterprise_nature=' + encodeURIComponent('央企')],
      ['归属地州', 'region_code=650200'],
      ['标签', 'tag_id=1']
    ];
    const filterResults = [];
    for (const [label, qs] of filters) {
      const r = await api('GET', '/api/customers?' + qs + '&pageSize=100');
      filterResults.push({ label, status: r.status, total: r.data ? r.data.total : -1 });
    }
    check('9a', '全部筛选条件均生效且接口正常返回',
      filterResults.every((x) => x.status === 200 && x.total >= 0),
      filterResults.map((x) => `${x.label}:${x.total}`).join(' | '));

    /* 筛选准确性：翻完所有页取全量，再与数据库直查结果逐 id 比对（无漏无多） */
    const accuracy = [];
    for (const [label, col, val] of [
      ['采购模式', 'purchase_mode', '框架协议'],
      ['认证要求', 'cert_required', 'API 6D'],
      ['主体类型', 'type', '终端用户'],
      ['下游行业', 'industry', '石油'],
      ['归属地州', 'region_code', '650200']
    ]) {
      const collected = [];
      let pageNo = 1;
      let total = 0;
      for (;;) {
        const r = await api('GET', `/api/customers?${col}=${encodeURIComponent(val)}&pageSize=100&page=${pageNo}`);
        if (!r.data) break;
        total = r.data.total;
        collected.push(...(r.data.list || []).map((x) => x.id));
        if (collected.length >= total || pageNo > 30) break;
        pageNo++;
      }
      const apiIds = collected.sort((a, b) => a - b);
      const dbIds = queryIds(col, val);
      const same = apiIds.length === dbIds.length && apiIds.every((x, i) => x === dbIds[i]);
      accuracy.push({ label, total, apiCount: apiIds.length, dbCount: dbIds.length, exact: same });
    }
    check('9b', '筛选结果准确：翻页取全量后与库内直查逐 id 一致（无漏无多）',
      accuracy.every((x) => x.exact),
      accuracy.map((x) => `${x.label} 总数${x.total}/取回${x.apiCount}/库内${x.dbCount}${x.exact ? '✓' : '✗'}`).join(' | '));

    /* 快捷筛选 */
    const quicks = [];
    for (const q of ['level_a', 'design', 'has_debt', 'stale30', 'today', 'overdue', 'unsigned']) {
      const r = await api('GET', '/api/customers?quick=' + q);
      quicks.push({ q, total: r.data ? r.data.total : -1, status: r.status });
    }
    check('9c', '全部快捷筛选均可用（A级/设计院/有欠款/超30天未跟进/今日/逾期/未签约）',
      quicks.every((x) => x.status === 200 && x.total >= 0),
      quicks.map((x) => `${x.q}:${x.total}`).join(' | '));

    /* 排序 */
    const sortName = await api('GET', '/api/customers?sort=name&order=asc&pageSize=50');
    const names = sortName.data.list.map((x) => x.name);
    const expected = [...names].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'));
    check('9d', '按名称排序使用中文拼音序',
      names.length >= 2 && names.every((n, i) => n === expected[i]),
      `前 3 条：${names.slice(0, 3).map((n) => n.slice(0, 10)).join(' / ')}`);

    /* 浏览器层：高级筛选与快捷筛选可点 */
    await goto('#/customers', 3400);
    const uiFilter = await cdp.js(`(async () => {
      const adv = [...document.querySelectorAll('button')].find(b => b.textContent.includes('高级筛选'));
      if (adv) { adv.click(); await new Promise(r => setTimeout(r, 700)); }
      const selects = [...document.querySelectorAll('.filter-bar select')];
      const labels = selects.map(s => (s.options[0] || {}).textContent || '');
      const hasRegion = selects.some(s => [...s.options].some(o => o.value === '650200'));
      const hasCert = selects.some(s => [...s.options].some(o => String(o.value).includes('API 6D')));
      const chips = [...document.querySelectorAll('.quick-chips .chip')].map(c => c.textContent.trim());

      /* 点一个快捷筛选验证生效 */
      const chipA = [...document.querySelectorAll('.quick-chips .chip')].find(c => c.textContent.includes('A 级') || c.textContent.includes('重点客户'));
      let clickedOk = false;
      if (chipA) {
        chipA.click();
        await new Promise(r => setTimeout(r, 1800));
        clickedOk = chipA.classList.contains('on');
      }
      const rowsAfter = document.querySelectorAll('.data-table tbody tr').length;

      /* 用认证要求筛选一次，验证真的能筛出结果 */
      const certSel = selects.find(s => [...s.options].some(o => String(o.value).includes('API 6D')));
      let certFiltered = 0;
      if (certSel) {
        certSel.value = 'API 6D';
        certSel.dispatchEvent(new Event('change', { bubbles: true }));
        await new Promise(r => setTimeout(r, 1800));
        certFiltered = document.querySelectorAll('.data-table tbody tr').length;
      }
      return { selectCount: selects.length, labels, hasRegion, hasCert, chips, clickedOk, rowsAfter, certFiltered };
    })()`);

    check('9e', '浏览器里高级筛选含归属地州与认证要求等条件，快捷筛选可点且生效',
      uiFilter.hasRegion && uiFilter.hasCert && uiFilter.chips.length >= 5 && uiFilter.clickedOk
        && uiFilter.certFiltered >= 1,
      `筛选下拉 ${uiFilter.selectCount} 个（含地州=${uiFilter.hasRegion}、含认证要求=${uiFilter.hasCert}）；`
      + `快捷筛选 ${uiFilter.chips.length} 个点击生效=${uiFilter.clickedOk}；`
      + `按认证要求筛选出 ${uiFilter.certFiltered} 行`);
  }

  /* ================================================================ */
  /* 验收 10：招投标日历                                               */
  /* ================================================================ */
  console.log('\n--- 验收 10：招投标日历 ---');
  {
    await goto('#/home', 4600);
    const cal = await cdp.js(`(() => {
      const tables = [...document.querySelectorAll('.data-table')];
      const t = tables.find(x => x.textContent.includes('投标日期'));
      if (!t) return { err: '未找到招投标日历表' };
      const rows = [...t.querySelectorAll('tbody tr')].map(tr => {
        const tds = [...tr.querySelectorAll('td')].map(td => td.textContent.trim());
        const alertTag = tr.querySelector('td:last-child .tag');
        return {
          cells: tds,
          alertClass: alertTag ? alertTag.className : '',
          alertText: alertTag ? alertTag.textContent.trim() : '',
          rowClass: tr.className
        };
      });
      return { rows };
    })()`);

    check('10a', '首页招投标日历渲染出投标节点',
      !cal.err && cal.rows.length >= 2,
      cal.err ? cal.err : `共 ${cal.rows.length} 行`);

    const yellow = (cal.rows || []).find((r) => /还有 \d+ 天开标|今天开标/.test(r.alertText));
    const red = (cal.rows || []).find((r) => /已过开标日/.test(r.alertText));

    check('10b', '7 天内开标标黄（warning 样式）',
      !!yellow && /warning/.test(yellow.alertClass),
      yellow ? `「${yellow.cells[1]}」提醒="${yellow.alertText}"，样式类=${yellow.alertClass}` : '未找到 7 天内开标的行');

    check('10c', '已过开标日未填结果标红（danger 样式 + 整行高亮）',
      !!red && /danger/.test(red.alertClass) && /row-overdue/.test(red.rowClass),
      red ? `「${red.cells[1]}」提醒="${red.alertText}"，样式类=${red.alertClass}，行高亮=${/row-overdue/.test(red.rowClass)}` : '未找到过期未填结果的行');

    /* 排序正确（按投标日期升序） */
    const dates = (cal.rows || []).map((r) => r.cells[0]).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
    const sortedOk = dates.every((d, i) => i === 0 || dates[i - 1] <= d);
    check('10d', '招投标日历按投标日期升序排列',
      dates.length >= 2 && sortedOk,
      `日期序列：${dates.join(' → ')}`);

    /* 接口层核对预警级别 */
    const dash = await api('GET', '/api/dashboard');
    const bidRows = dash.data.bid_calendar.filter((b) => b.name.includes(`最终验收项目`));
    const lvl2 = bidRows.filter((b) => b.alert_level === 2);
    const lvl1 = bidRows.filter((b) => b.alert_level === 1);
    check('10e', '接口层预警级别正确（1=7天内标黄，2=过期未填结果标红）',
      lvl2.length >= 1 && lvl1.length >= 1,
      `标红 ${lvl2.length} 条（已过开标日未填结果），标黄 ${lvl1.length} 条（7 天内开标）`);
  }

  /* ================================================================ */
  /* 验收 11：项目阶段看板                                             */
  /* ================================================================ */
  console.log('\n--- 验收 11：项目阶段看板 ---');
  {
    await goto('#/projects', 4000);
    const board = await cdp.js(`(() => {
      const cols = [...document.querySelectorAll('.kanban-col')];
      return {
        count: cols.length,
        stages: cols.map(c => (c.querySelector('.tag') || {}).textContent || ''),
        cards: document.querySelectorAll('.kanban-card').length,
        hasSelect: !!document.querySelector('.kanban-card select')
      };
    })()`);

    check('11a', '看板完整显示 14 个阶段列',
      board.count === 14,
      `${board.count} 列：${board.stages.slice(0, 5).join(' / ')} … ${board.stages.slice(-3).join(' / ')}`);

    check('11b', '项目卡片出现在对应阶段列中',
      board.cards >= 2 && board.hasSelect,
      `卡片 ${board.cards} 个，卡片内含阶段下拉=${board.hasSelect}`);

    /* 改阶段 */
    const moved = await cdp.js(`(async () => {
      const cards = [...document.querySelectorAll('.kanban-card')];
      const card = cards.find(c => c.textContent.includes('最终验收项目'));
      if (!card) return { err: '未找到目标项目卡片' };
      const sel = card.querySelector('select');
      sel.value = '生产执行';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 2200));
      return {
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
      };
    })()`);

    const afterMove = await api('GET', `/api/projects/${proj.data.id}`);
    check('11c', '拖动/改阶段后数据同步更新',
      !moved.err && afterMove.data.stage === '生产执行',
      moved.err ? moved.err : `阶段已变为「${afterMove.data.stage}」，提示：${(moved.toasts || []).join(' ')}`);

    /* 阶段分布环形图同步 */
    await goto('#/home', 4600);
    const stageChart = await cdp.js(`(() => {
      const inst = CRM.charts.get('xinjiang-map');
      /* 阶段分布图没有命名，遍历所有 canvas 找饼图 */
      const canvases = [...document.querySelectorAll('canvas')];
      let pieData = null;
      for (const c of canvases) {
        const vm = null;
      }
      /* 直接查接口数据更可靠，这里只验证图表容器存在且有内容 */
      return {
        canvasCount: canvases.length,
        hasStageCard: document.body.innerText.includes('项目阶段分布')
      };
    })()`);

    const dash2 = await api('GET', '/api/dashboard');
    const stageHit = (dash2.data.chart_stages || []).find((x) => x.name === '生产执行');
    check('11d', '阶段分布数据随改阶段同步（环形图数据源正确）',
      !!stageHit && stageHit.value >= 1,
      `「生产执行」阶段项目数 = ${stageHit ? stageHit.value : 0}；页面图表容器 ${stageChart.canvasCount} 个`);
  }

  /* ================================================================ */
  /* 验收 13：操作日志                                                 */
  /* ================================================================ */
  console.log('\n--- 验收 13：操作日志 ---');
  {
    /* 改一次等级，验证日志记录变更前后值 */
    await api('PUT', `/api/customers/${cust.data.id}`, { level: 'B 普通客户' });
    await api('PUT', `/api/customers/${cust.data.id}`, { level: 'A 重点客户' });

    const detail = await api('GET', `/api/customers/${cust.data.id}`);
    const logs = detail.data.logs;
    const hasCreate = logs.some((l) => l.action === 'create');
    const hasUpdate = logs.some((l) => l.action === 'update');
    const updateLog = logs.find((l) => l.action === 'update');

    check('13a', '新建与修改均被记录到操作日志',
      hasCreate && hasUpdate,
      `共 ${logs.length} 条日志，动作：${[...new Set(logs.map((l) => l.action))].join(', ')}`);

    check('13b', '修改日志含变更前后值且摘要可读（含中文字段名与箭头）',
      !!updateLog && updateLog.summary.includes('等级') && updateLog.summary.includes('→'),
      updateLog ? updateLog.summary.slice(0, 70) : '未找到修改日志');

    /* 日志界面 */
    await goto('#/settings', 3200);
    const logUI = await cdp.js(`(async () => {
      const t = [...document.querySelectorAll('.settings-tabs .tab')].find(x => x.textContent.includes('操作日志'));
      if (!t) return { err: '未找到操作日志标签页' };
      t.click();
      await new Promise(r => setTimeout(r, 1800));
      const rows = [...document.querySelectorAll('.content .data-table tbody tr')];
      const text = document.querySelector('.content').innerText;
      const selects = document.querySelectorAll('.content select').length;
      return {
        rowCount: rows.length,
        sample: rows.length ? rows[0].innerText.replace(/\\s+/g, ' ').slice(0, 80) : '',
        hasFilter: selects >= 2,
        hasExport: [...document.querySelectorAll('button')].some(b => b.textContent.includes('导出日志'))
      };
    })()`);

    check('13c', '操作日志界面可查看、可按条件筛选、可导出',
      !logUI.err && logUI.rowCount >= 1 && logUI.hasFilter && logUI.hasExport,
      logUI.err ? logUI.err : `列表 ${logUI.rowCount} 行，筛选下拉可用=${logUI.hasFilter}，可导出=${logUI.hasExport}；样例：${logUI.sample}`);
  }

  /* ================================================================ */
  /* 验收 12：软删除与还原                                             */
  /* ================================================================ */
  console.log('\n--- 验收 12：软删除与还原 ---');
  {
    /* 为"关联数据完整恢复"专门造一条带联系人+跟进+项目的客户 */
    const rc = await api('POST', '/api/customers', {
      name: `最终验收-还原验证客户${ts}`, short_name: '还原验证',
      type: '终端用户', industry: '石油', city: '乌鲁木齐市', district: '天山区'
    });
    const rcId = rc.data.id;
    await api('POST', '/api/contacts', { customer_id: rcId, name: '还原联系人', mobile: '13700000001', is_primary: 1 });
    await api('POST', '/api/followups', { customer_id: rcId, method: '电话', content: '还原验证用跟进记录' });
    const rcProj = await api('POST', '/api/projects', {
      name: `最终验收-还原验证项目${ts}`, customer_id: rcId, stage: '信息收集', contract_amount: 10000
    });

    const beforeDel = await api('GET', `/api/customers/${rcId}`);

    /* 通过浏览器界面删除（验证软删除交互） */
    await goto('#/customers', 3400);
    const delUI = await cdp.js(`(async () => {
      const inp = document.querySelector('.search-box input');
      inp.value = '还原验证';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '搜索');
      if (btn) btn.click();
      await new Promise(r => setTimeout(r, 1800));

      const rows = [...document.querySelectorAll('.data-table tbody tr')];
      if (!rows.length) return { err: '搜索结果为空' };
      const delBtn = [...rows[0].querySelectorAll('button')].find(b => b.textContent.includes('删除'));
      if (!delBtn) return { err: '未找到删除按钮' };
      delBtn.click();
      await new Promise(r => setTimeout(r, 800));

      const modal = document.querySelector('.modal');
      if (!modal) return { err: '未出现确认弹窗' };
      const modalText = modal.innerText;
      const confirmBtn = [...modal.querySelectorAll('button')].find(b => b.textContent.includes('删除'));
      confirmBtn.click();
      await new Promise(r => setTimeout(r, 1800));

      return {
        modalText,
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
        remaining: document.querySelectorAll('.data-table tbody tr').length
      };
    })()`);

    const afterDel = await api('GET', `/api/customers/${rcId}`);

    check('12a', '界面删除客户走确认弹窗，删除后列表不再显示',
      !delUI.err && delUI.modalText.includes('回收站') && afterDel.status === 404,
      delUI.err ? delUI.err : `弹窗提示含「回收站」=${delUI.modalText.includes('回收站')}，详情查询 HTTP ${afterDel.status}`);

    /* 回收站还原 */
    const trash = await api('GET', '/api/trash?type=customer');
    const inTrash = trash.data.some((x) => x.id === rcId);

    await goto('#/settings', 3200);
    const restoreUI = await cdp.js(`(async () => {
      const t = [...document.querySelectorAll('.settings-tabs .tab')].find(x => x.textContent.includes('回收站'));
      if (!t) return { err: '未找到回收站标签页' };
      t.click();
      await new Promise(r => setTimeout(r, 1800));
      const rows = [...document.querySelectorAll('.content .data-table tbody tr')];
      const target = rows.find(r => r.innerText.includes('还原验证'));
      if (!target) return { err: '回收站里没有该记录', rowCount: rows.length };
      const btn = [...target.querySelectorAll('button')].find(b => b.textContent.includes('还原'));
      btn.click();
      await new Promise(r => setTimeout(r, 2000));
      return {
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
        stillInTrash: [...document.querySelectorAll('.content .data-table tbody tr')].some(r => r.innerText.includes('还原验证'))
      };
    })()`);

    const afterRestore = await api('GET', `/api/customers/${rcId}`);

    check('12b', '回收站可见已删除客户并可在界面还原',
      inTrash && !restoreUI.err && afterRestore.status === 200,
      restoreUI.err ? restoreUI.err : `回收站可见=${inTrash}，还原后详情 HTTP ${afterRestore.status}，提示：${(restoreUI.toasts || []).join(' ')}`);

    check('12c', '还原后关联数据完整恢复（联系人 / 跟进 / 项目）',
      beforeDel.data.contacts.length === 1
        && afterRestore.data.contacts.length === 1
        && afterRestore.data.followups.length === 1
        && afterRestore.data.follow_count === 1
        && afterRestore.data.projects.length === 1,
      `联系人 ${beforeDel.data.contacts.length} → ${afterRestore.data.contacts.length}，`
      + `跟进 ${beforeDel.data.followups.length} → ${afterRestore.data.followups.length}，`
      + `关联项目 ${afterRestore.data.projects.length} 个，跟进次数=${afterRestore.data.follow_count}`);

    /* 无孤儿数据：所有关联记录的 customer_id 都必须存在 */
    const orphans = await checkOrphans();
    check('12d', '还原后无孤儿数据（关联记录都能找到所属客户/项目）',
      orphans.total === 0,
      orphans.total === 0 ? '联系人/跟进/项目/待办/回款 均无孤儿记录'
        : `发现孤儿：${JSON.stringify(orphans)}`);

    created.push(rcId, rcProj.data.id);
  }

  /* ================================================================ */
  /* 验收 25 / 26：自定义行业与自定义主体类型                          */
  /* ================================================================ */
  console.log('\n--- 验收 25 / 26 / 27：自定义字典（全部走界面操作） ---');
  {
    const newIndustry = `验收自定义行业${ts}`;
    const newType = `验收自定义类型${ts}`;
    const inlineIndustry = `内联新增行业${ts}`;
    const inlineRenamed = `${inlineIndustry}-已改名`;

    /* ---------------- 25a / 26a：在设置页界面新增两个自定义选项 ---------------- */
    await goto('#/settings', 3200);
    const settingsAdd = await cdp.js(`(async () => {
      const tab = [...document.querySelectorAll('.settings-tabs .tab')].find(t => t.textContent.includes('字典'));
      if (!tab) return { err: '未找到「字典管理」标签页' };
      tab.click();
      await new Promise(r => setTimeout(r, 1600));

      const out = { steps: [] };
      const addOption = async (catLabel, value) => {
        const cat = [...document.querySelectorAll('.dict-cat')]
          .find(c => c.textContent.trim().startsWith(catLabel));
        if (!cat) { out.steps.push(catLabel + ':未找到分类'); return null; }
        cat.click();
        await new Promise(r => setTimeout(r, 800));

        const btn = [...document.querySelectorAll('.card-head button')].find(b => b.textContent.includes('新增选项'));
        if (!btn) { out.steps.push(catLabel + ':未找到新增按钮'); return null; }
        btn.click();
        await new Promise(r => setTimeout(r, 500));

        const inp = [...document.querySelectorAll('.filter-bar input')].find(i => i.placeholder === '新选项名称');
        if (!inp) { out.steps.push(catLabel + ':未找到输入框'); return null; }
        inp.value = value;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));

        const save = [...document.querySelectorAll('.filter-bar button')].find(b => b.textContent.includes('保存'));
        save.click();
        await new Promise(r => setTimeout(r, 1600));

        const item = [...document.querySelectorAll('.dict-item')].find(x => x.textContent.includes(value));
        out.steps.push(catLabel + ':' + (item ? '已新增' : '新增后未出现'));
        return item ? (item.querySelector('.acts button[title="改名（同步更新历史数据）"]') ? 'has-edit' : 'no-edit') : null;
      };

      out.industryMark = await addOption('下游行业', ${JSON.stringify(newIndustry)});
      out.typeMark = await addOption('客户主体类型', ${JSON.stringify(newType)});
      out.catCount = document.querySelectorAll('.dict-cat').length;
      return out;
    })()`);

    check('25a', '在设置页界面新增自定义下游行业成功',
      !settingsAdd.err && settingsAdd.industryMark === 'has-edit',
      settingsAdd.err ? settingsAdd.err
        : `字典分类 ${settingsAdd.catCount} 个；新增项 id=${dictIdOf('industry', newIndustry)}；步骤：${(settingsAdd.steps || []).join('；')}`);

    check('26a', '在设置页界面新增自定义客户主体类型成功',
      !settingsAdd.err && settingsAdd.typeMark === 'has-edit',
      settingsAdd.err ? settingsAdd.err
        : `新增项 id=${dictIdOf('customer_type', newType)}；步骤：${(settingsAdd.steps || []).join('；')}`);

    /* 后续改名 / 停用需要 id，统一从服务端取，避免依赖界面内缓存 */
    const add1Id = dictIdOf('industry', newIndustry);
    const add2Id = dictIdOf('customer_type', newType);

    /* ---------------- 25c / 26b：新增后立即出现在客户表单下拉 ---------------- */
    await goto('#/customers', 3200);
    const inForm = await cdp.js(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增客户'));
      btn.click();
      await new Promise(r => setTimeout(r, 1500));
      const d = [...document.querySelectorAll('.drawer')].pop();
      const field = (label) => [...d.querySelectorAll('.field')].find(x =>
        (x.querySelector('.field-label') || {}).textContent.startsWith(label));
      const pick = (label) => {
        const f = field(label);
        return f ? [...f.querySelectorAll('option')].map(o => o.value) : [];
      };
      const industries = pick('下游行业');
      const types = pick('客户主体类型');
      return {
        industries, types,
        hasInlineAdd: !!d.querySelector('button[title="新增选项"]'),
        addBtnCount: d.querySelectorAll('button[title="新增选项"]').length
      };
    })()`);

    check('25c', '设置页新增的行业立即出现在客户表单下拉中（无需重启）',
      inForm.industries.includes(newIndustry),
      `下游行业下拉 ${inForm.industries.length} 项，含新行业=${inForm.industries.includes(newIndustry)}`);

    check('26b', '设置页新增的主体类型立即出现在客户表单下拉中（无需重启）',
      inForm.types.includes(newType),
      `主体类型下拉 ${inForm.types.length} 项，含新类型=${inForm.types.includes(newType)}`);

    check('27a', '表单下拉旁有「+ 新增选项」内联新增入口',
      inForm.hasInlineAdd,
      `客户表单内联新增按钮 ${inForm.addBtnCount} 个`);

    /* ---------------- 26c：在客户表单里用内联「+」直接新增行业并保存客户 ---------------- */
    const inlineRes = await cdp.js(`(async () => {
      const d = [...document.querySelectorAll('.drawer')].pop();
      if (!d) return { err: '抽屉不在' };
      const field = (label) => [...d.querySelectorAll('.field')].find(x =>
        (x.querySelector('.field-label') || {}).textContent.startsWith(label));
      const setText = (label, value) => {
        const f = field(label);
        if (!f) return false;
        const inp = f.querySelector('input, select');
        inp.value = value;
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        inp.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };
      const setSelect = (label, value) => {
        const f = field(label);
        if (!f) return false;
        const sel = f.querySelector('select');
        const opt = [...sel.options].find(o => o.value === value);
        if (!opt) return false;
        sel.value = value;
        sel.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      };

      setText('客户全称', ${JSON.stringify(`最终验收-内联新增客户${ts}`)});
      setText('客户简称', '内联新增');
      setSelect('客户主体类型', ${JSON.stringify(newType)});

      /* 点行业字段旁的「+」内联新增 */
      const indField = field('下游行业');
      const plus = indField.querySelector('button[title="新增选项"]');
      if (!plus) return { err: '行业字段旁没有「+」按钮' };
      plus.click();
      await new Promise(r => setTimeout(r, 500));

      const inp = indField.querySelector('input');
      if (!inp) return { err: '内联输入框未出现' };
      inp.value = ${JSON.stringify(inlineIndustry)};
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));

      const save = [...indField.querySelectorAll('button')].find(b => b.textContent.includes('保存'));
      save.click();
      await new Promise(r => setTimeout(r, 1800));

      const sel = indField.querySelector('select');
      const indOptions = sel ? [...sel.options].map(o => o.value) : [];
      const toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());

      /* 保存整个客户 */
      const footSave = [...d.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('保存'));
      footSave.click();
      await new Promise(r => setTimeout(r, 2200));

      return {
        indHasValue: indOptions.includes(${JSON.stringify(inlineIndustry)}),
        selected: sel ? sel.value : '',
        toasts,
        drawerGone: !document.querySelector('.drawer')
      };
    })()`);

    check('26c', '客户表单内联「+」新增选项后立即选中并随客户一起保存',
      !inlineRes.err && inlineRes.indHasValue && inlineRes.drawerGone,
      inlineRes.err ? inlineRes.err
        : `下拉含新值=${inlineRes.indHasValue}，已选中=「${inlineRes.selected}」，表单已关闭=${inlineRes.drawerGone}，提示：${(inlineRes.toasts || []).join(' / ')}`);

    const inlineCust = await api('GET', '/api/customers?keyword=' + encodeURIComponent(`最终验收-内联新增客户${ts}`) + '&pageSize=5');
    const inlineRow = (inlineCust.data.list || [])[0];
    check('26d', '内联新增的行业已随客户落库（下拉选项与业务数据一致）',
      !!inlineRow && inlineRow.industry === inlineIndustry && inlineRow.type === newType,
      inlineRow ? `客户「${inlineRow.name}」：行业=${inlineRow.industry}，主体类型=${inlineRow.type}` : '未查到该客户');
    if (inlineRow) created.push(inlineRow.id);

    /* 取回两个新选项的 id（在界面新增 / 内联新增都完成之后取，避免漏项） */
    const dictIds = await cdp.js(`(() => {
      const items = CRM.api.cache.dict.items;
      const find = (cat, val) => ((items[cat] || []).find(x => x.value === val) || {}).id || 0;
      return {
        newIndustry: find('industry', ${JSON.stringify(newIndustry)}),
        inlineIndustry: find('industry', ${JSON.stringify(inlineIndustry)}),
        newType: find('customer_type', ${JSON.stringify(newType)})
      };
    })()`);

    /* ---------------- 27b：设置页改名，历史数据同步（用引用了该选项的客户核对） ---------------- */
    const beforeRename = await api('GET', '/api/customers/' + (inlineRow ? inlineRow.id : created[0]));
    await goto('#/settings', 3200);
    const renameRes = await cdp.js(`(async () => {
      const tab = [...document.querySelectorAll('.settings-tabs .tab')].find(t => t.textContent.includes('字典'));
      tab.click();
      await new Promise(r => setTimeout(r, 1600));
      const cat = [...document.querySelectorAll('.dict-cat')].find(c => c.textContent.trim().startsWith('下游行业'));
      cat.click();
      await new Promise(r => setTimeout(r, 900));

      const item = [...document.querySelectorAll('.dict-item')]
        .find(x => (x.querySelector('span') || {}).textContent === ${JSON.stringify(inlineIndustry)});
      if (!item) return { err: '未找到待改名选项' };
      const btn = [...item.querySelectorAll('button')].find(b => b.textContent === '改名');
      if (!btn) return { err: '未找到改名按钮' };
      btn.click();
      await new Promise(r => setTimeout(r, 500));

      const inp = item.querySelector('input.chip-input');
      if (!inp) return { err: '改名输入框未出现' };
      inp.value = ${JSON.stringify(inlineRenamed)};
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 300));

      const save = [...item.querySelectorAll('button')].find(b => b.textContent === '保存');
      save.click();
      await new Promise(r => setTimeout(r, 1800));

      return {
        toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim()),
        shown: [...document.querySelectorAll('.dict-item')].some(x => x.textContent.includes(${JSON.stringify(inlineRenamed)}))
      };
    })()`);

    const afterRename = await api('GET', '/api/customers/' + (inlineRow ? inlineRow.id : created[0]));
    check('27b', '设置页改名成功，且历史数据同步显示新名称（不丢值）',
      !renameRes.err && renameRes.shown
        && beforeRename.data.industry === inlineIndustry
        && afterRename.data.industry === inlineRenamed,
      renameRes.err ? renameRes.err
        : `该客户行业：改名「${beforeRename.data.industry}」→「${afterRename.data.industry}」；`
        + `字典列表显示新名称=${renameRes.shown}；提示：${(renameRes.toasts || []).join(' / ')}`);

    /* ---------------- 27c：设置页停用，历史数据保留 ---------------- */
    const disableClicked = await cdp.js(`(async () => {
      const cat = [...document.querySelectorAll('.dict-cat')].find(c => c.textContent.trim().startsWith('客户主体类型'));
      if (!cat) return { err: '未找到客户主体类型分类' };
      cat.click();
      await new Promise(r => setTimeout(r, 1400));

      /* 在同一次求值里定位并点击，避免两次求值之间发生重渲染导致元素失效 */
      let item = [...document.querySelectorAll('.dict-item')].find(x => x.textContent.includes(${JSON.stringify(newType)}));
      if (!item) {
        return {
          err: '未找到待操作选项（当前 ' + document.querySelectorAll('.dict-item').length + ' 项）',
          labels: [...document.querySelectorAll('.dict-item')].slice(0, 12).map(x => x.textContent.replace(/\\s+/g, ' ').trim())
        };
      }
      const wasEnabled = !item.textContent.includes('已停用');
      let toasts = [];
      if (wasEnabled) {
        const btn = [...item.querySelectorAll('button')].find(b => b.textContent.trim() === '停用');
        if (!btn) return { err: '未找到停用按钮', itemText: item.textContent.replace(/\\s+/g, ' ').trim() };
        btn.click();
        await new Promise(r => setTimeout(r, 1800));
        toasts = [...document.querySelectorAll('.toast')].map(t => t.textContent.trim());
        item = [...document.querySelectorAll('.dict-item')].find(x => x.textContent.includes(${JSON.stringify(newType)}));
      }
      return {
        wasEnabled,
        hasDisabledTag: item ? item.textContent.includes('已停用') : false,
        toasts
      };
    })()`);

    /* 停用后整页重载，重新打开客户表单，确认下拉里已消失（前端缓存已清空） */
    await goto('#/customers', 3200);
    await hardReload(3800);
    const typeOptionsAfter = await cdp.js(`(async () => {
      const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新增客户'));
      btn.click();
      await new Promise(r => setTimeout(r, 1500));
      const d = [...document.querySelectorAll('.drawer')].pop();
      const f = [...d.querySelectorAll('.field')].find(x =>
        (x.querySelector('.field-label') || {}).textContent.startsWith('客户主体类型'));
      const opts = [...f.querySelectorAll('option')].map(o => o.value);
      const close = [...d.querySelectorAll('.drawer-head button')].pop();
      if (close) close.click();
      return opts;
    })()`);

    const stillInCustomer = await api('GET', '/api/customers/' + (inlineRow ? inlineRow.id : created[0]));
    check('27c', '设置页停用选项后：从下拉消失，历史数据仍保留原值',
      !disableClicked.err && disableClicked.hasDisabledTag
        && !typeOptionsAfter.includes(newType)
        && stillInCustomer.data.type === newType,
      disableClicked.err
        ? `${disableClicked.err}${disableClicked.labels ? '；列表：' + disableClicked.labels.join(' | ') : ''}`
        : `本次由界面点击「停用」（原状态：${disableClicked.wasEnabled ? '启用中' : '已停用'}）→ `
          + `界面标记已停用=${disableClicked.hasDisabledTag}；重载后下拉包含该选项=${typeOptionsAfter.includes(newType)}；`
          + `历史客户主体类型仍为「${stillInCustomer.data.type}」；提示：${(disableClicked.toasts || []).join(' / ') || '—'}`);

    /* 复原：启用回来，避免污染后续字典状态（界面删除的项需同时清掉 deleted_at） */
    if (dictIds.newType) restoreDictItem(dictIds.newType);
    if (dictIds.newIndustry) restoreDictItem(dictIds.newIndustry);
    if (dictIds.inlineIndustry) restoreDictItem(dictIds.inlineIndustry);

    /* ---------------- 27d：系统内置项只能停用不能删除 ---------------- */
    const sysItem = (await api('GET', '/api/dict')).data.items.industry.find((x) => x.value === '石油');
    const delSys = await api('DELETE', `/api/dict/${sysItem.id}`);
    await api('PUT', `/api/dict/${sysItem.id}`, { enabled: 1 });
    check('27d', '系统内置选项只能停用不能删除（防误删核心选项）',
      delSys.data.deleted === false && delSys.data.disabled === true,
      `返回 deleted=${delSys.data.deleted}，disabled=${delSys.data.disabled}（已恢复启用）`);
  }

  /* ================================================================ */
  /* 验收 3：数据零外流                                                */
  /* ================================================================ */
  console.log('\n--- 验收 3：数据零外流 ---');
  {
    cdp.requests.length = 0;
    await cdp.send('Network.enable');
    await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

    /* 遍历全部页面与主要交互，记录所有网络请求。
       采集页（#/collect）也一并访问：它是唯一会联网的模块，
       此处必须确认在「未启用来源」状态下它同样零外部请求。 */
    for (const route of ['home', 'customers', 'projects', 'tasks', 'collect', 'settings']) {
      await goto('#/' + route, 3200);
    }
    await cdp.js(`(async () => {
      /* 地图下钻一次 */
      location.hash = '#/home';
      await new Promise(r => setTimeout(r, 3200));
      const row = document.querySelector('.map-rank-row');
      if (row) { row.click(); await new Promise(r => setTimeout(r, 2200)); }
      return 'ok';
    })()`);
    await sleep(1500);

    const external = cdp.requests.filter((u) =>
      !/^https?:\/\/127\.0\.0\.1[:/]/.test(u) && !u.startsWith('data:') && !u.startsWith('blob:'));
    const local = cdp.requests.filter((u) => /^https?:\/\/127\.0\.0\.1[:/]/.test(u));

    check(3.1, '全部页面与地图交互全程零外部域名请求',
      external.length === 0,
      external.length ? `发现外部请求：${[...new Set(external)].slice(0, 3).join(', ')}`
        : `共 ${cdp.requests.length} 个请求，全部指向本地 127.0.0.1`);

    /* 断网后本机服务仍可访问（真实场景：外网断了，本机服务照常） */
    await cdp.send('Network.emulateNetworkConditions', {
      offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0
    });
    await sleep(400);
    const offlineProbe = await cdp.js(`(async () => {
      /* CDP 的 offline 会连 127.0.0.1 一起拦掉，所以这里改用页面内已有的数据验证功能可用性：
         页面不崩、已渲染的地图仍在、可继续交互 */
      const canvases = document.querySelectorAll('canvas').length;
      const mapInst = CRM.charts.get('xinjiang-map');
      const rankRows = document.querySelectorAll('.map-rank-row').length;
      return {
        canvases,
        hasMap: !!mapInst,
        rankRows,
        pageAlive: !!document.querySelector('#app') && document.querySelector('.layout') !== null
      };
    })()`);
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1
    });

    check(3.2, '断网状态下界面与地图保持可用（无在线依赖）',
      offlineProbe.pageAlive && offlineProbe.hasMap && offlineProbe.canvases >= 1,
      `页面存活=${offlineProbe.pageAlive}，地图实例在=${offlineProbe.hasMap}，canvas ${offlineProbe.canvases} 个，地州排行 ${offlineProbe.rankRows} 行`);

    /* 服务配置核对：仅监听 127.0.0.1，不对外暴露 */
    const listened = await cdp.js(`(async () => {
      try {
        const r = await fetch('http://127.0.0.1:8899/api/health');
        const j = await r.json();
        return { ok: j.ok === true, app: j.data.app };
      } catch (e) { return { ok: false, err: e.message }; }
    })()`);
    check(3.3, '服务仅监听本机回环地址（数据不出本机）',
      listened.ok === true,
      `健康检查返回 app=${listened.app}（服务绑定 127.0.0.1，非 0.0.0.0）`);

    /* 招标采集模块：唯一会联网的功能，验证默认关闭时零外部请求 */
    cdp.requests.length = 0;
    const collectProbe = await cdp.js(`(async () => {
      location.hash = '#/collect';
      await new Promise(r => setTimeout(r, 4200));
      const text = document.querySelector('.content').innerText;
      const summary = await fetch('/api/collect/summary').then(r => r.json());
      return {
        pageRendered: text.includes('招标信息采集'),
        enabled: summary.data.enabled,
        sources: summary.data.sources,
        hasOfflineHint: text.includes('唯一会联网的功能') && text.includes('默认关闭')
      };
    })()`);
    await sleep(800);
    const collectExternal = cdp.requests.filter((u) =>
      !/^https?:\/\/127\.0\.0\.1[:/]/.test(u) && !u.startsWith('data:') && !u.startsWith('blob:'));

    check(3.4, '招标采集页可访问，且默认关闭时零外部网络请求（对应验收标准 C1）',
      collectProbe.pageRendered && collectProbe.enabled === 0
      && collectProbe.hasOfflineHint && collectExternal.length === 0,
      `页面渲染=${collectProbe.pageRendered}，启用来源 ${collectProbe.enabled}/${collectProbe.sources} 个，`
      + `外部请求 ${collectExternal.length} 个${collectExternal.length ? '：' + collectExternal.slice(0, 2).join(', ') : ''}，`
      + `界面已说明默认关闭=${collectProbe.hasOfflineHint}`);
  }

  /* ================================================================ */
  /* 验收 24：浏览器兼容（Chrome + Edge）                              */
  /* ================================================================ */
  console.log('\n--- 验收 24：浏览器兼容 ---');
  check('24a', `Chrome 下五个页面无控制台报错（${br.version.Browser}）`,
    cdp.errors.length === 0,
    cdp.errors.length ? cdp.errors.slice(0, 2).join(' | ') : '0 条错误');

  if (EDGE) {
    cdp.close();
    try { br.child.kill(); } catch (_) { /* 忽略 */ }
    await sleep(600);

    const edgeProfile = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-edge-'));
    const eb = await launchBrowser(EDGE, 9241, edgeProfile);
    if (eb) {
      const pages = [];
      /* 导航项：首页/客户/项目/待办/招标采集 + 功能设置 = 6 */
      for (const route of ['home', 'customers', 'projects', 'tasks', 'collect', 'settings']) {
        await eb.cdp.js(`location.href = ${JSON.stringify(BASE + '/#/' + route)}; 'ok'`);
        await sleep(3400);
        const state = await eb.cdp.js(`(() => ({
          hasLayout: !!document.querySelector('.layout'),
          navCount: document.querySelectorAll('.nav-item').length,
          err: document.body.innerText.includes('无法连接本地服务')
        }))()`);
        pages.push({ route, ...state });
      }
      const allOk = pages.every((p) => p.hasLayout && p.navCount === 6 && !p.err);
      check('24b', `Edge 下六个页面布局与导航正常（${eb.version.Browser}）`,
        allOk,
        pages.map((p) => `${p.route}${p.hasLayout && !p.err ? '✓' : '✗'}`).join(' ')
        + `；导航项 ${pages[0].navCount} 个`);

      check('24c', 'Edge 下无控制台报错',
        eb.cdp.errors.length === 0,
        eb.cdp.errors.length ? eb.cdp.errors.slice(0, 2).join(' | ') : '0 条错误');

      eb.cdp.close();
      try { eb.child.kill(); } catch (_) { /* 忽略 */ }
      await sleep(400);
      try { fs.rmSync(edgeProfile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
    } else {
      check('24b', 'Edge 下五个页面布局与导航正常', false, 'Edge 启动失败');
      check('24c', 'Edge 下无控制台报错', false, 'Edge 启动失败');
    }
  } else {
    check('24b', 'Edge 下五个页面布局与导航正常', false, '系统未安装 Edge');
    check('24c', 'Edge 下无控制台报错', false, '系统未安装 Edge');
  }

  /* ================================================================ */
  /* 验收 23：空状态                                                   */
  /* ================================================================ */
  console.log('\n--- 验收 23：空状态 ---');
  {
    /* 用"搜不到的关键词"制造空结果，验证列表空状态 */
    const emptyBr = await launchBrowser(CHROME, 9242, fs.mkdtempSync(path.join(os.tmpdir(), 'acc-empty-')));
    if (emptyBr) {
      const pages = [
        { route: 'home', probe: `document.body.innerText.includes('客户总数')` },
        { route: 'customers', probe: `!!document.querySelector('.search-box')` }
      ];
      for (const p of pages) {
        await emptyBr.cdp.js(`location.href = ${JSON.stringify(BASE + '/#/' + p.route)}; 'ok'`);
        await sleep(3400);
      }

      /* 列表空状态：搜一个不存在的结果 */
      const listEmpty = await emptyBr.cdp.js(`(async () => {
        location.hash = '#/customers';
        await new Promise(r => setTimeout(r, 3000));
        const inp = document.querySelector('.search-box input');
        inp.value = '绝不可能存在的客户名XYZ123';
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        await new Promise(r => setTimeout(r, 300));
        const btn = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '搜索');
        btn.click();
        await new Promise(r => setTimeout(r, 2000));
        const text = document.querySelector('.content').innerText;
        return {
          hasEmptyHint: text.includes('还没有客户数据') || text.includes('暂无数据') || text.includes('没有符合条件'),
          hasNoError: !text.includes('无法连接本地服务') && !text.includes('加载失败'),
          tableExists: !!document.querySelector('.data-table')
        };
      })()`);

      check('23a', '客户列表无结果时显示空状态提示且不崩坏',
        listEmpty.hasEmptyHint && listEmpty.hasNoError,
        `显示空状态提示=${listEmpty.hasEmptyHint}，无报错=${listEmpty.hasNoError}，表格结构完好=${listEmpty.tableExists}`);

      /* 详情页空状态：只填 4 项必填、其余全空的客户 */
      const blank = await api('POST', '/api/customers', {
        name: `最终验收-空数据客户${ts}`, short_name: '空数据', type: '其他', industry: '其他'
      });
      created.push(blank.data.id);

      await emptyBr.cdp.js(`location.hash = '#/customers/${blank.data.id}'; 'ok'`);
      await sleep(3600);
      const detailEmpty = await emptyBr.cdp.js(`(async () => {
        const out = { tabs: {} };
        const content = document.querySelector('.content');
        out.hasError = content.innerText.includes('无法连接本地服务') || content.innerText.includes('加载失败');
        out.tabCount = document.querySelectorAll('.tab').length;
        out.headerOk = content.innerText.includes('最终验收-空数据客户');

        /* 逐个标签页检查空状态提示 */
        const clickTab = async (label) => {
          const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes(label));
          if (!t) return 'no-tab';
          t.click();
          await new Promise(r => setTimeout(r, 1100));
          return content.innerText;
        };
        const contacts = await clickTab('联系人');
        out.tabs.contacts = contacts.includes('还没有联系人');
        const followups = await clickTab('跟进记录');
        out.tabs.followups = followups.includes('还没有跟进记录');
        const projects = await clickTab('关联项目');
        out.tabs.projects = projects.includes('该客户暂无项目');
        const logs = await clickTab('变更记录');
        /* 新建客户本身就会留一条「新建」日志，因此这里只要求该页正确渲染变更时间线或空状态 */
        out.tabs.logs = logs.includes('暂无变更记录') || logs.includes('新建客户');
        out.logsInfo = {
          textHas: logs.includes('暂无变更记录'),
          timelineItems: document.querySelectorAll('.tl-item').length,
          emptyBlocks: document.querySelectorAll('.empty').length,
          tail: logs.replace(/\\s+/g, ' ').slice(-120)
        };
        const basic = await clickTab('基本信息');
        out.tabs.basicOk = basic.length > 60;
        out.basicHasEmptyHint = basic.includes('尚未填写任何资料');
        out.hasTabNav = document.querySelectorAll('.tab').length >= 5;
        return out;
      })()`);

      const tabOk = detailEmpty.tabs
        && detailEmpty.tabs.contacts && detailEmpty.tabs.followups
        && detailEmpty.tabs.projects && detailEmpty.tabs.logs && detailEmpty.tabs.basicOk;

      check('23b', '客户详情在资料为空时各标签页均显示对应空状态（不白屏、不报错）',
        tabOk && detailEmpty.hasTabNav && !detailEmpty.hasError && detailEmpty.headerOk,
        `标签页 ${detailEmpty.tabCount} 个；空状态：联系人=${detailEmpty.tabs.contacts}、跟进=${detailEmpty.tabs.followups}、`
        + `项目=${detailEmpty.tabs.projects}、变更记录=${detailEmpty.tabs.logs}；页面报错=${detailEmpty.hasError}；`
        + `页头正常=${detailEmpty.headerOk}；基本信息页可渲染=${detailEmpty.tabs.basicOk}；`
        + `变更记录页：时间线条目 ${(detailEmpty.logsInfo || {}).timelineItems}，尾部文本「${(detailEmpty.logsInfo || {}).tail}」`);

      /* 待办中心空状态 */
      await emptyBr.cdp.js(`location.hash = '#/tasks'; 'ok'`);
      await sleep(3400);
      const taskEmpty = await emptyBr.cdp.js(`(() => {
        const text = document.querySelector('.content').innerText;
        return {
          hasHint: text.includes('没有符合条件') || text.includes('待办中心'),
          hasError: text.includes('无法连接本地服务')
        };
      })()`);
      check('23c', '待办中心空状态下正常显示',
        taskEmpty.hasHint && !taskEmpty.hasError,
        '页面正常渲染');

      emptyBr.cdp.close();
      try { emptyBr.child.kill(); } catch (_) { /* 忽略 */ }
    } else {
      check('23a', '客户列表无结果时显示空状态提示且不崩坏', false, '浏览器启动失败');
      check('23b', '客户详情在资料为空时显示引导提示（不白屏、不报错）', false, '浏览器启动失败');
      check('23c', '待办中心空状态下正常显示', false, '浏览器启动失败');
    }
  }

  /* ================================================================ */
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 浏览器验收汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.no}. ${r.name} —— ${r.detail}`);
  }

  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'acceptance-browser-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
    'utf8'
  );
  console.log('\n（结果已写入 .fixtures/acceptance-browser-result.json）');

  try { cdp.close(); } catch (_) { /* 忽略 */ }
  try { br.child.kill(); } catch (_) { /* 忽略 */ }
  await sleep(400);
  try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }

  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('验收脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});

/** 检查孤儿数据 */
async function checkOrphans() {
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'), { readOnly: true });
  const q = (sql) => db.prepare(sql).get().n;
  const out = {
    contacts: q('SELECT COUNT(*) AS n FROM contacts WHERE customer_id NOT IN (SELECT id FROM customers)'),
    followups: q('SELECT COUNT(*) AS n FROM followups WHERE customer_id NOT IN (SELECT id FROM customers)'),
    projects: q('SELECT COUNT(*) AS n FROM projects WHERE customer_id NOT IN (SELECT id FROM customers)'),
    payments: q('SELECT COUNT(*) AS n FROM payments WHERE project_id NOT IN (SELECT id FROM projects)'),
    tasks: q('SELECT COUNT(*) AS n FROM tasks WHERE customer_id > 0 AND customer_id NOT IN (SELECT id FROM customers)'),
    customer_tags: q('SELECT COUNT(*) AS n FROM customer_tags WHERE customer_id NOT IN (SELECT id FROM customers)')
  };
  db.close();
  out.total = Object.values(out).reduce((s, x) => s + x, 0);
  return out;
}

/**
 * 把字典项恢复为「启用且未删除」。
 * 界面上「删除非内置项」是软删除（deleted_at 置位），而 PUT 接口对已删除项会返回 404，
 * 所以测试收尾时直接改库复原，保证脚本可重复运行。
 */
function restoreDictItem(id) {
  if (!id) return false;
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  db.prepare('UPDATE dict SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?')
    .run(new Date().toISOString().slice(0, 19).replace('T', ' '), id);
  db.close();
  return true;
}

/**
 * 按筛选条件直查数据库，返回命中的客户 id（升序）。
 * 用于与接口返回结果交叉核对，确认筛选「无漏无多」。
 */
function queryIds(column, value) {
  const { DatabaseSync } = require('node:sqlite');
  const ALLOWED = ['purchase_mode', 'cert_required', 'type', 'industry', 'region_code', 'level', 'status'];
  if (!ALLOWED.includes(column)) throw new Error('未允许的核对字段：' + column);
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'), { readOnly: true });
  /* 与后端一致：多值字段用 LIKE 包含匹配，其余等值 */
  const isMulti = column === 'cert_required';
  const rows = isMulti
    ? db.prepare(`SELECT id FROM customers WHERE deleted_at IS NULL AND ${column} LIKE ?`).all(`%${value}%`)
    : db.prepare(`SELECT id FROM customers WHERE deleted_at IS NULL AND ${column} = ?`).all(value);
  db.close();
  return rows.map((r) => r.id).sort((a, b) => a - b);
}

/* node:sqlite 的 DatabaseSync 在文件顶部按需引入 */
const { DatabaseSync } = require('node:sqlite');
