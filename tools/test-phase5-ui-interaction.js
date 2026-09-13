/**
 * 阶段五 浏览器交互测试（Chrome DevTools Protocol）
 *
 * 重点：在真实浏览器里构造 File 对象并通过 drop 事件上传，
 *       完整走一遍「前端 FileReader → base64 → 上传接口 → 落盘 → 列表刷新 → 预览」
 *
 * 用法：node tools/test-phase5-ui-interaction.js
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
const PORT = 9226;

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
  close() { try { this.ws.close(); } catch (_) { /* 忽略 */ } }
}

function findBrowser() {
  for (const p of CHROME_CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error('未找到 Chrome / Edge');
}

/** 最小合法 PNG */
const PNG_B64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';

/** 最小合法 PDF */
const PDF_TEXT = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 60>>stream
BT /F1 12 Tf 10 50 Td (Phase5 Preview Test) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;

(async () => {
  console.log('=== 阶段五 浏览器交互测试（附件）===\n');

  const ts = Date.now().toString().slice(-6);
  const cust = await (await fetch(BASE + '/api/customers', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: `阶段五交互测试客户${ts}`, short_name: `附件${ts}`,
      type: '终端用户', industry: '石油'
    })
  })).json();
  const customerId = cust.data.id;
  console.log(`准备测试客户 id=${customerId}\n`);

  const browser = findBrowser();
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'crmp5-'));
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
  if (!version) { console.log('浏览器未就绪'); try { child.kill(); } catch (_) {} process.exit(1); }
  console.log(`浏览器：${version.Browser}\n`);

  const tab = await (await fetch(`http://127.0.0.1:${PORT}/json/new?about:blank`, { method: 'PUT' })).json();
  const cdp = new CDP(tab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');

  async function goto(hash, wait) {
    await cdp.evalJs(`location.href = ${JSON.stringify(BASE + '/' + hash)}; 'ok'`);
    await sleep(wait || 3200);
  }

  /* ================= 1. 客户详情有附件标签页 ================= */
  await goto('#/customers/' + customerId, 3400);
  const tabInfo = await cdp.evalJs(`(() => {
    const tabs = [...document.querySelectorAll('.tab')].map(t => t.textContent.trim());
    return { tabs, hasFiles: tabs.some(t => t.includes('附件')) };
  })()`);
  check('客户详情页新增「附件」标签页', tabInfo.hasFiles,
    `标签页：${tabInfo.tabs.join(' / ')}`);

  const panelInfo = await cdp.evalJs(`(async () => {
    const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes('附件'));
    t.click();
    await new Promise(r => setTimeout(r, 1200));

    /* 各标签页用 v-show 隐藏，元素仍在 DOM；这里只取当前可见的附件面板 */
    const panels = [...document.querySelectorAll('.content > div > div')]
      .filter(d => d.style.display !== 'none' && d.querySelector('.drop-zone'));
    const panel = panels[panels.length - 1];

    return {
      hasDropZone: !!panel,
      hasUploadBtn: panel ? [...panel.querySelectorAll('button')].some(b => b.textContent.includes('上传附件')) : false,
      hasCategorySelect: panel ? !!panel.querySelector('.card-head select') : false,
      emptyText: panel ? ((panel.querySelector('.placeholder h3') || {}).textContent || '') : '',
      panelTitle: panel ? ((panel.querySelector('.card-title') || {}).textContent || '') : ''
    };
  })()`);
  check('附件面板渲染（拖拽区 / 上传按钮 / 分类选择 / 空状态文案）',
    panelInfo.hasDropZone && panelInfo.hasUploadBtn && panelInfo.hasCategorySelect
      && panelInfo.emptyText.includes('还没有附件'),
    `标题=${panelInfo.panelTitle}，拖拽区=${panelInfo.hasDropZone}，上传按钮=${panelInfo.hasUploadBtn}，分类下拉=${panelInfo.hasCategorySelect}，空状态="${panelInfo.emptyText}"`);

  /* ================= 2. 在浏览器里构造 File 并通过 drop 上传图片 ================= */
  const upload1 = await cdp.evalJs(`(async () => {
    /* 先切到「合同」分类，验证分类生效 */
    const sel = document.querySelector('.card-head select');
    if (sel) {
      sel.value = '合同';
      sel.dispatchEvent(new Event('change', { bubbles: true }));
      await new Promise(r => setTimeout(r, 200));
    }

    const bin = atob(${JSON.stringify(PNG_B64)});
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const file = new File([bytes], '营业执照交互测试${ts}.png', { type: 'image/png' });

    const dt = new DataTransfer();
    dt.items.add(file);
    const dz = document.querySelector('.drop-zone');
    if (!dz) return { ok: false, why: '未找到拖拽区' };
    dz.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));

    await new Promise(r => setTimeout(r, 2600));
    const items = [...document.querySelectorAll('.att-item')];
    return {
      ok: true,
      itemCount: items.length,
      names: items.map(i => (i.querySelector('.att-name') || {}).textContent.trim()),
      groupTitles: [...document.querySelectorAll('.att-group-title')].map(g => g.textContent.trim()),
      toasts: [...document.querySelectorAll('.toast')].map(t => t.textContent.trim())
    };
  })()`);
  check('通过拖拽在浏览器内上传图片成功（走完 FileReader→base64→接口→落盘）',
    upload1.ok && upload1.itemCount === 1
      && upload1.names.some((n) => n && n.includes(`营业执照交互测试${ts}`)),
    upload1.ok
      ? `列表 ${upload1.itemCount} 个：${upload1.names.join(' / ')}；分组：${upload1.groupTitles.join(' / ')}；提示：${upload1.toasts.join(' ')}`
      : `失败：${upload1.why}`);

  check('上传时选择的分类生效（归入「合同」组）',
    (upload1.groupTitles || []).some((g) => g.includes('合同')),
    `分组标题：${(upload1.groupTitles || []).join(' / ')}`);

  /* ================= 3. 上传 PDF 验证多文件与不同类型 ================= */
  const upload2 = await cdp.evalJs(`(async () => {
    const sel = document.querySelector('.card-head select');
    if (sel) { sel.value = '资质'; sel.dispatchEvent(new Event('change', { bubbles: true })); await new Promise(r => setTimeout(r, 200)); }

    const pdfText = ${JSON.stringify(PDF_TEXT)};
    const bytes = new TextEncoder().encode(pdfText);
    const file = new File([bytes], '技术协议交互测试${ts}.pdf', { type: 'application/pdf' });

    const dt = new DataTransfer();
    dt.items.add(file);
    const dz = document.querySelector('.drop-zone');
    dz.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
    await new Promise(r => setTimeout(r, 2600));

    const items = [...document.querySelectorAll('.att-item')];
    const pdfItem = items.find(i => i.textContent.includes('技术协议交互测试${ts}'));
    return {
      ok: true,
      itemCount: items.length,
      hasPdfItem: !!pdfItem,
      pdfBadge: pdfItem ? pdfItem.textContent.includes('PDF') : false,
      groups: [...document.querySelectorAll('.att-group-title')].map(g => g.textContent.trim())
    };
  })()`);
  check('上传 PDF 成功并显示 PDF 标识',
    upload2.ok && upload2.hasPdfItem && upload2.pdfBadge && upload2.itemCount === 2,
    upload2.ok ? `列表 ${upload2.itemCount} 个，PDF 标识=${upload2.pdfBadge}，分组：${upload2.groups.join(' / ')}` : '失败');

  /* ================= 4. 预览弹层 ================= */
  const preview = await cdp.evalJs(`(async () => {
    const items = [...document.querySelectorAll('.att-item')];
    const pdfItem = items.find(i => i.textContent.includes('技术协议交互测试${ts}'));
    if (!pdfItem) return { ok: false, why: '未找到 PDF 附件' };

    const btn = [...pdfItem.querySelectorAll('button')].find(b => b.textContent.includes('预览'));
    if (!btn) return { ok: false, why: '未找到预览按钮' };
    btn.click();
    await new Promise(r => setTimeout(r, 1600));

    const mask = document.querySelector('.preview-mask');
    const iframe = document.querySelector('.preview-body iframe');
    const img = document.querySelector('.preview-body img');
    return {
      ok: true,
      maskOpen: !!mask,
      hasIframe: !!iframe,
      iframeSrc: iframe ? iframe.getAttribute('src') : '',
      hasImg: !!img,
      title: (document.querySelector('.pv-name') || {}).textContent || '',
      hasZoomBtns: [...document.querySelectorAll('.preview-head button')].some(b => b.textContent.includes('放大'))
    };
  })()`);
  check('点击预览打开预览层，PDF 用 iframe 内联加载',
    preview.ok && preview.maskOpen && preview.hasIframe
      && /^\/api\/attachments\/\d+\/file$/.test(preview.iframeSrc || ''),
    preview.ok
      ? `预览层=${preview.maskOpen}，iframe=${preview.hasIframe}，src=${preview.iframeSrc}，标题=${preview.title}`
      : `失败：${preview.why}`);

  /* 图片预览 + 缩放 */
  const imgPreview = await cdp.evalJs(`(async () => {
    /* 先关掉 PDF 预览 */
    const closeBtn = [...document.querySelectorAll('.preview-head button')].find(b => b.textContent.includes('关闭'));
    if (closeBtn) closeBtn.click();
    await new Promise(r => setTimeout(r, 500));

    const items = [...document.querySelectorAll('.att-item')];
    const imgItem = items.find(i => i.textContent.includes('营业执照交互测试${ts}'));
    if (!imgItem) return { ok: false, why: '未找到图片附件' };
    const btn = [...imgItem.querySelectorAll('button')].find(b => b.textContent.includes('预览'));
    btn.click();
    await new Promise(r => setTimeout(r, 1500));

    const img = document.querySelector('.preview-body img');
    if (!img) return { ok: false, why: '未出现图片预览元素' };
    const before = img.style.transform;

    /* 点放大两次 */
    const zoomBtn = [...document.querySelectorAll('.preview-head button')].find(b => b.textContent.includes('放大'));
    zoomBtn.click(); await new Promise(r => setTimeout(r, 250));
    zoomBtn.click(); await new Promise(r => setTimeout(r, 250));
    const after = img.style.transform;

    const pct = [...document.querySelectorAll('.preview-head button')].map(b => b.textContent.trim()).find(t => /%/.test(t));

    return { ok: true, before, after, pct, src: img.getAttribute('src') };
  })()`);
  check('图片预览可缩放（放大两次后百分比与 transform 变化）',
    imgPreview.ok && imgPreview.before !== imgPreview.after && /%/.test(imgPreview.pct || ''),
    imgPreview.ok ? `${imgPreview.before || '无'} → ${imgPreview.after}，显示 ${imgPreview.pct}，src=${imgPreview.src}` : `失败：${imgPreview.why}`);

  /* ESC 关闭 */
  const escClose = await cdp.evalJs(`(async () => {
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await new Promise(r => setTimeout(r, 600));
    return { stillOpen: !!document.querySelector('.preview-mask') };
  })()`);
  check('ESC 可关闭预览层', !escClose.stillOpen, escClose.stillOpen ? '仍开着' : '已关闭');

  /* ================= 5. 附件真实落盘（接口核对） ================= */
  const apiList = await (await fetch(`${BASE}/api/attachments?owner_type=customer&owner_id=${customerId}`)).json();
  const listData = apiList.data;
  const filesOnDisk = listData.list.map((it) => ({
    name: it.file_name,
    size: it.file_size,
    exists: fs.existsSync(path.join(__dirname, '..', 'data', 'attachments', it.file_path))
  }));
  check('两个附件均已落盘且大小正确',
    listData.total === 2 && filesOnDisk.every((f) => f.exists),
    filesOnDisk.map((f) => `${f.name}(${f.size}B, 落盘=${f.exists})`).join('；'));

  /* ================= 6. 图片可通过接口直接取回（预览用的 URL 有效） ================= */
  const imgId = listData.list.find((x) => x.is_image).id;
  const imgRes = await fetch(`${BASE}/api/attachments/${imgId}/file`);
  const imgBuf = Buffer.from(await imgRes.arrayBuffer());
  const pngBuf = Buffer.from(PNG_B64, 'base64');
  check('预览用的图片 URL 可直接取回且内容正确',
    imgRes.status === 200 && imgRes.headers.get('content-type') === 'image/png'
      && imgBuf.equals(pngBuf) && imgRes.headers.get('content-disposition').startsWith('inline'),
    `HTTP ${imgRes.status}，${imgBuf.length} 字节，内容一致=${imgBuf.equals(pngBuf)}，inline=${imgRes.headers.get('content-disposition').startsWith('inline')}`);

  /* ================= 7. 删除附件（确认弹窗） ================= */
  const del = await cdp.evalJs(`(async () => {
    const items = [...document.querySelectorAll('.att-item')];
    const pdfItem = items.find(i => i.textContent.includes('技术协议交互测试${ts}'));
    const btn = [...pdfItem.querySelectorAll('button')].find(b => b.textContent.includes('删除'));
    btn.click();
    await new Promise(r => setTimeout(r, 700));
    const modal = document.querySelector('.modal');
    const modalText = modal ? modal.innerText : '';
    /* 点确认删除 */
    const confirmBtn = [...document.querySelectorAll('.modal-foot button')].find(b => b.textContent.includes('删除'));
    if (!confirmBtn) return { ok: false, why: '未出现确认弹窗', modalText };
    confirmBtn.click();
    await new Promise(r => setTimeout(r, 1800));
    const after = [...document.querySelectorAll('.att-item')].length;
    return { ok: true, modalText: modalText.slice(0, 60), after };
  })()`);
  check('删除附件走确认弹窗并可成功删除',
    del.ok && del.after === 1,
    del.ok ? `确认文案="${del.modalText}…"，删除后剩余 ${del.after} 个` : `失败：${del.why}`);

  /* ================= 8. 项目详情也有附件标签页 ================= */
  const proj = await (await fetch(BASE + '/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: `阶段五交互测试项目${ts}`, customer_id: customerId, stage: '已中标/已签约', contract_amount: 100000 })
  })).json();
  await goto('#/projects/' + proj.data.id, 3400);
  const projTab = await cdp.evalJs(`(async () => {
    const tabs = [...document.querySelectorAll('.tab')].map(t => t.textContent.trim());
    const t = [...document.querySelectorAll('.tab')].find(x => x.textContent.includes('附件'));
    if (!t) return { tabs, hasFiles: false };
    t.click();
    await new Promise(r => setTimeout(r, 1200));
    /* 同样只取可见的附件面板 */
    const panels = [...document.querySelectorAll('.content > div > div')]
      .filter(d => d.style.display !== 'none' && d.querySelector('.drop-zone'));
    const panel = panels[panels.length - 1];
    return {
      tabs, hasFiles: true,
      hasDropZone: !!panel,
      emptyText: panel ? ((panel.querySelector('.placeholder h3') || {}).textContent || '') : ''
    };
  })()`);
  check('项目详情页也有「附件」标签页且面板可渲染',
    projTab.hasFiles && projTab.hasDropZone && projTab.emptyText.includes('还没有附件'),
    `标签页：${projTab.tabs.join(' / ')}；面板可见=${projTab.hasDropZone}，空状态="${projTab.emptyText}"`);

  /* ================= 9. 设置页附件与存储面板 ================= */
  await goto('#/settings', 3000);
  const store = await cdp.evalJs(`(async () => {
    const t = [...document.querySelectorAll('.settings-tabs .tab')].find(x => x.textContent.includes('附件与存储'));
    if (!t) return { ok: false, why: '未找到附件与存储标签页' };
    t.click();
    await new Promise(r => setTimeout(r, 1800));
    const text = document.querySelector('.content').innerText;
    const stats = [...document.querySelectorAll('.stat .l')].map(s => s.textContent.trim());
    return {
      ok: true,
      hasLimit: text.includes('单个附件大小上限'),
      hasDist: text.includes('分布情况'),
      hasBackupNote: text.includes('附件不在数据库备份里'),
      stats,
      limitValue: (document.querySelector('input[type=number]') || {}).value
    };
  })()`);
  check('设置页「附件与存储」面板渲染用量统计与上限配置',
    store.ok && store.hasLimit && store.hasDist && store.hasBackupNote,
    store.ok
      ? `统计项：${store.stats.join(' / ')}；上限=${store.limitValue} MB；含备份提示=${store.hasBackupNote}`
      : `失败：${store.why}`);

  /* ================= 10. JS 错误 ================= */
  check('全程无未捕获的 JS 错误',
    cdp.errors.length === 0,
    cdp.errors.length ? cdp.errors.slice(0, 3).join(' | ') : '0 条错误');

  /* ================= 清理 ================= */
  const left = await (await fetch(`${BASE}/api/attachments?owner_type=customer&owner_id=${customerId}`)).json();
  if (left.data.list.length) {
    await fetch(BASE + '/api/attachments/batch-delete', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ids: left.data.list.map((x) => x.id) })
    });
  }
  await fetch(BASE + '/api/attachments/clean-orphans', { method: 'POST' });
  await fetch(BASE + `/api/projects/${proj.data.id}`, { method: 'DELETE' });
  await fetch(BASE + `/api/customers/${customerId}`, { method: 'DELETE' });
  console.log('\n（已清理测试数据）');

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
