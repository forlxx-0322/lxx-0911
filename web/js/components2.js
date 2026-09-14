/**
 * 前端公共组件库
 * 阶段二新增：提示条 / 抽屉 / 确认框 / 表格 / 分页 / 表单控件 / 下拉选择
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const { reactive, computed, ref, watch, onMounted, onBeforeUnmount, nextTick } = Vue;

  /* ------------------------------------------------------------------ */
  /* 全局提示（toast）                                                   */
  /* ------------------------------------------------------------------ */

  const toastState = reactive({ items: [] });
  let toastSeq = 0;

  function toast(message, type, duration) {
    const id = ++toastSeq;
    const item = { id, message: String(message), type: type || 'info' };
    toastState.items.push(item);
    const ms = duration || (type === 'error' ? 5200 : 2600);
    setTimeout(() => {
      const i = toastState.items.findIndex((x) => x.id === id);
      if (i >= 0) toastState.items.splice(i, 1);
    }, ms);
    return id;
  }

  const ToastHost = {
    name: 'ToastHost',
    setup() {
      const ICONS = { success: 'check', error: 'alert', warn: 'alert', info: 'check' };
      return { items: computed(() => toastState.items), ICONS };
    },
    template: `
      <div class="toast-host">
        <transition-group name="toast">
          <div v-for="t in items" :key="t.id" class="toast" :class="'toast-' + t.type">
            <c-icon :name="ICONS[t.type] || 'check'" :size="16" />
            <span>{{ t.message }}</span>
          </div>
        </transition-group>
      </div>`
  };

  /* ------------------------------------------------------------------ */
  /* 抽屉（右侧滑出，用于表单）                                          */
  /* ------------------------------------------------------------------ */

  const Drawer = {
    name: 'Drawer',
    props: {
      modelValue: Boolean,
      title: String,
      sub: String,
      width: { type: String, default: '720px' }
    },
    emits: ['update:modelValue'],
    methods: {
      close() { this.$emit('update:modelValue', false); },
      onKey(e) { if (e.key === 'Escape') this.close(); }
    },
    mounted() { window.addEventListener('keydown', this.onKey); },
    beforeUnmount() { window.removeEventListener('keydown', this.onKey); },
    template: `
      <transition name="drawer">
        <div v-if="modelValue" class="drawer-mask" @click.self="close">
          <aside class="drawer" :style="{ width: width }">
            <header class="drawer-head">
              <div>
                <div class="drawer-title">{{ title }}</div>
                <div class="drawer-sub" v-if="sub">{{ sub }}</div>
              </div>
              <button class="icon-btn" title="关闭 (Esc)" @click="close">✕</button>
            </header>
            <div class="drawer-body"><slot></slot></div>
            <footer class="drawer-foot" v-if="$slots.footer"><slot name="footer"></slot></footer>
          </aside>
        </div>
      </transition>`
  };

  /* ------------------------------------------------------------------ */
  /* 确认框（Promise 化）                                                */
  /* ------------------------------------------------------------------ */

  const confirmState = reactive({
    open: false, title: '', message: '', danger: false,
    okText: '确定', cancelText: '取消', _resolve: null
  });

  function confirmBox(options) {
    const opts = typeof options === 'string' ? { message: options } : (options || {});
    confirmState.title = opts.title || '请确认';
    confirmState.message = opts.message || '';
    confirmState.danger = !!opts.danger;
    confirmState.okText = opts.okText || (opts.danger ? '删除' : '确定');
    /* 支持自定义取消文案：像「回填项目 / 暂不」这种二选一，明确文案比「取消」更清楚 */
    confirmState.cancelText = opts.cancelText || '取消';
    confirmState.open = true;
    return new Promise((resolve) => { confirmState._resolve = resolve; });
  }

  function settleConfirm(val) {
    confirmState.open = false;
    const r = confirmState._resolve;
    confirmState._resolve = null;
    if (r) r(val);
  }

  const ConfirmHost = {
    name: 'ConfirmHost',
    setup() {
      return { state: confirmState, settleConfirm };
    },
    methods: {
      onKey(e) {
        if (!this.state.open) return;
        if (e.key === 'Escape') settleConfirm(false);
        if (e.key === 'Enter') settleConfirm(true);
      }
    },
    mounted() { window.addEventListener('keydown', this.onKey); },
    beforeUnmount() { window.removeEventListener('keydown', this.onKey); },
    template: `
      <transition name="fade">
        <div v-if="state.open" class="modal-mask" @click.self="settleConfirm(false)">
          <div class="modal">
            <div class="modal-title">
              <c-icon :name="state.danger ? 'alert' : 'check'" :size="18"
                      :style="{ color: state.danger ? 'var(--c-danger)' : 'var(--c-primary)' }" />
              <span>{{ state.title }}</span>
            </div>
            <div class="modal-body" v-html="state.message"></div>
            <div class="modal-foot">
              <button class="btn" @click="settleConfirm(false)">{{ state.cancelText }}</button>
              <button class="btn" :class="state.danger ? 'btn-danger' : 'btn-primary'"
                      @click="settleConfirm(true)">{{ state.okText }}</button>
            </div>
          </div>
        </div>
      </transition>`
  };

  /* ------------------------------------------------------------------ */
  /* 表格                                                               */
  /* ------------------------------------------------------------------ */

  const DataTable = {
    name: 'DataTable',
    props: {
      columns: { type: Array, required: true },  // [{key,label,width,align,sortable,className}]
      rows: { type: Array, default: () => [] },
      loading: Boolean,
      rowKey: { type: String, default: 'id' },
      selectable: Boolean,
      selected: { type: Array, default: () => [] },
      sort: String,
      order: String,
      emptyText: { type: String, default: '暂无数据' },
      emptyDesc: String,
      rowClass: Function
    },
    emits: ['update:selected', 'sort-change', 'row-click'],
    computed: {
      allChecked() {
        return this.rows.length > 0 && this.rows.every((r) => this.selected.includes(r[this.rowKey]));
      },
      someChecked() {
        return this.rows.some((r) => this.selected.includes(r[this.rowKey])) && !this.allChecked;
      }
    },
    methods: {
      toggleAll(e) {
        const ids = this.rows.map((r) => r[this.rowKey]);
        let next;
        if (e.target.checked) next = [...new Set([...this.selected, ...ids])];
        else next = this.selected.filter((id) => !ids.includes(id));
        this.$emit('update:selected', next);
      },
      toggleRow(row, e) {
        e.stopPropagation();
        const id = row[this.rowKey];
        const next = this.selected.includes(id)
          ? this.selected.filter((x) => x !== id)
          : [...this.selected, id];
        this.$emit('update:selected', next);
      },
      onSort(col) {
        if (!col.sortable) return;
        const key = col.sortKey || col.key;
        const nextOrder = (this.sort === key && this.order === 'asc') ? 'desc' : 'asc';
        this.$emit('sort-change', { sort: key, order: nextOrder });
      },
      sortMark(col) {
        const key = col.sortKey || col.key;
        if (this.sort !== key) return '';
        return this.order === 'asc' ? '↑' : '↓';
      }
    },
    template: `
      <div class="table-wrap">
        <table class="data-table">
          <thead>
            <tr>
              <th v-if="selectable" class="th-check">
                <input type="checkbox" :checked="allChecked" :indeterminate.prop="someChecked"
                       @change="toggleAll" title="全选本页" />
              </th>
              <th v-for="col in columns" :key="col.key"
                  :style="{ width: col.width, textAlign: col.align || 'left' }"
                  :class="[{ sortable: col.sortable }, col.className]"
                  @click="onSort(col)">
                {{ col.label }}
                <span v-if="col.sortable" class="sort-mark">{{ sortMark(col) || '↕' }}</span>
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-if="loading">
              <td :colspan="columns.length + (selectable ? 1 : 0)" class="td-center muted">正在加载…</td>
            </tr>
            <tr v-else-if="!rows.length">
              <td :colspan="columns.length + (selectable ? 1 : 0)" class="td-center">
                <c-empty :icon="'list'" :title="emptyText" :desc="emptyDesc" />
              </td>
            </tr>
            <tr v-else v-for="row in rows" :key="row[rowKey]"
                :class="rowClass ? rowClass(row) : ''"
                @click="$emit('row-click', row)">
              <td v-if="selectable" class="th-check" @click.stop>
                <input type="checkbox" :checked="selected.includes(row[rowKey])"
                       @change="toggleRow(row, $event)" />
              </td>
              <td v-for="col in columns" :key="col.key"
                  :style="{ textAlign: col.align || 'left' }" :class="col.className">
                <slot :name="'cell-' + col.key" :row="row" :value="row[col.key]">{{ row[col.key] }}</slot>
              </td>
            </tr>
          </tbody>
        </table>
      </div>`
  };

  /* ------------------------------------------------------------------ */
  /* 分页                                                               */
  /* ------------------------------------------------------------------ */

  const Pager = {
    name: 'Pager',
    props: {
      page: { type: Number, default: 1 },
      pages: { type: Number, default: 1 },
      total: { type: Number, default: 0 },
      pageSize: { type: Number, default: 20 }
    },
    emits: ['update:page', 'update:pageSize'],
    computed: {
      window() {
        const p = this.page, n = this.pages;
        const out = [];
        const push = (v) => { if (v >= 1 && v <= n && !out.includes(v)) out.push(v); };
        push(1);
        for (let i = p - 2; i <= p + 2; i++) push(i);
        push(n);
        const withDots = [];
        let prev = 0;
        for (const v of out.sort((a, b) => a - b)) {
          if (prev && v - prev > 1) withDots.push('...');
          withDots.push(v);
          prev = v;
        }
        return withDots;
      }
    },
    template: `
      <div class="pager">
        <span class="muted">共 <strong>{{ total }}</strong> 条，第 {{ page }} / {{ pages }} 页</span>
        <div class="pager-btns">
          <button class="btn btn-sm" :disabled="page <= 1" @click="$emit('update:page', 1)">首页</button>
          <button class="btn btn-sm" :disabled="page <= 1" @click="$emit('update:page', page - 1)">上一页</button>
          <template v-for="(w, i) in window" :key="i">
            <span v-if="w === '...'" class="pager-dots">…</span>
            <button v-else class="btn btn-sm" :class="{ 'btn-primary': w === page }"
                    @click="$emit('update:page', w)">{{ w }}</button>
          </template>
          <button class="btn btn-sm" :disabled="page >= pages" @click="$emit('update:page', page + 1)">下一页</button>
          <button class="btn btn-sm" :disabled="page >= pages" @click="$emit('update:page', pages)">末页</button>
        </div>
        <select class="input input-sm" :value="pageSize"
                @change="$emit('update:pageSize', Number($event.target.value))">
          <option v-for="n in [20, 50, 100, 200]" :key="n" :value="n">每页 {{ n }} 条</option>
        </select>
      </div>`
  };

  /* ------------------------------------------------------------------ */
  /* 表单控件                                                            */
  /* ------------------------------------------------------------------ */

  /** 文本 / 数字 / 日期输入 */
  const Field = {
    name: 'Field',
    props: {
      label: String,
      modelValue: [String, Number],
      type: { type: String, default: 'text' },
      placeholder: String,
      required: Boolean,
      hint: String,
      disabled: Boolean,
      span: { type: Number, default: 1 },   // 占几列
      rows: { type: Number, default: 3 }
    },
    emits: ['update:modelValue'],
    computed: {
      style() { return { gridColumn: `span ${this.span}` }; }
    },
    template: `
      <div class="field" :style="style">
        <label class="field-label">
          {{ label }}<span v-if="required" class="req">*</span>
        </label>
        <textarea v-if="type === 'textarea'" class="input" :rows="rows" :value="modelValue"
                  :placeholder="placeholder" :disabled="disabled"
                  @input="$emit('update:modelValue', $event.target.value)"></textarea>
        <input v-else class="input" :type="type" :value="modelValue" :placeholder="placeholder"
               :disabled="disabled" @input="$emit('update:modelValue', $event.target.value)" />
        <div class="field-hint" v-if="hint">{{ hint }}</div>
      </div>`
  };

  /**
   * 下拉选择：支持字典选项 + 「+ 新增」内联新增
   * 当 allow-add 为真且值为字典分类时，底部显示新增入口
   */
  const SelectField = {
    name: 'SelectField',
    props: {
      label: String,
      modelValue: [String, Number],
      options: { type: Array, default: () => [] },
      placeholder: { type: String, default: '请选择' },
      required: Boolean,
      allowEmpty: { type: Boolean, default: true },
      emptyText: { type: String, default: '（空）' },
      category: String,        // 字典分类，用于内联新增
      allowAdd: Boolean,
      hint: String,
      span: { type: Number, default: 1 },
      disabled: Boolean
    },
    emits: ['update:modelValue', 'added'],
    data() {
      return { adding: false, newValue: '', saving: false };
    },
    computed: {
      style() { return { gridColumn: `span ${this.span}` }; },
      /* 选项支持两种写法：
         - 字符串数组（字典选项，显示什么就提交什么）
         - {value,label} 对象数组（如归属地州：显示名称、提交编码） */
      list() {
        return (this.options || []).map((o) => (o && typeof o === 'object'
          ? { value: o.value, label: o.label === undefined ? o.value : o.label }
          : { value: o, label: o }));
      },
      /* 当前应选中哪一项：按 value 匹配（对象选项），否则按文本匹配 */
      shownValue() {
        const v = this.modelValue;
        if (v === null || v === undefined) return '';
        const str = String(v);
        /* 1) 直接命中某个选项的 value */
        const byValue = this.list.find((o) => String(o.value) === str);
        if (byValue) return byValue.value;
        /* 2) 命中某个选项的显示文本（兼容历史数据里存的是文本） */
        const byLabel = this.list.find((o) => String(o.label) === str);
        if (byLabel) return byLabel.value;
        return v;
      }
    },
    methods: {
      onChange(e) {
        const raw = e.target.value;
        const hit = this.list.find((o) => String(o.value) === String(raw));
        this.$emit('update:modelValue', hit ? hit.value : raw);
      },
      startAdd() { this.adding = true; this.newValue = ''; this.$nextTick(() => this.$refs.newInput && this.$refs.newInput.focus()); },
      cancelAdd() { this.adding = false; this.newValue = ''; },
      async submitAdd() {
        const v = (this.newValue || '').trim();
        if (!v || this.saving) return;
        this.saving = true;
        try {
          const r = await CRM.api.post('/api/dict/quick-add', { category: this.category, value: v });
          this.$emit('added', r);
          this.$emit('update:modelValue', r.value);
          this.adding = false;
          this.newValue = '';

          /* 用服务端返回的 existed 判断，而不是在前端猜。
             此前写法是 this.list.includes(r.value)，但 list 已是 {value,label} 对象数组，
             字符串永远匹配不上，导致"复用已有选项"也提示成"已新增"。
             服务端 /api/dict/quick-add 的语义：
               existed=false           → 确实新建了
               existed=true            → 已存在，直接选用
               existed=true + reenabled → 已存在但之前被停用，本次重新启用 */
          let tip;
          if (!r.existed) tip = `已新增选项「${r.value}」`;
          else if (r.reenabled) tip = `「${r.value}」之前已停用，已重新启用并选用`;
          else if (r.restored) tip = `「${r.value}」已恢复并选用`;
          else tip = `已选用已有选项「${r.value}」`;
          CRM.toast(tip, 'success');
        } catch (e) {
          CRM.toast(e.message || '新增失败', 'error');
        } finally {
          this.saving = false;
        }
      }
    },
    template: `
      <div class="field" :style="style">
        <label class="field-label">
          {{ label }}<span v-if="required" class="req">*</span>
        </label>

        <div v-if="!adding" style="display:flex;gap:6px">
          <select class="input" :value="shownValue" :disabled="disabled" @change="onChange">
            <option value="">{{ emptyText }}</option>
            <option v-for="opt in list" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
          <button v-if="allowAdd" type="button" class="btn btn-sm" title="新增选项"
                  style="flex:0 0 auto" @click="startAdd">+</button>
        </div>

        <div v-else style="display:flex;gap:6px">
          <input ref="newInput" class="input" v-model="newValue" :placeholder="'输入新的' + label"
                 @keydown.enter.prevent="submitAdd" @keydown.esc="cancelAdd" />
          <button type="button" class="btn btn-sm btn-primary" :disabled="saving" @click="submitAdd">
            {{ saving ? '…' : '保存' }}
          </button>
          <button type="button" class="btn btn-sm" @click="cancelAdd">取消</button>
        </div>

        <div class="field-hint" v-if="hint">{{ hint }}</div>
      </div>`
  };

  /**
   * 多选标签：用于阀门类型 / 认证要求等逗号分隔多值字段
   */
  const MultiSelectField = {
    name: 'MultiSelectField',
    props: {
      label: String,
      modelValue: String,          // 逗号分隔字符串
      options: { type: Array, default: () => [] },
      category: String,
      allowAdd: Boolean,
      hint: String,
      span: { type: Number, default: 2 },
      separator: { type: String, default: ',' }
    },
    emits: ['update:modelValue'],
    data() { return { adding: false, newValue: '', saving: false }; },
    computed: {
      style() { return { gridColumn: `span ${this.span}` }; },
      selected() {
        return String(this.modelValue || '').split(this.separator).map((s) => s.trim()).filter(Boolean);
      }
    },
    methods: {
      toggle(opt) {
        const cur = this.selected;
        const i = cur.indexOf(opt);
        if (i >= 0) cur.splice(i, 1); else cur.push(opt);
        this.$emit('update:modelValue', cur.join(this.separator));
      },
      startAdd() { this.adding = true; this.newValue = ''; this.$nextTick(() => this.$refs.ni && this.$refs.ni.focus()); },
      async submitAdd() {
        const v = (this.newValue || '').trim();
        if (!v || this.saving) return;
        this.saving = true;
        try {
          const r = await CRM.api.post('/api/dict/quick-add', { category: this.category, value: v });
          const cur = this.selected;
          if (!cur.includes(r.value)) cur.push(r.value);
          this.$emit('update:modelValue', cur.join(this.separator));
          this.adding = false;
          CRM.toast(`已新增「${r.value}」`, 'success');
        } catch (e) {
          CRM.toast(e.message || '新增失败', 'error');
        } finally { this.saving = false; }
      }
    },
    template: `
      <div class="field" :style="style">
        <label class="field-label">{{ label }}</label>
        <div class="chips">
          <button v-for="opt in options" :key="opt" type="button"
                  class="chip" :class="{ on: selected.includes(opt) }" @click="toggle(opt)">{{ opt }}</button>

          <template v-if="adding">
            <input ref="ni" class="chip-input" v-model="newValue" placeholder="新选项"
                   @keydown.enter.prevent="submitAdd" @keydown.esc="adding = false" />
            <button type="button" class="btn btn-sm btn-primary" :disabled="saving" @click="submitAdd">保存</button>
            <button type="button" class="btn btn-sm" @click="adding = false">取消</button>
          </template>
          <button v-else-if="allowAdd" type="button" class="chip chip-add" @click="startAdd">+ 新增</button>
        </div>
        <div class="field-hint" v-if="hint">{{ hint }}</div>
        <div class="field-hint" v-else-if="selected.length">已选 {{ selected.length }} 项</div>
      </div>`
  };

  /** 开关 */
  const SwitchField = {
    name: 'SwitchField',
    props: {
      label: String,
      modelValue: [Number, Boolean],
      hint: String,
      span: { type: Number, default: 1 }
    },
    emits: ['update:modelValue'],
    computed: {
      style() { return { gridColumn: `span ${this.span}` }; },
      on() { return this.modelValue === 1 || this.modelValue === true; }
    },
    template: `
      <div class="field" :style="style">
        <label class="field-label">{{ label }}</label>
        <label class="switch">
          <input type="checkbox" :checked="on" @change="$emit('update:modelValue', $event.target.checked ? 1 : 0)" />
          <span class="switch-track"><span class="switch-thumb"></span></span>
          <span class="switch-text">{{ on ? '是' : '否' }}</span>
        </label>
        <div class="field-hint" v-if="hint">{{ hint }}</div>
      </div>`
  };

  /**
   * 选项下拉增强版：支持 {value,label} 对象数组（用于客户等需要 ID 的下拉）
   */
  const RefSelect = {
    name: 'RefSelect',
    props: {
      label: String,
      modelValue: [String, Number],
      options: { type: Array, default: () => [] },   // [{ value, label }]
      placeholder: { type: String, default: '请选择' },
      required: Boolean,
      hint: String,
      span: { type: Number, default: 1 },
      disabled: Boolean,
      emptyLabel: { type: String, default: '（不关联）' },
      allowEmpty: { type: Boolean, default: true }
    },
    emits: ['update:modelValue'],
    computed: {
      style() { return { gridColumn: `span ${this.span}` }; }
    },
    methods: {
      onChange(e) {
        const v = e.target.value;
        this.$emit('update:modelValue', v === '' ? '' : (Number.isNaN(Number(v)) ? v : Number(v)));
      }
    },
    template: `
      <div class="field" :style="style">
        <label class="field-label">
          {{ label }}<span v-if="required" class="req">*</span>
        </label>
        <select class="input" :value="modelValue === null || modelValue === undefined ? '' : modelValue"
                :disabled="disabled" @change="onChange">
          <option v-if="allowEmpty" value="">{{ emptyLabel }}</option>
          <option v-for="o in options" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <div class="field-hint" v-if="hint">{{ hint }}</div>
      </div>`
  };

  /** 标签选择器：可勾选已有标签，也可即时新建 */  const TagPicker = {
    name: 'TagPicker',
    props: {
      label: { type: String, default: '标签' },
      modelValue: { type: Array, default: () => [] },
      span: { type: Number, default: 2 }
    },
    emits: ['update:modelValue'],
    data() { return { adding: false, newName: '', saving: false }; },
    computed: {
      style() { return { gridColumn: `span ${this.span}` }; },
      all() { return CRM.api.cache.tags || []; }
    },
    methods: {
      toggle(tag) {
        const ids = [...(this.modelValue || [])];
        const i = ids.indexOf(tag.id);
        if (i >= 0) ids.splice(i, 1); else ids.push(tag.id);
        this.$emit('update:modelValue', ids);
      },
      isOn(tag) { return (this.modelValue || []).includes(tag.id); },
      async submitAdd() {
        const name = (this.newName || '').trim();
        if (!name || this.saving) return;
        this.saving = true;
        try {
          const r = await CRM.api.saveTag({ name });
          await CRM.api.loadTags(true);
          const ids = [...(this.modelValue || [])];
          ids.push(r.id);
          this.$emit('update:modelValue', ids);
          this.adding = false;
          this.newName = '';
          CRM.toast(`已新建标签「${name}」`, 'success');
        } catch (e) {
          CRM.toast(e.message || '新建标签失败', 'error');
        } finally { this.saving = false; }
      }
    },
    async created() { try { await CRM.api.loadTags(); } catch (_) { /* 忽略 */ } },
    template: `
      <div class="field" :style="style">
        <label class="field-label">{{ label }}</label>
        <div class="chips">
          <button v-for="t in all" :key="t.id" type="button"
                  class="chip" :class="{ on: isOn(t) }" @click="toggle(t)">{{ t.name }}</button>
          <template v-if="adding">
            <input class="chip-input" v-model="newName" placeholder="新标签名" autofocus
                   @keydown.enter.prevent="submitAdd" @keydown.esc="adding = false" />
            <button type="button" class="btn btn-sm btn-primary" :disabled="saving" @click="submitAdd">
              {{ saving ? '…' : '保存' }}
            </button>
            <button type="button" class="btn btn-sm" @click="adding = false">取消</button>
          </template>
          <button v-else type="button" class="chip chip-add" @click="adding = true">+ 新建标签</button>
        </div>
        <div class="field-hint" v-if="(modelValue || []).length">已选 {{ modelValue.length }} 个标签</div>
      </div>`
  };

  /* ------------------------------------------------------------------ */
  /* 输入弹窗（Promise 化，替代 window.prompt）                          */
  /* ------------------------------------------------------------------ */

  const promptState = reactive({
    open: false, title: '', label: '', placeholder: '', value: '',
    multiline: false, okText: '确定', _resolve: null
  });

  function promptBox(options) {
    const opts = typeof options === 'string' ? { label: options } : (options || {});
    promptState.title = opts.title || '请输入';
    promptState.label = opts.label || '';
    promptState.placeholder = opts.placeholder || '';
    promptState.value = opts.value || '';
    promptState.multiline = !!opts.multiline;
    promptState.okText = opts.okText || '确定';
    promptState.open = true;
    return new Promise((resolve) => { promptState._resolve = resolve; });
  }

  function settlePrompt(val) {
    promptState.open = false;
    const r = promptState._resolve;
    promptState._resolve = null;
    if (r) r(val);
  }

  const PromptHost = {
    name: 'PromptHost',
    setup() {
      return { state: promptState, settlePrompt };
    },
    computed: {
      canSubmit() { return String(promptState.value || '').trim().length > 0; }
    },
    methods: {
      submit() {
        if (!this.canSubmit) return;
        settlePrompt(String(promptState.value).trim());
      },
      onKey(e) {
        if (!this.state.open) return;
        if (e.key === 'Escape') settlePrompt(null);
        if (e.key === 'Enter' && !this.state.multiline) this.submit();
      }
    },
    mounted() {
      window.addEventListener('keydown', this.onKey);
      this._watch = this.$watch('state.open', (v) => {
        if (v) this.$nextTick(() => { if (this.$refs.inp) this.$refs.inp.focus(); });
      });
    },
    beforeUnmount() {
      window.removeEventListener('keydown', this.onKey);
    },
    template: `
      <transition name="fade">
        <div v-if="state.open" class="modal-mask" @click.self="settlePrompt(null)">
          <div class="modal">
            <div class="modal-title">
              <c-icon name="plus" :size="17" style="color:var(--c-primary)" />
              <span>{{ state.title }}</span>
            </div>
            <div class="modal-body">
              <div v-if="state.label" class="field-label" style="margin-bottom:6px">{{ state.label }}</div>
              <textarea v-if="state.multiline" ref="inp" class="input" :rows="4"
                        v-model="state.value" :placeholder="state.placeholder"></textarea>
              <input v-else ref="inp" class="input" v-model="state.value" :placeholder="state.placeholder" />
            </div>
            <div class="modal-foot">
              <button class="btn" @click="settlePrompt(null)">取消</button>
              <button class="btn btn-primary" :disabled="!canSubmit" @click="submit">{{ state.okText }}</button>
            </div>
          </div>
        </div>
      </transition>`
  };

  /* ------------------------------------------------------------------ */

  CRM.toast = toast;
  CRM.confirm = confirmBox;
  CRM.prompt = promptBox;

  CRM.ui = {
    ToastHost, ConfirmHost, PromptHost, Drawer, DataTable, Pager,
    Field, SelectField, MultiSelectField, SwitchField, TagPicker, RefSelect
  };

  CRM.registerUiComponents = function (app) {
    app.component('c-toast-host', ToastHost);
    app.component('c-confirm-host', ConfirmHost);
    app.component('c-prompt-host', PromptHost);
    app.component('c-drawer', Drawer);
    app.component('c-table', DataTable);
    app.component('c-pager', Pager);
    app.component('c-field', Field);
    app.component('c-select', SelectField);
    app.component('c-multi', MultiSelectField);
    app.component('c-switch', SwitchField);
    app.component('c-tag-picker', TagPicker);
    app.component('c-ref-select', RefSelect);
    /* 顶栏跟进提醒：定义在 js/reminders.js（后加载），故做存在性判断 */
    if (CRM.components && CRM.components.ReminderBell) {
      app.component('c-reminder-bell', CRM.components.ReminderBell);
    }
  };

})(window.CRM);
