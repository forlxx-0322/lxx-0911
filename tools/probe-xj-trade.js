/**
 * 验证新疆公共资源交易网「交易信息」板块的真实数据接口与字段。
 * 用法：node tools/probe-xj-trade.js
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
        'Accept': 'text/html,application/json,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        'X-Requested-With': 'XMLHttpRequest'
      },
      redirect: 'follow'
    }, opts || {}));
    const buf = Buffer.from(await res.arrayBuffer());
    let text = buf.toString('utf8');
    if ((text.match(/\uFFFD/g) || []).length > 5) {
      try { text = new TextDecoder('gbk').decode(buf); } catch (_) { /* utf8 */ }
    }
    return { status: res.status, url: res.url, type: res.headers.get('content-type') || '', text };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? '超时' : e.message };
  } finally { clearTimeout(timer); }
}

(async () => {
  const page = '/xinjiangggzy_new/jyxx/trade_info.html';
  const r = await get(BASE + page);
  console.log(`=== ${page} ===`);
  console.log(`HTTP ${r.status}${r.error ? ' ' + r.error : ''}，${r.text.length} 字符\n`);
  if (r.status !== 200) return;

  fs.writeFileSync(path.resolve(__dirname, '..', '.fixtures', 'xj-trade-info.html'), r.text, 'utf8');

  /* 1. 找出页面里引用的脚本，尤其列表渲染脚本 */
  const scripts = [...r.text.matchAll(/<script[^>]+src\s*=\s*["']([^"']+)["']/gi)].map((m) => m[1]);
  console.log('外链脚本：');
  for (const s of scripts) console.log('   ' + s);

  /* 2. 内联脚本里的接口地址（这类站点多用 ajax 取列表） */
  const urls = [...new Set([
    ...[...r.text.matchAll(/(?:url|action|api)\s*[:=]\s*["']([^"']{3,140})["']/gi)].map((m) => m[1]),
    ...[...r.text.matchAll(/["'](\/[a-zA-Z0-9_\-/.]*(?:getList|list|query|search|json|data)[a-zA-Z0-9_\-/.]*)["']/gi)].map((m) => m[1])
  ])];
  console.log('\n内联脚本中的接口候选：');
  for (const u of urls.slice(0, 40)) console.log('   ' + u);

  /* 3. 隐藏域里的栏目号（这类站点靠 catenum 区分栏目） */
  const hidden = [...r.text.matchAll(/<input[^>]+(?:id|name)\s*=\s*["']([^"']+)["'][^>]*value\s*=\s*["']([^"']*)["']/gi)]
    .map((m) => `${m[1]}=${m[2]}`);
  console.log('\n隐藏域：' + (hidden.length ? hidden.join('  ') : '无'));

  /* 4. 详情页链接（若列表是服务端渲染，这里会有） */
  const details = [...new Set([...r.text.matchAll(/href\s*=\s*["']([^"']*\/20\d{6}\/[^"']+\.html)["']/gi)].map((m) => m[1]))];
  console.log(`\n详情页链接：${details.length} 个`);
  for (const d of details.slice(0, 6)) console.log('   ' + d);

  /* 5. 页面可见文本，看实际栏目名 */
  const text = r.text
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  console.log('\n--- 页面文本（前 900 字）---');
  console.log(text.slice(0, 900));

  /* 6. 尝试该站常见的列表接口形态 */
  console.log('\n=== 试探列表接口 ===');
  const tries = [
    '/xinjiangggzy_new/jyxx/trade_info.html?catenum=003001',
    '/xinjiangggzy_new/interface/getInfoList.do?catenum=003001&page=1',
    '/xinjiangggzy_new/jyxx/getList.do?catenum=003001'
  ];
  for (const t of tries) {
    const res = await get(BASE + t);
    console.log(`   ${res.status === 0 ? '✗ ' + res.error : 'HTTP ' + res.status}  ${t}  ${res.type.slice(0, 40)}`);
    if (res.status === 200 && /json/i.test(res.type)) console.log('        返回：' + res.text.slice(0, 200));
    await new Promise((s) => setTimeout(s, 1200));
  }
  console.log('\n完成。');
})();
