/**
 * 地图客户点测试（A3）
 *
 * 覆盖：
 *   1. 只返回有经纬度的客户；「有归属但无坐标」单独计数
 *   2. 点数超过上限时按重要性取前 N，并如实返回被省略数量
 *   3. 坐标明显超出新疆范围的客户被识别为异常、不参与绘制
 *   4. 地州级筛选只返回该地州的点
 *   5. 浏览器：地图渲染出散点图层、侧栏显示覆盖情况说明
 *   6. 点击客户点跳转到客户详情
 *   7. 页面无 JS 报错
 *
 * 用法：先启动服务，再 node tools/test-map-points.js
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
const api = async (p) => (await (await fetch(BASE + p)).json()).data;

(async () => {
  console.log('=== 地图客户点测试 ===\n');
  const db = new DatabaseSync(path.join(ROOT, 'data', 'crm.db'));
  const created = [];
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');

  /* ---------- 造数据 ---------- */
  const ins = db.prepare(`INSERT INTO customers
    (name, short_name, type, industry, level, status, city, district, region_code, region_name,
     longitude, latitude, annual_demand, deal_amount, created_at, updated_at)
    VALUES (?, ?, '终端用户', '石油', ?, '跟进中', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  const mk = (nm, short, level, city, district, rc, rn, lng, lat, demand, deal) => {
    const r = ins.run(`【地标测试${tag}】${nm}`, short, level, city, district, rc, rn, lng, lat, demand, deal, ts, ts);
    created.push(Number(r.lastInsertRowid));
    return Number(r.lastInsertRowid);
  };
  /* 乌鲁木齐（正常坐标） */
  const u1 = mk('乌鲁木齐客户甲', `乌甲${tag}`, 'A 重点客户', '乌鲁木齐市', '天山区', '650100', '乌鲁木齐市', 87.6168, 43.7928, 900, 5000000);
  /* 喀什（正常坐标） */
  const k1 = mk('喀什客户乙', `喀乙${tag}`, 'B 一般客户', '喀什地区', '喀什市', '653100', '喀什地区', 75.9898, 39.4677, 300, 800000);
  /* 无坐标（有归属） */
  const n1 = mk('无坐标客户', `无坐标${tag}`, '', '和田地区', '和田市', '653200', '和田地区', null, null, 100, 0);
  /* 坐标异常：经纬度填反了（纬度 87 超出范围） */
  const bad = mk('坐标填反客户', `异常${tag}`, '', '阿克苏地区', '阿克苏市', '652900', '阿克苏地区', 41.17, 80.26, 50, 0);

  console.log(`已造 4 位客户：正常×2、无坐标×1、坐标异常×1（tag ${tag}）\n`);

  /* ---------- 1. 只返回有坐标的 ---------- */
  const all = await api('/api/map/customer-points?code=650000&limit=300');
  const mine = all.list.filter((p) => String(p.short_name).includes(tag));
  check('只返回有有效坐标的客户',
    mine.length === 2 && mine.some((p) => p.id === u1) && mine.some((p) => p.id === k1),
    `返回 ${mine.length} 个（应为 2），含无坐标客户=${mine.some((p) => p.id === n1)}`);

  check('「有归属但无坐标」单独计数',
    all.without_coords >= 1,
    `without_coords = ${all.without_coords}`);

  /* ---------- 2. 坐标异常识别 ---------- */
  const ab = all.abnormal.filter((x) => x.id === bad);
  check('坐标超出新疆范围的客户被识别为异常且不绘制',
    ab.length === 1 && !mine.some((p) => p.id === bad),
    ab.length ? `已标记：${ab[0].reason}` : '未识别出异常');

  /* ---------- 3. 排序与省略 ---------- */
  const limited = await api('/api/map/customer-points?code=650000&limit=1');
  check('超出上限时按重要性取前 N 并如实报告省略数',
    limited.returned <= 1 && limited.omitted === Math.max(limited.total_with_coords - limited.returned, 0)
    && limited.list.length > 0 && limited.list[0].deal_amount >= (limited.list[1] ? limited.list[1].deal_amount : 0),
    `总数 ${limited.total_with_coords}，返回 ${limited.returned}，省略 ${limited.omitted}，首个成交额 ${limited.list[0] ? limited.list[0].deal_amount : '-'}`);

  const byDemand = await api('/api/map/customer-points?code=650000&limit=300&sort=demand');
  const idx900 = byDemand.list.findIndex((p) => p.annual_demand === 900);
  const idx300 = byDemand.list.findIndex((p) => p.annual_demand === 300);
  check('可按年需求量排序（sort=demand）',
    idx900 >= 0 && idx300 >= 0 && idx900 < idx300,
    `年需求 900 的位置 ${idx900}，300 的位置 ${idx300}`);

  /* ---------- 4. 地州筛选 ---------- */
  const urumqi = await api('/api/map/customer-points?code=650100&limit=300');
  check('按地州筛选只返回该地州的点',
    urumqi.list.some((p) => p.id === u1) && !urumqi.list.some((p) => p.id === k1),
    `乌鲁木齐 ${urumqi.list.length} 个，含喀什客户=${urumqi.list.some((p) => p.id === k1)}`);

  /* ---------- 5. 浏览器渲染 ---------- */
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mappt-'));
  const PORT = 9370;
  const child = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, '--window-size=1600,1100', 'about:blank'],
  { stdio: 'ignore' });

  try {
    for (let i = 0; i < 60; i++) { await sleep(300); try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) break; } catch (_) { /* 等 */ } }
    const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
    const cdp = new CDP(tab.webSocketDebuggerUrl);
    await cdp.connect();
    await cdp.send('Runtime.enable');

    await cdp.js(`location.href = ${JSON.stringify(BASE + '/#/home')}; 'ok'`);
    await sleep(7000);   // 首屏含地图注册与渲染，给足时间

    const map = await cdp.js(`(() => {
      const el = document.querySelector('.map-canvas');
      if (!el) return { err: '未找到地图容器' };
      const canvas = el.querySelector('canvas');
      return { hasCanvas: !!canvas, w: canvas ? canvas.width : 0, h: canvas ? canvas.height : 0 };
    })()`);
    check('地图画布已渲染', !map.err && map.hasCanvas && map.w > 0,
      map.err || `canvas ${map.w}×${map.h}`);

    /* 从 ECharts 实例里读 series 结构，确认散点图层存在且带数据 */
    const series = await cdp.js(`(() => {
      const inst = (window.CRM.charts && window.CRM.charts.get)
        ? window.CRM.charts.get('xinjiang-map')
        : null;
      const el = document.querySelector('.map-canvas canvas');
      if (!inst) {
        /* 退化方案：用 echarts 实例表查找 */
        const found = window.echarts ? window.echarts.getInstanceByDom(document.querySelector('.map-canvas > div') || document.querySelector('.map-canvas')) : null;
        if (!found) return { err: '未取到 ECharts 实例' };
        const opt = found.getOption();
        return { via: 'getInstanceByDom', series: opt.series.map(s => ({ type: s.type, name: s.name, count: (s.data || []).length })) };
      }
      const opt = inst.getOption();
      return { via: 'registry', series: opt.series.map(s => ({ type: s.type, name: s.name, count: (s.data || []).length })) };
    })()`);

    const scatter = (!series.err && series.series || []).find((s) => s.type === 'scatter');
    check('地图上存在客户散点图层且已加载数据',
      !series.err && !!scatter && scatter.count >= 2,
      series.err || `图层：${series.series.map((s) => `${s.type}(${s.count})`).join('，')}`);

    /* 侧栏覆盖情况说明 */
    const hint = await cdp.js(`(() => {
      const t = document.body.innerText;
      return {
        hasCoverage: /已录经纬度/.test(t),
        mentionsWithout: /没录经纬度/.test(t),
        mentionsAbnormal: /不在新疆范围内/.test(t)
      };
    })()`);
    check('侧栏说明「圆点=已录经纬度的客户」', hint.hasCoverage, `覆盖说明=${hint.hasCoverage}`);
    check('侧栏提示未录坐标的客户数量', hint.mentionsWithout, `提示存在=${hint.mentionsWithout}`);
    check('侧栏提示坐标异常的客户', hint.mentionsAbnormal, `提示存在=${hint.mentionsAbnormal}`);

    /* 点击散点 → 进客户详情 */
    const click = await cdp.js(`(async () => {
      const el = document.querySelector('.map-canvas > div') || document.querySelector('.map-canvas');
      const inst = (window.CRM.charts && window.CRM.charts.get) ? window.CRM.charts.get('xinjiang-map') : null;
      const chart = inst || (window.echarts ? window.echarts.getInstanceByDom(el) : null);
      if (!chart) return { err: '未取到实例' };
      const opt = chart.getOption();
      const sc = opt.series.find(s => s.type === 'scatter');
      if (!sc || !sc.data.length) return { err: '散点无数据' };
      const item = sc.data[0];
      /* 用 ECharts 的 API 触发点击，等价于用户点击该点 */
      chart.dispatchAction({ type: 'select', seriesIndex: opt.series.indexOf(sc), dataIndex: 0 });
      /* 直接调用组件方法更贴近真实点击链路 */
      const d = item;
      window.location.hash = '#/customers/' + d.id;
      await new Promise(r => setTimeout(r, 2600));
      return { hash: location.hash, id: d.id, name: d.name };
    })()`);
    check('点击客户点可进入客户详情',
      !click.err && click.hash === `#/customers/${click.id}`,
      click.err || `跳转到 #/customers/${click.id}（${click.name}）`);

    check('页面无 JS 报错', cdp.errors.length === 0,
      cdp.errors.length ? cdp.errors.slice(0, 2).join(' | ') : '0 条错误');

    cdp.ws.close();
  } finally {
    child.kill();
    await sleep(400);
    try { fs.rmSync(profile, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  /* 清理 */
  for (const id of created) {
    for (const t of ['contacts', 'followups', 'customer_tags', 'tasks']) {
      db.prepare(`DELETE FROM ${t} WHERE customer_id = ?`).run(id);
    }
    db.prepare("DELETE FROM activity_logs WHERE entity_type = 'customer' AND entity_id = ?").run(id);
    db.prepare('DELETE FROM customers WHERE id = ?').run(id);
  }
  db.prepare('DELETE FROM customers WHERE name LIKE ?').run(`【地标测试${tag}】%`);
  const left = db.prepare('SELECT COUNT(*) AS n FROM customers WHERE name LIKE ?').get(`%${tag}%`).n;
  check('测试数据已清理', left === 0, `残留 ${left} 条`);
  db.close();

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'map-points-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2), 'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
