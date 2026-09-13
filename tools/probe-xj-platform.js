/**
 * 探测新疆公共资源交易网的信息公开入口与数据获取方式。
 * 目标：判断是「静态 HTML 列表」还是「JSON 接口」，决定实现难度。
 *
 * 用法：node tools/probe-xj-platform.js
 */
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
const BASE = 'https://ggzy.xinjiang.gov.cn';
const TIMEOUT = 15000;

async function get(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, {
      signal: ctl.signal,
      headers: {
        'User-Agent': UA,
        'Accept': 'text/html,application/xhtml+xml,application/json,*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9'
      },
      redirect: 'follow'
    });
    const text = await res.text().catch(() => '');
    return { status: res.status, finalUrl: res.url, type: res.headers.get('content-type') || '', text };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? '超时' : e.message };
  } finally { clearTimeout(timer); }
}

/** 从 HTML 中抽取所有站内链接（用于发现栏目结构） */
function links(html, base) {
  const out = new Set();
  const re = /href\s*=\s*["']([^"'#]+)["']/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1].trim();
    if (/^(javascript:|mailto:|tel:)/i.test(href)) continue;
    try {
      const u = new URL(href, base);
      if (u.host === new URL(base).host) out.add(u.pathname + (u.search || ''));
    } catch (_) { /* 忽略 */ }
  }
  return [...out];
}

(async () => {
  console.log('=== 新疆公共资源交易网 · 结构探测 ===\n');

  const home = await get(BASE + '/xinjiangggzy/');
  if (home.status !== 200) {
    console.log('首页不可达：' + (home.error || home.status));
    return;
  }
  console.log(`首页 HTTP ${home.status}，长度 ${home.text.length} 字符`);
  const ls = links(home.text, BASE + '/xinjiangggzy/');
  console.log(`站内链接 ${ls.length} 个，交易信息相关：`);
  for (const l of ls.filter((x) => /jyxx|jygg|zbgg|jy|gg/i.test(x)).slice(0, 30)) {
    console.log('   ' + l);
  }

  /* 常见栏目路径猜测 */
  console.log('\n--- 尝试常见栏目路径 ---');
  const guesses = [
    '/xinjiangggzy/jyxx/003001/003001001/',
    '/xinjiangggzy/jyxx/003001/003001001/003001001001/',
    '/xinjiangggzy/jyxx/003001/003001001/subPage.html',
    '/xinjiangggzy/jyxx/003002/003002001/subPage.html',
    '/xinjiangggzy/jyxx/003004/subPage.html',
    '/xinjiangggzy/jyxx/003001/003001001/003001001001/subPage.html'
  ];
  for (const g of guesses) {
    const r = await get(BASE + g);
    const t = r.text ? ((r.text.match(/<title[^>]*>([\s\S]{0,80}?)<\/title>/i) || [])[1] || '').replace(/\s+/g, ' ').trim() : '';
    console.log(`   ${r.status === 0 ? '✗ ' + r.error : 'HTTP ' + r.status}  ${g}${t ? '  ← ' + t : ''}`);
    if (r.status === 200 && r.text) {
      /* 看是否含列表条目或分页控件 */
      const hasList = /<ul[^>]*class="[^"]*list/i.test(r.text) || /<li[^>]*>\s*<a[^>]+href/i.test(r.text);
      const hasPager = /page|分页|下一页|totalPage/i.test(r.text);
      const hasJsonApi = /\.json|ajax|getData|queryList/i.test(r.text);
      console.log(`        列表结构=${hasList} 分页迹象=${hasPager} 疑含接口调用=${hasJsonApi}`);
    }
    await new Promise((s) => setTimeout(s, 900));   // 限频：单源 ≥ 8 秒是采集规则，探测阶段也保持克制
  }

  /* 是否有 RSS / 数据接口目录 */
  console.log('\n--- 其他获取方式 ---');
  for (const p of ['/rss.xml', '/feed', '/sitemap.xml', '/xinjiangggzy/rss.xml']) {
    const r = await get(BASE + p);
    console.log(`   ${r.status === 0 ? '✗ ' + r.error : 'HTTP ' + r.status}  ${p}`);
    await new Promise((s) => setTimeout(s, 700));
  }
  console.log('\n完成。');
})();
