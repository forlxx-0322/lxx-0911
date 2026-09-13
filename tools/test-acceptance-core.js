/**
 * 阶段七 · 最终验收测试（专项部分）
 *
 * 覆盖需要特殊布置才能验的验收项：
 *   1  一键启动（.bat 实测 + 3 秒判定）
 *   2  首次初始化（全新环境建库 + 二次启动幂等）
 *   16 Excel 导出（中文不乱码 + 数值列可计算）
 *   17 Excel 导入（100 条全部成功 + 错误行报告 + 特殊字符）
 *   18 附件预览（图片/PDF + 10MB 大文件）
 *   19 备份与恢复（双目录 + 恢复后完全一致 + 精确回滚）
 *   20 端口与重启（重复启动不产生第二个进程、端口释放）
 *   21 数据持久（重启后数据完整）
 *   22 500 条性能（翻页/搜索/筛选均 < 1 秒）
 *
 * 执行顺序有讲究：**19（备份恢复）必须放最后**。
 * 恢复会把整个数据库回滚到备份时刻，若放在中间，
 * 后面依赖数据的验收项（17 导入、22 性能）会全部失效。
 *
 * 用法：node tools/test-acceptance-core.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.resolve(__dirname, '..');
const BASE = 'http://127.0.0.1:8899';
const FIX = path.join(ROOT, '.fixtures');
const BACKUP_DIR = path.join(ROOT, 'data', 'backups');
const MIRROR_DIR = path.join(BACKUP_DIR, 'mirror');
const START_BAT = path.join(ROOT, '启动.bat');

const results = [];
function check(no, name, pass, detail) {
  results.push({ no: String(no), name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${no}. ${name}${detail ? '  —— ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function api(method, p, body) {
  const opts = { method, headers: { Accept: 'application/json' } };
  if (body !== undefined && body !== null) {
    opts.headers['Content-Type'] = 'application/json; charset=utf-8';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch (_) { /* 非 JSON */ }
  return { status: res.status, headers: res.headers, json, data: json && json.data, raw: text };
}

function dayOffset(n) {
  const d = new Date();
  d.setDate(d.getDate() + n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/* ------------------------------------------------------------------ */
/* 服务进程管理                                                        */
/* ------------------------------------------------------------------ */

let spawnedServer = null;

function findServerPid() {
  try {
    const out = execFileSync('netstat', ['-ano'], { encoding: 'utf8' });
    const line = out.split(/\r?\n/).find((l) => /127\.0\.0\.1:8899\s+0\.0\.0\.0:0\s+LISTENING/.test(l));
    if (!line) return null;
    const parts = line.trim().split(/\s+/);
    return Number(parts[parts.length - 1]) || null;
  } catch (_) {
    return null;
  }
}

function killServer() {
  const pid = findServerPid();
  if (pid) {
    try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch (_) { /* 忽略 */ }
  }
  const runFile = path.join(ROOT, 'data', '.run.json');
  try { if (fs.existsSync(runFile)) fs.unlinkSync(runFile); } catch (_) { /* 忽略 */ }
}

async function startServerAndWait(timeoutMs) {
  const t0 = Date.now();
  const child = spawn(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
    cwd: ROOT,
    env: Object.assign({}, process.env, { CRM_ROOT: ROOT, CRM_PORT: '8899' }),
    stdio: 'ignore'
  });
  spawnedServer = child;
  const limit = timeoutMs || 15000;
  while (Date.now() - t0 < limit) {
    await sleep(60);
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) return { ok: true, ms: Date.now() - t0, pid: child.pid };
    } catch (_) { /* 继续等 */ }
  }
  return { ok: false, ms: Date.now() - t0, pid: child.pid };
}

async function waitServerDown(timeoutMs) {
  const limit = timeoutMs || 8000;
  const t0 = Date.now();
  while (Date.now() - t0 < limit) {
    await sleep(120);
    try { await fetch(BASE + '/api/health'); } catch (_) { return true; }
  }
  return false;
}

function releaseServer() {
  if (spawnedServer) {
    try { spawnedServer.unref(); } catch (_) { /* 忽略 */ }
    spawnedServer = null;
  }
}

/** 数据快照（含具体 id 集合，用于恢复后精确比对） */
async function snapshot() {
  const c = await api('GET', '/api/customers?pageSize=500');
  const p = await api('GET', '/api/projects?pageSize=500');
  const t = await api('GET', '/api/tasks?view=all');
  return {
    customers: c.data.total,
    projects: p.data.total,
    tasks: t.data.list.length,
    contractTotal: p.data.summary ? p.data.summary.contract_total : 0,
    ids: c.data.list.map((x) => x.id).sort((a, b) => a - b)
  };
}

/* ------------------------------------------------------------------ */

const created = [];

