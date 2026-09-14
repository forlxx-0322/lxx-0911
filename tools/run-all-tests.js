/**
 * 一键运行全部测试套件，汇总各套件通过/失败数量。
 *
 * 运行顺序与依赖（很关键）：
 *   1. 先清空业务数据（node tools/cleanup-test-data.js --all），让全部套件从空库起跑；
 *      否则各套件按累计数据算出的精确断言（如"设计院 0 家""乌鲁木齐 60 家"）会误判。
 *   2. 阶段七「接口/性能/文件」套件内含备份恢复用例，恢复完会重启服务，务必排在
 *      「浏览器」套件之前，且两者之间不需要人工干预。
 *   3. 阶段一套件会调用优雅停机接口关掉服务，必须放在最末。
 *
 * 用法：
 *   node tools/run-all-tests.js            自动清库后跑全套
 *   node tools/run-all-tests.js --no-clean 跳过清库（沿用当前数据）
 */
'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';

/* 依赖服务的套件（按阶段顺序），阶段一放最后（它会关停服务） */
const SUITES = [
  ['阶段二 · 接口', 'tools/test-phase2-api.js'],
  ['阶段二 · 数据契约', 'tools/test-phase2-ui-contract.js'],
  ['阶段二 · 界面交互', 'tools/test-phase2-ui-interaction.js'],
  ['阶段三 · 接口', 'tools/test-phase3-api.js'],
  ['阶段三 · 界面交互', 'tools/test-phase3-ui-interaction.js'],
  ['阶段四 · 接口', 'tools/test-phase4-api.js'],
  ['阶段四 · 界面交互', 'tools/test-phase4-ui-interaction.js'],
  ['阶段五 · 接口', 'tools/test-phase5-api.js'],
  ['阶段五 · 界面交互', 'tools/test-phase5-ui-interaction.js'],
  ['阶段六 · 接口', 'tools/test-phase6-api.js'],
  ['阶段六 · 界面交互', 'tools/test-phase6-ui-interaction.js'],
  ['数据库结构迁移', 'tools/test-migration.js'],
  /* 地址 → 地州归属 → 地图显示（含历史脏数据纠正与下拉取值） */
  ['地址归属与地图显示', 'tools/test-region-map.js'],
  ['归属地州历史数据纠正', 'tools/test-region-legacy-fix.js'],
  ['归属地州下拉取值', 'tools/test-region-select.js'],
  ['客户详细地址保存', 'tools/test-customer-address.js'],
  ['批量导入模板内容', 'tools/test-import-template.js'],
  ['批量导入客户（接口）', 'tools/test-import-customers.js'],
  ['批量导入客户（界面）', 'tools/test-import-ui.js'],
  /* 1.11 新增 */
  ['跟进提醒（界面）', 'tools/test-remind-ui.js'],
  ['邮件提醒（SMTP）', 'tools/test-notify-email.js'],
  ['提醒与偏好设置页', 'tools/test-prefs-ui.js'],
  ['地图客户点', 'tools/test-map-points.js'],
  ['报价单服务层', 'tools/test-quotation-service.js'],
  ['报价单全流程', 'tools/test-quotation-flow.js'],
  /* 招标采集模块：不联网，用本地模拟 IMAP 服务器跑真实协议 */
  ['招标采集 · MIME 解析', 'tools/test-collect-mail.js'],
  ['招标采集 · IMAP 客户端', 'tools/test-collect-imap.js'],
  ['招标采集 · 信息抽取', 'tools/test-collect-extract.js'],
  ['招标采集 · 采集引擎', 'tools/test-collect-engine.js'],
  ['招标采集 · 接口层', 'tools/test-collect-api.js'],
  ['阶段七 · 最终验收（接口/性能/文件）', 'tools/test-acceptance-core.js'],
  ['阶段七 · 最终验收（浏览器）', 'tools/test-acceptance-browser.js'],
  ['阶段一 · 环境与服务（会关停服务，放最后）', 'tools/test-phase1.js']
];

