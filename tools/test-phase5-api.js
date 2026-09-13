/**
 * 阶段五 API 验收测试 —— 附件上传 / 下载 / 预览 / 删除
 * 用法：node tools/test-phase5-api.js
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const ATTACH_DIR = path.resolve(__dirname, '..', 'data', 'attachments');

const results = [];
function check(no, name, pass, detail) {
  results.push({ no, name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${no}. ${name}${detail ? '  —— ' + detail : ''}`);
}

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

/* ---------------- 构造真实测试文件 ---------------- */

/** 最小合法 PNG（1×1 红点） */
function makePng() {
  const b64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==';
  return Buffer.from(b64, 'base64');
}

/** 最小合法 PDF（单页，含中文可读文本） */
function makePdf() {
  const content = `%PDF-1.4
1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj
2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj
3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 100]/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>endobj
4 0 obj<</Length 60>>stream
BT /F1 12 Tf 10 50 Td (Valve Contract Test) Tj ET
endstream
endobj
5 0 obj<</Type/Font/Subtype/Type1/BaseFont/Helvetica>>endobj
trailer<</Root 1 0 R>>
%%EOF`;
  return Buffer.from(content, 'utf8');
}

/** 造一个较大文件用于测试 Range（1.5MB 的伪二进制） */
function makeBig(sizeMb) {
  const size = Math.round(sizeMb * 1024 * 1024);
  const buf = Buffer.alloc(size);
  for (let i = 0; i < size; i++) buf[i] = i % 256;
  return buf;
}

const created = {};

