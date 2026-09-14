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
        /* 自定义列（报价单与模板共用同一套列，全局管理） */
        fields: []
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
      async modelValue(open) {
        if (!open) return;
        this.reset();
        this.syncFields();
        await Promise.all([this.loadTemplates(), this.loadFields()]);
      }
    },
    created() {
      /* 列管理抽屉是全局单例：在别处增删列后，这里要跟着换表头 */
      this.offFields = CRM.quotationFields.onChange((list) => { this.fields = list; });
    },
    beforeUnmount() {
      if (this.offFields) this.offFields();
    },
    methods: {
      /* ---------------- 自定义列 ---------------- */
      /** 先用缓存里的列渲染，避免打开抽屉时表头跳一下 */
      syncFields() { this.fields = CRM.quotationFields.enabled(); },

      async loadFields() {
        try {
          await CRM.quotationFields.load(true);
          this.syncFields();
        } catch (_) {
          /* 读列失败不影响报价本身，按无自定义列继续 */
        }
      },

      openFields() { CRM.quotationFields.open(); },

      /** 列宽按列名长度估，避免「设计压力（MPa）」被截断 */
      fieldWidth(f) {
        const label = String(f.name || '') + (f.unit ? `（${f.unit}）` : '');
        return Math.min(160, Math.max(84, label.length * 13 + 26)) + 'px';
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
                  title="增删自定义列：介质、设计压力、设计温度、泄露等级、执行器型号…（列数不限）">
            ⚙ 自定义列<span v-if="fields.length">（{{ fields.length }}）</span>
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
                <th style="width:130px">名称 / 阀种</th>
                <th style="width:90px">口径</th>
                <th style="width:96px">压力</th>
                <th style="width:104px">阀体材质</th>
                <th style="width:88px">连接</th>
                <!-- 自定义列（列名由用户在「自定义列」里定义，列数不限） -->
                <th v-for="f in fields" :key="f.id" :style="{width: fieldWidth(f)}">
                  {{ f.name }}<span v-if="f.unit" class="quo-th-unit">（{{ f.unit }}）</span>
                </th>
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
                <!-- 自定义列的值：v-model 直接落在 extra[列id] 上 -->
                <td v-for="f in fields" :key="f.id">
                  <input class="input input-sm" :class="{ num: f.kind === 'number' }"
                         :type="f.kind === 'number' ? 'number' : 'text'"
                         :list="f.kind === 'select' ? ('qf-' + f.id) : null"
                         v-model="it.extra[f.id]" />
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
                <td :colspan="10 + fields.length" class="quo-total-label">合计（{{ form.items.length }} 行）</td>
                <td class="quo-total">{{ fmt(previewTotal) }}</td>
                <td colspan="3"></td>
              </tr>
            </tfoot>
          </table>
        </div>

        <!-- 下拉候选值：统一放表格外，避免每行重复渲染 datalist -->
        <div style="display:none">
          <template v-for="f in fields" :key="f.id">
            <datalist v-if="f.kind === 'select'" :id="'qf-' + f.id">
              <option v-for="o in (f.options_list || [])" :key="o" :value="o"></option>
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
            套用模板时自定义列的值一起带出。
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

    const COLS = 8 + custom.length;
    /* 明细表各列的落位（自定义列插在「规格型号」之后，数量之前） */
    const C_SEQ = 0, C_NAME = 1, C_SPEC = 2;
    const C_CUSTOM0 = 3;
    const C_QTY = C_CUSTOM0 + custom.length;
    const C_UNIT = C_QTY + 1, C_PRICE = C_QTY + 2, C_DISC = C_QTY + 3, C_SUM = C_QTY + 4;

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
    const header = ['序号', '产品名称', '规格型号'];
    for (const c of custom) header.push(c.unit ? `${c.name}（${c.unit}）` : c.name);
    header.push('数量', '单位', '单价(元)', '折扣', '小计(元)');
    push(header, { bold: true, size: 10, align: 'center', height: 20, border: true, fill: true });

    /* ---- 明细行 ---- */
    const alignRight = [C_QTY, C_PRICE, C_SUM];
    const alignCenter = [C_SEQ, C_UNIT, C_DISC];
    for (let i = 0; i < custom.length; i++) {
      /* 数字列右对齐，读数更顺眼 */
      if (custom[i].kind === 'number') alignRight.push(C_CUSTOM0 + i);
    }

    for (const it of (d.items || [])) {
      const row = [it.seq, it.item_name || '', it.spec || ''];
      for (const c of custom) {
        row.push((it.extra && it.extra[c.name] !== undefined) ? it.extra[c.name] : '');
      }
      row.push(it.quantity, it.unit || '',
        fmt(it.unit_price),
        it.discount ? `${Math.round(money(it.discount) * 10000) / 100}%` : '—',
        fmt(it.subtotal));
      push(row, { size: 10, height: 18, border: true, alignRight, alignCenter });
    }

    /* ---- 合计 ---- */
    const totalRow = new Array(COLS).fill('');
    totalRow[0] = '合计';
    totalRow[COLS - 1] = fmt(d.total_amount);
    r = push(totalRow, { bold: true, size: 11, height: 22, border: true });
    merges.push({ s: { r, c: 0 }, e: { r, c: COLS - 2 } });

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

    /* 列宽按 A4 横向排版调（单位约等于字符数）；自定义列给固定宽度 */
    ws['!cols'] = [
      { wch: 6 }, { wch: 18 }, { wch: 30 },
      ...custom.map(() => ({ wch: 14 })),
      { wch: 8 }, { wch: 6 }, { wch: 13 }, { wch: 8 }, { wch: 15 }
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
