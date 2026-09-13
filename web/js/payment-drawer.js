/**
 * 回款抽屉 —— 新增/编辑 回款计划 与 实收记录（共用组件）
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  function todayStr() {
    const d = new Date();
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  }

  const PaymentDrawer = {
    name: 'PaymentDrawer',
    props: {
      modelValue: Boolean,
      type: { type: String, default: '计划' },     // 计划 | 实收
      projectId: [Number, String],
      projectName: String,
      contractAmount: { type: Number, default: 0 },
      debtAmount: { type: Number, default: 0 },
      plans: { type: Array, default: () => [] },   // 实收时可核销的计划
      payment: { type: Object, default: null }
    },
    emits: ['update:modelValue', 'saved'],
    data() {
      return {
        form: { amount: '', plan_date: '', actual_date: '', method: '', plan_id: '', voucher: '', remark: '' },
        saving: false
      };
    },
    computed: {
      isPlan() { return this.type === '计划'; },
      title() {
        if (this.payment && this.payment.id) return this.isPlan ? '编辑回款计划' : '编辑实收记录';
        return this.isPlan ? '新增回款计划' : '登记实收';
      },
      unsettledPlans() {
        return (this.plans || []).filter((p) => !p.is_settled);
      }
    },
    watch: {
      modelValue(v) { if (v) this.reset(); }
    },
    methods: {
      reset() {
        if (this.payment && this.payment.id) {
          this.form = {
            amount: this.payment.amount,
            plan_date: this.payment.plan_date || '',
            actual_date: this.payment.actual_date || todayStr(),
            method: this.payment.method || '',
            plan_id: this.payment.plan_id || '',
            voucher: this.payment.voucher || '',
            remark: this.payment.remark || ''
          };
        } else {
          this.form = {
            amount: '', plan_date: todayStr(), actual_date: todayStr(),
            method: '', plan_id: '', voucher: '', remark: ''
          };
        }
      },
      async save() {
        const amount = Number(this.form.amount);
        if (!isFinite(amount) || amount <= 0) {
          CRM.toast('金额必须大于 0', 'error');
          return;
        }
        if (this.isPlan && !this.form.plan_date) {
          CRM.toast('请填写计划收款日期', 'error');
          return;
        }
        this.saving = true;
        try {
          const payload = {
            project_id: Number(this.projectId),
            type: this.type,
            amount,
            plan_date: this.isPlan ? this.form.plan_date : null,
            actual_date: this.isPlan ? null : (this.form.actual_date || todayStr()),
            method: this.form.method,
            plan_id: this.form.plan_id === '' ? null : Number(this.form.plan_id),
            voucher: this.form.voucher,
            remark: this.form.remark
          };
          if (this.payment && this.payment.id) payload.id = this.payment.id;

          const r = await CRM.api.savePayment(payload);
          if (r.warning) {
            CRM.toast(r.warning, 'warn', 6000);
          } else {
            CRM.toast(this.isPlan
              ? (r.taskCreated ? '回款计划已保存，并已自动生成待办' : '回款计划已保存')
              : '实收已登记，欠款与回款率已自动更新', 'success');
          }
          this.$emit('saved', r);
          this.$emit('update:modelValue', false);
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.saving = false;
        }
      },
      fillRemain() {
        if (this.debtAmount > 0) this.form.amount = this.debtAmount;
      }
    },
    template: `
      <c-drawer :model-value="modelValue" :title="title"
                :sub="projectName ? '项目：' + projectName : ''" width="560px"
                @update:model-value="$emit('update:modelValue', $event)">
        <div class="note" style="margin-bottom:16px">
          <c-icon name="money" :size="16" />
          <div style="font-size:var(--fs-sm)">
            合同额 <strong>{{ fmtMoney(contractAmount) }}</strong> 元 ·
            当前欠款 <strong :style="debtAmount > 0 ? 'color:var(--c-danger)' : ''">{{ fmtMoney(debtAmount) }}</strong> 元
            <span v-if="debtAmount > 0" style="margin-left:8px">
              <button class="btn btn-sm" @click="fillRemain">按欠款金额填入</button>
            </span>
          </div>
        </div>

        <div class="form-grid">
          <c-field v-model="form.amount" label="金额（元）" type="number" required
                   :placeholder="isPlan ? '例如：558000' : '例如：558000'" />
          <c-field v-if="isPlan" v-model="form.plan_date" label="计划收款日期" type="date" required />
          <c-field v-else v-model="form.actual_date" label="实际收款日期" type="date" required />
          <c-select v-model="form.method" label="收款方式" :options="api.options('payment_method')" />

          <c-ref-select v-if="!isPlan" v-model="form.plan_id" label="核销对应计划"
                        :options="unsettledPlans.map(p => ({ value: p.id, label: (p.plan_date || '无日期') + ' · ' + p.amount + ' 元 · 余 ' + p.remain }))"
                        empty-label="（不核销具体计划）"
                        hint="选择后该计划会标记为已核销" />
          <c-field v-else v-model="form.voucher" label="凭证备注" placeholder="例如：合同编号 / 发票号" />

          <c-field v-model="form.remark" label="备注" type="textarea" :span="2" :rows="2" />
        </div>

        <div v-if="isPlan" class="note warn mt-4">
          <c-icon name="clock" :size="16" />
          <div style="font-size:var(--fs-sm)">
            保存后系统会按「设置 → 提醒规则」中的回款提醒提前天数，自动生成一条待办。
          </div>
        </div>

        <template #footer>
          <div style="flex:1"></div>
          <button class="btn" @click="$emit('update:modelValue', false)">取消</button>
          <button class="btn btn-primary" :disabled="saving" @click="save">
            {{ saving ? '保存中…' : '保存' }}
          </button>
        </template>
      </c-drawer>`,
    setup() {
      return {
        api: CRM.api,
        fmtMoney: CRM.util.fmtMoney
      };
    }
  };

  CRM.pages = CRM.pages || {};
  CRM.pages.PaymentDrawer = PaymentDrawer;

})(window.CRM);
