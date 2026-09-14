/**
 * 报价单抽屉 —— 新建 / 编辑报价单（含明细行编辑）
 *
 * 交互要点：
 *   - 上半部分单头字段，下半部分明细表（可增删行、行内编辑）
 *   - 小计与合计**实时预览**，但保存时以服务端计算结果为准
 *     （两边算法一致，前端只是让用户看到即时反馈；避免"前端算的与库里不一致"）
 *   - 折扣按百分比填写（填 10 = 让 10%），服务端也按同一口径归一化
 *   - 明细行的阀门字段用字典下拉（与客户表单共用字典），也允许直接手输
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {
  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  /** 加 30 天作为默认有效期 */
  function plusDays(n) {
    const d = new Date();
    d.setDate(d.getDate() + n);
    const p = (x) => String(x).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  function blankItem() {
    return {
      item_name: '', valve_type: '', size_range: '', pressure_rating: '',
      body_material: '', connection_type: '', quantity: 1, unit: '台',
      unit_price: '', discount: 0, delivery_days: '', remark: ''
    };
  }

  function blankForm() {
    return {
      project_id: '', quote_no: '', quote_date: todayStr(), valid_until: plusDays(30),
      currency: '人民币', status: '草稿', tax_note: '', delivery_note: '',
      payment_note: '', remark: '', items: [blankItem()]
    };
  }

  const QuotationDrawer = {
    name: 'QuotationDrawer',
    props: {
      modelValue: Boolean,
      projectId: [Number, String],
      projectName: String,
      customerName: String,
      quotation: { type: Object, default: null }
    },
    emits: ['update:modelValue', 'saved'],
    data() {
      return {
        form: blankForm(),
        saving: false,
        errors: {}
      };
    },
    computed: {
      isEdit() { return !!(this.quotation && this.quotation.id); },
      title() { return this.isEdit ? `编辑报价单 ${this.quotation.quote_no || ''}` : '新建报价单'; },
      /* 字典型下拉选项 */
      dict() { return CRM.api.cache.dict.options || {}; },
      statuses() { return (CRM.api.cache.dict.options || {}).quotation_status || ['草稿', '已报出', '已中标', '已落标', '已过期']; },
      /** 前端合计（仅预览；保存后以服务端返回为准） */
      previewTotal() {
        return this.form.items.reduce((s, it) => s + this.lineSubtotal(it), 0);
      }
    },
    watch: {
      modelValue(open) { if (open) this.reset(); }
    },
    methods: {
      money(v) {
        const n = Number(v);
        return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
      },
      /** 单行小计：数量 × 单价 × (1 − 折扣%) */
      lineSubtotal(it) {
        const qty = Number(it.quantity) || 0;
        const price = Number(it.unit_price) || 0;
        let d = Number(it.discount) || 0;
        if (d > 1) d = d / 100;               // 兼容填 10 或 0.1
        if (d < 0) d = 0; else if (d > 1) d = 1;
        return Math.round(qty * price * (1 - d) * 100) / 100;
      },
      fmt(v) { return CRM.util.fmtMoney(this.money(v)); },

      reset() {
        this.errors = {};
        if (this.isEdit) {
          const q = this.quotation;
          this.form = {
            project_id: q.project_id,
            quote_no: q.quote_no || '',
            quote_date: q.quote_date || todayStr(),
            valid_until: q.valid_until || '',
            currency: q.currency || '人民币',
            status: q.status || '草稿',
            tax_note: q.tax_note || '',
            delivery_note: q.delivery_note || '',
            payment_note: q.payment_note || '',
            remark: q.remark || '',
            items: (q.items || []).length
              ? q.items.map((it) => Object.assign(blankItem(), {
                item_name: it.item_name, valve_type: it.valve_type, size_range: it.size_range,
                pressure_rating: it.pressure_rating, body_material: it.body_material,
                connection_type: it.connection_type, quantity: it.quantity, unit: it.unit,
                unit_price: it.unit_price,
                /* 库里存比例，界面显示百分比 */
                discount: it.discount ? Math.round(Number(it.discount) * 10000) / 100 : 0,
                delivery_days: it.delivery_days || '', remark: it.remark
              }))
              : [blankItem()]
          };
        } else {
          this.form = blankForm();
          this.form.project_id = this.projectId || '';
        }
      },

      addRow() { this.form.items.push(blankItem()); },
      removeRow(i) {
        this.form.items.splice(i, 1);
        if (!this.form.items.length) this.form.items.push(blankItem());
      },
      moveRow(i, dir) {
        const j = i + dir;
        if (j < 0 || j >= this.form.items.length) return;
        const arr = this.form.items;
        const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
      },

      /** 从上一行复制规格（同规格多行时省事） */
      copyDown(i) {
        const src = this.form.items[i];
        const dst = blankItem();
        for (const k of ['item_name', 'valve_type', 'size_range', 'pressure_rating', 'body_material', 'connection_type', 'unit', 'unit_price', 'discount', 'delivery_days']) {
          dst[k] = src[k];
        }
        this.form.items.splice(i + 1, 0, dst);
      },

      validate() {
        const e = {};
        if (!this.form.items.some((it) => (it.item_name || it.valve_type) && Number(it.quantity) > 0 && Number(it.unit_price) >= 0)) {
          e.items = '至少填写一行明细（需有名称或阀种、数量大于 0）';
        }
        this.errors = e;
        if (Object.keys(e).length) {
          CRM.toast(Object.values(e)[0], 'error');
          return false;
        }
        return true;
      },

      async save() {
        if (!this.validate()) return;
        this.saving = true;
        try {
          const payload = Object.assign({}, this.form, {
            project_id: this.form.project_id || this.projectId,
            items: this.form.items
          });
          if (this.isEdit) payload.id = this.quotation.id;
          const r = await CRM.api.saveQuotation(payload);
          CRM.toast(this.isEdit ? '报价单已保存' : `报价单已创建（${r.item_count} 行，合计 ${this.fmt(r.total_amount)} 元）`, 'success');
          this.$emit('saved', r);
          this.$emit('update:modelValue', false);
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.saving = false;
        }
      }
    },
    template: `
      <c-drawer :model-value="modelValue" :title="title"
                :sub="customerName ? ('客户：' + customerName + (projectName ? ' · ' + projectName : '')) : ''"
                width="1080px"
                @update:model-value="$emit('update:modelValue', $event)">

        <!-- 单头 -->
        <div class="form-grid">
          <div class="field">
            <label class="field-label">报价单号</label>
            <input class="input" v-model="form.quote_no" placeholder="留空自动生成" />
            <div class="field-hint">留空则按「前缀-日期-序号」自动取号，例如 BJ-20260914-001</div>
          </div>
          <div class="field">
            <label class="field-label">状态</label>
            <select class="input" v-model="form.status">
              <option v-for="s in statuses" :key="s" :value="s">{{ s }}</option>
            </select>
          </div>
          <div class="field">
            <label class="field-label">报价日期</label>
            <input class="input" type="date" v-model="form.quote_date" />
          </div>
          <div class="field">
            <label class="field-label">有效期至</label>
            <input class="input" type="date" v-model="form.valid_until" />
          </div>
          <div class="field">
            <label class="field-label">币种</label>
            <input class="input" v-model="form.currency" />
          </div>
          <div class="field">
            <label class="field-label">税率说明</label>
            <input class="input" v-model="form.tax_note" placeholder="例如：含 13% 增值税" />
          </div>
        </div>

        <!-- 明细 -->
        <div class="quo-items-head">
          <div class="quo-items-title">报价明细</div>
          <div style="flex:1"></div>
          <button class="btn btn-sm" type="button" @click="addRow">+ 增加一行</button>
        </div>
        <div v-if="errors.items" class="field-error" style="margin-bottom:8px">{{ errors.items }}</div>

        <div class="quo-table-wrap">
          <table class="quo-table">
            <thead>
              <tr>
                <th style="width:34px">#</th>
                <th style="width:130px">名称 / 阀种</th>
                <th style="width:90px">口径</th>
                <th style="width:96px">压力</th>
                <th style="width:104px">阀体材质</th>
                <th style="width:88px">连接</th>
                <th style="width:72px">数量</th>
                <th style="width:56px">单位</th>
                <th style="width:96px">单价(元)</th>
                <th style="width:66px">折扣%</th>
                <th style="width:104px">小计(元)</th>
                <th style="width:64px">交期(天)</th>
                <th style="width:120px">备注</th>
                <th style="width:86px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(it, i) in form.items" :key="i">
                <td class="quo-seq">{{ i + 1 }}</td>
                <td><input class="input input-sm" v-model="it.item_name" placeholder="如 球阀" /></td>
                <td>
                  <input class="input input-sm" v-model="it.size_range" list="quo-size" placeholder="DN50" />
                  <datalist id="quo-size">
                    <option v-for="o in (dict.size_range || [])" :key="o" :value="o"></option>
                  </datalist>
                </td>
                <td>
                  <input class="input input-sm" v-model="it.pressure_rating" list="quo-pr" placeholder="Class150" />
                  <datalist id="quo-pr">
                    <option v-for="o in (dict.pressure_rating || [])" :key="o" :value="o"></option>
                  </datalist>
                </td>
                <td>
                  <input class="input input-sm" v-model="it.body_material" list="quo-mat" placeholder="WCB" />
                  <datalist id="quo-mat">
                    <option v-for="o in (dict.body_material || [])" :key="o" :value="o"></option>
                  </datalist>
                </td>
                <td>
                  <input class="input input-sm" v-model="it.connection_type" list="quo-conn" placeholder="法兰" />
                  <datalist id="quo-conn">
                    <option v-for="o in (dict.connection_type || [])" :key="o" :value="o"></option>
                  </datalist>
                </td>
                <td><input class="input input-sm num" type="number" min="0" step="any" v-model="it.quantity" /></td>
                <td><input class="input input-sm" v-model="it.unit" /></td>
                <td><input class="input input-sm num" type="number" min="0" step="any" v-model="it.unit_price" /></td>
                <td><input class="input input-sm num" type="number" min="0" max="100" step="any" v-model="it.discount" /></td>
                <td class="quo-sub">{{ fmt(lineSubtotal(it)) }}</td>
                <td><input class="input input-sm num" type="number" min="0" v-model="it.delivery_days" /></td>
                <td><input class="input input-sm" v-model="it.remark" /></td>
                <td class="quo-ops">
                  <button class="icon-btn" title="复制本行" @click="copyDown(i)">⧉</button>
                  <button class="icon-btn" title="上移" @click="moveRow(i, -1)">↑</button>
                  <button class="icon-btn" title="下移" @click="moveRow(i, 1)">↓</button>
                  <button class="icon-btn danger" title="删除本行" @click="removeRow(i)">✕</button>
                </td>
              </tr>
            </tbody>
            <tfoot>
              <tr>
                <td colspan="10" class="quo-total-label">合计（{{ form.items.length }} 行）</td>
                <td class="quo-total">{{ fmt(previewTotal) }}</td>
                <td colspan="3"></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <div class="note mt-3">
          <c-icon name="alert" :size="14" />
          <div style="font-size:var(--fs-xs)">
            折扣填百分比（填 10 表示让价 10%）。金额保存时由服务端重新计算，
            与这里的预览一致；报价合计<strong>不会自动改动项目合同额</strong>，
            中标后可在报价单详情里一键回填。
          </div>
        </div>

        <!-- 条款 -->
        <div class="form-grid mt-4">
          <div class="field">
            <label class="field-label">交货说明</label>
            <input class="input" v-model="form.delivery_note" placeholder="例如：合同生效后 30 天内交货" />
          </div>
          <div class="field">
            <label class="field-label">付款方式</label>
            <input class="input" v-model="form.payment_note" placeholder="例如：预付 30%，到货 60%，质保金 10%" />
          </div>
          <div class="field" style="grid-column: span 2">
            <label class="field-label">备注</label>
            <input class="input" v-model="form.remark" />
          </div>
        </div>

        <template #footer>
          <button class="btn" @click="$emit('update:modelValue', false)">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存报价单' }}
          </button>
        </template>
      </c-drawer>`
  };

  CRM.quotation = CRM.quotation || {};
  CRM.quotation.QuotationDrawer = QuotationDrawer;
  CRM.registerQuotationComponent = function (app) {
    app.component('c-quotation-drawer', QuotationDrawer);
  };

  /* ------------------------------------------------------------------ */
  /* Excel 报价单导出                                                    */
  /*                                                                     */
  /* 与「数据导出」不同：报价单是**给客户看的单据**，不是数据表，          */
  /* 所以单独排版（表头合并、边框、金额右对齐、A4 列宽），不复用导出模板。  */
  /* 生成在浏览器里完成（SheetJS），后端只提供数据，与既有架构一致。        */
  /* ------------------------------------------------------------------ */

  CRM.quotation.buildWorkbook = function (d) {
    const XLSX = window.XLSX;
    if (!XLSX) throw new Error('Excel 组件未加载');

    const money = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
    };
    const fmt = (v) => money(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

    const COLS = 8;
    const aoa = [];
    const merges = [];
    const rowMeta = [];   // { bold?, size?, align?, height? }

    const push = (row, meta) => { aoa.push(row); rowMeta.push(meta || {}); return aoa.length - 1; };
    const blank = (h) => { const i = push(new Array(COLS).fill(''), { height: h || 6 }); return i; };

    /* ---- 抬头 ---- */
    let r = push([d.company || '（未填写公司名，可在设置里填「我方公司名称」）', '', '', '', '', '', '', ''], { bold: true, size: 15, align: 'center', height: 26 });
    merges.push({ s: { r, c: 0 }, e: { r, c: COLS - 1 } });
    r = push(['阀门产品报价单', '', '', '', '', '', '', ''], { bold: true, size: 13, align: 'center', height: 22 });
    merges.push({ s: { r, c: 0 }, e: { r, c: COLS - 1 } });
    blank(6);

    /* ---- 单据信息 ---- */
    r = push([`报价单号：${d.quote_no || ''}`, '', '', `版本：V${d.version || 1}`, '',
      `报价日期：${d.quote_date || ''}`, '', `有效期至：${d.valid_until || ''}`], { size: 10, height: 18 });
    r = push([`客户名称：${d.customer_name || ''}`, '', '', '', '',
      `项目名称：${d.project_name || ''}`, '', `币种：${d.currency || '人民币'}`], { size: 10, height: 18 });
    if (d.contact) {
      r = push([`联系方式：${d.contact}`, '', '', '', '', '', '', ''], { size: 10, height: 18 });
      merges.push({ s: { r, c: 0 }, e: { r, c: 3 } });
    }
    blank(4);

    /* ---- 明细表头 ---- */
    const header = ['序号', '产品名称', '规格型号', '数量', '单位', '单价(元)', '折扣', '小计(元)'];
    push(header, { bold: true, size: 10, align: 'center', height: 20, border: true, fill: true });

    /* ---- 明细行 ---- */
    for (const it of (d.items || [])) {
      push([
        it.seq, it.item_name || '', it.spec || '', it.quantity, it.unit || '',
        fmt(it.unit_price),
        it.discount ? `${Math.round(money(it.discount) * 10000) / 100}%` : '—',
        fmt(it.subtotal)
      ], { size: 10, height: 18, border: true, alignRight: [3, 5, 7], alignCenter: [0, 4, 6] });
    }

    /* ---- 合计 ---- */
    r = push(['合计', '', '', '', '', '', '', fmt(d.total_amount)], { bold: true, size: 11, height: 22, border: true });
    merges.push({ s: { r, c: 0 }, e: { r, c: 6 } });

    blank(4);

    /* ---- 条款 ---- */
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

    /* ---- 落款 ---- */
    r = push(['报价单位（盖章）：', '', '', '', '联系人：', d.contact || '', '', ''], { size: 10, height: 22 });
    r = push(['日期：', '', '', '', '联系电话：', '', '', ''], { size: 10, height: 22 });

    const ws = XLSX.utils.aoa_to_sheet(aoa);

    /* 列宽按 A4 横向排版调（单位约等于字符数） */
    ws['!cols'] = [
      { wch: 6 }, { wch: 18 }, { wch: 30 }, { wch: 8 },
      { wch: 6 }, { wch: 13 }, { wch: 8 }, { wch: 15 }
    ];
    ws['!merges'] = merges;

    /* 逐单元格设置对齐、边框、字体（SheetJS 社区版支持 s 样式） */
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
    const safeNo = String(d.quote_no || '报价单').replace(/[\\/:*?"<>|]/g, '_');
    XLSX.writeFile(wb, `报价单-${safeNo}-V${d.version || 1}.xlsx`);
    return true;
  };

})(window.CRM);
