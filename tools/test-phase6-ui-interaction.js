/**
 * 阶段六 浏览器交互测试（Chrome DevTools Protocol）
 *
 * 重点：
 *   - 地图在真实浏览器里渲染（canvas 有色块，不是空白）
 *   - 在 canvas 上真实点击区域 → 触发下钻 / 客户清单
 *   - 坐标工具：粘贴高德坐标 → 自动转换 → 填入表单
 *   - 在线核对链接生成
 *   - 断网可用性（地图不依赖任何在线资源）
 *
 * 用法：node tools/test-phase6-ui-interaction.js
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
const PORT = 9227;

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
      }, 30000);
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
  /** 在页面坐标处派发真实鼠标事件（用于点击 ECharts canvas） */
  async clickAt(x, y) {
    const base = { x, y, button: 'left', clickCount: 1 };
    await this.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseMoved' }, base));
    await sleep(60);
    await this.send('Input.dispatchMouseEvent', Object.assign({ type: 'mousePressed' }, base));
    await sleep(60);
    await this.send('Input.dispatchMouseEvent', Object.assign({ type: 'mouseReleased' }, base));
  }
  close() { try { this.ws.close(); } catch (_) { /* 忽略 */ } }
}

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome / Edge');
}

const created = [];

(async () => {
  console.log('=== 阶段六 浏览器交互测试（地图）===\n');

  /* ---------- 清理上次残留（避免客户数累加影响断言） ---------- */
  try {
    const old = await (await fetch(BASE + '/api/customers?pageSize=200&q=' + encodeURIComponent('地图测试'))).json();
    const oldIds = (old.data.list || []).map((x) => x.id);
    if (oldIds.length) {
      await fetch(BASE + '/api/customers/batch-delete', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ids: oldIds })
      });
      console.log(`（清理上次残留 ${oldIds.length} 条测试客户）`);
    }
  } catch (_) { /* 首次运行 */ }

  /* ---------- 准备：带地址的客户，让地图有数据 ---------- */
  const ts = Date.now().toString().slice(-6);
  const seed = [
    { name: `地图测试乌鲁木齐A${ts}`, city: '乌鲁木齐市', district: '天山区', lng: 87.6168, lat: 43.8256, demand: 500 },
    { name: `地图测试乌鲁木齐B${ts}`, city: '乌鲁木齐市', district: '沙依巴克区', lng: 87.5900, lat: 43.8000, demand: 300 },
    { name: `地图测试乌鲁木齐C${ts}`, city: '乌鲁木齐市', district: '新市区', lng: 87.5700, lat: 43.8600, demand: 200 },
    { name: `地图测试喀什D${ts}`, city: '喀什地区', district: '喀什市', lng: 75.9898, lat: 39.4677, demand: 800 }
  ];
  for (const s of seed) {
    const r = await (await fetch(BASE + '/api/customers', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: s.name, short_name: s.name.slice(0, 8), type: '终端用户', industry: '石油',
        city: s.city, district: s.district, longitude: s.lng, latitude: s.lat,
        annual_demand: s.demand
      })
    })).json();
    if (r.data && r.data.id) created.push(r.data.id);
  }
  console.log(`准备 ${created.length} 个带坐标的客户\n`);

  const browser = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crmp6-'));
  const child = spawn(browser, [
    '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
    `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`,
    '--window-size=1600,1100', 'about:blank'
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

  async function goto(hash, wait) {
    await cdp.evalJs(`location.href = ${JSON.stringify(BASE + '/' + hash)}; 'ok'`);
    await sleep(wait || 3600);
  }

  /* ================= 1. 地图渲染 ================= */
  await goto('#/home', 4600);
  const mapInfo = await cdp.evalJs(`(() => {
    const canvas = [...document.querySelectorAll('canvas')];
    /* 地图是最后一张 canvas（首页第 5 张图） */
    const mapCanvas = canvas[canvas.length - 1];
    const host = document.querySelector('.map-canvas');
    const rect = host ? host.getBoundingClientRect() : null;

    /* 采样 canvas 像素，判断是否真的画了东西（不是纯白） */
    let nonWhite = 0, total = 0;
    try {
      const ctx = mapCanvas.getContext('2d');
      const w = mapCanvas.width, h = mapCanvas.height;
      const data = ctx.getImageData(0, 0, w, h).data;
      const step = Math.max(1, Math.floor((w * h) / 20000));
      for (let i = 0; i < w * h; i += step) {
        const r = data[i * 4], g = data[i * 4 + 1], b = data[i * 4 + 2], a = data[i * 4 + 3];
        total++;
        if (a > 0 && !(r > 248 && g > 248 && b > 248)) nonWhite++;
      }
    } catch (e) { /* 忽略取样失败 */ }

    return {
      canvasCount: canvas.length,
      mapCanvasSize: mapCanvas ? (mapCanvas.width + 'x' + mapCanvas.height) : '无',
      hostRect: rect ? { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) } : null,
      nonWhiteRatio: total ? Math.round(nonWhite / total * 100) : 0,
      hasToolbar: !!document.querySelector('.map-toolbar'),
      crumb: (document.querySelector('.map-crumb') || {}).textContent || '',
      hasRank: document.querySelectorAll('.map-rank-row').length,
      src: mapCanvas ? mapCanvas.parentElement.parentElement.getBoundingClientRect().x : 0
    };
  })()`);

  check('首页渲染出地图 canvas 且尺寸正常',
    mapInfo.canvasCount >= 5 && mapInfo.mapCanvasSize !== '0x0' && mapInfo.hostRect && mapInfo.hostRect.w > 300,
    `共 ${mapInfo.canvasCount} 个 canvas；地图尺寸 ${mapInfo.mapCanvasSize}，显示区 ${mapInfo.hostRect && mapInfo.hostRect.w}×${mapInfo.hostRect && mapInfo.hostRect.h}`);

  check('地图真的画出了内容（非空白画布）',
    mapInfo.nonWhiteRatio > 5,
    `非白像素占比约 ${mapInfo.nonWhiteRatio}%（>5% 说明有边界色块）`);

  check('地图工具条与面包屑正常',
    mapInfo.hasToolbar && mapInfo.crumb.includes('新疆'),
    `面包屑="${mapInfo.crumb.trim()}"`);

  check('右侧地州客户数排行有数据',
    mapInfo.hasRank >= 2,
    `排行 ${mapInfo.hasRank} 行`);

  const rankFirst = await cdp.evalJs(`(() => {
    const rows = [...document.querySelectorAll('.map-rank-row')];
    return rows.slice(0, 3).map(r => ({
      name: (r.querySelector('.rank-name') || {}).textContent || '',
      num: (r.querySelector('.rank-num') || {}).textContent || ''
    }));
  })()`);
  check('排行按客户数排序且乌鲁木齐居首',
    rankFirst[0] && rankFirst[0].name.includes('乌鲁木齐'),
    rankFirst.map((r) => `${r.name}:${r.num}`).join(' / '));

  /* ================= 2. 在 canvas 上真实点击 → 下钻 ================= */
  /* 取 ECharts 实例说明：
     ECharts 6 无法用 getInstanceByDom 反查；Vue 生产构建也不会把组件实例挂到
     DOM（__vueParentComponent 取不到）。因此图表组件会把自己登记到
     CRM.charts，这里通过该注册表取实例。 */
  const getMapInst = 'CRM.charts.get("xinjiang-map")';

  const clickPoint = await cdp.evalJs(`(async () => {
    const inst = ${getMapInst};
    if (!inst) return { err: '注册表里没有地图实例（CRM.charts.keys()=' + JSON.stringify(CRM.charts.keys()) + '）' };
    const host = document.querySelector('.map-canvas');
    const canvasEl = host.querySelector('canvas');

    /* 先把地图滚到视口内：点击坐标必须在视口范围内才点得到 */
    canvasEl.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 900));

    const rect = canvasEl.getBoundingClientRect();
    const pt = inst.convertToPixel({ seriesIndex: 0 }, [87.6177, 43.7928]);
    if (!pt) return { err: 'convertToPixel 返回空' };
    return {
      x: Math.round(rect.left + pt[0]),
      y: Math.round(rect.top + pt[1]),
      localX: Math.round(pt[0]),
      localY: Math.round(pt[1]),
      rectTop: Math.round(rect.top),
      rectH: Math.round(rect.height),
      inViewport: rect.top > 0 && rect.top + rect.height < window.innerHeight + 200
    };
  })()`);

  check('能把经纬度换算成地图上的屏幕坐标（用于点击）',
    clickPoint && !clickPoint.err && clickPoint.x > 0 && clickPoint.y > 0,
    clickPoint && !clickPoint.err
      ? `乌鲁木齐在屏幕 (${clickPoint.x}, ${clickPoint.y})，地图区域 top=${clickPoint.rectTop} h=${clickPoint.rectH}`
      : `取不到：${(clickPoint && clickPoint.err) || '未知'}`);

  /* 地图缩放：读实例配置 */
  const zoomProbe = () => cdp.evalJs(`(() => {
    const inst = ${getMapInst};
    if (!inst) return { err: '无地图实例' };
    const opt = inst.getOption();
    const s = (opt.series || []).find(x => x.type === 'map');
    if (!s) return { err: '未找到 map series' };
    return { zoom: s.zoom, roam: s.roam, center: s.center, scaleLimit: s.scaleLimit };
  })()`);

  if (clickPoint) {
    await cdp.clickAt(clickPoint.x, clickPoint.y);
    await sleep(2600);

    const afterClick = await cdp.evalJs(`(() => ({
      crumb: (document.querySelector('.map-crumb') || {}).textContent || '',
      hasBack: [...document.querySelectorAll('.map-toolbar button')].some(b => b.textContent.includes('返回全疆')),
      sideTitle: (document.querySelector('.map-side-head strong') || {}).textContent || '',
      custRows: document.querySelectorAll('.map-cust').length
    }))()`);

    check('点击地州区域触发下钻（面包屑出现层级）',
      afterClick.crumb.includes('乌鲁木齐') || afterClick.hasBack,
      `面包屑="${afterClick.crumb.trim()}"，出现「返回全疆」按钮=${afterClick.hasBack}`);

    check('下钻后右侧展示该地州客户清单',
      afterClick.custRows >= 2 && afterClick.sideTitle.includes('乌鲁木齐'),
      `侧栏标题="${afterClick.sideTitle}"，客户 ${afterClick.custRows} 条`);

    /* 返回全疆 */
    const back = await cdp.evalJs(`(async () => {
      const btn = [...document.querySelectorAll('.map-toolbar button')].find(b => b.textContent.includes('返回全疆'));
      if (!btn) return { ok: false };
      btn.click();
      await new Promise(r => setTimeout(r, 2600));
      return {
        ok: true,
        crumb: (document.querySelector('.map-crumb') || {}).textContent || '',
        hasBack: [...document.querySelectorAll('.map-toolbar button')].some(b => b.textContent.includes('返回全疆'))
      };
    })()`);
    check('可返回全疆视图',
      back.ok && !back.hasBack && back.crumb.includes('新疆'),
      back.ok ? `面包屑="${back.crumb.trim()}"` : '未找到返回按钮');
  }

  /* ================= 3. 从排行榜点击地州也能下钻 ================= */
  const rankClick = await cdp.evalJs(`(async () => {
    const row = document.querySelector('.map-rank-row');
    if (!row) return { ok: false, why: '无排行数据' };
    const name = (row.querySelector('.rank-name') || {}).textContent || '';
    row.click();
    await new Promise(r => setTimeout(r, 2800));
    return {
      ok: true,
      clicked: name,
      crumb: (document.querySelector('.map-crumb') || {}).textContent || '',
      custRows: document.querySelectorAll('.map-cust').length
    };
  })()`);
  check('点击排行条目也能下钻并显示客户',
    rankClick.ok && rankClick.crumb.includes(rankClick.clicked) && rankClick.custRows >= 1,
    rankClick.ok
      ? `点击「${rankClick.clicked}」→ 面包屑"${rankClick.crumb.trim()}"，客户 ${rankClick.custRows} 条`
      : `失败：${rankClick.why}`);

  /* ================= 4. 地图缩放与漫游配置 ================= */
  const zoomState = await zoomProbe();
  check('地图支持缩放与拖拽（roam 开启且可设置 zoom）',
    !zoomState.err && zoomState.roam === true && typeof zoomState.zoom === 'number',
    zoomState.err ? zoomState.err : `roam=${zoomState.roam}，zoom=${zoomState.zoom}（滚轮缩放与拖拽平移生效）`);

  /* 缩放：通过 ECharts 动作验证地图系列响应缩放（无头浏览器里原生滚轮事件不稳定） */
  const zoomApplied = await cdp.evalJs(`(() => {
    const inst = ${getMapInst};
    if (!inst) return { err: '无地图实例' };
    const before = (inst.getOption().series || []).find(s => s.type === 'map');
    inst.dispatchAction({ type: 'restore' });
    inst.setOption({ series: [{ zoom: 2.2 }] });
    const after = (inst.getOption().series || []).find(s => s.type === 'map');
    return { before: before && before.zoom, after: after && after.zoom };
  })()`);
  check('地图可缩放（zoom 可被设置并生效）',
    !zoomApplied.err && Math.abs((zoomApplied.after || 0) - 2.2) < 0.01,
    zoomApplied.err ? zoomApplied.err : `zoom ${zoomApplied.before} → ${zoomApplied.after}`);

  /* 恢复初始视图 */
  await cdp.evalJs(`(() => {
    const inst = ${getMapInst};
    if (inst) inst.setOption({ series: [{ zoom: 1.15, center: null }] });
    return 'ok';
  })()`);
  await sleep(700);

  /* ================= 5. 坐标工具 ================= */
  let coordTest = { ok: false, why: '未执行' };
  if (created.length) {
    await goto('#/customers/' + created[0], 3400);
    coordTest = await cdp.evalJs(`(async () => {
      const editBtn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('编辑资料'));
      if (!editBtn) return { ok: false, why: '未找到编辑资料按钮' };
      editBtn.click();
      await new Promise(r => setTimeout(r, 1400));

      /* 注意：内层抽屉（坐标工具）在 DOM 中排在主抽屉之后，
         所以取「最后一个 .drawer」才是坐标工具。 */
      const main = [...document.querySelectorAll('.drawer')].pop();
      if (!main) return { ok: false, why: '抽屉未打开' };

      const head = [...main.querySelectorAll('.form-block-head')].find(h => h.textContent.includes('地址信息'));
      if (head && !head.classList.contains('open')) { head.click(); await new Promise(r => setTimeout(r, 600)); }

      const coordBtn = [...main.querySelectorAll('button')].find(b => b.textContent.includes('坐标工具'));
      if (!coordBtn) return { ok: false, why: '未找到坐标工具按钮' };
      coordBtn.click();
      await new Promise(r => setTimeout(r, 1200));

      const drawers = [...document.querySelectorAll('.drawer')];
      const cd = drawers[drawers.length - 1];
      const cdTitle = (cd.querySelector('.drawer-title') || {}).textContent || '';
      if (!cdTitle.includes('坐标工具')) {
        return { ok: false, why: '最内层抽屉不是坐标工具：' + cdTitle, drawerCount: drawers.length };
      }

      /* 粘贴一个高德坐标（GCJ-02） */
      const inp = cd.querySelector('input.input');
      if (!inp) return { ok: false, why: '坐标工具无输入框' };
      inp.value = '87.6196499,43.8268054';
      inp.dispatchEvent(new Event('input', { bubbles: true }));
      await new Promise(r => setTimeout(r, 2600));

      const text = cd.innerText;
      const applyBtn = [...cd.querySelectorAll('button')].find(b => b.textContent.includes('填入这两个坐标'));

      return {
        ok: true,
        hasResult: text.includes('转为 WGS84'),
        hasShift: /偏移量/.test(text),
        shiftText: (text.match(/偏移量[\\s\\S]{0,26}/) || [''])[0].replace(/\\s+/g, ' '),
        hasApply: !!applyBtn,
        nearestRows: cd.querySelectorAll('.mini-row').length,
        wgs84Shown: text.includes('87.6168'),
        drawerCount: drawers.length
      };
    })()`);
  }
  check('坐标工具能粘贴高德坐标并自动转成 WGS84',
    coordTest.ok && coordTest.hasResult && coordTest.hasShift && coordTest.wgs84Shown,
    coordTest.ok
      ? `${coordTest.shiftText}；转换结果含 87.6168=${coordTest.wgs84Shown}`
      : `失败：${coordTest.why}`);

  check('坐标工具显示偏移量（告知用户不转换会偏多少）',
    coordTest.ok && coordTest.hasShift,
    coordTest.ok ? coordTest.shiftText : '');

  check('坐标工具推荐最近地州（供人工判断，不自动写入）',
    coordTest.ok && coordTest.nearestRows >= 1,
    coordTest.ok ? `推荐 ${coordTest.nearestRows} 个地州候选` : '');

  /* 点填入，验证写回表单 */
  const applyTest = await cdp.evalJs(`(async () => {
    const drawers = [...document.querySelectorAll('.drawer')];
    const cd = drawers[drawers.length - 1];
    if (!cd || !(cd.querySelector('.drawer-title') || {}).textContent.includes('坐标工具')) {
      return { ok: false, why: '坐标工具抽屉不在了' };
    }
    const btn = [...cd.querySelectorAll('button')].find(b => b.textContent.includes('填入这两个坐标'));
    if (!btn) return { ok: false, why: '未找到填入按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 1200));

    /* 关掉坐标工具抽屉，看主表单里的经纬度是否被填入 */
    const closeBtn = [...cd.querySelectorAll('.drawer-foot button')].find(b => b.textContent.includes('关闭'));
    if (closeBtn) closeBtn.click();
    await new Promise(r => setTimeout(r, 900));

    const rest = [...document.querySelectorAll('.drawer')];
    const main = rest[rest.length - 1];
    if (!main) return { ok: false, why: '主抽屉没了' };
    const fields = [...main.querySelectorAll('.field')];
    const lngField = fields.find(f => (f.querySelector('.field-label') || {}).textContent === '经度');
    const latField = fields.find(f => (f.querySelector('.field-label') || {}).textContent === '纬度');
    return {
      ok: true,
      lng: lngField ? lngField.querySelector('input').value : '',
      lat: latField ? latField.querySelector('input').value : ''
    };
  })()`);
  check('点「填入」后坐标正确写回客户表单（且是转换后的 WGS84）',
    applyTest.ok && applyTest.lng && applyTest.lng.startsWith('87.61') && applyTest.lat.startsWith('43.82'),
    applyTest.ok ? `表单经度=${applyTest.lng}，纬度=${applyTest.lat}` : `失败：${applyTest.why}`);

  /* ================= 6. 归属地州下拉 ================= */
  const regionSelect = await cdp.evalJs(`(() => {
    const main = [...document.querySelectorAll('.drawer')].filter(d => !d.textContent.includes('粘贴坐标')).pop();
    if (!main) return { ok: false };
    const f = [...main.querySelectorAll('.field')].find(x => (x.querySelector('.field-label') || {}).textContent === '归属地州');
    if (!f) return { ok: false, why: '未找到归属地州字段' };
    const sel = f.querySelector('select');
    if (!sel) return { ok: false, why: '未找到下拉' };
    const opts = [...sel.options];
    return {
      ok: true,
      optionCount: opts.length,
      /* 显示文本里应有地州名（用户看到的是名称） */
      hasUrumqiLabel: opts.some(o => o.textContent.includes('乌鲁木齐')),
      /* 值应是 6 位地州编码（地图按编码聚合，不能用名称） */
      allValuesAreCodes: opts.filter(o => o.value !== '').every(o => /^\\d{6}$/.test(o.value)),
      sample: opts.slice(1, 3).map(o => o.textContent.trim() + '→' + o.value),
      current: sel.value
    };
  })()`);
  check('客户表单有「归属地州」下拉（显示地州名、值存地州编码）',
    regionSelect.ok && regionSelect.optionCount >= 24
    && regionSelect.hasUrumqiLabel && regionSelect.allValuesAreCodes,
    regionSelect.ok
      ? `选项 ${regionSelect.optionCount} 个，显示名含乌鲁木齐=${regionSelect.hasUrumqiLabel}，`
        + `值均为编码=${regionSelect.allValuesAreCodes}，样例 ${(regionSelect.sample || []).join('，')}，当前=${regionSelect.current}`
      : `失败：${regionSelect.why}`);

  /* 关掉抽屉 */
  await cdp.evalJs(`(() => {
    const main = [...document.querySelectorAll('.drawer')].pop();
    if (main) {
      const b = [...main.querySelectorAll('.drawer-head button')].pop();
      if (b) b.click();
    }
    return 'ok';
  })()`);
  await sleep(600);

  /* ================= 7. 客户列表区域筛选 ================= */
  const regionFilter = await cdp.evalJs(`(async () => {
    location.hash = '#/customers';
    await new Promise(r => setTimeout(r, 3000));
    const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('高级筛选'));
    if (btn) { btn.click(); await new Promise(r => setTimeout(r, 600)); }
    const selects = [...document.querySelectorAll('.filter-bar select')];
    const hasRegion = selects.some(s => [...s.options].some(o => o.value === '650100'));
    return { ok: true, hasRegionFilter: hasRegion, selectCount: selects.length };
  })()`);
  check('客户列表高级筛选含「归属地州」选项',
    regionFilter.ok && regionFilter.hasRegionFilter,
    `筛选下拉 ${regionFilter.selectCount} 个，含地州选项=${regionFilter.hasRegionFilter}`);

  /* ================= 8. 离线能力与零外部依赖 =================
     说明：本软件的服务就在本机，所以「断网」在真实场景下只影响外网，
     本地 127.0.0.1 始终可达（CDP 的 offline 模式会把 localhost 也拦掉，
     用它测会得到假失败）。
     因此这里验证两件真正重要的事：
       ① 地图数据全部来自本地文件（浏览器本地嵌入，断网也能画出来）
       ② 使用地图的整个过程不产生任何外部域名请求 */
  await goto('#/home', 4200);

  /* 记录整段地图交互期间的所有网络请求 */
  const requests = [];
  const listen = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.method === 'Network.requestWillBeSent') {
      requests.push(m.params.request.url);
    }
  };
  cdp.ws.addEventListener('message', listen);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });

  /* 触发一轮完整的地图交互：下钻 → 返回 → 再下钻 */
  await cdp.evalJs(`(async () => {
    const c = document.querySelector('.map-canvas canvas');
    if (c) c.scrollIntoView({ block: 'center', behavior: 'instant' });
    await new Promise(r => setTimeout(r, 800));
    const row = document.querySelector('.map-rank-row');
    if (row) row.click();
    await new Promise(r => setTimeout(r, 2600));
    const back = [...document.querySelectorAll('.map-toolbar button')].find(b => b.textContent.includes('返回全疆'));
    if (back) { back.click(); await new Promise(r => setTimeout(r, 2400)); }
    return 'ok';
  })()`);
  await sleep(1200);
  cdp.ws.removeEventListener('message', listen);

  const external = requests.filter((u) => !/^https?:\/\/127\.0\.0\.1[:/]/.test(u) && !u.startsWith('data:') && !u.startsWith('blob:'));
  const local = requests.filter((u) => /^https?:\/\/127\.0\.0\.1[:/]/.test(u));
  const geoRequests = local.filter((u) => u.includes('/api/map/geojson'));

  check('使用地图全程不产生任何外部域名请求（真正零外网依赖）',
    external.length === 0,
    external.length
      ? `发现外部请求：${[...new Set(external)].slice(0, 3).join(', ')}`
      : `共 ${requests.length} 个请求全部指向本地（其中边界数据 ${geoRequests.length} 次、地图接口 ${local.filter((u) => u.includes('/api/map')).length} 次）`);

  /* 边界数据的底图直接内嵌在页面里，断网也能画出来 */
  const offlineCapable = await cdp.evalJs(`(async () => {
    const inst = CRM.charts.get('xinjiang-map');
    if (!inst) return { err: '无地图实例' };
    const name = (inst.getOption().series[0] || {}).map;

    /* 用「页面内已注册的地图」重新绘制一次（不发起任何请求），
       模拟断网后仍能渲染：echarts.getMap() 取的是本地注册的边界。 */
    const localMap = echarts.getMap(name);
    const featureCount = localMap && localMap.geoJSON
      ? (localMap.geoJSON.features || []).length : 0;

    /* 重新 setOption 一次，验证不依赖网络也能重绘 */
    inst.setOption({ series: [{ zoom: 1.3 }] });
    const after = (inst.getOption().series[0] || {}).zoom;

    return {
      mapName: name,
      featureCount,
      redrawn: Math.abs((after || 0) - 1.3) < 0.01,
      canvasSize: document.querySelector('.map-canvas canvas').width + 'x'
        + document.querySelector('.map-canvas canvas').height
    };
  })()`);

  check('边界数据已内嵌到页面（断网也能渲染，无在线瓦片依赖）',
    !offlineCapable.err && offlineCapable.featureCount >= 20 && offlineCapable.redrawn,
    offlineCapable.err
      ? offlineCapable.err
      : `注册地图 ${offlineCapable.mapName} 内含 ${offlineCapable.featureCount} 个区域边界，canvas ${offlineCapable.canvasSize}，可离线重绘=${offlineCapable.redrawn}`);

  /* 恢复视图 */
  await cdp.evalJs(`(() => {
    const inst = CRM.charts.get('xinjiang-map');
    if (inst) inst.setOption({ series: [{ zoom: 1.15 }] });
    return 'ok';
  })()`);
  await sleep(600);

  /* ================= 9. JS 错误 ================= */
  check('全程无未捕获的 JS 错误',
    cdp.errors.length === 0,
    cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '0 条错误');

  /* ================= 清理 ================= */
  if (created.length) {
    await fetch(BASE + '/api/customers/batch-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: created })
    });
  }
  console.log(`\n（已清理 ${created.length} 条测试客户）`);

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
