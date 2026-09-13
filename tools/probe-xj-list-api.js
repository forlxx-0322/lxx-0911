/**
 * 验证 getPageInfoList 接口能否真正取到招标公告数据。
 * 这是采集模块可行性的决定性验证：能拿到结构化列表 + 详情字段，才谈得上开发。
 *
 * 用法：node tools/probe-xj-list-api.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const BASE = 'https://ggzy.xinjiang.gov.cn';
const REF = BASE + '/xinjiangggzy_new/jyxx/trade_info.html';
const TIMEOUT = 20000;

/* 先看 JS 里 getPageInfoList 的定义 */
function findDef(jsText) {
  const i = jsText.indexOf('getPageInfoList:');
  if (i < 0) return '（未找到定义）';
  return jsText.slice(i, i + 700).replace(/\s+/g, ' ');
}

async function post(url, data) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  const body = new URLSearchParams(data).toString();
  try {
    const res = await fetch(url, {
      method: 'POST',
      signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': REF,
        'Origin': BASE
      },
      body,
      redirect: 'follow'
    });
    const buf = Buffer.from(await res.arrayBuffer());
    let text = buf.toString('utf8');
    if ((text.match(/\uFFFD/g) || []).length > 5) {
      try { text = new TextDecoder('gbk').decode(buf); } catch (_) { /* utf8 */ }
    }
    return { status: res.status, type: res.headers.get('content-type') || '', text };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? '超时' : e.message };
  } finally { clearTimeout(timer); }
}

(async () => {
  const jsPath = path.resolve(__dirname, '..', '.fixtures', 'xj-webBuilderCommon.js');
  const js = fs.readFileSync(jsPath, 'utf8');
  console.log('=== getPageInfoList 定义 ===');
  console.log(findDef(js) + '\n');

  /* 找到页面里 siteGuid 等初始化变量 */
  const cfg = [];
  try {
    const html = fs.readFileSync(path.resolve(__dirname, '..', '.fixtures', 'xj-trade-info.html'), 'utf8');
    for (const m of html.matchAll(/(?:siteGuid|projectName|siteInfo|systemName)\s*[:=]\s*["']([^"']*)["']/gi)) {
      cfg.push(m[0]);
    }
    /* siteInfo 可能是对象字面量 */
    const si = html.match(/siteInfo\s*=\s*\{[\s\S]{0,400}?\}/);
    if (si) cfg.push(si[0].replace(/\s+/g, ' '));
  } catch (_) { /* 忽略 */ }
  console.log('=== 页面初始化变量 ===');
  console.log(cfg.slice(0, 6).join('\n') || '（未找到）');
  console.log('');

  /* 取 siteGuid：常见于页面或 common.js */
  let siteGuid = '';
  try {
    const html = fs.readFileSync(path.resolve(__dirname, '..', '.fixtures', 'xj-trade-info.html'), 'utf8');
    siteGuid = (html.match(/siteGuid["']?\s*[:=]\s*["']([0-9a-f-]{20,})["']/i) || [])[1] || '';
  } catch (_) { /* 忽略 */ }

  const ENDPOINT = BASE + '/EpointWebBuilder/frontAppAction.action?cmd=getPageInfoList';
  console.log('=== 调用接口 ===');
  console.log('POST ' + ENDPOINT);
  console.log('siteGuid: ' + (siteGuid || '（未取到，尝试空值）') + '\n');

  /* 尝试多组参数组合：栏目号 001001001 = 工程建设/房屋和市政工程/招标公告 */
  const attempts = [
    { cateNum: '001001001', pageIndex: '0', pageSize: '10', siteGuid, keyWord: '' },
    { cateNum: '001001001', pageIndex: '1', pageSize: '10', siteGuid, keyWord: '' },
    { cateNum: '001001001', pageIndex: '0', pageSize: '10', keyWord: '' },
    { categoryNum: '001001001', pageIndex: '0', pageSize: '10', siteGuid, keyWord: '' }
  ];

  for (let i = 0; i < attempts.length; i++) {
    const a = attempts[i];
    const clean = {};
    for (const [k, v] of Object.entries(a)) if (v !== '' || k === 'keyWord') clean[k] = v;
    const r = await post(ENDPOINT, clean);
    console.log(`[尝试 ${i + 1}] 参数 ${JSON.stringify(clean)}`);
    if (r.status === 0) { console.log(`   ✗ ${r.error}\n`); continue; }
    console.log(`   HTTP ${r.status}  ${r.type}  ${r.text.length} 字符`);
    console.log('   返回前 700 字：' + r.text.slice(0, 700).replace(/\s+/g, ' '));
    console.log('');
    /* 若是合法 JSON 且含列表，保存并深入分析 */
    try {
      const j = JSON.parse(r.text);
      const payload = j.custom !== undefined ? j.custom : j;
      const str = JSON.stringify(payload);
      if (str.length > 200) {
        fs.writeFileSync(path.resolve(__dirname, '..', '.fixtures', `xj-api-result-${i + 1}.json`), JSON.stringify(j, null, 2), 'utf8');
        console.log(`   ✅ 有效 JSON（${str.length} 字符），已保存 .fixtures/xj-api-result-${i + 1}.json`);
        /* 打印结构键名 */
        const keys = Object.keys(payload);
        console.log('   顶层键：' + keys.join(', '));
        const rows = payload.list || payload.rows || payload.data || payload.resultList || payload.infoList;
        if (Array.isArray(rows) && rows.length) {
          console.log(`   列表条数：${rows.length}`);
          console.log('   首条字段：' + Object.keys(rows[0]).join(', '));
          console.log('   首条内容：' + JSON.stringify(rows[0]).slice(0, 600));
        }
        console.log('');
        break;
      }
    } catch (_) { /* 非 JSON */ }
    await new Promise((s) => setTimeout(s, 1500));
  }
  console.log('完成。');
})();
