/**
 * 报价自定义列 全流程测试
 *
 * 覆盖：
 *   A. 接口：列定义 CRUD（任意列名、类型、单位、候选值、排序、启用、删除、重名与非法值拦截）
 *   B. 接口：报价明细带自定义列保存 → 读回逐值比对（**数据库能不能跑通**的核心验证）
 *   C. 接口：规模验证（40 列 × 20 行 = 800 个值，存进去再读回来必须一字不差）
 *   D. 接口：模板联动（沉淀为模板 / 套用模板都带自定义列；改名不丢值；删列不删值）
 *   E. 接口：导出数据包含自定义列（只带有值的列，带单位，键为列名）
 *   F. 浏览器：报价单抽屉里的「自定义列」按钮能打开列管理、加列后表头即时出现、填值能存能回显
 *   G. 浏览器：报价模板页同样支持自定义列
 *
 * 说明：自定义列是**全局配置**（不是测试数据），所以本套件建的列一律带
 * 「【列测试<tag>】」前缀，并在 finally 里删干净，绝不碰使用者自己建的列。
 *
 * 用法：先启动服务，再 node tools/test-quotation-custom-fields.js
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
const check = (name, pass, detail) => {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
};

async function api(method, p, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const j = await res.json().catch(() => null);
  return { status: res.status, data: j && j.data, code: j && j.code, message: j && j.message };
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
const P = `【列测试${tag}】`;                       // 列名前缀：便于识别与清理
const CUSTOMER_NAME = `【列测试${tag}】某某化工`;
const TPL_NAME = `【列测试${tag}】自定义列模板`;

/** 使用者点名的 14 个列（测试里带前缀建同名结构，避免动到他可能已建的同名列） */
const USER_COLUMNS = [
  { name: '介质', kind: 'text' },
  { name: '设计压力', kind: 'number', unit: 'MPa' },
  { name: '设计温度', kind: 'number', unit: '℃' },
  { name: '操作压力', kind: 'number', unit: 'MPa' },
  { name: '操作温度', kind: 'number', unit: '℃' },
  { name: '环境温度', kind: 'number', unit: '℃' },
  { name: '泄露等级', kind: 'select', options: 'A级,AA级,B级,C级,D级,E级,F级,G级' },
  { name: '阀门标准', kind: 'select', options: 'GB,API 6D,ANSI/ASME,DIN' },
  { name: '执行器型号', kind: 'text' },
  { name: '定位器', kind: 'text' },
  { name: '电磁阀', kind: 'text' },
  { name: '限位开关', kind: 'text' },
  { name: '过滤减压阀', kind: 'text' },
  { name: '气控阀', kind: 'text' }
];

