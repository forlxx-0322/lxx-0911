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

  const COLS = 8;
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

  push(['序号', '产品名称', '规格型号', '数量', '单位', '单价(元)', '折扣', '小计(元)'],
    { bold: true, size: 10, align: 'center', height: 20, border: true, fill: true });

  for (const it of (d.items || [])) {
    push([
      it.seq, it.item_name || '', it.spec || '', it.quantity, it.unit || '',
      fmt(it.unit_price),
      it.discount ? `${Math.round(money(it.discount) * 10000) / 100}%` : '—',
      fmt(it.subtotal)
    ], { size: 10, height: 18, border: true, alignRight: [3, 5, 7], alignCenter: [0, 4, 6] });
  }

  r = push(['合计', '', '', '', '', '', '', fmt(d.total_amount)], { bold: true, size: 11, height: 22, border: true });
  merges.push({ s: { r, c: 0 }, e: { r, c: 6 } });
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
  ws['!cols'] = [
    { wch: 6 }, { wch: 18 }, { wch: 30 }, { wch: 8 },
    { wch: 6 }, { wch: 13 }, { wch: 8 }, { wch: 15 }
  ];
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
