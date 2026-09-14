/**
 * 报价自定义列 —— 预设清单 + 全局「列管理」抽屉 + 共享缓存
 *
 * 背景：阀门报价的规格项因客户而异（介质、设计压力、设计温度、操作压力、操作温度、
 * 环境温度、泄露等级、阀门标准、执行器型号、定位器、电磁阀、限位开关、过滤减压阀、
 * 气控阀……），固定列永远不够用，所以做成**列由使用者自己加**：
 *
 *   - 列定义存在服务端（`quotation_fields`），报价单与报价模板**共用同一套列**
 *   - 明细行的值存在各自的 `extra` 里，键是**列 id**
 *     → 所以**改名不丢值**（「泄露等级」改成「泄漏等级」，历史报价照样显示）
 *   - 删列只是不再显示，已经填过的值仍留在明细里（界面会提示影响了几张报价单）
 *
 * 管理抽屉做成**全局单例**（挂在应用根节点），这样它不会嵌在报价单抽屉里，
 * 任何页面都只要调用 CRM.quotationFields.open()。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {
  const { reactive } = Vue;

  /** 常用列：点一下即添加。用户也可以完全自己敲列名（列数不封顶） */
  const PRESETS = [
    { name: '介质', kind: 'text' },
    { name: '设计压力', kind: 'text', unit: 'MPa' },
    { name: '设计温度', kind: 'text', unit: '℃' },
    { name: '操作压力', kind: 'text', unit: 'MPa' },
    { name: '操作温度', kind: 'text', unit: '℃' },
    { name: '环境温度', kind: 'text', unit: '℃' },
    { name: '泄露等级', kind: 'select', options: 'A级,AA级,B级,C级,D级,E级,F级,G级' },
    { name: '阀门标准', kind: 'select', options: 'GB,API 6D,API 608,API 609,ANSI/ASME,DIN,EN,JIS' },
    { name: '执行器型号', kind: 'text' },
    { name: '定位器', kind: 'text' },
    { name: '电磁阀', kind: 'text' },
    { name: '限位开关', kind: 'text' },
    { name: '过滤减压阀', kind: 'text' },
    { name: '气控阀', kind: 'text' }
  ];

  const state = reactive({
    open: false,
    loading: false,
    loaded: false,
    list: [],        // 全部未删除的列（含停用）
    kinds: ['text', 'number', 'select'],
    limits: { maxFields: 60, nameMax: 20 }
  });

  const listeners = [];

  /** 列发生变化时通知订阅者（报价单抽屉、模板页靠它刷新表头） */
  function emitChange() {
    for (const fn of listeners) {
      try { fn(enabledFields()); } catch (_) { /* 单个订阅者出错不影响其它 */ }
    }
  }

  function onChange(fn) {
    listeners.push(fn);
    return () => {
      const i = listeners.indexOf(fn);
      if (i >= 0) listeners.splice(i, 1);
    };
  }

  /** 界面上要显示的列 = 启用且未删除 */
  function enabledFields() {
    return state.list.filter((f) => f.enabled);
  }

  async function load(force) {
    if (state.loaded && !force) return state.list;
    state.loading = true;
    try {
      const r = await CRM.api.listQuotationFields();
      state.list = r.list || [];
      state.kinds = r.kinds || state.kinds;
      state.limits = r.limits || state.limits;
      state.loaded = true;
      return state.list;
    } finally {
      state.loading = false;
    }
  }

  async function open() {
    state.open = true;
    try { await load(true); } catch (e) { CRM.toast(e.message || '读取自定义列失败', 'error'); }
  }

  function close() { state.open = false; }

  /* ------------------------------------------------------------------ */
  /* 列管理抽屉                                                          */
  /* ------------------------------------------------------------------ */

  const FieldsManager = {
    name: 'QuotationFieldsManager',
    data() {
      return {
        st: state,
        presets: PRESETS,
        newName: '',
        newKind: 'text',
        newUnit: '',
        newOptions: '',
        busy: false
      };
    },
    computed: {
      /* 还没加过的预设（已加过的就不再提示，避免重复列） */
      presetsLeft() {
        const have = new Set(this.st.list.map((f) => String(f.name).trim()));
        return this.presets.filter((p) => !have.has(p.name));
      },
      enabledCount() { return this.st.list.filter((f) => f.enabled).length; }
    },
    methods: {
      close() { close(); },

      async refresh() {
        await load(true);
        emitChange();
      },

      /** 新增一列（预设或手工填写都走这里） */
      async add(payload) {
        this.busy = true;
        try {
          await CRM.api.saveQuotationField(payload);
          await this.refresh();
          CRM.toast(`已添加列「${payload.name}」`, 'success');
          return true;
        } catch (e) {
          CRM.toast(e.message || '添加失败', 'error');
          return false;
        } finally {
          this.busy = false;
        }
      },

      async addPreset(p) {
        await this.add({ name: p.name, kind: p.kind || 'text', unit: p.unit || '', options: p.options || '' });
      },

      async addNew() {
        const name = String(this.newName || '').trim();
        if (!name) { CRM.toast('请先填列名', 'error'); return; }
        const ok = await this.add({
          name,
          kind: this.newKind,
          unit: this.newUnit,
          options: this.newKind === 'select' ? this.newOptions : ''
        });
        if (ok) {
          this.newName = '';
          this.newUnit = '';
          this.newOptions = '';
          this.newKind = 'text';
        }
      },

      /** 行内改完（失焦/回车）即保存 */
      async saveRow(row) {
        try {
          await CRM.api.saveQuotationField({
            id: row.id,
            name: row.name,
            kind: row.kind,
            unit: row.unit,
            options: row.kind === 'select' ? row.options : '',
            enabled: row.enabled,
            remark: row.remark
          });
          await this.refresh();
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
          await this.refresh();   // 出错就把界面拉回服务端的真实状态
        }
      },

      async toggle(row) {
        row.enabled = row.enabled ? 0 : 1;
        await this.saveRow(row);
      },

      async move(row, dir) {
        try {
          const r = await CRM.api.moveQuotationField(row.id, dir);
          if (!r.moved) { CRM.toast(r.message, 'info'); return; }
          await this.refresh();
        } catch (e) {
          CRM.toast(e.message || '调整顺序失败', 'error');
        }
      },

      async remove(row) {
        const ok = await CRM.confirm({
          title: '删除自定义列',
          message: `确定删除列「${row.name}」吗？<br><br>`
            + `已经填过的值<strong>不会从历史报价单里消失</strong>，只是这一列不再显示。<br>`
            + `注意：如果以后再加一个同名列，那是新的一列，拿不回旧值。`,
          okText: '删除',
          danger: true
        });
        if (!ok) return;
        try {
          const r = await CRM.api.deleteQuotationField(row.id);
          await this.refresh();
          const used = Number(r.used_in) || 0;
          CRM.toast(used
            ? `列已删除（${used} 张报价单曾填过这一列，值仍保留在单据里）`
            : '列已删除', 'success', 4000);
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      }
    },
    template: `
      <c-drawer :model-value="st.open" title="报价自定义列"
                sub="这些列会同时出现在报价单明细与报价模板明细里；列数不封顶，随时可加"
                width="980px"
                @update:model-value="close">

        <div class="note">
          <c-icon name="alert" :size="15" />
          <div style="font-size:var(--fs-xs)">
            报价时按客户要求填的规格项（介质、设计温度、泄露等级、执行器型号……）
            都可以加成列。<br>
            <strong>改列名不会丢数据</strong>：历史报价单里的值跟着新列名一起显示；
            <strong>删列也不会删值</strong>，只是不再显示。当前启用 <strong>{{ enabledCount }}</strong> 列，
            最多 {{ st.limits.maxFields }} 列。
          </div>
        </div>

        <!-- 常用列一键添加 -->
        <div class="qf-presets mt-4">
          <div class="field-label">常用列（点一下即添加）</div>
          <div class="qf-chips">
            <button v-for="p in presetsLeft" :key="p.name" class="qf-chip" type="button"
                    :disabled="busy" @click="addPreset(p)">
              + {{ p.name }}<span v-if="p.unit" class="qf-chip-unit">（{{ p.unit }}）</span>
            </button>
            <span v-if="!presetsLeft.length" class="muted" style="font-size:var(--fs-xs)">
              常用列都已添加，可在下面继续自定义新列
            </span>
          </div>
        </div>

        <!-- 新增自定义列 -->
        <div class="qf-add mt-4">
          <div class="field-label">新增一列（列名随便起，列数不限）</div>
          <div class="qf-add-row">
            <input class="input input-sm" style="max-width:170px" v-model="newName"
                   placeholder="列名，如 介质" @keyup.enter="addNew" />
            <select class="input input-sm" style="max-width:110px" v-model="newKind">
              <option value="text">文本</option>
              <option value="number">数字</option>
              <option value="select">下拉候选</option>
            </select>
            <input class="input input-sm" style="max-width:90px" v-model="newUnit" placeholder="单位" />
            <input v-if="newKind === 'select'" class="input input-sm" style="flex:1;min-width:180px"
                   v-model="newOptions" placeholder="候选值，用逗号分隔：A级,B级,C级" />
            <button class="btn btn-primary btn-sm" :disabled="busy" @click="addNew">添加这一列</button>
          </div>
        </div>

        <!-- 现有列 -->
        <div v-if="st.loading" class="muted mt-4">加载中…</div>
        <c-empty v-else-if="!st.list.length" icon="file" class="mt-4"
                 title="还没有自定义列"
                 desc="点上面的常用列，或在「新增一列」里填一个列名" />
        <div v-else class="table-wrap mt-4">
          <table class="data-table qf-table">
            <thead>
              <tr>
                <th style="width:52px">排序</th>
                <th style="width:170px">列名</th>
                <th style="width:120px">类型</th>
                <th style="width:100px">单位</th>
                <th>候选值（下拉类型用）</th>
                <th style="width:96px">启用</th>
                <th style="width:70px">操作</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(f, i) in st.list" :key="f.id" :class="{ muted: !f.enabled }">
                <td>
                  <div class="tpl-sort">
                    <button class="icon-btn" title="上移" :disabled="i === 0" @click="move(f, 'up')">↑</button>
                    <button class="icon-btn" title="下移" :disabled="i === st.list.length - 1" @click="move(f, 'down')">↓</button>
                  </div>
                </td>
                <td>
                  <input class="input input-sm" v-model="f.name" @change="saveRow(f)" />
                </td>
                <td>
                  <select class="input input-sm" v-model="f.kind" @change="saveRow(f)">
                    <option value="text">文本</option>
                    <option value="number">数字</option>
                    <option value="select">下拉候选</option>
                  </select>
                </td>
                <td><input class="input input-sm" v-model="f.unit" @change="saveRow(f)" /></td>
                <td>
                  <input v-if="f.kind === 'select'" class="input input-sm" v-model="f.options"
                         placeholder="用逗号分隔" @change="saveRow(f)" />
                  <span v-else class="muted" style="font-size:var(--fs-xs)">—</span>
                </td>
                <td>
                  <span class="tag" :class="f.enabled ? 'success' : 'muted'" style="cursor:pointer"
                        @click="toggle(f)">{{ f.enabled ? '启用' : '停用' }}</span>
                </td>
                <td>
                  <button class="icon-btn danger" title="删除这一列" @click="remove(f)">✕</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>

        <template #footer>
          <button class="btn btn-primary" @click="close">完成</button>
        </template>
      </c-drawer>`
  };

  CRM.quotationFields = {
    PRESETS,
    state,
    load,
    open,
    close,
    onChange,
    enabled: enabledFields,
    Manager: FieldsManager,
    register(app) { app.component('c-quotation-fields', FieldsManager); }
  };
})(window.CRM);
