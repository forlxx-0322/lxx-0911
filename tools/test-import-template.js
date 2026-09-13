/**
 * 导入模板内容测试
 *
 * 直接在 Node 里跑一遍模板生成逻辑（与前端 CRM.importXlsx.downloadTemplate 同构），
 * 把生成的工作簿读回来核对：
 *   - 表头顺序、必填标记、示例行、只填必填项的最小示例行
 *   - 「填写说明」页存在且包含关键提示
 *   - 「可选值参考」页列出各字典列的当前可选值（避免用户填出脏字典项）
 *
 * 用法：先启动服务，再 node tools/test-import-template.js
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const BASE = process.env.CRM_TEST_BASE || 'http://127.0.0.1:8899';
const XLSX = require(path.join(ROOT, 'web', 'vendor', 'xlsx.full.min.js'));

const results = [];
function check(name, pass, detail) {
  results.push({ name, pass: !!pass, detail: detail || '' });
  console.log(`[${pass ? '✓ 通过' : '✗ 失败'}] ${name}${detail ? '  —— ' + detail : ''}`);
}

/** 与前端 downloadTemplate 完全相同的生成逻辑（保证测的就是实际产物） */
function buildWorkbook(tpl) {
  const header = tpl.fields.map((f) => (f.required ? f.label + ' *' : f.label));
  const sample = tpl.sample;
  const minimal = tpl.fields.map((f, i) => {
    if (!f.required) return '';
    const v = sample[i];
    if (v === '' || v === undefined) return '';
    if (f.options && f.options.length && !f.options.includes(v)) return f.options[0];
    return v;
  });

  const ws = XLSX.utils.aoa_to_sheet([header, sample, minimal]);
  ws['!cols'] = tpl.fields.map((f) => ({ wch: Math.max(10, Math.min(40, f.width || 16)) }));
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, tpl.label + '导入模板');

  const notes = [
    ['填写说明'], [''],
    ['1. 请不要修改第一行表头文字；列顺序可以调整，多余的列会被忽略。'],
    ['2. 带 * 的列为必填项；其余列可留空。'],
    ['3. 第 2 行是完整示例，第 3 行只填了必填项——可直接照着改，也可删掉这两行再填。'],
    ['4. 「是否上市」「要求TS许可证」「主联系人」「决策人」等列填「是」或「否」；留空按「否」处理。'],
    ['5. 日期支持 2026-03-01、2026/3/1、2026年3月1日；带时间的列如「下次跟进时间」写 2026-03-01 10:00。'],
    ['6. 多值列（如常用阀门类型、认证要求）用英文或中文逗号分隔，例如：球阀,闸阀,截止阀。'],
    ['7. 数字列请只填数字，不要带单位（如年需求量填 800，不要写「800 万」）。'],
    ['8. 带下拉选项的列，请优先使用「可选值参考」页里的写法；填了列表外的词也能导入，但会在字典里新增一个选项。'],
    ['9. 「市/地区」决定客户在地图上的归属：填「克拉玛依市」「喀什地区」等标准名称即可自动归入统计；只填「市/地区」或只填「区/县」都能识别。'],
    ['10. 客户全称重复的行会被识别为重复客户，导入时可选择跳过或更新已有记录。'],
    ['11. 导入前系统会先做校验并展示预览，不会直接写入数据库。'],
    ['12. 单次最多导入 5000 行。']
  ];
  const ws2 = XLSX.utils.aoa_to_sheet(notes);
  ws2['!cols'] = [{ wch: 96 }];
  XLSX.utils.book_append_sheet(wb, ws2, '填写说明');

  const dictFields = tpl.fields.filter((f) => f.options && f.options.length);
  if (dictFields.length) {
    const ref = [['列名', '是否必填', '可选值（推荐照此填写）']];
    for (const f of dictFields) ref.push([f.label, f.required ? '必填' : '可空', f.options.join('、')]);
    ref.push([]);
    ref.push(['提示', '', '以上是系统当前已有的选项。填列表外的词会被自动加入字典，']);
    ref.push(['', '', '但同一含义尽量只用一种写法（例如统一用「终端用户」而不是「终端客户」）。']);
    const ws3 = XLSX.utils.aoa_to_sheet(ref);
    ws3['!cols'] = [{ wch: 22 }, { wch: 10 }, { wch: 90 }];
    XLSX.utils.book_append_sheet(wb, ws3, '可选值参考');
  }
  return wb;
}

