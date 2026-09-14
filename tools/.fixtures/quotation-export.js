/**
 * 报价单 Excel 单据生成（测试用，与前端 buildWorkbook 同源逻辑）
 *
 * 前端（web/js/quotation-drawer.js）在浏览器里用 SheetJS 生成；
 * 这里在 Node 侧用同一套「数据 → 行列数组 + 合并 + 列宽」逻辑产出真实 xlsx，
 * 以便测试能读回文件、验证导出内容真的可用（而不是只验证数据结构）。
 *
 * 用法（测试内）：
 *   const { buildWorkbookAoa } = require('./.fixtures/quotation-export');
 *   const buf = buildWorkbookAoa(exportData, XLSX);
 */
'use strict';

/**
 * 把服务端的导出数据转成工作簿并返回 Buffer。
 * @param {object} d    /api/quotations/:id/export 返回的 data
 * @param {object} XLSX SheetJS 实例（由调用方传入，避免重复加载）
 */
function buildWorkbookAoa(d, XLSX) {
  const money = (v) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
  };
  const fmt = (v) => money(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  /* 自定义列：只把本单真的填过值的列排进单据（与 web/js/quotation-drawer.js 同源逻辑） */
  const custom = (d.custom_columns || []).filter((c) => (d.items || []).some(
    (it) => it.extra && String(it.extra[c.name] || '').trim() !== ''
  ));

  /* 单据列按全局列顺序排；「规格型号」是 5 个规格字段合并成一列，取其中最靠前的位置 */
  const order = Array.isArray(d.column_order) ? d.column_order : [];
  const rank = (key) => {
    const i = order.indexOf(key);
    return i < 0 ? 9999 : i;
  };
  const SPEC_KEYS = ['valve_type', 'size_range', 'pressure_rating', 'body_material', 'connection_type'];
  const specRank = Math.min(...SPEC_KEYS.map(rank));

  const slots = [
    { key: 'name', label: '产品名称', rank: rank('item_name'), width: 18, value: (it) => it.item_name || '' },
    { key: 'spec', label: '规格型号', rank: specRank, width: 30, value: (it) => it.spec || '' },
    ...custom.map((c) => ({
      key: 'c:' + c.id,
      label: c.unit ? `${c.name}（${c.unit}）` : c.name,
      rank: rank('f:' + c.id),
      width: 14,
      kind: c.kind,
      value: (it) => ((it.extra && it.extra[c.name] !== undefined) ? it.extra[c.name] : '')
    })),
    { key: 'quantity', label: '数量', rank: rank('quantity'), width: 8, right: true, center: true, value: (it) => it.quantity },
    { key: 'unit', label: '单位', rank: rank('unit'), width: 6, center: true, value: (it) => it.unit || '' },
    { key: 'unit_price', label: '单价(元)', rank: rank('unit_price'), width: 13, right: true, value: (it) => fmt(it.unit_price) },
    {
      key: 'discount',
      label: '折扣',
      rank: rank('discount'),
      width: 8,
      center: true,
      value: (it) => (it.discount ? `${Math.round(money(it.discount) * 10000) / 100}%` : '—')
    },
    { key: 'subtotal', label: '小计(元)', rank: rank('subtotal'), width: 15, right: true, value: (it) => fmt(it.subtotal) }
  ].sort((a, b) => a.rank - b.rank);

  const COLS = 1 + slots.length;          // 首列是「序号」
  const SUM_AT = 1 + slots.findIndex((s) => s.key === 'subtotal');

  const aoa = [];
  const merges = [];
  const rowMeta = [];
  const push = (row, meta) => { aoa.push(row); rowMeta.push(meta || {}); return aoa.length - 1; };
  const blank = (h) => push(new Array(COLS).fill(''), { height: h || 6 });

  let r = push([d.company || '', '', '', '', '', '', '', ''], { bold: true, size: 15, align: 'center', height: 26 });
  merges.push({ s: { r, c: 0 }, e: { r, c: COLS - 1 } });
  r = push(['阀门产品报价单', '', '', '', '', '', '', ''], { bold: true, size: 13, align: 'center', height: 22 });
  merges.push({ s: { r, c: 0 }, e: { r, c: COLS - 1 } });
  blank(6);

  push([`报价单号：${d.quote_no || ''}`, '', '', `版本：V${d.version || 1}`, '',
    `报价日期：${d.quote_date || ''}`, '', `有效期至：${d.valid_until || ''}`], { size: 10, height: 18 });
  push([`客户名称：${d.customer_name || ''}`, '', '', '', '',
    `项目名称：${d.project_name || ''}`, '', `币种：${d.currency || '人民币'}`], { size: 10, height: 18 });
  if (d.contact) {
    r = push([`联系方式：${d.contact}`, '', '', '', '', '', '', ''], { size: 10, height: 18 });
    merges.push({ s: { r, c: 0 }, e: { r, c: 3 } });
  }
  blank(4);

  push(['序号', ...slots.map((s) => s.label)],
    { bold: true, size: 10, align: 'center', height: 20, border: true, fill: true });

  for (const it of (d.items || [])) {
    const row = [it.seq];
    const alignRight = [];
    const alignCenter = [0];
    slots.forEach((s, i) => {
      row.push(s.value(it));
      if (s.right) alignRight.push(i + 1);
      if (s.center) alignCenter.push(i + 1);
    });
    push(row, { size: 10, height: 18, border: true, alignRight, alignCenter });
  }

  const totalRow = new Array(COLS).fill('');
  totalRow[0] = '合计';
  totalRow[SUM_AT] = fmt(d.total_amount);
  r = push(totalRow, { bold: true, size: 11, height: 22, border: true });
  if (SUM_AT > 1) merges.push({ s: { r, c: 0 }, e: { r, c: SUM_AT - 1 } });
  blank(4);

  const clause = [
    ['税率说明', d.tax_note],
    ['交货说明', d.delivery_note],
    ['付款方式', d.payment_note],
    ['备注', d.remark]
  ].filter(([, v]) => v);
  for (const [k, v] of clause) {
    r = push([`${k}：${v}`, '', '', '', '', '', '', ''], { size: 10, height: 18 });
    merges.push({ s: { r, c: 0 }, e: { r, c: COLS - 1 } });
  }
  if (clause.length) blank(4);

  push(['报价单位（盖章）：', '', '', '', '联系人：', d.contact || '', '', ''], { size: 10, height: 22 });
  push(['日期：', '', '', '', '联系电话：', '', '', ''], { size: 10, height: 22 });

  const ws = XLSX.utils.aoa_to_sheet(aoa);
  ws['!cols'] = [{ wch: 6 }, ...slots.map((s) => ({ wch: s.width }))];
  ws['!merges'] = merges;

  const border = {
    top: { style: 'thin', color: { rgb: 'B8C2D0' } },
    bottom: { style: 'thin', color: { rgb: 'B8C2D0' } },
    left: { style: 'thin', color: { rgb: 'B8C2D0' } },
    right: { style: 'thin', color: { rgb: 'B8C2D0' } }
  };
  for (let ri = 0; ri < aoa.length; ri++) {
    const meta = rowMeta[ri] || {};
    for (let ci = 0; ci < COLS; ci++) {
      const addr = XLSX.utils.encode_cell({ r: ri, c: ci });
      if (!ws[addr]) ws[addr] = { t: 's', v: '' };
      const st = {};
      if (meta.bold) st.font = { bold: true, sz: meta.size || 11 };
      else if (meta.size) st.font = { sz: meta.size };
      if (meta.align === 'center') st.alignment = { horizontal: 'center', vertical: 'center' };
      else if (meta.alignRight && meta.alignRight.includes(ci)) st.alignment = { horizontal: 'right', vertical: 'center' };
      else if (meta.alignCenter && meta.alignCenter.includes(ci)) st.alignment = { horizontal: 'center', vertical: 'center' };
      else st.alignment = { vertical: 'center' };
      if (meta.border) st.border = border;
      if (meta.fill && ri > 0) st.fill = { fgColor: { rgb: 'EEF3FA' } };
      ws[addr].s = st;
    }
    if (meta.height) {
      if (!ws['!rows']) ws['!rows'] = [];
      ws['!rows'][ri] = { hpt: meta.height };
    }
  }

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '报价单');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
}

module.exports = { buildWorkbookAoa };