/** 从套件输出里解析「通过 N / M」 */
function parseTotals(out) {
  const patterns = [
    /通过\s*(\d+)\s*\/\s*(\d+)/g,
    /(\d+)\s*\/\s*(\d+)\s*通过/g,
    /合计[：:]\s*(\d+)\s*\/\s*(\d+)/g
  ];
  let pass = 0; let total = 0; let found = false;
  for (const re of patterns) {
    let m;
    while ((m = re.exec(out))) {
      found = true;
      pass = Math.max(pass, Number(m[1]));
      total = Math.max(total, Number(m[2]));
    }
  }
  return found ? { pass, total } : null;
}

async function healthOk() {
  try {
    const r = await fetch(BASE + '/api/health');
    if (!r.ok) return false;
    const j = await r.json();
    /* 必须确认是本软件的服务，避免把同端口的其它程序当成它
       （signature 形如 crm-bjxt/1，带版本号，所以用前缀匹配） */
    return !!(j && j.ok === true && j.data && typeof j.data.app === 'string'
      && j.data.app.startsWith('crm-bjxt'));
  } catch (_) { return false; }
}

/** 端口上是否还有进程在监听 */
function portBusy(port) {
  try {
    const { execFileSync } = require('node:child_process');
    const out = execFileSync('powershell', ['-NoProfile', '-Command',
      `(Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Measure-Object).Count`
    ], { encoding: 'utf8', timeout: 8000 });
    return Number(String(out).trim()) > 0;
  } catch (_) { return false; }
}

/**
 * 确保服务在线。
 *
 * 为什么需要耐心等待：阶段七的「备份恢复」用例会让服务以退出码 4 主动重启，
 * 紧接着的套件如果在这个窗口内开跑，请求就会 fetch failed。
 * 因此这里先等端口彻底空闲（避免新实例被单实例锁挡掉），再拉起并等健康检查通过。
 */
async function ensureServer() {
  const port = (BASE.match(/:(\d+)/) || [])[1] || '8899';

  /* 已经在跑就直接用 */
  if (await healthOk()) return true;

  /* 先等旧进程把端口让出来（最多 15 秒）；期间若它自己回来了就直接用 */
  for (let i = 0; i < 30; i++) {
    if (await healthOk()) return true;
    if (!portBusy(port)) break;
    await new Promise((s) => setTimeout(s, 500));
  }

  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    detached: true,
    stdio: 'ignore',
    env: Object.assign({}, process.env, { CRM_ROOT: ROOT, CRM_PORT: port })
  });
  child.unref();

  /* 等健康检查通过；超时则再确认一次端口状态后放弃 */
  for (let i = 0; i < 60; i++) {
    await new Promise((s) => setTimeout(s, 500));
    if (await healthOk()) {
      /* 连续两次通过才认为稳定，避免打到正在重启的实例 */
      await new Promise((s) => setTimeout(s, 300));
      if (await healthOk()) {
        console.log(`   （已重新拉起服务，端口 ${port}）`);
        return true;
      }
    }
  }
  return false;
}

const summary = [];