(async () => {
  console.log('=== 导入模板内容测试 ===\n');

  const tpl = (await (await fetch(BASE + '/api/data/template?entity=customer')).json()).data;
  const wb = buildWorkbook(tpl);

  /* 真实写入 → 读回，验证文件本身可用 */
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const back = XLSX.read(buf, { type: 'buffer' });
  const OUT = path.join(ROOT, '.fixtures', '客户导入模板-测试.xlsx');
  fs.writeFileSync(OUT, buf);
  console.log(`模板已生成：${path.relative(ROOT, OUT)}（${Math.round(buf.length / 1024)} KB）\n`);

  /* ---------- 1. 工作表结构 ---------- */
  check('模板含 3 张表：导入模板 / 填写说明 / 可选值参考',
    back.SheetNames.length === 3
    && back.SheetNames[0] === '客户导入模板'
    && back.SheetNames[1] === '填写说明'
    && back.SheetNames[2] === '可选值参考',
    back.SheetNames.join(' / '));

  const ws = back.Sheets['客户导入模板'];
  const aoa = XLSX.utils.sheet_to_json(ws, { header: 1, raw: false, defval: '' });
  const headerRow = aoa[0].map((h) => String(h));

  /* ---------- 2. 表头与必填标记 ---------- */
  const requiredLabels = tpl.fields.filter((f) => f.required).map((f) => f.label + ' *');
  check('必填列在表头带 * 标记',
    requiredLabels.every((h) => headerRow.includes(h)),
    `必填：${requiredLabels.map((h) => h.trim()).join('、')}`);
  check('表头列数与字段数一致', headerRow.length === tpl.fields.length,
    `${headerRow.length} 列`);

  /* ---------- 3. 示例行 ---------- */
  const sampleRow = aoa[1].map((v) => String(v));
  check('第 2 行为完整示例（多数列有值）',
    sampleRow.filter((v) => v !== '').length > 30,
    `${sampleRow.filter((v) => v !== '').length} 列有示例值，例如 客户全称=「${sampleRow[0]}」`);

  const minRow = aoa[2].map((v) => String(v));
  const minFilled = tpl.fields.filter((f, i) => minRow[i] !== '').map((f) => f.label);
  check('第 3 行只填必填项（示意"最少填什么"）',
    minFilled.length === tpl.fields.filter((f) => f.required).length
    && minFilled.every((l) => tpl.fields.find((f) => f.label === l).required),
    `填了：${minFilled.join('、')}`);

  /* ---------- 4. 字典值必须在可选值里（避免示例本身就不合法） ---------- */
  const badSample = [];
  tpl.fields.forEach((f, i) => {
    const v = sampleRow[i];
    if (!v || !f.options || !f.options.length) return;
    if (!f.options.includes(v)) badSample.push(`${f.label}「${v}」`);
  });
  check('示例值都在字典可选范围内（照着填不会产生脏选项）',
    badSample.length === 0,
    badSample.length ? `不合规：${badSample.join('、')}` : `已核对 ${tpl.fields.filter((f) => f.options && f.options.length).length} 个字典列`);

  /* ---------- 5. 填写说明页 ---------- */
  const ws2 = back.Sheets['填写说明'];
  const noteText = XLSX.utils.sheet_to_json(ws2, { header: 1, raw: false, defval: '' })
    .map((r) => r.join('')).join('\n');
  check('填写说明页包含关键提示（必填/日期/多值/归属地州/重名）',
    /必填项/.test(noteText) && /日期支持/.test(noteText)
    && /多值列/.test(noteText) && /归属/.test(noteText) && /重名|重复/.test(noteText),
    `说明页 ${noteText.length} 字`);

  /* ---------- 6. 可选值参考页 ---------- */
  const ws3 = back.Sheets['可选值参考'];
  const refRows = XLSX.utils.sheet_to_json(ws3, { header: 1, raw: false, defval: '' });
  /* 只取真正的字典行：第 2 列是「必填」或「可空」；末尾的「提示」行不算 */
  const dictCols = refRows.slice(1)
    .filter((r) => r[0] && (r[1] === '必填' || r[1] === '可空'))
    .map((r) => String(r[0]));
  /* 期望值取自模板自身（带 options 的字段），避免把数字写死在断言里 */
  const expectDictCols = tpl.fields.filter((f) => f.options && f.options.length).map((f) => f.label);
  check('可选值参考页列出全部字典列',
    dictCols.length === expectDictCols.length
    && expectDictCols.every((l) => dictCols.includes(l)),
    `参考页 ${dictCols.length} 列 / 模板字典列 ${expectDictCols.length} 列：${dictCols.join('、')}`);

  /* 逐列核对可选值与接口返回一致 */
  const mismatch = [];
  for (const r of refRows.slice(1)) {
    const label = String(r[0] || '');
    const field = tpl.fields.find((f) => f.label === label);
    if (!field || !field.options) continue;
    const listed = String(r[2] || '').split('、');
    if (listed.join('、') !== field.options.join('、')) mismatch.push(label);
  }
  check('参考页里的可选值与系统当前字典一致',
    mismatch.length === 0,
    mismatch.length ? `不一致：${mismatch.join('、')}` : '全部一致');

  /* ---------- 7. 该模板能被导入流程直接读回 ---------- */
  const headerNoStar = headerRow.map((h) => h.replace(/[*＊\s]/g, ''));
  const colMap = [];
  for (const f of tpl.fields) {
    const idx = headerNoStar.findIndex((h) => h === f.label);
    if (idx >= 0) colMap[idx] = f;
  }
  const missing = tpl.fields.filter((f) => f.required && !colMap.some((c) => c && c.key === f.key));
  check('前端"表头匹配"逻辑能从该模板识别出全部必填列',
    missing.length === 0,
    missing.length ? `缺：${missing.map((f) => f.label).join('、')}` : '全部识别');

  const pass = results.filter((r) => r.pass).length;
  const fail = results.length - pass;
  console.log(`\n=== 汇总 ===\n通过 ${pass} / ${results.length}，失败 ${fail}`);
  if (fail) {
    console.log('\n失败项：');
    for (const r of results.filter((x) => !x.pass)) console.log(`  ✗ ${r.name} —— ${r.detail}`);
  }
  fs.writeFileSync(
    path.join(ROOT, '.fixtures', 'import-template-result.json'),
    JSON.stringify({ pass, fail, total: results.length, results }, null, 2),
    'utf8'
  );
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('测试异常：', e.stack || e); process.exit(1); });
