/**
 * 项目新增 / 编辑抽屉
 * 按 4 个区块组织项目字段；所属客户为必填（下拉可搜索）。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const STAGE_ORDER = [
    '信息收集', '初步接洽', '技术交流', '方案选型', '询价报价', '投标/议价',
    '已中标/已签约', '生产执行', '发货交付', '安装调试', '验收结项',
    '质保期内', '已暂停', '已终止'
  ];

  const BID_RESULTS = ['未投标', '已投标待开标', '已中标', '未中标', '已废标'];
  const WIN_LOSS = ['价格无优势', '技术不满足', '交期不满足', '关系不到位', '资质不满足', '其他'];

  function emptyForm(customerId) {
    return {
      name: '', customer_id: customerId || '', stage: '信息收集', progress: 0,
      end_user: '', design_institute: '', valve_needs: '', quantity: '',
      contract_amount: '', signed_at: '', bid_date: '', bid_result: '',
      win_rate_note: '', start_date: '', end_date: '', delivery_date: '',
      owner: '', remark: ''
    };
  }

  const ProjectEdit = {
    name: 'ProjectEdit',
    props: {
      modelValue: Boolean,
      project: { type: Object, default: null },
      defaultCustomerId: [String, Number]
    },
    emits: ['update:modelValue', 'saved'],
    data() {
      return {
        form: emptyForm(),
        saving: false,
        errors: {},
        open: ['basic']
      };
    },
    computed: {
      isEdit() { return !!(this.project && this.project.id); },
      title() { return this.isEdit ? '编辑项目' : '新增项目'; },
      customers() { return CRM.api.customerOptions(); },
      valveTypeOptions() { return CRM.api.options('valve_type'); }
    },
    watch: {
      modelValue(v) { if (v) this.reset(); },
      project() { if (this.modelValue) this.reset(); }
    },
    methods: {
      reset() {
        this.errors = {};
        this.open = ['basic'];
        if (this.project) {
          const f = emptyForm();
          for (const k of Object.keys(f)) {
            if (this.project[k] !== undefined && this.project[k] !== null) f[k] = this.project[k];
          }
          this.form = f;
          for (const key of ['parties', 'bid', 'other']) {
            const hasVal = Object.keys(f).some((k) => {
              if (key === 'other') return k === 'remark' && this.form[k];
              if (key === 'bid') return ['contract_amount', 'signed_at', 'bid_date', 'bid_result', 'win_rate_note', 'delivery_date', 'start_date', 'end_date'].some((x) => this.form[x]);
              if (key === 'parties') return ['end_user', 'design_institute', 'valve_needs', 'quantity', 'owner'].some((x) => this.form[x]);
              return false;
            });
            if (hasVal) this.open.push(key);
          }
        } else {
          this.form = emptyForm(this.defaultCustomerId);
        }
      },
      toggle(key) {
        const i = this.open.indexOf(key);
        if (i >= 0) this.open.splice(i, 1); else this.open.push(key);
      },
      isOpen(key) { return this.open.includes(key); },
      toggleValve(v) {
        const cur = String(this.form.valve_needs || '').split(',').map((s) => s.trim()).filter(Boolean);
        const i = cur.indexOf(v);
        if (i >= 0) cur.splice(i, 1); else cur.push(v);
        this.form.valve_needs = cur.join(',');
      },
      valveSelected(v) {
        return String(this.form.valve_needs || '').split(',').map((s) => s.trim()).includes(v);
      },
      validate() {
        const e = {};
        if (!String(this.form.name || '').trim()) e.name = '项目名称必填';
        if (!this.form.customer_id) e.customer_id = '必须选择所属客户';
        const amt = Number(this.form.contract_amount);
        if (this.form.contract_amount !== '' && (!isFinite(amt) || amt < 0)) e.contract_amount = '合同金额必须是不小于 0 的数字';
        this.errors = e;
        if (Object.keys(e).length) {
          this.open = [...new Set([...this.open, 'basic', 'bid'])];
          CRM.toast('请先填写必填项：项目名称、所属客户', 'error');
          return false;
        }
        return true;
      },
      async save() {
        if (!this.validate()) return;
        this.saving = true;
        try {
          const payload = Object.assign({}, this.form);
          if (this.isEdit) payload.id = this.project.id;
          payload.progress = Math.max(0, Math.min(100, Number(payload.progress) || 0));
          if (payload.contract_amount === '') payload.contract_amount = 0;
          const r = await CRM.api.saveProject(payload);
          CRM.toast(r.created ? '项目已创建' : '项目已保存', 'success');
          this.$emit('saved', r);
          this.$emit('update:modelValue', false);
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.saving = false;
        }
      }
    },
    async created() { try { await CRM.api.loadCustomerOptions(); } catch (_) { /* 忽略 */ } },
    template: `
      <c-drawer :model-value="modelValue" :title="title"
                :sub="isEdit ? '修改后欠款与回款率会自动重算' : '仅项目名称与所属客户必填'"
                width="820px"
                @update:model-value="$emit('update:modelValue', $event)">

        <div class="form-block" style="margin-top:0;border:none">
          <div class="form-block-head open" style="cursor:default">
            <span>基本信息</span>
            <span class="count">项目名称与所属客户必填</span>
          </div>
          <div class="form-block-body" style="border-top:none;padding-top:0">
            <div class="form-grid">
              <c-field v-model="form.name" label="项目名称" :span="2" required
                       :hint="errors.name || '建议格式：客户简称 + 装置/项目名 + 年份'"
                       placeholder="例如：塔河炼化 2026 年大修阀门采购项目" />
              <c-ref-select v-model="form.customer_id" label="所属客户" required
                            :options="customers.map(c => ({ value: c.id, label: c.label }))"
                            :allow-empty="false" :hint="errors.customer_id || ''" />
              <c-select v-model="form.stage" label="项目阶段" :options="STAGE_ORDER" :allow-empty="false" />
              <c-field v-model="form.progress" label="进度（%）" type="number" hint="0 ~ 100" />
              <c-field v-model="form.owner" label="负责人" placeholder="默认本人" />
            </div>
          </div>
        </div>

        <div class="form-block">
          <div class="form-block-head" :class="{ open: isOpen('parties') }" @click="toggle('parties')">
            <span class="arrow">▶</span><span>相关单位与阀门需求</span>
          </div>
          <div v-show="isOpen('parties')" class="form-block-body">
            <div class="form-grid">
              <c-field v-model="form.end_user" label="最终用户" hint="阀门最终装到哪个厂" />
              <c-field v-model="form.design_institute" label="设计院" hint="涉及上图时填写" />
              <c-field v-model="form.quantity" label="数量（台/套）" type="number" />
              <div class="field" style="grid-column:span 2">
                <label class="field-label">项目阀门需求</label>
                <div class="chips">
                  <button v-for="v in valveTypeOptions" :key="v" type="button"
                          class="chip" :class="{ on: valveSelected(v) }" @click="toggleValve(v)">{{ v }}</button>
                </div>
                <div class="field-hint">可多选；也可直接写到下面的备注里</div>
              </div>
            </div>
          </div>
        </div>

        <div class="form-block">
          <div class="form-block-head" :class="{ open: isOpen('bid') }" @click="toggle('bid')">
            <span class="arrow">▶</span><span>招投标与合同</span>
          </div>
          <div v-show="isOpen('bid')" class="form-block-body">
            <div class="form-grid">
              <c-field v-model="form.bid_date" label="投标日期" type="date" />
              <c-select v-model="form.bid_result" label="投标结果" :options="BID_RESULTS" />
              <c-field v-model="form.contract_amount" label="合同金额（元）" type="number"
                       :hint="errors.contract_amount || '未签约填 0；欠款与回款率由实收流水自动算'"
                       placeholder="例如：1860000" />
              <c-field v-model="form.signed_at" label="签约日期" type="date" />
              <c-field v-model="form.delivery_date" label="合同交货期" type="date" />
              <c-select v-model="form.win_rate_note" label="中标 / 失标原因" :options="WIN_LOSS"
                        hint="复盘用，避免重复踩坑" />
              <c-field v-model="form.start_date" label="开始日期" type="date" />
              <c-field v-model="form.end_date" label="预计结束日期" type="date" />
            </div>
          </div>
        </div>

        <div class="form-block">
          <div class="form-block-head" :class="{ open: isOpen('other') }" @click="toggle('other')">
            <span class="arrow">▶</span><span>备注</span>
          </div>
          <div v-show="isOpen('other')" class="form-block-body">
            <div class="form-grid">
              <c-field v-model="form.remark" label="备注" type="textarea" :span="2" :rows="3" />
            </div>
          </div>
        </div>

        <template #footer>
          <span class="muted" style="font-size:var(--fs-xs)">
            {{ isEdit ? '项目 ID：' + project.id : '保存后可在详情页维护回款计划与实收流水' }}
          </span>
          <div style="flex:1"></div>
          <button class="btn" @click="$emit('update:modelValue', false)">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </template>
      </c-drawer>`,
    setup() {
      return { STAGE_ORDER, BID_RESULTS, WIN_LOSS };
    }
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.ProjectEdit = ProjectEdit;

})(window.CRM);