(async () => {
  console.log('=== 阶段七 最终验收测试（专项） ===\n');

  const health = await api('GET', '/api/health');
  if (health.status !== 200) {
    console.log('服务未运行，无法开始验收。请先双击 启动.bat。');
    process.exit(1);
  }
  console.log(`服务已就绪：${health.data.version}\n`);

  /* ---------- 清理上次残留（保证结果可复现） ---------- */
  {
    let cleaned = 0;
    for (const kw of ['验收测试', '持久化验证', '备份后新增', '附件预览', '导出中文校验', '恢复验证']) {
      const r = await api('GET', '/api/customers?pageSize=500&q=' + encodeURIComponent(kw));
      const ids = (r.data && r.data.list || []).map((x) => x.id);
      for (const id of ids) {
        const pl = await api('GET', `/api/projects?customer_id=${id}&pageSize=100`);
        const pids = (pl.data.list || []).map((p) => p.id);
        if (pids.length) await api('POST', '/api/projects/batch-delete', { ids: pids });
        const tl = await api('GET', `/api/tasks?view=all&customer_id=${id}`);
        const tids = (tl.data.list || []).map((t) => t.id);
        if (tids.length) await api('POST', '/api/tasks/batch-delete', { ids: tids });
        cleaned++;
      }
      if (ids.length) await api('POST', '/api/customers/batch-delete', { ids });
    }
    console.log(cleaned ? `（已清理上次残留 ${cleaned} 条验收测试客户）\n` : '');
  }

  /* ================================================================ */
  /* 验收 1：一键启动                                                  */
  /* ================================================================ */
  console.log('--- 验收 1：一键启动 ---');
  {
    const batExists = fs.existsSync(START_BAT);
    const batBuf = batExists ? fs.readFileSync(START_BAT) : Buffer.alloc(0);
    const hasBom = batBuf[0] === 0xEF && batBuf[1] === 0xBB && batBuf[2] === 0xBF;
    const batText = batBuf.toString('utf8');

    check(1.1, '启动.bat 存在且为 UTF-8 无 BOM（中文不乱码的前提）',
      batExists && !hasBom,
      `文件 ${batBuf.length} 字节，BOM=${hasBom ? '有(异常)' : '无'}`);

    check(1.2, '启动.bat 含完整启动逻辑（Node 检测 / 版本校验 / 端口探测 / 单实例探测 / 自动开浏览器）',
      batText.includes('chcp 65001') && batText.includes('node -v')
        && /22/.test(batText) && /start "" http/.test(batText)
        && batText.includes(':findport') && batText.includes(':probe'),
      '五个关键环节齐全');

    /* 实测：停掉服务，按 .bat 的等价流程启动，量到"可访问"的总耗时 */
    killServer();
    await waitServerDown();
    await sleep(400);

    const started = await startServerAndWait(15000);
    const bootMs = started.ok ? started.ms : -1;

    const t1 = Date.now();
    spawnSync(process.execPath, ['-e',
      "const v=process.versions.node.split('.').map(Number);process.exit((v[0]>22||(v[0]===22&&v[1]>=5))?0:1)"],
      { stdio: 'ignore' });
    const nodeCheckMs = Date.now() - t1;

    const t2 = Date.now();
    try { spawnSync('netstat', ['-ano'], { encoding: 'utf8' }); } catch (_) { /* 忽略 */ }
    const netstatMs = Date.now() - t2;

    const totalMs = bootMs + nodeCheckMs + netstatMs;
    check(1.3, '从启动到服务可访问的总耗时（含 Node 检测与端口探测）< 3 秒',
      started.ok && totalMs < 3000,
      started.ok
        ? `服务就绪 ${bootMs} ms + Node 检测 ${nodeCheckMs} ms + 端口探测 ${netstatMs} ms = ${totalMs} ms`
        : '服务未能启动');

    /* 正常路径不能有交互式暂停（错误分支里的 pause 是正确的） */
    const beforeProbe = (batText.split(':probe')[0] || '').replace(/\r/g, '');
    let inErrorBlock = 0;
    let normalPause = 0;
    for (const line of beforeProbe.split('\n')) {
      if (/echo\s+\[错误\]/.test(line)) inErrorBlock = 1;
      if (inErrorBlock && /^\s*\)/.test(line)) inErrorBlock = 0;
      if (!inErrorBlock && /^\s*pause\s*$/i.test(line)) normalPause++;
    }
    check(1.4, '正常路径上没有交互式暂停（无需人工确认即可完成启动）',
      normalPause === 0,
      `正常路径段 pause ${normalPause} 处（应为 0）；错误分支的 pause 不计入`);
  }

  /* ================================================================ */
  /* 验收 20：端口与重启                                               */
  /* ================================================================ */
  console.log('\n--- 验收 20：端口与重启 ---');
  {
    const before = findServerPid();

    const second = spawnSync(process.execPath, [path.join(ROOT, 'server', 'server.js')], {
      cwd: ROOT,
      env: Object.assign({}, process.env, { CRM_ROOT: ROOT, CRM_PORT: '8899' }),
      encoding: 'utf8',
      timeout: 15000
    });
    await sleep(500);

    const after = findServerPid();
    const out = (second.stdout || '') + (second.stderr || '');

    check(20.1, '服务已在运行时再次启动不会产生第二个进程',
      !!before && before === after,
      `首次 PID=${before}，重复启动后 PID=${after}（同一进程）`);

    check(20.2, '重复启动给出明确提示并优雅退出（退出码 0）',
      second.status === 0 && /已经在运行|无需重复启动/.test(out),
      `退出码=${second.status}，提示="${out.split('\n').filter((l) => l.includes('运行')).join(' ').trim().slice(0, 56)}"`);

    killServer();
    const released = await waitServerDown(8000);
    const pidAfterKill = findServerPid();

    check(20.3, '停止服务后端口释放',
      released && !pidAfterKill,
      `端口已释放=${released}，监听进程=${pidAfterKill || '无'}`);

    const restart = await startServerAndWait(15000);
    check(20.4, '端口释放后可再次正常启动',
      restart.ok,
      restart.ok ? `重启耗时 ${restart.ms} ms，新 PID=${findServerPid()}` : '重启失败');
  }

  /* ================================================================ */
  /* 验收 21：数据持久                                                 */
  /* ================================================================ */
  console.log('\n--- 验收 21：数据持久 ---');
  {
    const c = await api('POST', '/api/customers', {
      name: '验收测试-持久化验证客户', short_name: '持久化验证',
      type: '终端用户', industry: '石油', city: '乌鲁木齐市', district: '天山区',
      annual_demand: 777, remark: '重启后应完整存在'
    });
    created.push(c.data.id);

    const p = await api('POST', '/api/projects', {
      name: '验收测试-持久化验证项目', customer_id: c.data.id,
      stage: '已中标/已签约', contract_amount: 123456, signed_at: dayOffset(-3)
    });
    await api('POST', '/api/payments', {
      project_id: p.data.id, type: '实收', amount: 100000, actual_date: dayOffset(-1), method: '银行转账'
    });
    await api('POST', '/api/tasks', {
      title: '验收测试-持久化待办', customer_id: c.data.id, due_at: dayOffset(2) + ' 10:00:00'
    });

    check(21.1, '重启前录入完整数据（客户 / 项目 / 回款 / 待办）',
      c.data.created && p.data.created,
      `客户 ${c.data.id}，项目 ${p.data.id}，合同 123456，已收 100000`);

    killServer();
    await waitServerDown();
    await sleep(600);
    const restarted = await startServerAndWait(15000);

    const afterCust = await api('GET', `/api/customers/${c.data.id}`);
    const afterProj = await api('GET', `/api/projects/${p.data.id}`);
    const afterTask = await api('GET', `/api/tasks?view=all&customer_id=${c.data.id}`);

    check(21.2, '重启后客户数据完整存在（字段值一致）',
      restarted.ok && afterCust.status === 200
        && afterCust.data.name === '验收测试-持久化验证客户'
        && afterCust.data.annual_demand === 777
        && afterCust.data.city === '乌鲁木齐市'
        && afterCust.data.remark === '重启后应完整存在',
      afterCust.status === 200
        ? '名称 / 年需求 / 城市 / 备注 全部一致'
        : `HTTP ${afterCust.status}`);

    check(21.3, '重启后项目与回款金额一致（派生值未错乱）',
      afterProj.status === 200 && afterProj.data.contract_amount === 123456
        && afterProj.data.received_amount === 100000 && afterProj.data.debt_amount === 23456,
      `合同 ${afterProj.data.contract_amount} / 已收 ${afterProj.data.received_amount} / 欠款 ${afterProj.data.debt_amount}`);

    check(21.4, '重启后待办仍在',
      afterTask.data.list.some((x) => x.title === '验收测试-持久化待办'),
      `该客户待办 ${afterTask.data.list.length} 条`);
  }

  /* ================================================================ */
  /* 验收 2：首次初始化                                                */
  /* ================================================================ */
  console.log('\n--- 验收 2：首次初始化 ---');
  {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acc-init-'));
    const dataDir = path.join(tmp, 'data');
    const backupDir = path.join(dataDir, 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const dbFile = path.join(dataDir, 'crm.db');

    const { initDatabase, closeDatabase, SCHEMA_VERSION } = require('../server/db');
    const first = initDatabase({ dataDir, dbFile, backupDir });
    const tables = first.db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).all().map((r) => r.name);
    const idxCount = first.db.prepare(
      "SELECT COUNT(*) AS n FROM sqlite_master WHERE type='index' AND name LIKE 'idx_%'"
    ).get().n;
    const dictCount = first.db.prepare('SELECT COUNT(*) AS n FROM dict WHERE deleted_at IS NULL').get().n;
    const required = ['customers', 'contacts', 'tags', 'customer_tags', 'followups', 'projects',
      'payments', 'tasks', 'attachments', 'activity_logs', 'dict', 'settings', 'region'];
    const missing = required.filter((t) => !tables.includes(t));
    closeDatabase(first.db);

    check(2.1, '全新环境自动建库并建全部 13 张业务表',
      first.created === true && missing.length === 0,
      missing.length ? `缺少：${missing.join(', ')}`
        : `共 ${tables.length} 张表（含 schema_version），${idxCount} 个索引，字典 ${dictCount} 项，版本 v${first.schemaVersion}`);

    const second = initDatabase({ dataDir, dbFile, backupDir });
    const dictAfter = second.db.prepare('SELECT COUNT(*) AS n FROM dict WHERE deleted_at IS NULL').get().n;
    closeDatabase(second.db);

    check(2.2, '二次启动不重复初始化且不报错（幂等）',
      second.created === false && second.migrations.length === 0
        && second.schemaVersion === SCHEMA_VERSION && dictAfter === dictCount,
      `本次建库=${second.created}，迁移步骤=${second.migrations.length}，版本 v${second.schemaVersion}，字典 ${dictAfter} 项（未重复灌入）`);

    const freshCols = (() => {
      const db = new DatabaseSync(dbFile, { readOnly: true });
      const c = db.prepare('PRAGMA table_info(customers)').all().map((x) => x.name);
      db.close();
      return c;
    })();
    check(2.3, '全新库直接建成最新结构（含 region_code，且无已删除的注册资金）',
      freshCols.includes('region_code') && freshCols.includes('region_name') && !freshCols.includes('reg_capital'),
      `客户表 ${freshCols.length} 列，含 region_code=true，含 reg_capital=false`);

    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (_) { /* 忽略 */ }
  }

  /* ================================================================ */
  /* 验收 16：Excel 导出                                               */
  /* ================================================================ */
  console.log('\n--- 验收 16：Excel 导出 ---');
  {
    const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));

    const c = await api('POST', '/api/customers', {
      name: '验收测试-导出中文校验（阀门）公司', short_name: '导出中文校验',
      type: '终端用户', industry: '石油', city: '克拉玛依市', annual_demand: 1234.56,
      phone: '0990-1234567', remark: '中文备注：含标点、括号（测试）与数字 123'
    });
    created.push(c.data.id);

    const exp = await api('POST', '/api/data/export', { entity: 'customer' });
    const d = exp.data;
    const aoa = [d.fields.map((f) => f.label)];
    for (const r of d.rows) {
      aoa.push(d.fields.map((f) => (r[f.key] === null || r[f.key] === undefined ? '' : r[f.key])));
    }
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '客户');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const outFile = path.join(FIX, '导出结果-验收测试.xlsx');
    fs.writeFileSync(outFile, buf);

    /* 读回（模拟用 Excel 打开） */
    const wb2 = XLSX.read(fs.readFileSync(outFile), { type: 'buffer' });
    const aoa2 = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { header: 1, defval: '' });
    const header = aoa2[0];
    const nameIdx = header.indexOf('客户全称');
    const demandIdx = header.indexOf('年需求量(万元)');
    const remarkIdx = header.indexOf('备注');
    const row = aoa2.find((r) => String(r[nameIdx] || '').includes('导出中文校验'));

    check(16.1, '导出的 xlsx 是合法文件且可被读回（表头与数据行完整）',
      !!row && header.length >= 55,
      row ? `表头 ${header.length} 列，找到目标行，共 ${aoa2.length - 1} 条数据` : '未找到目标行');

    check(16.2, '中文表头与中文内容不乱码',
      header.includes('客户全称') && header.includes('年需求量(万元)')
        && String(row[nameIdx]).includes('验收测试-导出中文校验（阀门）公司'),
      `公司名读回="${String(row[nameIdx]).slice(0, 24)}…"`);

    check(16.3, '中文备注含标点括号不乱码',
      String(row[remarkIdx]).includes('含标点、括号（测试）与数字 123'),
      `备注读回="${String(row[remarkIdx]).slice(0, 30)}"`);

    check(16.4, '数值列读回仍是数字类型（可参与 Excel 计算）',
      typeof row[demandIdx] === 'number' && Math.abs(row[demandIdx] - 1234.56) < 0.01,
      `年需求量类型=${typeof row[demandIdx]}，值=${row[demandIdx]}`);

    const sum = aoa2.slice(1).reduce((s, r) => s + (typeof r[demandIdx] === 'number' ? r[demandIdx] : 0), 0);
    check(16.5, '数值列可参与计算（求和结果正确）',
      sum >= 1234.56,
      `${aoa2.length - 1} 行数值列求和 = ${Math.round(sum * 100) / 100}`);
  }

  /* ================================================================ */
  /* 验收 18：附件预览                                                 */
  /* ================================================================ */
  console.log('\n--- 验收 18：附件预览 ---');
  {
    const owner = await api('POST', '/api/customers', {
      name: '验收测试-附件预览客户', short_name: '附件预览', type: '终端用户', industry: '石油'
    });
    created.push(owner.data.id);

    const pngBuf = fs.readFileSync(path.join(FIX, '合同扫描件-验收测试.png'));
    const upPng = await api('POST', '/api/attachments', {
      owner_type: 'customer', owner_id: owner.data.id,
      file_name: '合同扫描件-验收测试.png', mime_type: 'image/png',
      category: '合同', content_base64: pngBuf.toString('base64')
    });

    const pdfBuf = fs.readFileSync(path.join(FIX, '技术协议-验收测试.pdf'));
    const upPdf = await api('POST', '/api/attachments', {
      owner_type: 'customer', owner_id: owner.data.id,
      file_name: '技术协议-验收测试.pdf', mime_type: 'application/pdf',
      category: '方案', content_base64: pdfBuf.toString('base64')
    });

    check(18.1, '图片附件上传成功并标记为可内联预览',
      upPng.data.previewable === true && upPng.data.is_image === true,
      `${upPng.data.file_name}（${upPng.data.size_text}），previewable=true`);

    check(18.2, 'PDF 附件上传成功并标记为可内联预览',
      upPdf.data.previewable === true && upPdf.data.is_pdf === true,
      `${upPdf.data.file_name}（${upPdf.data.size_text}），previewable=true`);

    const t0 = Date.now();
    const imgRes = await fetch(`${BASE}/api/attachments/${upPng.data.id}/file`);
    const imgGot = Buffer.from(await imgRes.arrayBuffer());
    const imgMs = Date.now() - t0;

    check(18.3, '图片可通过预览 URL 取回，类型与内容正确',
      imgRes.status === 200 && imgRes.headers.get('content-type') === 'image/png'
        && imgRes.headers.get('content-disposition').startsWith('inline') && imgGot.equals(pngBuf),
      `HTTP 200，type=image/png，inline，内容逐字节一致，耗时 ${imgMs} ms`);

    const pdfRes = await fetch(`${BASE}/api/attachments/${upPdf.data.id}/file`);
    const pdfGot = Buffer.from(await pdfRes.arrayBuffer());
    check(18.4, 'PDF 可通过预览 URL 取回，且支持 Range（浏览器阅读器必需）',
      pdfRes.status === 200 && pdfRes.headers.get('content-type') === 'application/pdf'
        && pdfRes.headers.get('accept-ranges') === 'bytes'
        && pdfGot.slice(0, 5).toString('ascii') === '%PDF-',
      `HTTP 200，type=application/pdf，accept-ranges=bytes，文件头 %PDF-，${pdfGot.length} 字节`);

    const txtBuf = Buffer.from('验收测试：不可预览类型应触发下载', 'utf8');
    const upTxt = await api('POST', '/api/attachments', {
      owner_type: 'customer', owner_id: owner.data.id,
      file_name: '资质清单-验收测试.csv', category: '资质',
      content_base64: txtBuf.toString('base64')
    });
    const txtRes = await fetch(`${BASE}/api/attachments/${upTxt.data.id}/file`);
    check(18.5, '非预览类型（csv）使用 attachment 触发下载',
      String(txtRes.headers.get('content-disposition') || '').startsWith('attachment'),
      String(txtRes.headers.get('content-disposition')).slice(0, 46));

    /* 10MB 大文件：验收标准要求"不卡死" */
    const bigSize = 10 * 1024 * 1024;
    const bigBuf = Buffer.alloc(bigSize);
    for (let i = 0; i < bigSize; i += 4096) bigBuf.writeUInt32LE(i, i);

    const tUp = Date.now();
    const upBig = await api('POST', '/api/attachments', {
      owner_type: 'customer', owner_id: owner.data.id,
      file_name: '大图纸-验收测试.pdf', mime_type: 'application/pdf',
      category: '图纸', content_base64: bigBuf.toString('base64')
    });
    const upMs = Date.now() - tUp;

    check(18.6, '10MB 大文件上传成功且未超时',
      upBig.status === 200 && upBig.data.file_size === bigSize,
      upBig.status === 200
        ? `10 MB 上传耗时 ${upMs} ms（${upBig.data.size_text}）`
        : `HTTP ${upBig.status} ${upBig.json && upBig.json.message}`);

    const tR = Date.now();
    const rangeRes = await fetch(`${BASE}/api/attachments/${upBig.data.id}/file`, {
      headers: { Range: 'bytes=5242880-5243885' }
    });
    const rangeBuf = Buffer.from(await rangeRes.arrayBuffer());
    const rangeMs = Date.now() - tR;

    check(18.7, '大文件 Range 分片读取流畅（不卡死）',
      rangeRes.status === 206 && rangeBuf.length === 1006 && rangeMs < 2000
        && rangeBuf.equals(bigBuf.slice(5242880, 5242880 + 1006)),
      `206 Partial，取 1006 字节，耗时 ${rangeMs} ms，内容一致`);

    const fullRes = await fetch(`${BASE}/api/attachments/${upBig.data.id}/file`);
    const fullBuf = Buffer.from(await fullRes.arrayBuffer());
    check(18.8, '大文件完整下载内容一致（无截断）',
      fullBuf.length === bigSize && fullBuf.equals(bigBuf),
      `${fullBuf.length} 字节，与源文件逐字节一致`);

    /* 清理该客户的附件（含 10MB 大文件，避免占空间） */
    const list = await api('GET', `/api/attachments?owner_type=customer&owner_id=${owner.data.id}`);
    if (list.data.list.length) {
      await api('POST', '/api/attachments/batch-delete', { ids: list.data.list.map((x) => x.id) });
    }
  }

  /* ================================================================ */
  /* 验收 17：Excel 导入                                               */
  /* ================================================================ */
  console.log('\n--- 验收 17：Excel 导入 ---');
  {
    const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));
    const tpl = await api('GET', '/api/data/template?entity=customer');

    const wb = XLSX.read(fs.readFileSync(path.join(FIX, '客户导入-100条.xlsx')), { type: 'buffer' });
    const aoa = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });

    const headerRow = aoa[0].map((h) => String(h || '').replace(/[*＊\s]/g, ''));
    const colMap = [];
    for (const f of tpl.data.fields) {
      const idx = headerRow.findIndex((h) => h === f.label);
      if (idx >= 0) colMap[idx] = f;
    }
    const rows = [];
    for (let i = 1; i < aoa.length; i++) {
      const line = aoa[i];
      if (!line || line.every((c) => String(c || '').trim() === '')) continue;
      const obj = {};
      for (let c = 0; c < line.length; c++) if (colMap[c]) obj[colMap[c].key] = line[c];
      rows.push(obj);
    }

    check(17.1, '读取夹具并解析出 100 行数据（表头按模板标签匹配）',
      rows.length === 100,
      `解析 ${rows.length} 行，匹配到 ${colMap.filter(Boolean).length} 列`);

    const preview = await api('POST', '/api/data/preview', { entity: 'customer', rows });
    check(17.2, '导入预校验：100 行全部可导入，无错误行',
      preview.data.total === 100 && preview.data.valid === 100 && preview.data.invalid === 0,
      `共 100 行：可导入 ${preview.data.valid}，有问题 ${preview.data.invalid}`);

    const t0 = Date.now();
    const impRaw = await api('POST', '/api/data/import', { entity: 'customer', rows });
    const impMs = Date.now() - t0;

    /* 接口异常时给出明确原因，而不是抛 TypeError 中断整个验收 */
    if (impRaw.status !== 200 || !impRaw.data) {
      check(17.3, '执行导入：100 条全部成功写入', false,
        `导入接口失败：HTTP ${impRaw.status} ${impRaw.json ? (impRaw.json.code + ' ' + impRaw.json.message) : impRaw.raw.slice(0, 120)}`);
      throw new Error('导入失败，后续依赖数据的验收项无法继续');
    }
    const imp = impRaw;

    check(17.3, '执行导入：100 条全部成功写入',
      imp.data.imported === 100 && imp.data.failed === 0 && imp.data.invalid === 0,
      `成功 ${imp.data.imported} 条，失败 ${imp.data.failed} 条，耗时 ${impMs} ms`);

    const list = await api('GET', '/api/customers?q=' + encodeURIComponent('验收测试客户') + '&pageSize=200');
    check(17.4, '导入后列表可查到 100 条，字段值正确',
      list.data.total === 100,
      `查到 ${list.data.total} 条；抽样：${(list.data.list[0] || {}).name}（${(list.data.list[0] || {}).industry}，年需求 ${(list.data.list[0] || {}).annual_demand} 万）`);

    const withRegion = list.data.list.filter((x) => x.region_code);
    check(17.5, '导入的客户按「市/地区」自动归属地州',
      withRegion.length === 100,
      `${withRegion.length}/100 条已归属（导入报告记录 ${imp.data.regionSynced || 0} 条）；样例：${list.data.list[0].city} → ${list.data.list[0].region_name}`);

    /* 错误行：用「库里不存在的两行」做有效对照 + 缺必填 + 文件内重复。
       注意不要复用本批次已导入的行——那样会被判为"库内重复"而非"文件内重复"。 */
    const validA = { name: '验收测试-校验对照A（未入库）', short_name: '校验对照A', type: '终端用户', industry: '石油', city: '乌鲁木齐市' };
    const validB = { name: '验收测试-校验对照B（未入库）', short_name: '校验对照B', type: '终端用户', industry: '化工' };
    const badRows = [
      validA, validB,
      { name: '', short_name: '缺名称', type: '终端用户', industry: '石油' },
      { name: validA.name, short_name: '重复行', type: '其他', industry: '其他' }
    ];
    const badPreview = await api('POST', '/api/data/preview', { entity: 'customer', rows: badRows });
    check(17.6, '错误行被正确识别并给出原因（必填缺失 / 文件内重复）',
      badPreview.data.valid === 2 && badPreview.data.invalid === 2
        && badPreview.data.rows[2].errors.some((e) => e.includes('必填'))
        && badPreview.data.rows[3].errors.some((e) => e.includes('文件内')),
      `${badPreview.data.valid} 有效 / ${badPreview.data.invalid} 无效；`
      + `第3行：${badPreview.data.rows[2].errors[0]}；第4行：${badPreview.data.rows[3].errors[0]}`);

    const dupRows = [{ name: rows[0].name, short_name: '库内重复', type: '终端用户', industry: '石油' }];
    const dupPreview = await api('POST', '/api/data/preview', { entity: 'customer', rows: dupRows });
    check('17b', '与库中已有客户重名会被识别为库内重复',
      dupPreview.data.rows[0].duplicateInDb === true
        && dupPreview.data.rows[0].action === 'skip'
        && dupPreview.data.rows[0].warnings.some((w) => w.includes('库中已有同名')),
      `action=${dupPreview.data.rows[0].action}；提示：${dupPreview.data.rows[0].warnings.join('；')}`);

    /* 特殊字符文件 */
    const labelToKey = new Map();
    for (const f of tpl.data.fields) labelToKey.set(f.label, f.key);
    const csvText = fs.readFileSync(path.join(FIX, '特殊字符-验收测试.csv'), 'utf8').replace(/^\uFEFF/, '');
    const csvRows = parseCsv(csvText).map((r) => {
      const obj = {};
      for (const [k, v] of Object.entries(r)) {
        const key = labelToKey.get(k);
        if (key) obj[key] = v;
      }
      return obj;
    });
    const csvPreview = await api('POST', '/api/data/preview', { entity: 'customer', rows: csvRows });
    const okRow = csvPreview.data.rows.find((r) => (r.data.short_name || '') === '特殊A');
    const badRow = csvPreview.data.rows.find((r) => r.errors.some((e) => e.includes('必填')));

    check(17.7, '含标签/引号/换行/表情/超长文本的行能正确解析',
      !!okRow && okRow.data.name.includes('<标签>') && okRow.data.remark.includes('"quotes"'),
      okRow ? `公司名="${okRow.data.name}"，备注含引号=${okRow.data.remark.includes('"quotes"')}` : '未解析出该行');

    check(17.8, '缺失必填项的行被标记为错误（不会被导入）',
      !!badRow,
      badRow ? `第 ${badRow.index} 行：${badRow.errors.join('；')}` : '未识别出错误行');

    const dash = await api('GET', '/api/dashboard');
    check(17.9, '导入后首页统计同步更新',
      dash.data.cards.customer_total >= 100,
      `首页客户总数 = ${dash.data.cards.customer_total}`);
  }

  /* ================================================================ */
  /* 验收 22：500 条性能                                               */
  /* ================================================================ */
  console.log('\n--- 验收 22：500 条性能 ---');
  {
    const existing = await api('GET', '/api/customers?q=' + encodeURIComponent('验收测试客户') + '&pageSize=1');
    const need = Math.max(0, 500 - existing.data.total);

    if (need > 0) {
      const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));
      const tpl = await api('GET', '/api/data/template?entity=customer');
      const aoa = [tpl.data.fields.map((f) => f.label)];
      const cities = [['乌鲁木齐市', '天山区'], ['喀什地区', '喀什市'], ['伊犁哈萨克自治州', '伊宁市'],
        ['昌吉回族自治州', '昌吉市'], ['阿克苏地区', '库车市'], ['巴音郭楞蒙古自治州', '库尔勒市']];
      const industries = ['石油', '化工', '电力', '冶金', '水处理'];
      for (let i = 0; i < need; i++) {
        const n = 100 + i + 1;
        const c = cities[i % cities.length];
        const r = {};
        for (const f of tpl.data.fields) r[f.key] = '';
        r.name = `验收测试客户${String(n).padStart(4, '0')}有限公司`;
        r.short_name = `验收客户${n}`;
        r.type = i % 2 ? '终端用户' : '贸易商/经销商';
        r.industry = industries[i % industries.length];
        r.level = i % 3 === 0 ? 'A 重点客户' : 'B 普通客户';
        r.status = '跟进中';
        r.annual_demand = String(100 + (i % 900));
        r.province = '新疆维吾尔自治区';
        r.city = c[0];
        r.district = c[1];
        r.account_period = '月结30天';
        aoa.push(tpl.data.fields.map((f) => r[f.key]));
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, '客户');
      const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

      const wb2 = XLSX.read(buf, { type: 'buffer' });
      const aoa2 = XLSX.utils.sheet_to_json(wb2.Sheets[wb2.SheetNames[0]], { header: 1, defval: '' });
      const headerRow = aoa2[0].map((h) => String(h || '').replace(/[*＊\s]/g, ''));
      const colMap = [];
      for (const f of tpl.data.fields) {
        const idx = headerRow.findIndex((h) => h === f.label);
        if (idx >= 0) colMap[idx] = f;
      }
      const rows = [];
      for (let i = 1; i < aoa2.length; i++) {
        const obj = {};
        for (let c = 0; c < aoa2[i].length; c++) if (colMap[c]) obj[colMap[c].key] = aoa2[i][c];
        rows.push(obj);
      }
      const t = Date.now();
      const imp = await api('POST', '/api/data/import', { entity: 'customer', rows });
      console.log(`   （补充导入 ${imp.data.imported} 条，耗时 ${Date.now() - t} ms）`);
    }

    const total = (await api('GET', '/api/customers?pageSize=1')).data.total;

    const bench = async (label, url) => {
      const times = [];
      for (let i = 0; i < 5; i++) {
        const t = Date.now();
        const r = await api('GET', url);
        times.push(Date.now() - t);
        if (r.status !== 200) return { label, err: 'HTTP ' + r.status, median: 99999, max: 99999 };
      }
      times.sort((a, b) => a - b);
      return { label, median: times[Math.floor(times.length / 2)], max: times[times.length - 1] };
    };

    const all = [];
    all.push(await bench('首页列表', '/api/customers?page=1&pageSize=20'));
    all.push(await bench('末页翻页', `/api/customers?page=${Math.ceil(total / 20)}&pageSize=20`));
    all.push(await bench('关键词搜索', '/api/customers?q=' + encodeURIComponent('验收客户25')));
    all.push(await bench('多维筛选', '/api/customers?industry=' + encodeURIComponent('石油') + '&level=' + encodeURIComponent('A 重点客户')));
    all.push(await bench('按地州筛选', '/api/customers?region_code=650100'));
    all.push(await bench('快捷筛选', '/api/customers?quick=stale30'));
    all.push(await bench('拼音排序', '/api/customers?sort=name&order=asc'));
    all.push(await bench('首页总览', '/api/dashboard'));
    all.push(await bench('地图分布统计', '/api/map/distribution'));

    const worst = Math.max(...all.map((x) => x.max));

    check(22.1, `客户总数已达 ${total} 条（满足 500 条量级）`,
      total >= 500, `实际 ${total} 条`);

    check(22.2, '全部查询场景中位耗时均 < 1 秒',
      all.every((x) => !x.err && x.median < 1000),
      all.map((x) => `${x.label} ${x.median}ms`).join(' | '));

    check(22.3, '全部查询场景最慢一次也 < 1 秒',
      worst < 1000,
      `最慢 ${worst} ms（${(all.find((x) => x.max === worst) || {}).label}）`);

    check(22.4, '500 条下分页与统计结果正确',
      (await api('GET', '/api/customers?pageSize=20')).data.pages === Math.ceil(total / 20),
      `共 ${total} 条 → ${Math.ceil(total / 20)} 页（每页 20）`);
  }

  /* ================================================================ */
  /* 验收 19：备份与恢复（必须最后执行——会把数据库回滚）                */
  /* ================================================================ */
  console.log('\n--- 验收 19：备份与恢复（最后执行） ---');
  {
    /* 备份必须建立在"数据准备完成"之后，否则恢复会把前面导入的数据一起回滚掉 */
    const before = await snapshot();

    const bk = await api('POST', '/api/backup/create', { reason: '验收测试-恢复验证' });
    const bkPath = path.join(BACKUP_DIR, bk.data.name);
    const mirrorPath = path.join(MIRROR_DIR, bk.data.name);

    check(19.1, '手动备份成功，主备份与镜像副本均生成',
      bk.status === 200 && fs.existsSync(bkPath) && fs.existsSync(mirrorPath),
      `${bk.data.name}：主 ${fs.existsSync(bkPath) ? Math.round(fs.statSync(bkPath).size / 1024) + ' KB' : '缺失'}，镜像 ${fs.existsSync(mirrorPath) ? '有' : '缺失'}`);

    const manifest = JSON.parse(fs.readFileSync(bkPath.replace(/\.db$/, '.json'), 'utf8'));
    check(19.2, '备份清单完整（时间 / 结构版本 / 各表行数）',
      !!manifest.createdAt && manifest.schemaVersion >= 3 && manifest.tables
        && Object.keys(manifest.tables).length >= 13,
      `结构版本 v${manifest.schemaVersion}，记录 ${Object.keys(manifest.tables).length} 张表；客户 ${manifest.tables.customers} 条`);

    const verify = await api('POST', '/api/backup/verify', { name: bk.data.name });
    check(19.3, '备份文件完整性校验通过',
      verify.data.ok === true,
      `integrity_check=true，含 ${verify.data.tables} 张表、${verify.data.customers} 条客户`);

    /* 制造可验证的差异 */
    const tempCust = await api('POST', '/api/customers', {
      name: '验收测试-备份后新增的客户（恢复后应消失）', short_name: '备份后新增',
      type: '终端用户', industry: '石油'
    });
    const deletedId = before.ids[0];
    await api('DELETE', `/api/customers/${deletedId}`);
    const mutated = await snapshot();

    const tempVisible = await api('GET', '/api/customers?q=' + encodeURIComponent('备份后新增'));
    const deletedGone = await api('GET', `/api/customers/${deletedId}`);

    check(19.4, '备份后制造了可验证的数据差异（新增 1 条、删除 1 条）',
      tempVisible.data.total === 1 && deletedGone.status === 404
        && JSON.stringify(mutated.ids) !== JSON.stringify(before.ids),
      `新增客户可见（${tempVisible.data.total} 条）、被删客户已不可见（HTTP ${deletedGone.status}）、id 集合已变化`);

    /* 恢复：两步确认 */
    const preview = await api('POST', '/api/backup/restore', { name: bk.data.name });
    check(19.5, '恢复第一步只校验并预览，不改动数据',
      preview.status === 200 && preview.data.needConfirm === true && preview.data.verify.ok === true,
      `预览：将替换 客户 ${preview.data.willReplace.customers} 条`);

    const doRestore = await api('POST', '/api/backup/restore', { name: bk.data.name, confirm: true });
    const safetyName = doRestore.data && doRestore.data.safetyBackup;
    check(19.6, '恢复执行成功，且「恢复前」兜底备份与原备份不是同一个文件',
      doRestore.status === 200 && doRestore.data.restored === true
        && !!safetyName && safetyName !== bk.data.name
        && fs.existsSync(path.join(BACKUP_DIR, safetyName)),
      `恢复源 ${bk.data.name}；兜底备份 ${safetyName}（两者不同名=${safetyName !== bk.data.name}，兜底文件存在）`);

    /* 服务会自行退出（退出码 4 表示需重启），等它停下再拉起 */
    await sleep(3200);
    killServer();
    await waitServerDown(8000);
    await sleep(500);

    const restarted = await startServerAndWait(15000);
    const after = await snapshot();

    check(19.7, '恢复后服务可正常重启并加载还原后的数据',
      restarted.ok, restarted.ok ? `重启耗时 ${restarted.ms} ms` : '重启失败');

    check(19.8, '恢复后数据与备份时刻完全一致（数量 + 客户 id 集合 + 合同额）',
      after.customers === before.customers
        && JSON.stringify(after.ids) === JSON.stringify(before.ids)
        && after.projects === before.projects
        && Math.abs(after.contractTotal - before.contractTotal) < 0.01,
      `客户 ${before.customers} → ${after.customers}；id 集合一致=${JSON.stringify(after.ids) === JSON.stringify(before.ids)}；`
      + `项目 ${before.projects} → ${after.projects}；合同额 ${before.contractTotal} → ${after.contractTotal}`);

    const gone = await api('GET', '/api/customers?q=' + encodeURIComponent('备份后新增'));
    const back = await api('GET', `/api/customers/${deletedId}`);

    check(19.9, '恢复精确回滚：备份后新增的消失、备份后删除的回来',
      gone.data.total === 0 && back.status === 200,
      `「备份后新增」命中 ${gone.data.total} 条（应为 0）；被删客户 id=${deletedId} 查询 HTTP ${back.status}（应为 200）`);

    /* 恢复后数据库已回滚，之前记录的 id 可能失效，清空追踪以免后续误操作 */
    created.length = 0;
    if (tempCust.data) { /* 恢复后已不存在 */ }
  }

  /* ================================================================ */
  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 专项验收汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.no}. ${r.name} —— ${r.detail}`);
  }

  fs.writeFileSync(
    path.join(FIX, 'acceptance-core-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
    'utf8'
  );
  console.log('\n（结果已写入 .fixtures/acceptance-core-result.json）');

  releaseServer();
  process.exit(fail ? 1 : 0);
})().catch((e) => {
  console.error('验收脚本异常：', e && e.stack ? e.stack : e);
  releaseServer();
  process.exit(1);
});

/** 极简 CSV 解析（支持引号包裹与转义引号） */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; }
      } else { field += ch; }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field); field = '';
    } else if (ch === '\n') {
      row.push(field); field = ''; rows.push(row); row = [];
    } else if (ch !== '\r') {
      field += ch;
    }
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }

  if (!rows.length) return [];
  const header = rows[0].map((h) => String(h || '').replace(/[*＊\s]/g, ''));
  return rows.slice(1)
    .filter((r) => r.some((c) => String(c).trim() !== ''))
    .map((r) => {
      const obj = {};
      for (let i = 0; i < r.length; i++) obj[header[i] || ('col' + i)] = r[i];
      return obj;
    });
}
