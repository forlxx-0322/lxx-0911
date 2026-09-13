/**
 * 取 pageView.js，定位交易信息列表的真实数据接口与请求参数。
 * 用法：node tools/probe-xj-api.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const BASE = 'https://ggzy.xinjiang.gov.cn';
const TIMEOUT = 18000;

async function get(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, Object.assign({
      signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'Referer': BASE + '/xinjiangggzy_new/jyxx/trade_info.html'
      },
      redirect: 'follow'
    }, opts || {}));
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
  const js = await get(BASE + '/xinjiangggzy_new/js/pageView.js');
  console.log(`pageView.js → HTTP ${js.status}，${js.text.length} 字符\n`);
  if (js.status !== 200) return;
  fs.writeFileSync(path.resolve(__dirname, '..', '.fixtures', 'xj-pageView.js'), js.text, 'utf8');

  /* 找出所有 ajax / fetch 的 url 与关键参数 */
  const urls = [...new Set([
    ...[...js.text.matchAll(/url\s*:\s*["']([^"']+)["']/gi)].map((m) => m[1]),
    ...[...js.text.matchAll(/["'](\/[a-zA-Z0-9_\-/.]+)["']/g)].map((m) => m[1]),
    ...[...js.text.matchAll(/["'](https?:\/\/[^"']+|\/\/[^"']+)["']/g)].map((m) => m[1])
  ])];
  console.log('=== 候选接口地址 ===');
  for (const u of urls.filter((x) => /\.(?:do|json|action)|list|query|search|get/i.test(x)).slice(0, 40)) {
    console.log('   ' + u);
  }

  /* 打印 ajax 调用附近片段 */
  console.log('\n=== ajax / fetch 调用片段 ===');
  const re = /(?:ajax|fetch)\s*\(|url\s*:/gi;
  let m; let n = 0;
  while ((m = re.exec(js.text)) && n < 8) {
    const s = Math.max(0, m.index - 160);
    const seg = js.text.slice(s, m.index + 420).replace(/\s+/g, ' ');
    console.log(`\n[${++n}] …${seg}…`);
  }

  /* 提取参数名，便于构造请求 */
  const params = [...new Set([...js.text.matchAll(/["']?(catenum|catetype|pageNo|pageSize|pageIndex|page|keyword|projectName|projectCode|region|tradeType|publishDate|startTime|endTime|type|code)["']?\s*[:=]/gi)].map((x) => x[1]))];
  console.log('\n=== 出现的请求参数名 ===\n   ' + params.join(', '));
  console.log('\n完成。');
})();
