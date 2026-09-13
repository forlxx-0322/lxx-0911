/**
 * 招标数据源合规与可达性探测
 *
 * 用途：开发采集模块前，先核实各数据源的 robots.txt 与页面可达性，
 *       避免把"想当然"写进实现里（附录 A.3 的结论也需要复核）。
 *
 * 用法：node tools/probe-tender-sources.js
 */
'use strict';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 '
  + '(KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';

const SOURCES = [
  ['中国招标投标公共服务平台', 'https://www.cebpubservice.com/'],
  ['全国公共资源交易平台', 'https://www.ggzy.gov.cn/'],
  ['新疆公共资源交易网', 'https://ggzy.xinjiang.gov.cn/'],
  ['新疆维吾尔自治区招标投标公共服务平台', 'https://www.xjztb.cn/'],
  ['采购与招标网', 'https://www.chinabidding.com/'],
  ['中国政府采购网', 'https://www.ccgp.gov.cn/'],
  ['中招联合招标采购网', 'https://www.365trade.com.cn/']
];

const TIMEOUT = 15000;

async function fetchText(url, opts) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT);
  try {
    const res = await fetch(url, Object.assign({
      signal: ctl.signal,
      headers: { 'User-Agent': UA, 'Accept': 'text/html,text/plain,*/*' },
      redirect: 'follow'
    }, opts || {}));
    const text = await res.text().catch(() => '');
    return { status: res.status, url: res.url, text, headers: res.headers };
  } catch (e) {
    return { status: 0, error: e.name === 'AbortError' ? '超时' : e.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 robots.txt 中与本工具相关的规则 */
function analyzeRobots(txt) {
  if (!txt) return { verdict: '空内容' };
  const lines = txt.split(/\r?\n/).map((l) => l.replace(/#.*$/, '').trim()).filter(Boolean);
  const groups = [];
  let cur = null;
  for (const line of lines) {
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === 'user-agent') {
      cur = { agents: [val], rules: [] };
      groups.push(cur);
    } else if (cur && (key === 'disallow' || key === 'allow')) {
      cur.rules.push({ type: key, path: val });
    }
  }
  const star = groups.filter((g) => g.agents.some((a) => a === '*'));
  const disallowAll = star.some((g) => g.rules.some((r) => r.type === 'disallow' && r.path === '/'));
  const disallowRootPrefix = star.some((g) => g.rules.some((r) => r.type === 'disallow' && r.path === '/*'));
  const ruleCount = star.reduce((s, g) => s + g.rules.length, 0);
  let verdict;
  if (disallowAll || disallowRootPrefix) verdict = '⛔ 全站禁止（Disallow: /）';
  else if (ruleCount === 0) verdict = '✅ 未对通用爬虫设限';
  else verdict = `⚠ 部分限制（${ruleCount} 条规则）`;
  return { verdict, groups: star.length, ruleCount, raw: txt.slice(0, 400) };
}

(async () => {
  console.log('=== 招标数据源探测（robots.txt + 可达性）===');
  console.log('时间：' + new Date().toLocaleString('zh-CN'));
  console.log('UA：' + UA.slice(0, 60) + '…\n');

  for (const [name, home] of SOURCES) {
    const origin = new URL(home).origin;
    const robotsUrl = origin + '/robots.txt';
    console.log('── ' + name);
    console.log('   首页：' + home);

    const homeRes = await fetchText(home);
    if (homeRes.status === 0) {
      console.log(`   可达性：✗ ${homeRes.error}\n`);
      continue;
    }
    const titleMatch = (homeRes.text || '').match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i);
    console.log(`   可达性：HTTP ${homeRes.status}${titleMatch ? '  标题：' + titleMatch[1].replace(/\s+/g, ' ').trim() : ''}`);

    const rb = await fetchText(robotsUrl);
    if (rb.status === 0) {
      console.log(`   robots.txt：✗ ${rb.error}\n`);
    } else if (rb.status === 404) {
      console.log('   robots.txt：未声明（HTTP 404）→ 无明确禁止，仍需遵守四不原则\n');
    } else {
      const a = analyzeRobots(rb.text);
      console.log(`   robots.txt：HTTP ${rb.status} → ${a.verdict}`);
      if (a.raw) {
        const head = a.raw.split(/\r?\n/).slice(0, 6).map((l) => '      | ' + l).join('\n');
        console.log(head);
      }
      console.log('');
    }
  }

  /* 单独探测新疆公共资源交易网的检索入口（本地项目主力来源） */
  console.log('── 新疆公共资源交易网 · 检索入口探测');
  const candidates = [
    'https://ggzy.xinjiang.gov.cn/xinjiangggzy/jyxx/003001/003001001/subPage.html',
    'https://ggzy.xinjiang.gov.cn/xinjiangggzy/jyxx/003001/subPage.html',
    'https://ggzy.xinjiang.gov.cn/xinjiangggzy/'
  ];
  for (const u of candidates) {
    const r = await fetchText(u);
    console.log(`   ${r.status === 0 ? '✗ ' + r.error : 'HTTP ' + r.status}  ${u}`);
    if (r.status === 200 && r.text) {
      const t = (r.text.match(/<title[^>]*>([\s\S]{0,100}?)<\/title>/i) || [])[1];
      if (t) console.log(`        标题：${t.replace(/\s+/g, ' ').trim()}`);
    }
  }
  console.log('\n完成。');
})();