(async () => {
  console.log('================ 全部测试套件 ================\n');

  /* 前置：服务必须在跑。没跑就自动拉起（阶段一套件会在最后关掉服务，
     所以「跑两次全套」时第二次进来时服务是停的）。 */
  if (!(await healthOk())) {
    console.log(`服务未运行（${BASE}），正在自动启动…`);
    if (await ensureServer()) {
      console.log('');
    } else {
      console.log(`自动启动失败，请手动启动服务后重跑（见 启动.bat）。`);
      process.exit(2);
    }
  }

  /* 清空业务数据，保证各套件从空库起跑。
     注意：cleanup-test-data.js 会在检测到"看起来是真实业务数据"的客户时拒绝执行
     （退出码 3），这是为了防止在已录入真实数据的库上误跑验收脚本。
     这种情况下必须由使用者显式确认，运行器不代为跳过。 */
  if (!process.argv.includes('--no-clean')) {
    console.log('--- 前置：清空业务数据（保留字典与行政区划）');
    const clean = spawnSync(process.execPath, [path.join(ROOT, 'tools', 'cleanup-test-data.js'), '--all', '--yes'],
      { cwd: ROOT, encoding: 'utf8' });
    process.stdout.write((clean.stdout || '') + (clean.stderr || ''));
    if (clean.status === 3) {
      console.log('\n已中止：库里存在真实业务数据，未做任何删除。');
      console.log('全套测试需要从空库起跑。请任选其一：');
      console.log('  1) 先备份真实数据（设置 → 备份与恢复 → 立即备份），再确认清空后重跑：');
      console.log('       node tools/cleanup-test-data.js --all --yes --force');
      console.log('       node tools/run-all-tests.js --no-clean');
      console.log('  2) 把数据目录切到测试用的空库再跑：设置 CRM_ROOT 指向另一份拷贝');
      console.log('  3) 只想验证个别功能时，单跑对应套件（它们大多自建自清数据）');
      process.exit(3);
    }
    if (clean.status !== 0) {
      console.log('清库失败，终止。');
      process.exit(2);
    }
    console.log('');
  }

  for (const [label, file] of SUITES) {
    const abs = path.join(ROOT, file);
    if (!fs.existsSync(abs)) {
      console.log(`--- ${label}：文件不存在，跳过（${file}）`);
      summary.push({ label, file, pass: 0, total: 0, code: -1, note: '文件不存在' });
      continue;
    }

    /* 除阶段一（它负责停机）外，每个套件开跑前确保服务在线：
       阶段七「备份恢复」用例执行完会关停服务，需要重新拉起。 */
    if (!file.includes('test-phase1')) {
      const alive = await ensureServer();
      if (!alive) {
        console.log(`--- ${label}：服务不可用，跳过`);
        summary.push({ label, file, pass: 0, total: 0, code: -1, note: '服务不可用' });
        continue;
      }
    }

    process.stdout.write(`--- ${label}（${file}）… `);
    const r = spawnSync(process.execPath, [abs], {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: Object.assign({}, process.env, { CRM_TEST_BASE: BASE })
    });
    const out = (r.stdout || '') + (r.stderr || '');
    const totals = parseTotals(out);
    const failures = (out.match(/✗/g) || []).length;

    if (totals) {
      console.log(`通过 ${totals.pass}/${totals.total}${r.status !== 0 ? `（退出码 ${r.status}）` : ''}`);
      summary.push({ label, file, pass: totals.pass, total: totals.total, code: r.status, failures });
    } else {
      console.log(r.status === 0 ? '完成（未解析到汇总行）' : `退出码 ${r.status}`);
      summary.push({ label, file, pass: 0, total: 0, code: r.status, failures, note: '未解析到汇总行' });
    }

    fs.writeFileSync(
      path.join(ROOT, '.fixtures', 'suite-' + path.basename(file, '.js') + '.log'),
      out, 'utf8'
    );
  }

  console.log('\n================ 汇总 ================');
  let allPass = 0; let allTotal = 0; let badSuites = 0;
  for (const s of summary) {
    const ok = s.total > 0 && s.pass === s.total && s.code === 0;
    if (!ok) badSuites++;
    allPass += s.pass; allTotal += s.total;
    console.log(`${ok ? '✓' : '✗'} ${s.label}：${s.total ? `${s.pass}/${s.total}` : (s.note || '未通过')}`
      + `${s.code !== 0 ? `（退出码 ${s.code}）` : ''}`);
  }
  console.log(`\n合计：通过 ${allPass} / ${allTotal}；${badSuites ? `有 ${badSuites} 个套件未全绿` : '全部套件通过'}`);

  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'all-suites-summary.json'),
    JSON.stringify({ allPass, allTotal, badSuites, summary }, null, 2),
    'utf8'
  );
  console.log('（明细已写入 .fixtures/all-suites-summary.json 与 .fixtures/suite-*.log）');

  process.exit(badSuites ? 1 : 0);
})().catch((e) => {
  console.error('运行器异常：', e && e.stack ? e.stack : e);
  process.exit(2);
});
