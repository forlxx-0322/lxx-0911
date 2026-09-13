/**
 * 从 webBuilderCommon.js 中找出列表取数接口，并实际请求验证。
 * 用法：node tools/probe-xj-endpoint.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const BASE = 'https://ggzy.xinjiang.gov.cn';
const REF = BASE + '/xinjiangggzy_new/jyxx/trade_info.html';
const TIMEOUT = 18000;

async function get(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, Object.assign({
      signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json, text/javascript, */*; q=0.01',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'X-Requested-With': 'XMLHttpRequest',
        'Referer': REF
      },
      redirect: 'follow'
    }, opts || {}));
    const buf = Buffer.from(await res.arrayBuffer());
    let text = buf.toString('utf8');
    if ((text.match(/\uFFFD/g) || []).length > 5) {
      try { text = new TextDecoder('gbk').decode(buf); } catch (_) { /* utf8 */ }
    }
    return { status: res.status, type: res.headers.get('content-type') || '', text, bytes: buf.length };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? '超时' : e.message };
  } finally { clearTimeout(timer); }
}

(async () => {
  const jsUrl = BASE + '/xinjiangggzy_new/js/webBuilderCommon.js';
  const js = await get(jsUrl);
  console.log(`webBuilderCommon.js → HTTP ${js.status}，${js.text.length} 字符\n`);
  if (js.status !== 200) return;
  fs.writeFileSync(path.resolve(__dirname, '..', '.fixtures', 'xj-webBuilderCommon.js'), js.text, 'utf8');

  /* 所有字符串形式的接口路径 */
  const paths = [...new Set([...js.text.matchAll(/["'`](\/[a-zA-Z0-9_\-.$/{}+]+)["'`]/g)].map((m) => m[1]))];
  console.log('=== JS 中的接口路径 ===');
  for (const p of paths.slice(0, 60)) console.log('   ' + p);

  /* 含 ajax / getJSON / post 的调用上下文 */
  console.log('\n=== 网络调用片段 ===');
  const re = /\$\.(?:ajax|get|post|getJSON)\s*\(|fetch\s*\(|XMLHttpRequest/gi;
  let m; let n = 0;
  while ((m = re.exec(js.text)) && n < 10) {
    const s = Math.max(0, m.index - 200);
    console.log(`\n[${++n}] …${js.text.slice(s, m.index + 400).replace(/\s+/g, ' ')}…`);
  }

  /* 参数名 */
  const params = [...new Set([...js.text.matchAll(/["']?(catenum|catetype|pageNo|pageSize|pageIndex|page|keyword|projectName|projectCode|regionCode|tradeType|publishDate|beginTime|endTime|searchType|orderBy)["']?\s*[:=]/gi)].map((x) => x[1]))];
  console.log('\n=== 请求参数名 ===\n   ' + (params.join(', ') || '（未识别）'));
  console.log('\n完成。');
})();