(async () => {
  console.log('=== 阶段五 API 验收测试（附件）===\n');

  /* ---------- 0. 准备客户 ---------- */
  const cust = await api('POST', '/api/customers', {
    name: '阶段五测试客户（附件）', short_name: '附件测试',
    type: '终端用户', industry: '石油'
  });
  created.customer = cust.data.id;
  const proj = await api('POST', '/api/projects', {
    name: '阶段五测试项目（附件）', customer_id: created.customer,
    stage: '已中标/已签约', contract_amount: 100000
  });
  created.project = proj.data.id;
  check(0, '准备测试客户与项目', cust.data.created && proj.data.created,
    `客户 ${created.customer}，项目 ${created.project}`);

  /* ---------- 1. 上传图片 ---------- */
  const png = makePng();
  const up1 = await api('POST', '/api/attachments', {
    owner_type: 'customer', owner_id: created.customer,
    file_name: '营业执照扫描件.png', mime_type: 'image/png',
    category: '资质', remark: '测试用图',
    content_base64: png.toString('base64')
  });
  created.png = up1.data && up1.data.id;
  check(1, '上传图片附件成功',
    up1.status === 200 && up1.data.id > 0 && up1.data.file_size === png.length,
    up1.data ? `id=${up1.data.id}，${up1.data.file_size} 字节，分类=${up1.data.category}` : `HTTP ${up1.status}`);

  check(2, '图片被标记为可预览',
    up1.data.previewable === true && up1.data.is_image === true
      && up1.data.mime_type === 'image/png',
    `previewable=${up1.data.previewable}, is_image=${up1.data.is_image}, mime=${up1.data.mime_type}`);

  /* ---------- 2. 上传 PDF ---------- */
  const pdf = makePdf();
  const up2 = await api('POST', '/api/attachments', {
    owner_type: 'customer', owner_id: created.customer,
    file_name: '2026年度框架协议.pdf', mime_type: 'application/pdf',
    category: '合同',
    content_base64: pdf.toString('base64')
  });
  created.pdf = up2.data && up2.data.id;
  check(3, '上传 PDF 附件成功并识别为可预览',
    up2.data && up2.data.is_pdf === true && up2.data.previewable === true,
    up2.data ? `id=${up2.data.id}，分类=${up2.data.category}，${up2.data.size_text}` : '失败');

  /* ---------- 3. 上传到项目 ---------- */
  const up3 = await api('POST', '/api/attachments', {
    owner_type: 'project', owner_id: created.project,
    file_name: '阀门报价单.xlsx', category: '报价单',
    content_base64: Buffer.from('fake-xlsx-content-for-test').toString('base64')
  });
  created.xlsx = up3.data && up3.data.id;
  check(4, '上传到项目附件成功，MIME 按扩展名推断',
    up3.data && up3.data.mime_type.includes('spreadsheetml'),
    up3.data ? `mime=${up3.data.mime_type}，可预览=${up3.data.previewable}（表格文件不内联预览）` : '失败');

  /* ---------- 4. 文件真实落盘且内容一致 ---------- */
  const diskPath = path.join(ATTACH_DIR, up1.data.file_path);
  const diskBuf = fs.existsSync(diskPath) ? fs.readFileSync(diskPath) : null;
  check(5, '文件真实落盘且内容与原文件一致',
    !!diskBuf && diskBuf.length === png.length && diskBuf.equals(png),
    diskBuf ? `磁盘 ${diskBuf.length} 字节，与上传内容一致=${diskBuf.equals(png)}，路径=${up1.data.file_path}` : '文件不存在');

  check(6, '存储路径按年月分目录、用 uuid 命名（不暴露原文件名）',
    /^\d{4}\/\d{2}\/[0-9a-f]{32}\.png$/.test(up1.data.file_path),
    up1.data.file_path);

  /* ---------- 5. 下载与预览 ---------- */
  const dl = await fetch(BASE + `/api/attachments/${created.png}/file`);
  const dlBuf = Buffer.from(await dl.arrayBuffer());
  check(7, '下载图片返回正确 Content-Type 与内容',
    dl.status === 200 && dl.headers.get('content-type') === 'image/png'
      && dlBuf.equals(png),
    `HTTP ${dl.status}，type=${dl.headers.get('content-type')}，${dlBuf.length} 字节，内容一致=${dlBuf.equals(png)}`);

  check(8, '图片使用 inline 内联显示（浏览器直接预览）',
    String(dl.headers.get('content-disposition') || '').startsWith('inline'),
    dl.headers.get('content-disposition'));

  const dlPdf = await fetch(BASE + `/api/attachments/${created.pdf}/file`);
  check(9, 'PDF 也使用 inline 显示并支持 Range',
    dlPdf.headers.get('content-disposition').startsWith('inline')
      && dlPdf.headers.get('accept-ranges') === 'bytes',
    `disposition=${String(dlPdf.headers.get('content-disposition')).slice(0, 40)}…, accept-ranges=${dlPdf.headers.get('accept-ranges')}`);

  const dlXlsx = await fetch(BASE + `/api/attachments/${created.xlsx}/file`);
  check(10, '非预览类型使用 attachment 触发下载',
    String(dlXlsx.headers.get('content-disposition') || '').startsWith('attachment'),
    String(dlXlsx.headers.get('content-disposition')).slice(0, 60));

  /* 中文文件名编码 */
  check(11, '中文文件名按 RFC 5987 编码（避免下载后乱码）',
    String(dl.headers.get('content-disposition')).includes("filename*=UTF-8''")
      && String(dl.headers.get('content-disposition')).includes(encodeURIComponent('营业执照扫描件.png')),
    String(dl.headers.get('content-disposition')).slice(0, 90));

  check(12, '下载响应带 ETag 与 Content-Length',
    !!dl.headers.get('etag') && Number(dl.headers.get('content-length')) === png.length,
    `etag=${String(dl.headers.get('etag')).slice(0, 20)}…, length=${dl.headers.get('content-length')}`);

  /* ---------- 6. Range 请求（PDF 预览关键） ---------- */
  const big = makeBig(1.5);
  const upBig = await api('POST', '/api/attachments', {
    owner_type: 'project', owner_id: created.project,
    file_name: '大图纸测试.pdf', mime_type: 'application/pdf',
    category: '图纸', content_base64: big.toString('base64')
  });
  created.big = upBig.data && upBig.data.id;
  check(13, '上传 1.5MB 大文件成功',
    upBig.data && upBig.data.file_size === big.length,
    upBig.data ? `${upBig.data.size_text}，${upBig.data.file_size} 字节` : '失败');

  const range = await fetch(BASE + `/api/attachments/${created.big}/file`, {
    headers: { Range: 'bytes=0-1023' }
  });
  const rangeBuf = Buffer.from(await range.arrayBuffer());
  check(14, 'Range 请求返回 206 与正确的分片',
    range.status === 206 && rangeBuf.length === 1024
      && range.headers.get('content-range') === `bytes 0-1023/${big.length}`
      && rangeBuf.equals(big.slice(0, 1024)),
    `HTTP ${range.status}，${rangeBuf.length} 字节，content-range=${range.headers.get('content-range')}，内容一致=${rangeBuf.equals(big.slice(0, 1024))}`);

  const mid = await fetch(BASE + `/api/attachments/${created.big}/file`, {
    headers: { Range: 'bytes=1000000-1000099' }
  });
  const midBuf = Buffer.from(await mid.arrayBuffer());
  check(15, '中间位置 Range 分片正确',
    mid.status === 206 && midBuf.length === 100 && midBuf.equals(big.slice(1000000, 1000100)),
    `HTTP ${mid.status}，取 100 字节，内容一致=${midBuf.equals(big.slice(1000000, 1000100))}`);

  const tail = await fetch(BASE + `/api/attachments/${created.big}/file`, {
    headers: { Range: 'bytes=-500' }
  });
  const tailBuf = Buffer.from(await tail.arrayBuffer());
  check(16, '末尾 Range（bytes=-N）正确',
    tail.status === 206 && tailBuf.length === 500
      && tailBuf.equals(big.slice(big.length - 500)),
    `HTTP ${tail.status}，取末 500 字节，内容一致`);

  const badRange = await fetch(BASE + `/api/attachments/${created.big}/file`, {
    headers: { Range: 'bytes=99999999-99999999' }
  });
  check(17, '越界 Range 返回 416',
    badRange.status === 416,
    `HTTP ${badRange.status}，content-range=${badRange.headers.get('content-range')}`);

  /* ---------- 7. 条件请求 ---------- */
  const etag = dl.headers.get('etag');
  const cached = await fetch(BASE + `/api/attachments/${created.png}/file`, {
    headers: { 'If-None-Match': etag }
  });
  check(18, 'ETag 条件请求返回 304（省流量）',
    cached.status === 304,
    `HTTP ${cached.status}`);

  /* ---------- 8. 列表与分组 ---------- */
  const list = await api('GET', `/api/attachments?owner_type=customer&owner_id=${created.customer}`);
  check(19, '按归属列出附件并汇总大小',
    list.data.total === 2 && list.data.total_size === png.length + pdf.length
      && list.data.by_category['资质'].length === 1
      && list.data.by_category['合同'].length === 1,
    `客户下 ${list.data.total} 个附件，合计 ${list.data.total_size_text}；分类：${Object.entries(list.data.by_category).filter(([, v]) => v.length).map(([k, v]) => k + ':' + v.length).join(' ')}`);

  const listProj = await api('GET', `/api/attachments?owner_type=project&owner_id=${created.project}`);
  check(20, '项目附件与客户附件相互隔离',
    listProj.data.total === 2,
    `项目下 ${listProj.data.total} 个附件（报价单 + 大图纸）`);

  /* ---------- 9. 用量统计 ---------- */
  const usage = await api('GET', '/api/attachments/usage');
  check(21, '用量统计含数据库记录与实际磁盘占用',
    usage.data.count === 4 && usage.data.disk_files === 4
      && usage.data.disk_size === usage.data.size,
    `记录 ${usage.data.count} 个 / 磁盘 ${usage.data.disk_files} 个，占用 ${usage.data.size_text}，上限 ${usage.data.max_mb} MB`);

  /* ---------- 10. 校验与安全 ---------- */
  const badExt = await api('POST', '/api/attachments', {
    owner_type: 'customer', owner_id: created.customer,
    file_name: '木马.exe', content_base64: Buffer.from('x').toString('base64')
  });
  check(22, '可执行文件类型被拒绝',
    badExt.status === 400 && badExt.json.code === 'EXT_NOT_ALLOWED',
    `HTTP ${badExt.status}：${badExt.json.message.slice(0, 60)}…`);

  const noExt = await api('POST', '/api/attachments', {
    owner_type: 'customer', owner_id: created.customer,
    file_name: '没有扩展名', content_base64: Buffer.from('x').toString('base64')
  });
  check(23, '无扩展名文件被拒绝',
    noExt.status === 400 && noExt.json.code === 'NO_EXT',
    noExt.json.message);

  const pathInName = await api('POST', '/api/attachments', {
    owner_type: 'customer', owner_id: created.customer,
    file_name: '../../evil.pdf', content_base64: pdf.toString('base64')
  });
  check(24, '文件名含路径分隔符被拒绝',
    pathInName.status === 400 && pathInName.json.code === 'BAD_FILENAME',
    pathInName.json.message);

  const badOwner = await api('POST', '/api/attachments', {
    owner_type: 'customer', owner_id: 99999999,
    file_name: '测试.pdf', content_base64: pdf.toString('base64')
  });
  check(25, '归属记录不存在时拒绝上传',
    badOwner.status === 400 && badOwner.json.code === 'OWNER_NOT_FOUND',
    badOwner.json.message);

  const badType = await api('POST', '/api/attachments', {
    owner_type: 'unknown', owner_id: created.customer,
    file_name: '测试.pdf', content_base64: pdf.toString('base64')
  });
  check(26, '非法归属类型被拒绝',
    badType.status === 400 && badType.json.code === 'BAD_OWNER_TYPE',
    badType.json.message);

  const emptyContent = await api('POST', '/api/attachments', {
    owner_type: 'customer', owner_id: created.customer,
    file_name: '空文件.pdf', content_base64: ''
  });
  check(27, '空内容被拒绝',
    emptyContent.status === 400 && emptyContent.json.code === 'NO_CONTENT',
    emptyContent.json.message);

  /* 超限：临时把上限调到 1MB，再传 1.5MB */
  const oldSettings = await api('GET', '/api/settings');
  const oldMax = oldSettings.data.settings.attachment_max_mb;
  await api('PUT', '/api/settings', { attachment_max_mb: '1' });
  const tooBig = await api('POST', '/api/attachments', {
    owner_type: 'customer', owner_id: created.customer,
    file_name: '超大文件.pdf', content_base64: big.toString('base64')
  });
  await api('PUT', '/api/settings', { attachment_max_mb: oldMax });
  check(28, '超过大小上限被拒绝并提示可调整',
    tooBig.status === 400 && tooBig.json.code === 'TOO_LARGE'
      && /attachment_max_mb|提醒与偏好|上限/.test(tooBig.json.message),
    tooBig.json.message);

  /* 路径穿越：直接请求不存在的附件 id，以及尝试用编码路径 */
  const nf = await api('GET', '/api/attachments/99999999');
  const nfFile = await fetch(BASE + '/api/attachments/99999999/file');
  check(29, '不存在的附件返回 404',
    nf.status === 404 && nfFile.status === 404,
    `元数据 HTTP ${nf.status}，文件 HTTP ${nfFile.status}`);

  const traversal = await fetch(BASE + '/api/attachments/%2e%2e%2f%2e%2e%2fdata%2Fcrm.db/file');
  check(30, '附件路径穿越被阻止',
    traversal.status === 404 || traversal.status === 400,
    `HTTP ${traversal.status}`);

  /* ---------- 11. 修改分类与备注 ---------- */
  const meta = await api('PUT', `/api/attachments/${created.png}/meta`, {
    category: '合同', remark: '改到合同类下'
  });
  check(31, '可修改附件分类与备注',
    meta.data.category === '合同' && meta.data.remark === '改到合同类下',
    `分类=${meta.data.category}，备注=${meta.data.remark}`);

  const metaBad = await api('PUT', `/api/attachments/${created.png}/meta`, { category: '不存在的分类' });
  check(32, '非法分类回退为「其他」',
    metaBad.data.category === '其他',
    `分类=${metaBad.data.category}`);

  /* ---------- 12. 删除 ---------- */
  const beforeDelete = fs.existsSync(path.join(ATTACH_DIR, up3.data.file_path));
  const del = await api('DELETE', `/api/attachments/${created.xlsx}`);
  const afterDelete = fs.existsSync(path.join(ATTACH_DIR, up3.data.file_path));
  check(33, '删除附件同时移除磁盘文件',
    del.data.file_deleted === true && beforeDelete && !afterDelete,
    `删除前文件存在=${beforeDelete}，删除后=${afterDelete}`);

  const listAfterDel = await api('GET', `/api/attachments?owner_type=project&owner_id=${created.project}`);
  check(34, '删除后不再出现在列表中',
    listAfterDel.data.total === 1,
    `项目下剩余 ${listAfterDel.data.total} 个附件`);

  /* 归属记录被删除时，附件仍可查询（不级联删除，避免误删证据） */
  check(35, '删除是软删除（记录仍在库中可追溯）',
    del.data.id === created.xlsx,
    `软删除附件 id=${del.data.id}`);

  /* ---------- 13. 清理无主文件 ---------- */
  const orphanPath = path.join(ATTACH_DIR, '1999', '01', 'orphan-test-file.pdf');
  fs.mkdirSync(path.dirname(orphanPath), { recursive: true });
  fs.writeFileSync(orphanPath, Buffer.from('orphan'));
  const clean = await api('POST', '/api/attachments/clean-orphans');
  const orphanGone = !fs.existsSync(orphanPath);
  check(36, '清理无主文件（磁盘有、库里没有）',
    clean.data.removed >= 1 && orphanGone,
    `清理 ${clean.data.removed} 个，释放 ${clean.data.freed_text}，测试孤儿文件已移除=${orphanGone}`);

  /* ---------- 14. 类型覆盖 ---------- */
  const types = [
    { name: '技术方案.docx', ext: '.docx' },
    { name: '阀门图纸.dwg', ext: '.dwg' },
    { name: '资质包.zip', ext: '.zip' },
    { name: '参数表.csv', ext: '.csv' },
    { name: '现场照片.jpg', ext: '.jpg' }
  ];
  let typeOk = 0;
  for (const t of types) {
    const r = await api('POST', '/api/attachments', {
      owner_type: 'customer', owner_id: created.customer,
      file_name: t.name, content_base64: Buffer.from('test-' + t.name).toString('base64')
    });
    if (r.status === 200 && r.data.ext === t.ext) typeOk++;
  }
  check(37, '常见文件类型均可上传（docx/dwg/zip/csv/jpg）',
    typeOk === types.length,
    `${typeOk}/${types.length} 成功`);

  /* ---------- 清理 ---------- */
  const finalList = await api('GET', `/api/attachments?owner_type=customer&owner_id=${created.customer}`);
  const ids = finalList.data.list.map((x) => x.id);
  await api('POST', '/api/attachments/batch-delete', { ids });
  const projList = await api('GET', `/api/attachments?owner_type=project&owner_id=${created.project}`);
  if (projList.data.list.length) {
    await api('POST', '/api/attachments/batch-delete', { ids: projList.data.list.map((x) => x.id) });
  }
  await api('DELETE', `/api/projects/${created.project}`);
  await api('DELETE', `/api/customers/${created.customer}`);
  console.log(`\n（已清理测试数据：${ids.length + projList.data.list.length} 个附件、1 个项目、1 个客户）`);

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.no}. ${r.name} —— ${r.detail}`);
  }
  process.exitCode = fail ? 1 : 0;
})().catch((e) => {
  console.error('测试脚本异常：', e && e.stack ? e.stack : e);
  process.exit(1);
});
