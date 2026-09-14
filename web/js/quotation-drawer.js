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
      unit_price: '', discount: 0, delivery_days: '', remark: '',
      /* 自定义列的值：键 = 列 id，见 quotation-fields.js */
      extra: {}
    };
  }

  function blankForm() {
    return {
      project_id: '', quote_no: '', quote_date: todayStr(), valid_until: plusDays(30),
      currency: '人民币', status: '草稿', tax_note: '', delivery_note: '',
      payment_note: '', remark: '', items: [blankItem()]
    };
  }

  /**
   * 内置列在表格里的"骨架"：宽度、输入类型、占位提示、下拉数据源。
   * 列顺序不在这里定 —— 顺序由服务端的全局列序决定（见 quotation-fields.js）。
   */
  const BUILTIN_UI = {
    item_name: { width: 130, type: 'text', placeholder: '如 球阀' },
    size_range: { width: 90, type: 'text', placeholder: 'DN50', list: 'quo-size' },
    pressure_rating: { width: 96, type: 'text', placeholder: 'Class150', list: 'quo-pr' },
    body_material: { width: 104, type: 'text', placeholder: 'WCB', list: 'quo-mat' },
    connection_type: { width: 88, type: 'text', placeholder: '法兰', list: 'quo-conn' },
    quantity: { width: 72, type: 'number', min: 0 },
    unit: { width: 56, type: 'text' },
    unit_price: { width: 96, type: 'number', min: 0 },
    discount: { width: 66, type: 'number', min: 0, max: 100 },
    subtotal: { width: 104 },
    delivery_days: { width: 64, type: 'number', min: 0 },
    remark: { width: 120, type: 'text' }
  };

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
        errors: {},
        /* 报价模板 */
        templates: [],
        templateId: '',
        applyingTpl: false,
        /* 明细表的列（内置列 + 自定义列，按全局列顺序） */
        columns: [],
        ui: BUILTIN_UI
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
      },
      /** 「小计」列的位置：合计那一行要对齐到它 */
      subtotalIndex() { return this.columns.findIndex((c) => c.key === 'subtotal'); },
      customCount() { return this.columns.filter((c) => c.type === 'custom').length; }
    },
    watch: {
      async modelValue(open) {
        if (!open) return;
        this.reset();
        this.syncColumns();
        await Promise.all([this.loadTemplates(), this.loadColumns()]);
      }
    },
    created() {
      /* 列管理抽屉是全局单例：在别处增删列或调顺序后，这里要跟着换表头 */
      this.offColumns = CRM.quotationFields.onChange(() => { this.syncColumns(); });
    },
    beforeUnmount() {
      if (this.offColumns) this.offColumns();
    },
    methods: {
      /* ---------------- 明细列（内置 + 自定义，全局一套列序） ---------------- */
      /** 先用缓存里的列渲染，避免打开抽屉时表头跳一下 */
      syncColumns() { this.columns = CRM.quotationFields.columnsFor('quotation'); },

      async loadColumns() {
        try {
          await CRM.quotationFields.load(true);
          this.syncColumns();
        } catch (_) {
          /* 读列失败不影响报价本身，按默认列继续 */
        }
      },

      openFields() { CRM.quotationFields.open(); },

      /** 表头上的 ◀ ▶：在全局列序里把这一列前后挪一位 */
      async moveColumn(col, dir) {
        try {
          await CRM.quotationFields.moveColumn(col.key, dir);
        } catch (e) {
          CRM.toast(e.message || '调整列顺序失败', 'error');
        }
      },

      /** 列宽：内置列按既定宽度，自定义列按列名长度估（不截断） */
      colWidth(col) {
        const u = this.ui[col.key];
        if (u && u.width) return u.width + 'px';
        const label = String(col.label || '') + (col.unit ? `（${col.unit}）` : '');
        return Math.min(170, Math.max(84, label.length * 13 + 26)) + 'px';
      },

      isNumCol(col) {
        const u = this.ui[col.key];
        return col.type === 'custom' ? col.kind === 'number' : !!(u && u.type === 'number');
      },

      /** 输入框属性（内置列与自定义列统一走这里，省得模板里堆一堆三元） */
      inputAttrs(col) {
        if (col.type === 'custom') {
          return {
            type: col.kind === 'number' ? 'number' : 'text',
            step: col.kind === 'number' ? 'any' : null,
            list: col.kind === 'select' ? ('qf-' + col.id) : null
          };
        }
        const u = this.ui[col.key] || {};
        return {
          type: u.type === 'number' ? 'number' : 'text',
          min: u.min === undefined ? null : u.min,
          max: u.max === undefined ? null : u.max,
          step: u.type === 'number' ? 'any' : null,
          list: u.list || null,
          placeholder: u.placeholder || ''
        };
      },

      /* ---------------- 报价模板 ---------------- */
      async loadTemplates() {
        try {
          const r = await CRM.api.listTemplates({ enabledOnly: 1 });
          this.templates = r.list || [];
        } catch (_) {
          this.templates = [];
        }
      },

      /**
       * 套用模板：把模板的规格行填进明细。
       *
       * 两种策略：
       *   - 明细为空（只有一行且什么都没填）→ 直接替换
       *   - 明细已有内容 → 询问是"替换"还是"追加"
       * 模板不含价格，带出的行单价留空由使用者填。
       */
      async applyTemplate() {
        const id = this.templateId;
        if (!id) { CRM.toast('请先选择一个模板', 'error'); return; }
        const t = this.templates.find((x) => String(x.id) === String(id));
        const hasContent = this.form.items.some((it) => it.item_name || it.valve_type || it.size_range);

        let replace = true;
        if (hasContent) {
          const yes = await CRM.confirm({
            title: '套用模板',
            message: `明细里已经有内容了。<br><br>`
              + `点「替换」会<strong>清空现有 ${this.form.items.length} 行</strong>再填入模板；<br>`
              + `点「追加」会保留现有行、把模板行加到后面。`,
            okText: '替换',
            cancelText: '追加'
          });
          replace = yes;
        }

        this.applyingTpl = true;
        try {
          const r = await CRM.api.applyQuotationTemplate(id);
          const rows = (r.items || []).map((it) => Object.assign(blankItem(), {
            item_name: it.item_name, valve_type: it.valve_type, size_range: it.size_range,
            pressure_rating: it.pressure_rating, body_material: it.body_material,
            connection_type: it.connection_type, quantity: it.quantity, unit: it.unit,
            unit_price: '', discount: 0,
            delivery_days: it.delivery_days || '', remark: it.remark,
            /* 自定义列的值随模板带出（属于规格，不属于价格） */
            extra: Object.assign({}, it.extra || {})
          }));
          if (!rows.length) { CRM.toast('该模板没有明细行', 'error'); return; }
          this.form.items = replace ? rows : this.form.items.concat(rows);
          CRM.toast(
            `${replace ? '已套用' : '已追加'}模板「${r.template.name}」${rows.length} 行规格，请填写单价`,
            'success', 5000);
        } catch (e) {
          CRM.toast(e.message || '套用模板失败', 'error');
        } finally {
          this.applyingTpl = false;
        }
      },

      /** 把当前明细存为模板（新建时才显示） */
      async saveAsTemplate() {
        const real = this.form.items.filter((it) => it.item_name || it.valve_type || it.size_range);
        if (!real.length) { CRM.toast('明细为空，先填几行规格再存为模板', 'error'); return; }
        const name = await CRM.prompt({
          title: '存为报价模板',
          label: '模板名称',
          placeholder: '例如：炼化常用球阀组合',
          value: ''
        });
        if (!name) return;
        try {
          const r = await CRM.api.saveQuotationTemplate({
            name,
            description: '在报价单里保存的规格组合',
            items: real.map((it) => ({
              item_name: it.item_name, valve_type: it.valve_type, size_range: it.size_range,
              pressure_rating: it.pressure_rating, body_material: it.body_material,
              connection_type: it.connection_type, quantity: it.quantity, unit: it.unit,
              delivery_days: it.delivery_days, remark: it.remark,
              /* 自定义列一并沉淀，模板才是"完整的规格组合" */
              extra: Object.assign({}, it.extra || {})
            }))
          });
          CRM.toast(`已存为模板「${name}」（${r.item_count} 行规格，不含价格）`, 'success', 5000);
          await this.loadTemplates();
        } catch (e) {
          CRM.toast(e.message || '存为模板失败', 'error');
        }
      },

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
                delivery_days: it.delivery_days || '', remark: it.remark,
                extra: Object.assign({}, it.extra || {})
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
        /* 自定义列也一起复制：同规格多行时这才是省事的关键 */
        dst.extra = Object.assign({}, src.extra || {});
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
          <button class="btn btn-sm" type="button" @click="openFields"
                  title="增删自定义列、调整列顺序（介质、设计压力、设计温度、泄露等级、执行器型号…）">
            ⚙ 自定义列<span v-if="customCount">（{{ customCount }}）</span>
          </button>
          <button class="btn btn-sm" type="button" @click="addRow">+ 增加一行</button>
        </div>

        <!-- 套用模板：把常用规格一键带出来 -->
        <div v-if="templates.length" class="tpl-apply-bar">
          <span class="muted" style="font-size:var(--fs-xs)">套用模板</span>
          <select class="input input-sm" style="max-width:260px" v-model="templateId">
            <option value="">选择模板…</option>
            <option v-for="t in templates" :key="t.id" :value="t.id">
              {{ t.name }}（{{ t.item_count }} 行）{{ t.category ? ' · ' + t.category : '' }}
            </option>
          </select>
          <button class="btn btn-sm" type="button" :disabled="!templateId || applyingTpl"
                  @click="applyTemplate">
            {{ applyingTpl ? '套用中…' : '带出规格' }}
          </button>
          <button v-if="!isEdit" class="btn btn-sm" type="button" @click="saveAsTemplate">
            把当前明细存为模板
          </button>
          <span class="muted" style="font-size:var(--fs-xxs,11px)">
            模板只带规格，不带价格
          </span>
        </div>
        <div v-else-if="!isEdit" class="tpl-apply-bar">
          <span class="muted" style="font-size:var(--fs-xs)">
            还没有报价模板 —— 填好明细后可点右侧「把当前明细存为模板」，下次同类报价一键带出
          </span>
          <div style="flex:1"></div>
          <button class="btn btn-sm" type="button" @click="saveAsTemplate">把当前明细存为模板</button>
        </div>

        <div v-if="errors.items" class="field-error" style="margin-bottom:8px">{{ errors.items }}</div>

        <div class="quo-table-wrap">
          <table class="quo-table">
            <thead>
              <tr>
                <th style="width:34px">#</th>
                <!-- 列顺序是全局的：内置列与自定义列都能用表头上的 ◀ ▶ 移动 -->
                <th v-for="(col, ci) in columns" :key="col.key" :style="{ width: colWidth(col) }">
                  <div class="quo-th">
                    <span class="quo-th-label">{{ col.label }}<span v-if="col.unit" class="quo-th-unit">（{{ col.unit }}）</span></span>
                    <span class="col-move">
                      <button type="button" class="icon-btn" title="左移一列" :disabled="ci === 0"
                              @click="moveColumn(col, 'left')">◀</button>
                      <button type="button" class="icon-btn" title="右移一列" :disabled="ci === columns.length - 1"
                              @click="moveColumn(col, 'right')">▶</button>
                    </span>
                  </div>
                </th>
                <th style="width:86px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(it, i) in form.items" :key="i">
                <td class="quo-seq">{{ i + 1 }}</td>
                <td v-for="col in columns" :key="col.key">
                  <!-- 小计：只读，实时算 -->
                  <span v-if="col.key === 'subtotal'" class="quo-sub">{{ fmt(lineSubtotal(it)) }}</span>
                  <!-- 自定义列的值：v-model 直接落在 extra[列id] 上 -->
                  <input v-else-if="col.type === 'custom'" class="input input-sm"
                         :class="{ num: isNumCol(col) }" v-bind="inputAttrs(col)"
                         v-model="it.extra[col.id]" />
                  <!-- 内置列 -->
                  <input v-else class="input input-sm" :class="{ num: isNumCol(col) }"
                         v-bind="inputAttrs(col)" v-model="it[col.key]" />
                </td>
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
                <td :colspan="subtotalIndex + 1" class="quo-total-label">合计（{{ form.items.length }} 行）</td>
                <td class="quo-total">{{ fmt(previewTotal) }}</td>
                <td :colspan="columns.length - subtotalIndex"></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- 下拉候选值：统一放表格外，避免每行重复渲染 datalist -->
        <div style="display:none">
          <datalist id="quo-size">
            <option v-for="o in (dict.size_range || [])" :key="o" :value="o"></option>
          </datalist>
          <datalist id="quo-pr">
            <option v-for="o in (dict.pressure_rating || [])" :key="o" :value="o"></option>
          </datalist>
          <datalist id="quo-mat">
            <option v-for="o in (dict.body_material || [])" :key="o" :value="o"></option>
          </datalist>
          <datalist id="quo-conn">
            <option v-for="o in (dict.connection_type || [])" :key="o" :value="o"></option>
          </datalist>
          <template v-for="col in columns" :key="col.key">
            <datalist v-if="col.type === 'custom' && col.kind === 'select'" :id="'qf-' + col.id">
              <option v-for="o in (col.options_list || [])" :key="o" :value="o"></option>
            </datalist>
          </template>
        </div>

        <div class="note mt-3">
          <c-icon name="alert" :size="14" />
          <div style="font-size:var(--fs-xs)">
            折扣填百分比（填 10 表示让价 10%）。金额保存时由服务端重新计算，
            与这里的预览一致；报价合计<strong>不会自动改动项目合同额</strong>，
            中标后可在报价单详情里一键回填。<br>
            规格项不够用时点「⚙ 自定义列」自己加（介质、设计压力、设计温度、操作压力、
            操作温度、环境温度、泄露等级、阀门标准、执行器型号、定位器、电磁阀、限位开关、
            过滤减压阀、气控阀……列数不限）；<strong>报价单与报价模板共用同一套列</strong>，
            套用模板时自定义列的值一起带出。<br>
            <strong>列顺序也能改</strong>：把鼠标移到表头上，点 ◀ ▶ 就能把这一列左右挪
            （内置列和自定义列都能挪，报价模板与导出单据会跟着一起变）。
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

    /* 自定义列：只把本单真的填过值的列排进单据，免得导出一堆空列把表格撑宽 */
    const custom = (d.custom_columns || []).filter((c) => (d.items || []).some(
      (it) => it.extra && String(it.extra[c.name] || '').trim() !== ''
    ));

    /* 单据列按**全局列顺序**排；被删掉的内置列不进单据；
       改过名的内置列用改后的名字。 */
    const order = Array.isArray(d.column_order) ? d.column_order : [];
    const labels = d.column_labels || {};
    const hidden = new Set(d.hidden_columns || []);
    const L = (key, dflt) => labels[key] || dflt;
    const rank = (key) => {
      const i = order.indexOf(key);
      return i < 0 ? 9999 : i;
    };
    /* 「规格型号」是几个规格字段合并成的一列：删掉哪个就不再带哪个 */
    const specKeys = ['valve_type', 'size_range', 'pressure_rating', 'body_material', 'connection_type']
      .filter((k) => !hidden.has(k));
    const specRank = specKeys.length ? Math.min(...specKeys.map(rank)) : 9999;

    const slots = [
      {
        key: 'name', label: L('item_name', '产品名称'), rank: rank('item_name'), width: 18,
        value: (it) => it.item_name || ''
      },
      {
        key: 'spec', label: '规格型号', rank: specRank, width: 30,
        value: (it) => (specKeys.length
          ? specKeys.map((k) => it[k]).filter(Boolean).join(' ')
          : (it.spec || ''))
      },
      ...custom.map((c) => ({
        key: 'c:' + c.id,
        label: c.unit ? `${c.name}（${c.unit}）` : c.name,
        rank: rank('f:' + c.id),
        width: 14,
        custom: true,
        kind: c.kind,
        value: (it) => ((it.extra && it.extra[c.name] !== undefined) ? it.extra[c.name] : '')
      })),
      {
        key: 'quantity', label: L('quantity', '数量'), rank: rank('quantity'), width: 8,
        right: true, center: true, value: (it) => it.quantity
      },
      {
        key: 'unit', label: L('unit', '单位'), rank: rank('unit'), width: 6,
        center: true, value: (it) => it.unit || ''
      },
      {
        key: 'unit_price', label: L('unit_price', '单价(元)'), rank: rank('unit_price'), width: 13,
        right: true, value: (it) => fmt(it.unit_price)
      },
      {
        key: 'discount',
        label: L('discount', '折扣'),
        rank: rank('discount'),
        width: 8,
        center: true,
        value: (it) => (it.discount ? `${Math.round(money(it.discount) * 10000) / 100}%` : '—')
      },
      {
        key: 'subtotal', label: L('subtotal', '小计(元)'), rank: rank('subtotal'), width: 15,
        right: true, value: (it) => fmt(it.subtotal)
      }
    ].filter((s) => !hidden.has(s.key) && (s.key !== 'spec' || specKeys.length > 0))
      .sort((a, b) => a.rank - b.rank);

    const COLS = 1 + slots.length;          // 首列是「序号」
    const SUM_AT = 1 + slots.findIndex((s) => s.key === 'subtotal');

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
    push(['序号', ...slots.map((s) => s.label)],
      { bold: true, size: 10, align: 'center', height: 20, border: true, fill: true });

    /* ---- 明细行 ---- */
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

    /* ---- 合计 ---- */
    const totalRow = new Array(COLS).fill('');
    totalRow[0] = '合计';
    totalRow[SUM_AT] = fmt(d.total_amount);
    r = push(totalRow, { bold: true, size: 11, height: 22, border: true });
    if (SUM_AT > 1) merges.push({ s: { r, c: 0 }, e: { r, c: SUM_AT - 1 } });

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

    /* 列宽按 A4 横向排版调（单位约等于字符数），顺序与表头一致 */
    ws['!cols'] = [{ wch: 6 }, ...slots.map((s) => ({ wch: s.width }))];
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
