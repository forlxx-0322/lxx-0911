/**
 * 报价模板管理页
 *
 * 模板 = 一组常用规格，报价时一键带出明细行，省去每次重敲阀种/口径/压力/材质。
 *
 * 设计要点（与后端一致，界面上也要让用户看明白）：
 *   - 模板**不含价格**：单价随项目与行情变，套用后由使用者填
 *   - 模板与报价单互不影响：改模板不会动历史报价单
 *   - 支持"从报价单存为模板"：实际报过好用的组合可直接沉淀
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {
  function blankItem() {
    return {
      item_name: '', valve_type: '', size_range: '', pressure_rating: '',
      body_material: '', connection_type: '', quantity: 1, unit: '台',
      delivery_days: '', remark: '',
      /* 自定义列的值：键 = 列 id，与报价单共用同一套列 */
      extra: {}
    };
  }

  /**
   * 内置列在表格里的"骨架"（模板不含价格列）。
   * 列顺序不在这里定 —— 顺序由服务端的全局列序决定，与报价单共用。
   */
  const BUILTIN_UI = {
    item_name: { width: 140, type: 'text', placeholder: '如 球阀', list: 'tpl-valve' },
    size_range: { width: 100, type: 'text', placeholder: 'DN50', list: 'tpl-size' },
    pressure_rating: { width: 104, type: 'text', placeholder: 'Class150', list: 'tpl-pr' },
    body_material: { width: 110, type: 'text', placeholder: 'WCB', list: 'tpl-mat' },
    connection_type: { width: 96, type: 'text', placeholder: '法兰', list: 'tpl-conn' },
    quantity: { width: 76, type: 'number', min: 0 },
    unit: { width: 60, type: 'text' },
    delivery_days: { width: 70, type: 'number', min: 0 },
    remark: { width: 130, type: 'text' }
  };

  const TemplatePanel = {
    name: 'QuotationTemplatePanel',
    data() {
      return {
        loading: true,
        list: [],
        categories: [],
        keyword: '',
        category: '',
        /* 编辑抽屉 */
        drawerOpen: false,
        editing: null,
        form: { name: '', category: '', description: '', unit: '台', enabled: 1, items: [blankItem()] },
        saving: false,
        errors: {},
        /* 明细表的列（内置列 + 自定义列，按全局列顺序，与报价单共用） */
        columns: [],
        ui: BUILTIN_UI
      };
    },
    computed: {
      isEdit() { return !!(this.editing && this.editing.id); },
      drawerTitle() { return this.isEdit ? `编辑模板「${this.editing.name}」` : '新建报价模板'; },
      dict() { return CRM.api.cache.dict.options || {}; },
      totalItems() { return this.list.reduce((s, t) => s + (t.item_count || 0), 0); },
      customCount() { return this.columns.filter((c) => c.type === 'custom').length; }
    },
    async created() {
      await CRM.api.loadDict();
      this.syncColumns();
      this.offColumns = CRM.quotationFields.onChange(() => { this.syncColumns(); });
      await Promise.all([this.load(), this.loadColumns()]);
    },
    beforeUnmount() {
      if (this.offColumns) this.offColumns();
    },
    methods: {
      /* ---------------- 明细列（内置 + 自定义，全局一套列序） ---------------- */
      syncColumns() { this.columns = CRM.quotationFields.columnsFor('template'); },
      async loadColumns() {
        try {
          await CRM.quotationFields.load(true);
          this.syncColumns();
        } catch (_) { /* 读列失败不影响模板本身 */ }
      },
      openFields() { CRM.quotationFields.open(); },

      /** 表头上的 ◀ ▶：在全局列序里把这一列前后挪一位（与报价单是同一套顺序） */
      async moveColumn(col, dir) {
        try {
          await CRM.quotationFields.moveColumn(col.key, dir);
        } catch (e) {
          CRM.toast(e.message || '调整列顺序失败', 'error');
        }
      },

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

      inputAttrs(col) {
        if (col.type === 'custom') {
          return {
            type: col.kind === 'number' ? 'number' : 'text',
            step: col.kind === 'number' ? 'any' : null,
            list: col.kind === 'select' ? ('tqf-' + col.id) : null
          };
        }
        const u = this.ui[col.key] || {};
        return {
          type: u.type === 'number' ? 'number' : 'text',
          min: u.min === undefined ? null : u.min,
          step: u.type === 'number' ? 'any' : null,
          list: u.list || null,
          placeholder: u.placeholder || ''
        };
      },

      async load() {
        this.loading = true;
        try {
          const r = await CRM.api.listTemplates({
            q: this.keyword || undefined,
            category: this.category || undefined
          });
          this.list = r.list || [];
          this.categories = r.categories || [];
        } catch (e) {
          CRM.toast(e.message || '加载模板失败', 'error');
        } finally {
          this.loading = false;
        }
      },
      resetFilters() { this.keyword = ''; this.category = ''; this.load(); },

      /* ---------------- 编辑 ---------------- */
      openCreate() {
        this.editing = null;
        this.form = { name: '', category: this.category || '', description: '', unit: '台', enabled: 1, items: [blankItem()] };
        this.errors = {};
        this.drawerOpen = true;
      },
      async openEdit(row) {
        try {
          const t = await CRM.api.getQuotationTemplate(row.id);
          this.editing = t;
          this.form = {
            name: t.name, category: t.category || '', description: t.description || '',
            unit: t.unit || '台', enabled: t.enabled ? 1 : 0,
            items: (t.items || []).length
              ? t.items.map((it) => ({
                item_name: it.item_name, valve_type: it.valve_type, size_range: it.size_range,
                pressure_rating: it.pressure_rating, body_material: it.body_material,
                connection_type: it.connection_type, quantity: it.quantity, unit: it.unit,
                delivery_days: it.delivery_days || '', remark: it.remark,
                extra: Object.assign({}, it.extra || {})
              }))
              : [blankItem()]
          };
          this.errors = {};
          this.drawerOpen = true;
        } catch (e) {
          CRM.toast(e.message || '读取模板失败', 'error');
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
        const a = this.form.items;
        const t = a[i]; a[i] = a[j]; a[j] = t;
      },
      copyDown(i) {
        const src = this.form.items[i];
        const dst = blankItem();
        for (const k of ['item_name', 'valve_type', 'size_range', 'pressure_rating', 'body_material', 'connection_type', 'unit', 'delivery_days']) {
          dst[k] = src[k];
        }
        dst.extra = Object.assign({}, src.extra || {});
        this.form.items.splice(i + 1, 0, dst);
      },

      validate() {
        const e = {};
        if (!String(this.form.name || '').trim()) e.name = '模板名称必填';
        const real = this.form.items.filter((it) => it.item_name || it.valve_type || it.size_range);
        if (!real.length) e.items = '至少要填一行明细（需有名称或阀种）';
        this.errors = e;
        if (Object.keys(e).length) { CRM.toast(Object.values(e)[0], 'error'); return false; }
        return true;
      },

      async save() {
        if (!this.validate()) return;
        this.saving = true;
        try {
          const payload = Object.assign({}, this.form);
          if (this.isEdit) payload.id = this.editing.id;
          const r = await CRM.api.saveQuotationTemplate(payload);
          CRM.toast(this.isEdit ? '模板已保存' : `模板已创建（${r.item_count} 行）`, 'success');
          this.drawerOpen = false;
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.saving = false;
        }
      },

      async remove(row) {
        const ok = await CRM.confirm({
          title: '删除报价模板',
          message: `确定删除模板「${row.name}」吗？<br><br>`
            + `只影响这个模板，<strong>已经用它报过的报价单不受任何影响</strong>。`,
          okText: '删除',
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteQuotationTemplate(row.id);
          CRM.toast('模板已删除', 'success');
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      async move(row, dir) {
        try {
          const r = await CRM.api.moveQuotationTemplate(row.id, dir);
          if (!r.moved) { CRM.toast(r.message, 'info'); return; }
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '调整顺序失败', 'error');
        }
      },

      async toggleEnabled(row) {
        try {
          await CRM.api.saveQuotationTemplate({ id: row.id, enabled: row.enabled ? 0 : 1 });
          await this.load();
          CRM.toast(row.enabled ? '模板已停用（套用时不会出现在列表里）' : '模板已启用', 'success');
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        }
      }
    },
    template: `
      <div>
        <c-card>
          <template #head>
            <div style="display:flex;align-items:center;gap:12px;width:100%">
              <div>
                <div class="card-title">报价模板</div>
                <div class="card-sub">
                  把常用规格沉淀成模板，报价时一键带出明细行；共 {{ list.length }} 个模板、{{ totalItems }} 行规格
                </div>
              </div>
              <div style="flex:1"></div>
              <button class="btn btn-primary" @click="openCreate">+ 新建模板</button>
            </div>
          </template>

          <div class="filter-bar">
            <input class="input" style="max-width:220px" v-model="keyword" placeholder="搜索模板名称或说明"
                   @keyup.enter="load" />
            <select class="input" style="max-width:180px" v-model="category" @change="load">
              <option value="">全部类别</option>
              <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
            </select>
            <button class="btn" @click="load">搜索</button>
            <button class="btn" v-if="keyword || category" @click="resetFilters">清空条件</button>
          </div>

          <div class="note mt-3">
            <c-icon name="alert" :size="15" />
            <div style="font-size:var(--fs-xs)">
              模板里<strong>只存规格，不存价格</strong>——单价随项目与行情变，
              套用后由你填价，避免直接报出过期价。<br>
              在报价单里可以「存为模板」，把实际报过好用的组合直接沉淀下来。<br>
              <strong>列顺序是全局的</strong>：把鼠标移到表头上点 ◀ ▶ 就能挪列
              （内置列和自定义列都能挪），报价单明细与导出单据会跟着一起变。
            </div>
          </div>

          <div v-if="loading" class="muted mt-4">加载中…</div>
          <c-empty v-else-if="!list.length" icon="file" class="mt-4"
                   title="还没有报价模板"
                   desc="点右上角「新建模板」把常用规格存下来；也可以在报价单里用「存为模板」从已有报价沉淀" />
          <div v-else class="table-wrap mt-4">
            <table class="data-table">
              <thead>
                <tr>
                  <th style="width:52px">排序</th>
                  <th>模板名称</th>
                  <th style="width:110px">类别</th>
                  <th style="width:70px">规格行</th>
                  <th style="width:80px">用过</th>
                  <th style="width:96px">状态</th>
                  <th style="width:170px">最近使用</th>
                  <th style="width:230px">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(t, i) in list" :key="t.id" :class="{ muted: !t.enabled }">
                  <td>
                    <div class="tpl-sort">
                      <button class="icon-btn" title="上移" :disabled="i === 0" @click="move(t, 'up')">↑</button>
                      <button class="icon-btn" title="下移" :disabled="i === list.length - 1" @click="move(t, 'down')">↓</button>
                    </div>
                  </td>
                  <td>
                    <div class="tpl-name">{{ t.name }}</div>
                    <div v-if="t.description" class="tpl-desc">{{ t.description }}</div>
                  </td>
                  <td>{{ t.category || '—' }}</td>
                  <td>{{ t.item_count }}</td>
                  <td>{{ t.use_count || 0 }}</td>
                  <td>
                    <span class="tag" :class="t.enabled ? 'success' : 'muted'">
                      {{ t.enabled ? '启用' : '停用' }}
                    </span>
                  </td>
                  <td class="muted" style="font-size:var(--fs-xs)">{{ t.last_used_at || '未使用' }}</td>
                  <td>
                    <div style="display:flex;gap:4px;justify-content:flex-end">
                      <button class="btn btn-sm" @click="openEdit(t)">编辑</button>
                      <button class="btn btn-sm" @click="toggleEnabled(t)">{{ t.enabled ? '停用' : '启用' }}</button>
                      <button class="btn btn-sm btn-danger" @click="remove(t)">删除</button>
                    </div>
                  </td>
                </tr>
              </tbody>
            </table>
          </div>
        </c-card>

        <!-- 编辑抽屉 -->
        <c-drawer v-model="drawerOpen" :title="drawerTitle"
                  sub="模板只存规格组合，不存价格" width="1000px">
          <div class="form-grid">
            <div class="field">
              <label class="field-label">模板名称<span class="req">*</span></label>
              <input class="input" v-model="form.name" placeholder="例如：炼化常用球阀组合" />
              <div v-if="errors.name" class="field-error">{{ errors.name }}</div>
            </div>
            <div class="field">
              <label class="field-label">类别</label>
              <input class="input" v-model="form.category" list="tpl-cat" placeholder="例如：球阀 / 闸阀 / 通用" />
              <datalist id="tpl-cat">
                <option v-for="c in categories" :key="c" :value="c"></option>
              </datalist>
            </div>
            <div class="field" style="grid-column: span 2">
              <label class="field-label">说明</label>
              <input class="input" v-model="form.description" placeholder="这个模板适合什么场景" />
            </div>
          </div>

          <div class="quo-items-head">
            <div class="quo-items-title">规格明细</div>
            <div style="flex:1"></div>
            <button class="btn btn-sm" type="button" @click="openFields"
                    title="增删自定义列、调整列顺序（介质、设计压力、设计温度、泄露等级、执行器型号…）">
              ⚙ 自定义列<span v-if="customCount">（{{ customCount }}）</span>
            </button>
            <button class="btn btn-sm" type="button" @click="addRow">+ 增加一行</button>
          </div>
          <div v-if="errors.items" class="field-error" style="margin-bottom:8px">{{ errors.items }}</div>

          <div class="quo-table-wrap">
            <table class="quo-table">
              <thead>
                <tr>
                  <th style="width:34px">#</th>
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
                    <input v-if="col.type === 'custom'" class="input input-sm"
                           :class="{ num: isNumCol(col) }" v-bind="inputAttrs(col)"
                           v-model="it.extra[col.id]" />
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
            </table>
          </div>

          <!-- 下拉候选值：统一放表格外，避免每行重复渲染 datalist -->
          <div style="display:none">
            <datalist id="tpl-valve">
              <option v-for="o in (dict.valve_type || [])" :key="o" :value="o"></option>
            </datalist>
            <datalist id="tpl-size">
              <option v-for="o in (dict.size_range || [])" :key="o" :value="o"></option>
            </datalist>
            <datalist id="tpl-pr">
              <option v-for="o in (dict.pressure_rating || [])" :key="o" :value="o"></option>
            </datalist>
            <datalist id="tpl-mat">
              <option v-for="o in (dict.body_material || [])" :key="o" :value="o"></option>
            </datalist>
            <datalist id="tpl-conn">
              <option v-for="o in (dict.connection_type || [])" :key="o" :value="o"></option>
            </datalist>
            <template v-for="col in columns" :key="col.key">
              <datalist v-if="col.type === 'custom' && col.kind === 'select'" :id="'tqf-' + col.id">
                <option v-for="o in (col.options_list || [])" :key="o" :value="o"></option>
              </datalist>
            </template>
          </div>

          <div class="mt-3">
            <label class="field-label">模板状态</label>
            <div class="switch" @click="form.enabled = form.enabled ? 0 : 1">
              <input type="checkbox" :checked="form.enabled === 1" readonly />
              <span class="switch-track"><span class="switch-thumb"></span></span>
              <span class="switch-text">{{ form.enabled ? '启用（套用时可选）' : '停用（套用时不可选）' }}</span>
            </div>
          </div>

          <template #footer>
            <button class="btn" @click="drawerOpen = false">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存模板' }}
            </button>
          </template>
        </c-drawer>
      </div>`
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.QuotationTemplatePanel = TemplatePanel;

})(window.CRM);
