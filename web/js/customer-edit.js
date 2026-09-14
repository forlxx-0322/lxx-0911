/**
 * 客户新增 / 编辑抽屉
 * 按 8 个区块组织客户字段；仅「基础信息」常显，其余折叠。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const { BLOCKS } = CRM.customerForm;

  function emptyForm() {
    const f = {};
    for (const b of BLOCKS) {
      for (const fd of b.fields) {
        if (fd.key === 'tag_ids') f.tag_ids = [];
        else if (fd.type === 'switch') f[fd.key] = 0;
        else if (fd.type === 'number') f[fd.key] = '';
        else f[fd.key] = '';
      }
    }
    f.status = '潜在';
    return f;
  }

  const CustomerEdit = {
    name: 'CustomerEdit',
    props: {
      modelValue: Boolean,
      customer: { type: Object, default: null }   // 为空表示新增
    },
    emits: ['update:modelValue', 'saved'],
    data() {
      return {
        blocks: BLOCKS,
        open: ['basic'],
        form: emptyForm(),
        saving: false,
        errors: {},
        duplicates: [],
        showDup: false,
        /* 行政区划清单（用于「归属地州」下拉与坐标工具） */
        regions: { cities: [], districts: [] },
        coordOpen: false
      };
    },
    computed: {
      isEdit() { return !!(this.customer && this.customer.id); },
      title() { return this.isEdit ? '编辑客户' : '新增客户'; },
      dialogWidth() { return '860px'; },
      /* 「归属地州」下拉显示地州名，但字段里必须存地州编码（地图按编码聚合）。
         这里直接给出 {value: 编码, label: 名称} 形式的选项。 */
      regionOptions() {
        return (this.regions.cities || []).map((c) => ({ value: c.code, label: c.name }));
      }
    },
    watch: {
      modelValue(v) { if (v) { this.reset(); this.loadRegions(); } },
      customer() { if (this.modelValue) this.reset(); }
    },
    methods: {
      reset() {
        this.errors = {};
        this.duplicates = [];
        this.showDup = false;
        if (this.customer) {
          const f = emptyForm();
          for (const k of Object.keys(f)) {
            if (this.customer[k] !== undefined && this.customer[k] !== null) f[k] = this.customer[k];
          }
          f.tag_ids = (this.customer.tags || []).map((t) => t.id);
          this.form = f;
          /* 编辑时展开已填写的区块，省去逐个点开 */
          this.open = ['basic'];
          for (const b of this.blocks) {
            if (b.always) continue;
            const filled = b.fields.some((fd) => {
              const v = this.form[fd.key];
              return v !== '' && v !== null && v !== undefined && !(Array.isArray(v) && !v.length);
            });
            if (filled) this.open.push(b.key);
          }
        } else {
          this.form = emptyForm();
          this.open = ['basic'];
        }
      },
      toggle(key) {
        const i = this.open.indexOf(key);
        if (i >= 0) this.open.splice(i, 1); else this.open.push(key);
      },
      isOpen(key) { return this.open.includes(key); },
      blockFilledCount(b) {
        return b.fields.filter((fd) => {
          const v = this.form[fd.key];
          if (fd.key === 'tag_ids') return Array.isArray(v) && v.length > 0;
          return v !== '' && v !== null && v !== undefined;
        }).length;
      },
      validate() {
        const e = {};
        if (!String(this.form.name || '').trim()) e.name = '客户全称必填';
        if (!String(this.form.short_name || '').trim()) e.short_name = '客户简称必填';
        if (!String(this.form.type || '').trim()) e.type = '请选择客户主体类型';
        if (!String(this.form.industry || '').trim()) e.industry = '请选择下游行业';
        this.errors = e;
        if (Object.keys(e).length) {
          this.open = [...new Set([...this.open, 'basic'])];
          CRM.toast('请先填写基础信息中的必填项', 'error');
          return false;
        }
        return true;
      },
      onDictAdded(result, category) {
        CRM.api.applyDictAdded(result, category);
      },

      /** 坐标工具回填 */
      applyCoord(payload) {
        this.form.longitude = payload.longitude;
        this.form.latitude = payload.latitude;
        this.open = [...new Set([...this.open, 'address'])];
      },

      /** 坐标工具推荐的地州 → 填入城市文本（保存时后端会自动归属） */
      applyCity(name) {
        this.form.city = name;
        this.open = [...new Set([...this.open, 'address'])];
      },

      async loadRegions() {
        if (this.regions.cities.length) return;
        try {
          const r = await CRM.api.get('/api/map/regions');
          this.regions = { cities: r.cities || [], districts: r.districts || [] };
        } catch (_) { /* 地图数据未就绪时忽略，不影响客户编辑 */ }
      },
      async save(ignoreDuplicate) {
        if (!this.validate()) return;
        this.saving = true;
        try {
          const payload = Object.assign({}, this.form);
          if (this.isEdit) payload.id = this.customer.id;
          const r = await CRM.api.saveCustomer(payload);

          /* 查重提示：仅在新建且未忽略时弹出 */
          if (!ignoreDuplicate && r.duplicates && r.duplicates.length) {
            this.duplicates = r.duplicates;
            this.showDup = true;
            this.saving = false;
            return;
          }

          CRM.toast(r.created ? '客户已创建' : '客户已保存', 'success');
          this.$emit('saved', r);
          this.$emit('update:modelValue', false);
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.saving = false;
        }
      },
      async confirmDuplicate() {
        this.showDup = false;
        await this.save(true);
      },
      closeDup() { this.showDup = false; },
      goDuplicate(id) {
        this.$emit('update:modelValue', false);
        CRM.router.navigate(`/customers/${id}`);
      }
    },
    template: `
      <c-drawer :model-value="modelValue" :title="title"
                :sub="isEdit ? '修改后立即生效，变更会记入操作日志' : '仅 4 项必填，其余可后续补全'"
                :width="dialogWidth"
                @update:model-value="$emit('update:modelValue', $event)">

        <c-empty v-if="showDup" icon="alert" title="发现可能重复的客户"
                 desc="以下客户与本次录入的名称或电话相同，请确认是否继续创建。" />

        <!-- 用 template 承载 v-for：Vue 3 里 v-if 与 v-for 同元素时 v-if 优先级更高，
             官方明确不推荐（且容易误读作用域）。拆成两层后语义清晰。 -->
        <template v-if="showDup">
          <div v-for="d in duplicates" :key="d.id" class="mini-card mt-3">
            <div class="nm">
              {{ d.name }}
              <span class="tag muted">{{ d.match === 'name' ? '同名' : '同电话' }}</span>
            </div>
            <div class="rows">
              <div>简称：{{ d.short_name || '—' }}</div>
              <div>电话：{{ d.phone || '—' }}</div>
              <div>状态：{{ d.status || '—' }}</div>
            </div>
            <div class="mt-3">
              <button class="btn btn-sm" @click="goDuplicate(d.id)">查看这条记录</button>
            </div>
          </div>
        </template>

        <div v-if="!showDup">
          <div v-for="b in blocks" :key="b.key" class="form-block" :style="b.always ? 'margin-top:0;border:none' : ''">
            <div v-if="!b.always" class="form-block-head" :class="{ open: isOpen(b.key) }" @click="toggle(b.key)">
              <span class="arrow">▶</span>
              <span>{{ b.title }}</span>
              <span class="count">已填 {{ blockFilledCount(b) }} / {{ b.fields.length }}</span>
            </div>
            <div v-else class="form-block-head open" style="cursor:default">
              <span>{{ b.title }}</span>
              <span class="count">{{ b.desc }}</span>
            </div>

            <div v-show="b.always || isOpen(b.key)"
                 class="form-block-body" :style="b.always ? 'border-top:none;padding-top:0' : ''">
              <div class="form-grid">
                <template v-for="fd in b.fields" :key="fd.key">
                  <!-- 标签 -->
                  <c-tag-picker v-if="fd.type === 'tags'"
                                v-model="form[fd.key]" :label="fd.label" :span="fd.span" />

                  <!-- 多选 -->
                  <c-multi v-else-if="fd.type === 'multi'"
                           v-model="form[fd.key]" :label="fd.label"
                           :options="api.options(fd.category)"
                           :category="fd.category" :allow-add="fd.allowAdd"
                           :span="fd.span" :hint="fd.hint" />

                  <!-- 归属地州（特殊处理：需要城市清单）
                       该字段存的是地州编码，但下拉要显示地州名，
                       因此用 {value: 编码, label: 名称} 形式的选项。 -->
                  <c-select v-else-if="fd.type === 'region'"
                            v-model="form[fd.key]" :label="fd.label"
                            :options="regionOptions"
                            :span="fd.span" :hint="fd.hint" empty-text="（按地址自动匹配）" />

                  <!-- 单选 -->
                  <c-select v-else-if="fd.type === 'select'"
                            v-model="form[fd.key]" :label="fd.label"
                            :options="fd.options || api.options(fd.category)"
                            :category="fd.category" :allow-add="fd.allowAdd"
                            :required="fd.required" :span="fd.span" :hint="fd.hint"
                            @added="onDictAdded($event, fd.category)" />

                  <!-- 开关 -->
                  <c-switch v-else-if="fd.type === 'switch'"
                            v-model="form[fd.key]" :label="fd.label"
                            :span="fd.span" :hint="fd.hint" />

                  <!-- 文本 / 数字 / 日期 -->
                  <c-field v-else
                           v-model="form[fd.key]" :label="fd.label"
                           :type="fd.type" :placeholder="fd.placeholder"
                           :required="fd.required" :hint="errors[fd.key] || fd.hint"
                           :span="fd.span" :rows="fd.rows" />

                  <!-- 经度字段后面挂一个「坐标工具」入口 -->
                  <div v-if="fd.key === 'longitude'" class="coord-entry"
                       style="grid-column:span 2;margin-top:-6px">
                    <button type="button" class="btn btn-sm" @click="loadRegions(); coordOpen = true">
                      <c-icon name="map" :size="13" /> 坐标工具（粘贴高德/百度坐标自动转换）
                    </button>
                    <span class="muted" style="font-size:var(--fs-xs);margin-left:8px">
                      从地图复制的坐标直接粘进去即可，系统会转成 WGS84
                    </span>
                  </div>
                </template>
              </div>
            </div>
          </div>
        </div>

        <template #footer>
          <template v-if="showDup">
            <button class="btn" @click="closeDup">返回修改</button>
            <div style="flex:1"></div>
            <button class="btn btn-primary" :disabled="saving" @click="confirmDuplicate">
              确认不是同一家，继续创建
            </button>
          </template>
          <template v-else>
            <span class="muted" style="font-size:var(--fs-xs)">
              {{ isEdit ? '客户 ID：' + customer.id : '保存后可在详情页继续补充联系人与跟进记录' }}
            </span>
            <div style="flex:1"></div>
            <button class="btn" @click="$emit('update:modelValue', false)">取消</button>
            <button class="btn btn-primary" :disabled="saving" @click="save(false)">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </template>
        </template>

        <!-- 坐标工具（独立抽屉） -->
        <c-coord-tool v-model="coordOpen"
                      :longitude="form.longitude" :latitude="form.latitude"
                      :city-text="form.city" :customer-name="form.short_name || form.name"
                      @apply="applyCoord"
                      @apply-city="applyCity" />
      </c-drawer>`,
    setup() {
      return { api: CRM.api };
    }
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.CustomerEdit = CustomerEdit;

})(window.CRM);
