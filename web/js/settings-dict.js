/**
 * 设置页 · 字典管理
 * 18+ 类下拉选项的增删改、停用/启用、排序、改名（改名不影响历史数据）
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const DICT_GROUPS = [
    {
      title: 'A. 客户画像',
      cats: [
        { key: 'industry', label: '下游行业' },
        { key: 'customer_type', label: '客户主体类型' },
        { key: 'purchase_mode', label: '采购模式' },
        { key: 'enterprise_nature', label: '企业性质' },
        { key: 'customer_source', label: '客户来源' }
      ]
    },
    {
      title: 'B. 阀门产品参数',
      cats: [
        { key: 'valve_type', label: '阀门类型' },
        { key: 'drive_mode', label: '驱动方式' },
        { key: 'body_material', label: '阀体材质' },
        { key: 'pressure_rating', label: '压力等级' },
        { key: 'size_range', label: '公称口径' },
        { key: 'design_standard', label: '设计标准' },
        { key: 'connection_type', label: '连接方式' },
        { key: 'cert_required', label: '认证要求' }
      ]
    },
    {
      title: 'C. 商务与流程',
      cats: [
        { key: 'account_period', label: '账期' },
        { key: 'customer_level', label: '客户等级' },
        { key: 'customer_status', label: '客户状态' },
        { key: 'project_stage', label: '项目阶段' },
        { key: 'follow_method', label: '跟进方式' },
        { key: 'follow_result', label: '跟进结果' },
        { key: 'payment_method', label: '收款方式' }
      ]
    },
    {
      title: 'D. 人员与联系人',
      cats: [
        { key: 'contact_position', label: '联系人职位' },
        { key: 'contact_influence', label: '联系人影响力' }
      ]
    }
  ];

  const DictManager = {
    name: 'DictManager',
    data() {
      return {
        groups: DICT_GROUPS,
        current: 'industry',
        adding: false,
        newValue: '',
        newColor: '',
        saving: false,
        editingId: null,
        editingValue: '',
        usage: null
      };
    },
    computed: {
      allCats() { return this.groups.flatMap((g) => g.cats); },
      currentLabel() {
        const hit = this.allCats.find((c) => c.key === this.current);
        return hit ? hit.label : this.current;
      },
      items() {
        return (CRM.api.cache.dict.items && CRM.api.cache.dict.items[this.current]) || [];
      },
      enabledCount() { return this.items.filter((x) => x.enabled).length; }
    },
    methods: {
      async load(force) {
        await CRM.api.loadDict(force);
      },

      async switchCat(key) {
        this.current = key;
        this.adding = false;
        this.editingId = null;
        this.usage = null;
      },

      async addItem() {
        const v = String(this.newValue || '').trim();
        if (!v) { CRM.toast('请输入选项名称', 'error'); return; }
        this.saving = true;
        try {
          const r = await CRM.api.addDict(this.current, v);
          if (this.newColor) await CRM.api.updateDict(r.id, { color: this.newColor });
          await CRM.api.loadDict(true);
          this.newValue = '';
          this.newColor = '';
          this.adding = false;
          CRM.toast(`已新增「${v}」`, 'success');
        } catch (e) {
          CRM.toast(e.message || '新增失败', 'error');
        } finally {
          this.saving = false;
        }
      },

      startEdit(item) {
        this.editingId = item.id;
        this.editingValue = item.value;
      },

      async saveEdit(item) {
        const v = String(this.editingValue || '').trim();
        if (!v || v === item.value) { this.editingId = null; return; }
        try {
          const r = await CRM.api.updateDict(item.id, { value: v });
          await CRM.api.loadDict(true);
          this.editingId = null;
          CRM.toast(r.synced > 0
            ? `已改名为「${v}」，同步更新了 ${r.synced} 条历史数据`
            : `已改名为「${v}」`, 'success');
        } catch (e) {
          CRM.toast(e.message || '改名失败', 'error');
        }
      },

      async toggleEnabled(item) {
        try {
          await CRM.api.updateDict(item.id, { enabled: item.enabled ? 0 : 1 });
          await CRM.api.loadDict(true);
          CRM.toast(item.enabled ? `「${item.value}」已停用（历史数据保留）` : `「${item.value}」已启用`, 'success');
        } catch (e) {
          CRM.toast(e.message || '操作失败', 'error');
        }
      },

      async move(item, delta) {
        const list = [...this.items];
        const i = list.findIndex((x) => x.id === item.id);
        const j = i + delta;
        if (i < 0 || j < 0 || j >= list.length) return;
        try {
          await CRM.api.updateDict(list[i].id, { sort: list[j].sort });
          await CRM.api.updateDict(list[j].id, { sort: list[i].sort });
          await CRM.api.loadDict(true);
        } catch (e) {
          CRM.toast(e.message || '排序失败', 'error');
        }
      },

      async remove(item) {
        /* 先查引用次数，给出针对性提示 */
        let refText = '';
        try {
          const u = await CRM.api.dictUsage(this.current, item.value);
          if (u.count > 0) refText = `<br>当前有 <strong>${u.count}</strong> 条业务数据使用了该选项，删除后这些数据会显示为「未分类」。`;
        } catch (_) { /* 忽略 */ }

        if (item.is_system) {
          const ok0 = await CRM.confirm({
            title: '停用系统内置选项',
            message: `「${item.value}」是系统内置选项，为保证数据稳定<strong>不允许删除，只能停用</strong>。`
              + `<br>停用后不会出现在下拉框中，但历史数据仍正常显示。${refText}`,
            okText: '停用'
          });
          if (!ok0) return;
          try {
            const r = await CRM.api.deleteDict(item.id);
            await CRM.api.loadDict(true);
            CRM.toast(r.disabled ? `「${item.value}」已停用` : '已处理', 'success');
          } catch (e) {
            CRM.toast(e.message || '操作失败', 'error');
          }
          return;
        }

        const ok = await CRM.confirm({
          title: '删除选项',
          message: `确定要删除「${item.value}」吗？${refText}`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.deleteDict(item.id);
          await CRM.api.loadDict(true);
          CRM.toast(`已删除「${item.value}」`, 'success');
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      async setColor(item, color) {
        try {
          await CRM.api.updateDict(item.id, { color });
          await CRM.api.loadDict(true);
        } catch (e) {
          CRM.toast(e.message || '设置颜色失败', 'error');
        }
      }
    },
    async created() { await this.load(); },
    template: `
      <div>
        <div class="note" style="margin-bottom:14px">
          <c-icon name="settings" :size="16" />
          <div style="font-size:var(--fs-sm)">
            这里管理全部下拉选项。新增的选项<strong>立即生效</strong>，无需重启；
            <strong>改名会同步更新历史数据</strong>；系统内置选项只能停用不能删除，避免误删核心选项。
          </div>
        </div>

        <div class="dict-layout">
          <!-- 左侧分类 -->
          <div class="card">
            <div class="card-body" style="padding:10px">
              <div class="dict-cats">
                <template v-for="g in groups" :key="g.title">
                  <div class="nav-group-label" style="color:var(--c-text-3);padding:8px 12px 2px">{{ g.title }}</div>
                  <button v-for="c in g.cats" :key="c.key" class="dict-cat"
                          :class="{ active: current === c.key }" @click="switchCat(c.key)">
                    {{ c.label }}
                    <span class="n">{{ ((api.cache.dict.items[c.key] || []).filter(x => x.enabled)).length }}</span>
                  </button>
                </template>
              </div>
            </div>
          </div>

          <!-- 右侧选项 -->
          <div class="card">
            <div class="card-head">
              <div>
                <div class="card-title">{{ currentLabel }}</div>
                <div class="card-sub">
                  共 {{ items.length }} 项，启用 {{ enabledCount }} 项
                  <span class="muted">（分类键：{{ current }}）</span>
                </div>
              </div>
              <div class="spacer"></div>
              <button class="btn btn-sm btn-primary" @click="adding = true">
                <c-icon name="plus" :size="13" /> 新增选项
              </button>
            </div>

            <div class="card-body">
              <!-- 新增 -->
              <div v-if="adding" class="filter-bar" style="margin-bottom:14px">
                <input class="input" v-model="newValue" placeholder="新选项名称" style="flex:1 1 220px"
                       @keydown.enter="addItem" />
                <input type="color" v-model="newColor" title="选项颜色（可选）"
                       style="width:38px;height:32px;padding:2px;border:1px solid var(--c-border-strong);border-radius:6px;cursor:pointer" />
                <button class="btn btn-primary" :disabled="saving" @click="addItem">
                  {{ saving ? '保存中…' : '保存' }}
                </button>
                <button class="btn" @click="adding = false; newValue = ''; newColor = ''">取消</button>
              </div>

              <c-empty v-if="!items.length" title="该分类还没有选项" desc="点击右上角「新增选项」建立第一个。" />

              <div v-else class="dict-items">
                <div v-for="(it, i) in items" :key="it.id" class="dict-item" :class="{ off: !it.enabled }">
                  <span v-if="it.color" style="width:10px;height:10px;border-radius:50%;display:inline-block"
                        :style="{ background: it.color }"></span>

                  <template v-if="editingId === it.id">
                    <input class="chip-input" v-model="editingValue" style="width:120px"
                           @keydown.enter="saveEdit(it)" @keydown.esc="editingId = null" />
                    <button class="acts" style="border:none;background:none;cursor:pointer;color:var(--c-primary)"
                            @click="saveEdit(it)">保存</button>
                    <button class="acts" style="border:none;background:none;cursor:pointer;color:var(--c-text-3)"
                            @click="editingId = null">取消</button>
                  </template>

                  <template v-else>
                    <span>{{ it.value }}</span>
                    <span v-if="it.is_system" class="sys" title="系统内置选项，只能停用">内置</span>
                    <span v-if="!it.enabled" class="sys">已停用</span>
                    <span class="acts">
                      <button title="上移" @click="move(it, -1)" :disabled="i === 0">↑</button>
                      <button title="下移" @click="move(it, 1)" :disabled="i === items.length - 1">↓</button>
                      <button title="改名（同步更新历史数据）" @click="startEdit(it)">改名</button>
                      <button :title="it.enabled ? '停用（历史数据保留）' : '启用'" @click="toggleEnabled(it)">
                        {{ it.enabled ? '停用' : '启用' }}
                      </button>
                      <button class="danger" title="删除" @click="remove(it)">删除</button>
                    </span>
                  </template>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>`,
    setup() { return { api: CRM.api }; }
  };

  CRM.settings = CRM.settings || {};
  CRM.settings.DictManager = DictManager;

})(window.CRM);