(async () => {
  console.log('=== 报价自定义列 全流程测试 ===\n');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const created = { customer: null, project: null, quotations: [], templates: [], fields: [] };
  let cdp = null, child = null, profile = null;
  /* 套件开跑时的列顺序（本套件会加很多临时列，跑完要把顺序也还原干净） */
  const orderAtStart = (await api('GET', '/api/quotation-fields/order')).data.order;

  const dropFields = () => {
    try {
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'quotation_field' AND entity_id IN (SELECT id FROM quotation_fields WHERE name LIKE ?)").run(`%${P}%`);
      db.prepare('DELETE FROM quotation_fields WHERE name LIKE ?').run(`%${P}%`);
    } catch (_) { /* 忽略 */ }
  };

  try {
    /* 开跑前清上一轮残留（套件中途失败时清理段不会执行） */
    {
      const staleF = db.prepare('SELECT COUNT(*) AS n FROM quotation_fields WHERE name LIKE ?').get(`%【列测试%`).n;
      dropFields();
      const stale = db.prepare('SELECT id FROM customers WHERE name LIKE ?').all('%【列测试%').map((r) => r.id);
      for (const cid of stale) {
        const pids = db.prepare('SELECT id FROM projects WHERE customer_id = ?').all(cid).map((r) => r.id);
        for (const pid of pids) {
          db.prepare('DELETE FROM quotation_items WHERE quotation_id IN (SELECT id FROM quotations WHERE project_id = ?)').run(pid);
          db.prepare('DELETE FROM quotations WHERE project_id = ?').run(pid);
          db.prepare('DELETE FROM payments WHERE project_id = ?').run(pid);
          db.prepare('DELETE FROM tasks WHERE project_id = ?').run(pid);
          db.prepare('DELETE FROM projects WHERE id = ?').run(pid);
        }
        for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
          db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(cid);
        }
        db.prepare('DELETE FROM customers WHERE id = ?').run(cid);
      }
      const staleTpl = db.prepare('SELECT id FROM quotation_templates WHERE name LIKE ?').all('%【列测试%').map((r) => r.id);
      for (const tid of staleTpl) {
        db.prepare('DELETE FROM quotation_template_items WHERE template_id = ?').run(tid);
        db.prepare('DELETE FROM quotation_templates WHERE id = ?').run(tid);
      }
      if (staleF || stale.length || staleTpl.length) {
        console.log(`（已清理上一轮残留：列 ${staleF}、客户 ${stale.length}、模板 ${staleTpl.length}）\n`);
      }
    }

    /* ================= A. 列定义 CRUD ================= */
    const l0 = await api('GET', '/api/quotation-fields');
    check('接口：列清单接口可用，并返回支持的类型与上限',
      l0.status === 200 && Array.isArray(l0.data.kinds) && l0.data.limits && l0.data.limits.maxFields > 0,
      `类型 ${(l0.data.kinds || []).join('/')}，上限 ${l0.data.limits && l0.data.limits.maxFields} 列`);

    const before = l0.data.total;

    /* 一次把使用者点名的 14 个列都建出来 */
    const builtIds = [];
    let buildFail = '';
    for (const c of USER_COLUMNS) {
      const r = await api('POST', '/api/quotation-fields', {
        name: P + c.name, kind: c.kind, unit: c.unit || '', options: c.options || ''
      });
      if (r.status === 200 && r.data && r.data.id) {
        builtIds.push(r.data.id);
        created.fields.push(r.data.id);
      } else {
        buildFail = `${c.name}:${r.code || r.status}`;
        break;
      }
    }
    check(`接口：一次建出使用者点名的 ${USER_COLUMNS.length} 个自定义列（介质/设计压力/设计温度/…/气控阀）`,
      !buildFail && builtIds.length === USER_COLUMNS.length,
      buildFail || `共建 ${builtIds.length} 列`);

    const l1 = await api('GET', '/api/quotation-fields');
    const mine = l1.data.list.filter((f) => String(f.name).startsWith(P));
    check('接口：新建的列按 sort 顺序返回，顺序与添加顺序一致',
      mine.length === USER_COLUMNS.length
      && mine.every((f, i) => f.name === P + USER_COLUMNS[i].name),
      mine.map((f) => f.name.replace(P, '')).join('、'));

    const leak = mine.find((f) => f.name === P + '泄露等级');
    check('接口：下拉候选值被拆成数组（8 项）',
      leak && Array.isArray(leak.options_list) && leak.options_list.length === 8,
      leak ? leak.options_list.join(',') : '未找到');

    /* 非法输入拦截 */
    const dup = await api('POST', '/api/quotation-fields', { name: P + '介质' });
    check('接口：同名列被拒（400 NAME_DUPLICATED）',
      dup.status === 400 && dup.code === 'NAME_DUPLICATED', `${dup.status} ${dup.code}`);

    const badKind = await api('POST', '/api/quotation-fields', { name: P + '类型错', kind: 'rich-text' });
    check('接口：非法列类型被拒（400 BAD_KIND）',
      badKind.status === 400 && badKind.code === 'BAD_KIND', `${badKind.status} ${badKind.code}`);

    const noName = await api('POST', '/api/quotation-fields', { name: '   ' });
    check('接口：空列名被拒（400 NAME_REQUIRED）',
      noName.status === 400 && noName.code === 'NAME_REQUIRED', `${noName.status} ${noName.code}`);

    /* 列名允许的写法：括号、斜杠、空格、井号都行（列名不设字符白名单，只限长度） */
    const weirdName = `${P}压(设/操)#1`;   // 注意列名上限 20 字，测试前缀已占 11 字
    const weird = await api('POST', '/api/quotation-fields', { name: weirdName, kind: 'text' });
    if (weird.status === 200) created.fields.push(weird.data.id);
    check('接口：列名允许括号、斜杠、空格、井号等任意写法',
      weird.status === 200 && weird.data.created === true, `${weird.status} ${weird.code || ''}`);

    const tooLong = await api('POST', '/api/quotation-fields', { name: 'x'.repeat(21) });
    check('接口：超长列名被拒并说明长度上限（400 NAME_TOO_LONG）',
      tooLong.status === 400 && tooLong.code === 'NAME_TOO_LONG' && /20/.test(tooLong.message || ''),
      `${tooLong.status} ${tooLong.code}：${tooLong.message}`);

    /* 排序：现在调的是**全局列顺序**（内置列与自定义列同一套），不再是列自己的 sort */
    const firstId = builtIds[0];
    const key0 = 'f:' + firstId;
    const orderBefore = (await api('GET', '/api/quotation-fields/order')).data.order;
    const mvDown = await api('POST', `/api/quotation-fields/${firstId}/move`, { dir: 'down' });
    const orderAfter = mvDown.data.order;
    check('接口：自定义列可在全局列序里下移一位',
      mvDown.data.moved === true && orderAfter.indexOf(key0) === orderBefore.indexOf(key0) + 1,
      `位置 ${orderBefore.indexOf(key0)} → ${orderAfter.indexOf(key0)}`);

    /* 一路左移到第一位：证明自定义列可以越过内置列（"所有列一视同仁"） */
    let orderUp = mvDown.data.order;
    let guard = 0;
    while (guard++ < 80) {
      const r = await api('POST', '/api/quotation-fields/move', { key: key0, dir: 'up' });
      if (!r.data.moved) break;
      orderUp = r.data.order;
    }
    check('接口：自定义列可以一路移到内置列前面（所有列一视同仁）',
      orderUp[0] === key0 && orderUp.indexOf(key0) < orderUp.indexOf('connection_type'),
      `自定义列位置 ${orderUp.indexOf(key0)}，连接列位置 ${orderUp.indexOf('connection_type')}`);

    const mvTop = await api('POST', '/api/quotation-fields/move', { key: key0, dir: 'up' });
    check('接口：第一列再往前会给出「已经在最前面」提示而不是静默失败',
      mvTop.data.moved === false && /最前/.test(mvTop.data.message || ''), mvTop.data.message);
    /* 把列序恢复成本段测试开始前的样子，免得影响后面的断言 */
    await api('POST', '/api/quotation-fields/order', { order: orderBefore });

    /* 改名 + 停用 */
    const rename = await api('PUT', `/api/quotation-fields/${leak.id}`, { name: `${P}泄漏等级` });
    check('接口：列可以改名（泄露等级 → 泄漏等级）',
      rename.status === 200 && rename.data.name === `${P}泄漏等级`, `${rename.status}`);

    const disable = await api('PUT', `/api/quotation-fields/${firstId}`, { enabled: 0 });
    const l3 = await api('GET', '/api/quotation-fields?enabled=1');
    check('接口：停用的列不出现在「仅启用」列表里',
      disable.status === 200 && !l3.data.list.some((f) => f.id === firstId),
      `仅启用 ${l3.data.list.filter((f) => String(f.name).startsWith(P)).length} 列`);
    await api('PUT', `/api/quotation-fields/${firstId}`, { enabled: 1 });

    /* ================= B. 报价明细带自定义列 ================= */
    const cust = await api('POST', '/api/customers', {
      name: CUSTOMER_NAME, short_name: `列测试客户${tag}`, type: '终端用户', industry: '化工'
    });
    created.customer = cust.data.id;
    const proj = await api('POST', '/api/projects', {
      name: `【列测试${tag}】阀门采购`, customer_id: created.customer, stage: '询价报价'
    });
    created.project = proj.data.id;
    console.log(`\n已造客户 #${created.customer} 与项目 #${created.project}\n`);

    /* 用列 id 组织每行的值：列名 → id。
       注意用**建列时返回的 id 顺序**来对应，而不是按当前名字去查 ——
       上面刚把「泄露等级」改名成「泄漏等级」，按名字查会漏掉这一列。 */
    const idByName = {};
    USER_COLUMNS.forEach((c, i) => { idByName[c.name] = builtIds[i]; });

    const rowExtra = (row) => {
      const o = {};
      for (const c of USER_COLUMNS) {
        const id = idByName[c.name];
        o[id] = c.kind === 'number' ? String(row * 10) : `${c.name}-第${row}行`;
      }
      return o;
    };

    const q1 = await api('POST', '/api/quotations', {
      project_id: created.project,
      remark: '自定义列读写验证',
      items: [1, 2, 3].map((n) => ({
        item_name: `球阀${n}`, valve_type: '球阀', size_range: `DN${n * 50}`,
        quantity: n, unit_price: 1000 * n, extra: rowExtra(n)
      }))
    });
    created.quotations.push(q1.data.id);
    check('接口：带 14 个自定义列的报价单能保存（金额仍由服务端算）',
      q1.status === 200 && q1.data.item_count === 3 && q1.data.total_amount === 1000 + 4000 + 9000,
      `行数 ${q1.data.item_count}，合计 ${q1.data.total_amount}`);

    const got = await api('GET', `/api/quotations/${q1.data.id}`);
    let mismatch = null;
    for (const it of got.data.items) {
      const n = it.seq;
      for (const c of USER_COLUMNS) {
        const want = c.kind === 'number' ? String(n * 10) : `${c.name}-第${n}行`;
        const have = it.extra[String(idByName[c.name])];
        if (have !== want) { mismatch = `第${n}行「${c.name}」期望 ${want} 实得 ${have}`; break; }
      }
      if (mismatch) break;
    }
    check('接口：14 列 × 3 行的值全部原样读回（数据库读写跑通）',
      !mismatch, mismatch || `共核对 ${14 * 3} 个值`);

    /* 脏值处理：不存在的列 id、空值、超长值 */
    const dirty = await api('POST', '/api/quotations', {
      project_id: created.project,
      items: [{
        item_name: '脏值行', quantity: 1, unit_price: 10,
        extra: Object.assign({
          999999999: '这一列不存在，应被丢弃',
          [String(idByName['介质'])]: '   ',
          [String(idByName['定位器'])]: 'x'.repeat(500)
        })
      }]
    });
    created.quotations.push(dirty.data.id);
    const dirtyGot = await api('GET', `/api/quotations/${dirty.data.id}`);
    const de = dirtyGot.data.items[0].extra;
    check('接口：不存在的列 id 被丢弃（不会写进库里）',
      de['999999999'] === undefined, JSON.stringify(Object.keys(de)));
    check('接口：空值不落库（extra 里不留空键）',
      de[String(idByName['介质'])] === undefined, JSON.stringify(de));
    check('接口：超长值被截断到 200 字而不是写坏数据',
      de[String(idByName['定位器'])] && de[String(idByName['定位器'])].length === 200,
      `长度 ${de[String(idByName['定位器'])] ? de[String(idByName['定位器'])].length : '无'}`);

    /* ================= C. 规模验证 ================= */
    const limits = (await api('GET', '/api/quotation-fields')).data.limits;
    const usedNow = (await api('GET', '/api/quotation-fields')).data.total;
    const budget = Math.max(0, limits.maxFields - usedNow - 1);
    const bulkCount = Math.min(26, budget);   // 14 + 26 = 40 列
    const bulkIds = [];
    for (let i = 1; i <= bulkCount; i++) {
      const r = await api('POST', '/api/quotation-fields', { name: `${P}批量列${String(i).padStart(2, '0')}`, kind: 'text' });
      if (r.status === 200) { bulkIds.push(r.data.id); created.fields.push(r.data.id); }
    }
    check(`接口：可以继续扩列（本次再扩 ${bulkCount} 列，合计 ${USER_COLUMNS.length + bulkCount + 1} 列）`,
      bulkIds.length === bulkCount && bulkCount >= 20,
      `成功 ${bulkIds.length} 列，剩余额度 ${budget}`);

    /* 40 列 × 20 行 = 800 个值 */
    const allIds = [...USER_COLUMNS.map((c) => idByName[c.name]), ...bulkIds];
    const bigItems = [];
    for (let row = 1; row <= 20; row++) {
      const extra = {};
      for (let k = 0; k < allIds.length; k++) extra[String(allIds[k])] = `R${row}C${k}`;
      bigItems.push({ item_name: `批量阀${row}`, quantity: 1, unit_price: 100, extra });
    }
    const t0 = Date.now();
    const big = await api('POST', '/api/quotations', { project_id: created.project, remark: '规模验证', items: bigItems });
    const saveMs = Date.now() - t0;
    created.quotations.push(big.data.id);
    const bigGot = await api('GET', `/api/quotations/${big.data.id}`);
    let bigBad = 0;
    for (const it of bigGot.data.items) {
      for (let k = 0; k < allIds.length; k++) {
        if (it.extra[String(allIds[k])] !== `R${it.seq}C${k}`) bigBad++;
      }
    }
    const cells = 20 * allIds.length;
    check(`接口：${allIds.length} 列 × 20 行 = ${cells} 个值全部正确落库并读回`,
      bigBad === 0 && bigGot.data.items.length === 20 && bigGot.data.total_amount === 2000,
      `错值 ${bigBad} 个；写入耗时 ${saveMs} ms；合计 ${bigGot.data.total_amount}`);

    const rawLen = db.prepare('SELECT LENGTH(extra) AS n FROM quotation_items WHERE quotation_id = ? LIMIT 1').get(big.data.id).n;
    check('接口：明细行 extra 以 JSON 存储（未膨胀成列）',
      rawLen > 100 && rawLen < 4000, `单行 extra JSON 长度 ${rawLen} 字`);

    /* 复制新版本：自定义列一并带走 */
    const copied = await api('POST', `/api/quotations/${q1.data.id}/copy`);
    created.quotations.push(copied.data.id);
    const copiedGot = await api('GET', `/api/quotations/${copied.data.id}`);
    check('接口：报价单复制为新版本时自定义列一并复制',
      copiedGot.data.items.length === 3
      && copiedGot.data.items[0].extra[String(idByName['介质'])] === '介质-第1行'
      && copiedGot.data.items[2].extra[String(idByName['执行器型号'])] === '执行器型号-第3行',
      `新版本 V${copiedGot.data.version}，首行介质=${copiedGot.data.items[0].extra[String(idByName['介质'])]}`);

    /* 编辑：改数量不该动自定义列 */
    const edited = await api('PUT', `/api/quotations/${q1.data.id}`, {
      project_id: created.project,
      items: got.data.items.map((it) => Object.assign({}, it, { quantity: Number(it.quantity) + 1 }))
    });
    const editedGot = await api('GET', `/api/quotations/${q1.data.id}`);
    check('接口：覆盖保存（改数量）后自定义列的值不变',
      edited.status === 200
      && editedGot.data.items[0].extra[String(idByName['介质'])] === '介质-第1行'
      && editedGot.data.items[1].extra[String(idByName['阀门标准'])] === '阀门标准-第2行',
      `合计 ${editedGot.data.total_amount}`);

    /* ================= D. 模板联动 ================= */
    const from = await api('POST', `/api/quotation-templates/from-quotation/${q1.data.id}`, { name: TPL_NAME });
    created.templates.push(from.data.id);
    const tplGot = await api('GET', `/api/quotation-templates/${from.data.id}`);
    check('接口：报价单沉淀为模板时自定义列一起沉淀',
      tplGot.data.items.length === 3
      && tplGot.data.items[0].extra[String(idByName['介质'])] === '介质-第1行'
      && tplGot.data.items[0].unit_price === undefined,
      `模板 ${tplGot.data.items.length} 行，首行介质=${tplGot.data.items[0].extra[String(idByName['介质'])]}`);

    const applied = await api('POST', `/api/quotation-templates/${from.data.id}/apply`);
    check('接口：套用模板时自定义列的值一起带出（价格仍留空）',
      applied.status === 200 && applied.data.items.length === 3
      && applied.data.items[0].extra[String(idByName['介质'])] === '介质-第1行'
      && applied.data.items[0].unit_price === '',
      `首行介质=${applied.data.items[0].extra[String(idByName['介质'])]}，单价=${JSON.stringify(applied.data.items[0].unit_price)}`);

    /* 改名不丢值：改「介质」的列名后，报价单与模板里的值仍应显示在新列名下 */
    await api('PUT', `/api/quotation-fields/${idByName['介质']}`, { name: `${P}介质（工况）` });
    const afterRename = await api('GET', `/api/quotations/${q1.data.id}`);
    const tplAfterRename = await api('GET', `/api/quotation-templates/${from.data.id}`);
    check('接口：列改名后，报价单里的值仍挂在这一列上（改名不丢值）',
      afterRename.data.items[0].extra[String(idByName['介质'])] === '介质-第1行',
      `值=${afterRename.data.items[0].extra[String(idByName['介质'])]}`);
    check('接口：列改名后，模板里的值同样还在',
      tplAfterRename.data.items[0].extra[String(idByName['介质'])] === '介质-第1行');

    /* 停用不丢值 */
    await api('PUT', `/api/quotation-fields/${idByName['定位器']}`, { enabled: 0 });
    const afterDisable = await api('GET', `/api/quotations/${q1.data.id}`);
    check('接口：停用一列后，已有报价单里的值仍保留（只是界面不显示）',
      afterDisable.data.items[0].extra[String(idByName['定位器'])] === '定位器-第1行');
    await api('PUT', `/api/quotation-fields/${idByName['定位器']}`, { enabled: 1 });

    /* 删除列：值留在明细里，列不再出现在清单 */
    const delId = idByName['气控阀'];
    const del = await api('DELETE', `/api/quotation-fields/${delId}`);
    created.fields = created.fields.filter((x) => x !== delId);
    const afterDel = await api('GET', `/api/quotations/${q1.data.id}`);
    const listAfterDel = await api('GET', '/api/quotation-fields');
    check('接口：删除列时返回影响面（used_in 统计）',
      del.status === 200 && typeof del.data.used_in === 'number' && del.data.used_in >= 1,
      `影响 ${del.data.used_in} 张报价单、${del.data.used_in_templates} 个模板`);
    check('接口：删列后该列不再出现在清单里',
      !listAfterDel.data.list.some((f) => f.id === delId));
    check('接口：删列后历史报价单里的值仍在（只是取不到列定义）',
      afterDel.data.items[0].extra[String(delId)] === '气控阀-第1行',
      `值=${afterDel.data.items[0].extra[String(delId)]}`);

    /* 但此时重新保存该报价单，这个"孤儿值"会被自然清掉 */
    await api('PUT', `/api/quotations/${q1.data.id}`, {
      project_id: created.project,
      items: afterDel.data.items.map((it) => ({ item_name: it.item_name, quantity: it.quantity, unit_price: it.unit_price, extra: it.extra }))
    });
    const afterRe = await api('GET', `/api/quotations/${q1.data.id}`);
    check('接口：列删除后再保存，孤儿值被自然清理（不留脏数据）',
      afterRe.data.items[0].extra[String(delId)] === undefined);

    /* ================= E. 导出 ================= */
    const exp = await api('GET', `/api/quotations/${q1.data.id}/export`);
    const cc = exp.data.custom_columns || [];
    check('接口：导出数据带上自定义列（只含有值的列，带单位，按列顺序）',
      cc.length >= 10 && cc.every((c) => c.name && typeof c.unit === 'string')
      && cc.some((c) => c.unit === 'MPa'),
      `导出 ${cc.length} 个自定义列：${cc.slice(0, 5).map((c) => c.name.replace(P, '')).join('、')}…`);
    check('接口：导出数据里每行的自定义列以列名为键（便于直接排版）',
      exp.data.items[0].extra[`${P}设计压力`] === '10' && exp.data.items[0].extra[`${P}介质（工况）`] === '介质-第1行',
      JSON.stringify(Object.keys(exp.data.items[0].extra).slice(0, 3).map((k) => k.replace(P, ''))));

    /* 真出一份 xlsx，再读回来 —— 验证 40 列自定义列真的排进单据（不是只验证数据结构）。
       xlsx 是 zip，不能搜二进制；这里用 SheetJS 读回内容。 */
    {
      const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));
      const { buildWorkbookAoa } = require('./.fixtures/quotation-export');
      const bigExp = await api('GET', `/api/quotations/${big.data.id}/export`);
      const buf = buildWorkbookAoa(bigExp.data, XLSX);
      const wb = XLSX.read(buf, { type: 'buffer' });
      const rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, blankrows: false });
      const head = rows.find((r) => r[0] === '序号') || [];
      const rowIdx = rows.findIndex((r) => r[0] === '序号');
      const firstData = rows[rowIdx + 1] || [];
      const headNames = head.map(String);
      /* 单据列按**全局列顺序**排，自定义列可能夹在内置列之间，
         所以按列名定位，而不是假定它们连在某一列后面 */
      const customLabels = (bigExp.data.custom_columns || []).map((c) => (c.unit ? `${c.name}（${c.unit}）` : c.name));
      const idxs = customLabels.map((l) => headNames.indexOf(l));
      const customCells = idxs.map((i) => (i > 0 ? firstData[i] : undefined));
      const sumIdx = headNames.indexOf('小计(元)');
      /* 注意期望是 39 而不是 40：上面测过「删除列」，「气控阀」那一列已删，
         它的值在保存时被自然清理，所以单据里只应出现剩下 39 列 */
      check('导出：真出一份 xlsx 并能读回，单据表头包含全部自定义列',
        customLabels.length === 39 && idxs.every((i) => i > 0)
        && !headNames.some((h) => h.includes('气控阀')),
        `表头共 ${headNames.length} 列，自定义列 ${customLabels.length} 个：${customLabels.slice(0, 3).join(' / ')}…`);
      check('导出：xlsx 明细行里的自定义列值正确落格（39 个值一个不少）',
        customCells.length === 39 && new Set(customCells).size === 39
        && customCells.every((v) => /^R1C\d+$/.test(String(v)))
        && firstData[sumIdx] === '100.00',
        `自定义列 ${customCells.length} 格，首格 ${customCells[0]}，小计 ${firstData[sumIdx]}`);
      /* 列宽要按 xlsx 内部 XML 判断（SheetJS 读回时不还原 !cols） */
      const { readXlsxParts } = require('./.fixtures/xlsx-inspect');
      const parts = readXlsxParts(buf);
      check('导出：xlsx 列宽随自定义列数量扩展',
        parts.hasCols && parts.colWidths.length === headNames.length,
        `列宽定义 ${parts.colWidths.length} 项（表头 ${headNames.length} 列）`);
    }

    /* ================= F. 浏览器：报价单抽屉 ================= */
    if (!CHROME) {
      check('浏览器：找到 Chrome 可执行文件', false, '未找到 chrome.exe');
    } else {
      profile = fs.mkdtempSync(path.join(os.tmpdir(), 'qfcust-'));
      const PORT = 9412;
      child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
        `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1700,1100', 'about:blank'],
      { stdio: 'ignore' });
      for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
      const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
      cdp = new CDP(tab.webSocketDebuggerUrl);
      await cdp.connect();
      await cdp.send('Runtime.enable');

      /* 打开项目详情 → 报价单标签 → 新建报价单 */
      await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/projects/' + created.project)}; 'ok'`);
      await sleep(4200);

      const openDrawer = await cdp.js(`(async () => {
        const t = [...document.querySelectorAll('.tabs .tab')].find(x => x.textContent.includes('报价单'));
        if (!t) return { err: '未找到报价单标签' };
        t.click();
        await new Promise(r => setTimeout(r, 900));
        const nb = [...document.querySelectorAll('button')].find(x => x.textContent.includes('新建报价单'));
        if (!nb) return { err: '未找到新建报价单按钮' };
        nb.click();
        await new Promise(r => setTimeout(r, 1800));
        const d = [...document.querySelectorAll('.drawer')].pop();
        if (!d) return { err: '抽屉未打开' };
        const btn = [...d.querySelectorAll('button')].find(x => x.textContent.includes('自定义列'));
        const heads = [...d.querySelectorAll('.quo-table thead th')].map(x => x.textContent.trim());
        return {
          hasBtn: !!btn,
          btnText: btn ? btn.textContent.trim() : '',
          headCount: heads.length,
          heads: heads.join(' | ')
        };
      })()`);
      check('浏览器：报价单抽屉里有「自定义列」入口',
        !openDrawer.err && openDrawer.hasBtn === true, openDrawer.err || openDrawer.btnText);
      check('浏览器：明细表头已按自定义列展开（自定义列出现在明细表头里）',
        !openDrawer.err && openDrawer.heads.includes(`${P}介质`) && openDrawer.heads.includes(`${P}设计压力`),
        openDrawer.err || `${openDrawer.headCount} 个表头`);

      /* 打开列管理抽屉：常用列快捷区 + 新增一列。
         注意：列管理挂在应用根节点、在 DOM 里排在页面抽屉**之后**，
         所以用标题定位，而不是简单地取最后一个 .drawer。 */
      const manager = await cdp.js(`(async () => {
        const d = [...document.querySelectorAll('.drawer')].pop();
        const btn = [...d.querySelectorAll('button')].find(x => x.textContent.includes('自定义列'));
        btn.click();
        await new Promise(r => setTimeout(r, 1600));
        const mgr = [...document.querySelectorAll('.drawer')]
          .find(x => ((x.querySelector('.drawer-title') || {}).textContent || '').includes('报价自定义列'));
        if (!mgr) return { err: '列管理抽屉未打开' };
        const chips = [...mgr.querySelectorAll('.qf-chip')].map(x => x.textContent.trim());
        const rows = [...mgr.querySelectorAll('.qf-table tbody tr')].length;
        const hasAdd = !!mgr.querySelector('.qf-add-row input');
        const text = mgr.innerText;
        return {
          title: (mgr.querySelector('.drawer-title') || {}).textContent || '',
          chips, rows, hasAdd,
          mentionsOrder: /列顺序/.test(text),
          hasBuiltinTag: /内置/.test(text)
        };
      })()`);
      /* 常用列区只列「还没添加过」的预设：使用者若已把预设都加过，这里就该是空的
         （点了也只会多出一列同名重复列，所以干脆不提示） */
      const PRESET_NAMES = ['介质', '设计压力', '设计温度', '操作压力', '操作温度', '环境温度',
        '泄露等级', '阀门标准', '执行器型号', '定位器', '电磁阀', '限位开关', '过滤减压阀', '气控阀'];
      const allNames = ((await api('GET', '/api/quotation-fields')).data.list || []).map((f) => f.name);
      const expectLeft = PRESET_NAMES.filter((n) => !allNames.includes(n)).map((n) => n.replace(P, '')).length;
      check('浏览器：列管理抽屉能打开，常用列区只列还没添加过的预设（不重复提示）',
        manager.title.includes('自定义列') && (manager.chips || []).length === expectLeft,
        `${manager.title}；快捷列 ${(manager.chips || []).length} 个（应为 ${expectLeft} 个）`);
      check('浏览器：列管理里能看到已有列、提供「新增一列」，并说明了列顺序',
        manager.rows >= 15 && manager.hasAdd === true && manager.mentionsOrder === true,
        `已有 ${manager.rows} 行，新增区=${manager.hasAdd}，说明列顺序=${manager.mentionsOrder}`);
      check('浏览器：列管理里内置列带「内置」标注（可移动但不可改名/删除）',
        manager.hasBuiltinTag === true, `内置标注=${manager.hasBuiltinTag}`);

      /* 在列管理里新增一列，明细表头应即时出现 */
      const UI_COL = `${P}UI新增列`;
      const addViaUi = await cdp.js(`(async () => {
        const mgr = [...document.querySelectorAll('.drawer')]
          .find(x => ((x.querySelector('.drawer-title') || {}).textContent || '').includes('报价自定义列'));
        if (!mgr) return { err: '列管理抽屉不在' };
        const inp = mgr.querySelector('.qf-add-row input');
        inp.value = ${JSON.stringify(UI_COL)};
        inp.dispatchEvent(new Event('input', { bubbles: true }));
        const b = [...mgr.querySelectorAll('button')].find(x => x.textContent.includes('添加这一列'));
        b.click();
        await new Promise(r => setTimeout(r, 2200));
        const heads = [...mgr.querySelectorAll('.qf-table thead th')].length
          ? [...document.querySelectorAll('.quo-table thead th')].map(x => x.textContent.trim())
          : [];
        return {
          inTable: heads.some(h => h.includes(${JSON.stringify(UI_COL)})),
          inManager: [...mgr.querySelectorAll('.qf-table tbody tr input')].some(i => i.value === ${JSON.stringify(UI_COL)}),
          heads: heads.length
        };
      })()`);
      check('浏览器：在列管理里新增一列后，报价明细表头即时出现该列',
        !addViaUi.err && addViaUi.inTable === true && addViaUi.inManager === true,
        addViaUi.err || `表头 ${addViaUi.heads} 个，列管理里已出现=${addViaUi.inManager}`);
      const uiAdded = db.prepare('SELECT id FROM quotation_fields WHERE name = ? AND deleted_at IS NULL').get(UI_COL);
      if (uiAdded) created.fields.push(uiAdded.id);

      /* 关掉列管理，在明细里填自定义列的值并保存 */
      const fillAndSave = await cdp.js(`(async () => {
        /* 关掉列管理抽屉（按标题定位：它在 DOM 里排在页面抽屉之后） */
        const mgr = [...document.querySelectorAll('.drawer')]
          .find(x => ((x.querySelector('.drawer-title') || {}).textContent || '').includes('报价自定义列'));
        const done = [...mgr.querySelectorAll('.drawer-foot button')].find(x => x.textContent.includes('完成'));
        done.click();
        await new Promise(r => setTimeout(r, 1200));

        const d = [...document.querySelectorAll('.drawer')].pop();
        /* 表头里还带着移动按钮的 ◀ ▶ 字符，比对列名时要先去掉 */
        const heads = [...d.querySelectorAll('.quo-table thead th')]
          .map(x => x.textContent.replace(/[◀▶]/g, '').trim());
        const colIdx = heads.findIndex(h => h.includes(${JSON.stringify(UI_COL)}));
        if (colIdx < 0) return { err: '明细表头里没有刚新增的列' };
        const tr = d.querySelector('.quo-table tbody tr');
        const tds = [...tr.querySelectorAll('td')];
        if (tds.length !== heads.length) return { err: '表头与单元格数量对不上', heads: heads.length, tds: tds.length };
        const setVal = (el, v) => { el.value = v; el.dispatchEvent(new Event('input', { bubbles: true })); };
        setVal(tr.querySelectorAll('input')[0], '界面录入球阀');
        const cell = tds[colIdx].querySelector('input');
        if (!cell) return { err: '这一列没有输入框', colIdx };
        setVal(cell, '界面填的值');
        setVal(tds[heads.indexOf('数量')].querySelector('input'), '3');
        setVal(tds[heads.indexOf('单价(元)')].querySelector('input'), '1500');
        await new Promise(r => setTimeout(r, 400));

        const save = [...d.querySelectorAll('.drawer-foot button')].find(x => x.textContent.includes('保存报价单'));
        save.click();
        await new Promise(r => setTimeout(r, 3000));
        return {
          colIdx,
          saved: ![...document.querySelectorAll('.drawer')].some(x => x.querySelector('.quo-table')),
          toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
        };
      })()`);
      check('浏览器：在明细里填自定义列的值并保存成功',
        !fillAndSave.err && fillAndSave.saved === true,
        fillAndSave.err || `列位置 ${fillAndSave.colIdx}；提示 ${(fillAndSave.toasts || []).join(' / ')}`);

      const uiQ = db.prepare('SELECT id FROM quotations WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(created.project);
      if (uiQ) {
        created.quotations.push(uiQ.id);
        const uiItem = db.prepare('SELECT * FROM quotation_items WHERE quotation_id = ? ORDER BY seq LIMIT 1').get(uiQ.id);
        const uiExtra = JSON.parse(uiItem.extra || '{}');
        const uiField = db.prepare('SELECT id FROM quotation_fields WHERE name = ?').get(UI_COL);
        check('浏览器：界面上填的自定义列值已落库',
          uiField && uiExtra[String(uiField.id)] === '界面填的值' && uiItem.unit_price === 1500,
          `extra=${uiItem.extra}，单价=${uiItem.unit_price}`);
      }

      /* 重开编辑：值应回显（重新进入项目详情页，按单号定位到刚保存的那张单） */
      const uiQuoteNo = uiQ
        ? (db.prepare('SELECT quote_no FROM quotations WHERE id = ?').get(uiQ.id) || {}).quote_no
        : '';
      await cdp.js(`location.hash = ${JSON.stringify('#/projects/' + created.project)}; 'ok'`);
      await sleep(3800);
      const reopen = await cdp.js(`(async () => {
        const t = [...document.querySelectorAll('.tabs .tab')].find(x => x.textContent.includes('报价单'));
        if (!t) return { err: '未找到报价单标签' };
        t.click();
        await new Promise(r => setTimeout(r, 1600));
        const row = [...document.querySelectorAll('.content tbody tr')]
          .find(tr => tr.textContent.includes(${JSON.stringify(uiQuoteNo)}));
        if (!row) return { err: '报价单列表里找不到 ' + ${JSON.stringify(uiQuoteNo)} };
        const edit = [...row.querySelectorAll('button')].find(b => b.textContent.trim() === '编辑');
        if (!edit) return { err: '这一行没有编辑按钮' };
        edit.click();
        await new Promise(r => setTimeout(r, 2400));
        const d = [...document.querySelectorAll('.drawer')].pop();
        if (!d) return { err: '编辑抽屉未打开' };
        const heads = [...d.querySelectorAll('.quo-table thead th')].map(x => x.textContent.trim());
        const colIdx = heads.findIndex(h => h.includes(${JSON.stringify(UI_COL)}));
        if (colIdx < 0) return { err: '编辑抽屉里没有自定义列', heads: heads.join('|') };
        const tr = d.querySelector('.quo-table tbody tr');
        const cell = tr.querySelectorAll('td')[colIdx].querySelector('input');
        const name = tr.querySelectorAll('input')[0].value;
        return { colIdx, value: cell ? cell.value : '(无)', name };
      })()`);
      check('浏览器：重新打开这张报价单，自定义列的值正确回显',
        !reopen.err && reopen.value === '界面填的值' && reopen.name === '界面录入球阀',
        reopen.err || `回显「${reopen.value}」（${reopen.name}）`);

      /* 真调一次页面上的导出函数（不是 Node 侧的镜像实现），确认单据里带上自定义列 */
      const exportUi = await cdp.js(`(async () => {
        const d = await CRM.api.quotationExportData(${uiQ ? uiQ.id : 0});
        const orig = XLSX.writeFile;
        let wb = null;
        XLSX.writeFile = (w) => { wb = w; return true; };   // 拦下写文件，只取工作簿
        try { CRM.quotation.buildWorkbook(d); } finally { XLSX.writeFile = orig; }
        if (!wb) return { err: '未生成工作簿' };
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = XLSX.utils.sheet_to_json(ws, { header: 1, blankrows: false });
        const at = rows.findIndex(r => String(r[0]) === '序号');
        return {
          head: (rows[at] || []).map(String),
          data: (rows[at + 1] || []).map(String)
        };
      })()`);
      check('浏览器：页面上的「导出 Excel 报价单」函数把自定义列排进了单据',
        !exportUi.err && exportUi.head.some((h) => h.includes(`${P}UI新增列`))
        && exportUi.data.includes('界面填的值'),
        exportUi.err || `表头 ${exportUi.head.length} 列：${exportUi.head.slice(0, 5).join(' / ')}…`);

      /* ---------- G. 模板页也支持 ---------- */
      await cdp.js(`location.hash = '#/settings'; 'ok'`);
      await sleep(4200);
      const tplPage = await cdp.js(`(async () => {
        const t = [...document.querySelectorAll('.settings-tabs .tab')].find(x => x.textContent.includes('报价模板'));
        if (!t) return { err: '未找到「报价模板」标签' };
        t.click();
        await new Promise(r => setTimeout(r, 2000));
        const nb = [...document.querySelectorAll('button')].find(b => b.textContent.includes('新建模板'));
        if (!nb) return { err: '未找到新建模板按钮' };
        nb.click();
        await new Promise(r => setTimeout(r, 1800));
        const d = [...document.querySelectorAll('.drawer')].pop();
        if (!d) return { err: '模板抽屉未打开' };
        const btn = [...d.querySelectorAll('button')].find(x => x.textContent.includes('自定义列'));
        const heads = [...d.querySelectorAll('.quo-table thead th')].map(x => x.textContent.trim());
        return {
          hasBtn: !!btn,
          hasCol: heads.some(h => h.includes(${JSON.stringify(P + '介质')})),
          headCount: heads.length
        };
      })()`);
      check('浏览器：报价模板页同样有「自定义列」入口且列已展开',
        !tplPage.err && tplPage.hasBtn === true && tplPage.hasCol === true,
        tplPage.err || `表头 ${tplPage.headCount} 个`);

      check('页面无 JS 报错', cdp.errors.length === 0,
        cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '0 条错误');

      cdp.ws.close();
      child.kill();
      await sleep(400);
      try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
      child = null; profile = null;
    }
  } finally {
    if (child) { try { child.kill(); } catch (_) { /* 忽略 */ } }
    if (profile) { try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ } }

    /* ---------- 清理（无论成败都要把全局配置还原） ---------- */
    for (const qid of created.quotations) {
      await api('DELETE', `/api/quotations/${qid}`).catch(() => {});
      try {
        db.prepare('DELETE FROM quotation_items WHERE quotation_id = ?').run(qid);
        db.prepare("DELETE FROM activity_logs WHERE entity_type = 'quotation' AND entity_id = ?").run(qid);
        db.prepare('DELETE FROM quotations WHERE id = ?').run(qid);
      } catch (_) { /* 忽略 */ }
    }
    for (const tid of created.templates) {
      try {
        db.prepare('DELETE FROM quotation_template_items WHERE template_id = ?').run(tid);
        db.prepare('DELETE FROM quotation_templates WHERE id = ?').run(tid);
      } catch (_) { /* 忽略 */ }
    }
    try {
      db.prepare('DELETE FROM quotation_template_items WHERE template_id IN (SELECT id FROM quotation_templates WHERE name LIKE ?)').run(`%【列测试%`);
      db.prepare('DELETE FROM quotation_templates WHERE name LIKE ?').run(`%【列测试%`);
    } catch (_) { /* 忽略 */ }
    dropFields();
    /* 临时列删掉后，列顺序数组里还会留着它们的 key —— 用套件开跑时的顺序再存一次，
       免得把死 key 留在使用者的设置项里（读取时虽然会过滤，但存着不干净） */
    try {
      await api('POST', '/api/quotation-fields/order', { order: orderAtStart });
    } catch (_) { /* 忽略 */ }
    try {
      if (created.project) {
        db.prepare('DELETE FROM payments WHERE project_id = ?').run(created.project);
        db.prepare('DELETE FROM tasks WHERE project_id = ?').run(created.project);
        db.prepare('DELETE FROM projects WHERE id = ?').run(created.project);
      }
      if (created.customer) {
        for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
          db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(created.customer);
        }
        db.prepare('DELETE FROM customers WHERE id = ?').run(created.customer);
      }
      db.prepare("DELETE FROM activity_logs WHERE entity_type = 'quotation_field' AND entity_id NOT IN (SELECT id FROM quotation_fields)").run();
    } catch (_) { /* 忽略 */ }

    const leftFields = db.prepare('SELECT COUNT(*) AS n FROM quotation_fields WHERE name LIKE ?').get(`%${P}%`).n;
    const leftCust = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?').get('%【列测试%').n;
    const leftProj = db.prepare('SELECT COUNT(*) AS n FROM projects WHERE name LIKE ?').get('%【列测试%').n;
    const leftQuo = created.project
      ? db.prepare('SELECT COUNT(*) AS n FROM quotations WHERE project_id = ?').get(created.project).n : 0;
    const leftTpl = db.prepare('SELECT COUNT(*) AS n FROM quotation_templates WHERE name LIKE ?').get('%【列测试%').n;
    const orderBack = (await api('GET', '/api/quotation-fields/order').catch(() => ({ data: {} }))).data.order || [];
    const storedOrder = db.prepare("SELECT value FROM settings WHERE key = 'quotation_column_order'").get();
    const deadKeys = storedOrder ? JSON.parse(storedOrder.value).filter((k) => k.startsWith('f:')
      && !db.prepare('SELECT 1 AS x FROM quotation_fields WHERE id = ? AND deleted_at IS NULL').get(Number(k.slice(2))))
      : [];
    check('本套件测试数据与自定义列已全部清理',
      leftFields === 0 && leftCust === 0 && leftProj === 0 && leftQuo === 0 && leftTpl === 0,
      `残留：列 ${leftFields}、客户 ${leftCust}、项目 ${leftProj}、报价单 ${leftQuo}、模板 ${leftTpl}`);
    check('列顺序已还原，且设置项里不残留临时列的 key',
      JSON.stringify(orderBack) === JSON.stringify(orderAtStart) && deadKeys.length === 0,
      `顺序 ${orderBack.length} 项（原 ${orderAtStart.length} 项），死 key ${deadKeys.length} 个`);
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
    path.join(ROOT, '.fixtures', 'quotation-custom-fields-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
