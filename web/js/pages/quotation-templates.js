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
        /* 自定义列（与报价单共用同一套列） */
        fields: []
      };
    },
    computed: {
      isEdit() { return !!(this.editing && this.editing.id); },
      drawerTitle() { return this.isEdit ? `编辑模板「${this.editing.name}」` : '新建报价模板'; },
      dict() { return CRM.api.cache.dict.options || {}; },
      totalItems() { return this.list.reduce((s, t) => s + (t.item_count || 0), 0); }
    },
    async created() {
      await CRM.api.loadDict();
      this.syncFields();
      this.offFields = CRM.quotationFields.onChange((list) => { this.fields = list; });
      await Promise.all([this.load(), this.loadFields()]);
    },
    beforeUnmount() {
      if (this.offFields) this.offFields();
    },
    methods: {
      /* ---------------- 自定义列 ---------------- */
      syncFields() { this.fields = CRM.quotationFields.enabled(); },
      async loadFields() {
        try {
          await CRM.quotationFields.load(true);
          this.syncFields();
        } catch (_) { /* 读列失败不影响模板本身 */ }
      },
      openFields() { CRM.quotationFields.open(); },
      fieldWidth(f) {
        const label = String(f.name || '') + (f.unit ? `（${f.unit}）` : '');
        return Math.min(160, Math.max(84, label.length * 13 + 26)) + 'px';
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
              在报价单里可以「存为模板」，把实际报过好用的组合直接沉淀下来。
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
                    title="增删自定义列：介质、设计压力、设计温度、泄露等级、执行器型号…（列数不限）">
              ⚙ 自定义列<span v-if="fields.length">（{{ fields.length }}）</span>
            </button>
            <button class="btn btn-sm" type="button" @click="addRow">+ 增加一行</button>
          </div>
          <div v-if="errors.items" class="field-error" style="margin-bottom:8px">{{ errors.items }}</div>

          <div class="quo-table-wrap">
            <table class="quo-table">
              <thead>
                <tr>
                  <th style="width:34px">#</th>
                  <th style="width:140px">名称 / 阀种</th>
                  <th style="width:100px">口径</th>
                  <th style="width:104px">压力</th>
                  <th style="width:110px">阀体材质</th>
                  <th style="width:96px">连接</th>
                  <th v-for="f in fields" :key="f.id" :style="{width: fieldWidth(f)}">
                    {{ f.name }}<span v-if="f.unit" class="quo-th-unit">（{{ f.unit }}）</span>
                  </th>
                  <th style="width:76px">数量</th>
                  <th style="width:60px">单位</th>
                  <th style="width:70px">交期</th>
                  <th style="width:130px">备注</th>
                  <th style="width:86px">操作</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="(it, i) in form.items" :key="i">
                  <td class="quo-seq">{{ i + 1 }}</td>
                  <td>
                    <input class="input input-sm" v-model="it.item_name" list="tpl-valve" placeholder="如 球阀" />
                    <datalist id="tpl-valve">
                      <option v-for="o in (dict.valve_type || [])" :key="o" :value="o"></option>
                    </datalist>
                  </td>
                  <td>
                    <input class="input input-sm" v-model="it.size_range" list="tpl-size" placeholder="DN50" />
                    <datalist id="tpl-size">
                      <option v-for="o in (dict.size_range || [])" :key="o" :value="o"></option>
                    </datalist>
                  </td>
                  <td>
                    <input class="input input-sm" v-model="it.pressure_rating" list="tpl-pr" placeholder="Class150" />
                    <datalist id="tpl-pr">
                      <option v-for="o in (dict.pressure_rating || [])" :key="o" :value="o"></option>
                    </datalist>
                  </td>
                  <td>
                    <input class="input input-sm" v-model="it.body_material" list="tpl-mat" placeholder="WCB" />
                    <datalist id="tpl-mat">
                      <option v-for="o in (dict.body_material || [])" :key="o" :value="o"></option>
                    </datalist>
                  </td>
                  <td>
                    <input class="input input-sm" v-model="it.connection_type" list="tpl-conn" placeholder="法兰" />
                    <datalist id="tpl-conn">
                      <option v-for="o in (dict.connection_type || [])" :key="o" :value="o"></option>
                    </datalist>
                  </td>
                  <td v-for="f in fields" :key="f.id">
                    <input class="input input-sm" :class="{ num: f.kind === 'number' }"
                           :type="f.kind === 'number' ? 'number' : 'text'"
                           :list="f.kind === 'select' ? ('tqf-' + f.id) : null"
                           v-model="it.extra[f.id]" />
                  </td>
                  <td><input class="input input-sm num" type="number" min="0" step="any" v-model="it.quantity" /></td>
                  <td><input class="input input-sm" v-model="it.unit" /></td>
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
            </table>
          </div>

          <!-- 下拉候选值：统一放表格外，避免每行重复渲染 datalist -->
          <div style="display:none">
            <template v-for="f in fields" :key="f.id">
              <datalist v-if="f.kind === 'select'" :id="'tqf-' + f.id">
                <option v-for="o in (f.options_list || [])" :key="o" :value="o"></option>
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
