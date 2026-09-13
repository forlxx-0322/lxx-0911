/**
 * 设置页 · 附件与存储
 * 用量统计（数据库记录 vs 磁盘实际占用）、上限配置、清理无主文件
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const OWNER_LABEL = { customer: '客户', project: '项目', followup: '跟进记录', payment: '回款记录' };

  const AttachmentPanel = {
    name: 'AttachmentStorePanel',
    data() {
      return {
        loading: true,
        usage: null,
        maxMb: 50,
        dirty: false,
        cleaning: false,
        busy: false
      };
    },
    computed: {
      ownerRows() {
        if (!this.usage) return [];
        return (this.usage.by_owner || []).map((r) => ({
          label: OWNER_LABEL[r.owner_type] || r.owner_type,
          n: r.n,
          size_text: r.size_text
        }));
      },
      orphanInfo() {
        if (!this.usage) return null;
        const gap = this.usage.disk_files - this.usage.count;
        if (gap <= 0) return null;
        return { files: gap, note: '磁盘上有文件但数据库无对应记录（多为删除附件时的残留）' };
      }
    },
    methods: {
      fmtSize: CRM.util.fmtSize,

      async load() {
        this.loading = true;
        try {
          this.usage = await CRM.api.attachmentUsage();
          this.maxMb = this.usage.max_mb || 50;
          this.dirty = false;
        } catch (e) {
          CRM.toast(e.message || '读取存储用量失败', 'error');
        } finally {
          this.loading = false;
        }
      },

      async saveLimit() {
        const v = Number(this.maxMb);
        if (!Number.isFinite(v) || v < 1 || v > 2000) {
          CRM.toast('上限需在 1 ~ 2000 MB 之间', 'error');
          return;
        }
        this.busy = true;
        try {
          await CRM.api.saveSettings({ attachment_max_mb: String(Math.round(v)) });
          CRM.toast(`单个附件上限已设为 ${Math.round(v)} MB`, 'success');
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        } finally {
          this.busy = false;
        }
      },

      async cleanOrphans() {
        const ok = await CRM.confirm({
          title: '清理无主附件文件',
          message: '将删除磁盘上<strong>数据库中没有对应记录</strong>的附件文件。'
            + '<br>正常附件不会被影响。确定继续吗？',
          okText: '开始清理'
        });
        if (!ok) return;
        this.cleaning = true;
        try {
          const r = await CRM.api.cleanOrphanAttachments();
          CRM.toast(r.removed
            ? `已清理 ${r.removed} 个无主文件，释放 ${r.freed_text}`
            : '没有需要清理的无主文件', r.removed ? 'success' : 'info');
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '清理失败', 'error');
        } finally {
          this.cleaning = false;
        }
      },

      async openDir() {
        try {
          const r = await CRM.api.openDataDir();
          CRM.toast(r.message + '（附件在其中的 attachments 文件夹）', 'success');
        } catch (e) {
          CRM.toast(e.message || '打开失败', 'error');
        }
      }
    },
    async created() { this.load(); },
    template: `
      <div>
        <div v-if="loading" class="card"><div class="card-body muted">正在统计存储用量…</div></div>

        <template v-else-if="usage">
          <div class="stat-grid" style="margin-bottom:16px">
            <div class="stat">
              <div class="n">{{ usage.count }}</div>
              <div class="l">附件记录数</div>
            </div>
            <div class="stat">
              <div class="n">{{ usage.size_text }}</div>
              <div class="l">数据库记录合计</div>
            </div>
            <div class="stat">
              <div class="n">{{ usage.disk_files }}</div>
              <div class="l">磁盘文件数</div>
            </div>
            <div class="stat">
              <div class="n" :style="usage.disk_size !== usage.size ? 'color:var(--c-warning)' : ''">
                {{ usage.disk_size_text }}
              </div>
              <div class="l">磁盘实际占用</div>
            </div>
          </div>

          <div class="grid-2">
            <c-card title="单个附件大小上限" sub="超过上限的文件无法上传" icon="file">
              <div class="form-grid">
                <div class="field">
                  <label class="field-label">上限（MB）</label>
                  <input class="input" type="number" min="1" max="2000" v-model="maxMb"
                         @input="dirty = true" />
                  <div class="field-hint">建议 20 ~ 100 MB；合同扫描件与图纸通常不需要更大</div>
                </div>
                <div class="field">
                  <label class="field-label">保存</label>
                  <button class="btn btn-primary" :disabled="busy || !dirty" @click="saveLimit">
                    {{ busy ? '保存中…' : '保存上限' }}
                  </button>
                </div>
              </div>

              <div class="note mt-4">
                <c-icon name="alert" :size="16" />
                <div style="font-size:var(--fs-sm)">
                  <strong>附件不在数据库备份里。</strong>备份功能只备份数据库；
                  附件文件存放在 <span class="mono-text">{{ usage.attach_dir }}</span>，
                  备份数据目录时请把整个 <span class="mono-text">data</span> 文件夹一起拷走。
                </div>
              </div>

              <div class="mt-4" style="display:flex;gap:8px;flex-wrap:wrap">
                <button class="btn" @click="openDir">
                  <c-icon name="folder" :size="14" /> 打开数据目录
                </button>
                <button class="btn" :disabled="cleaning" @click="cleanOrphans">
                  <c-icon name="trash" :size="14" /> {{ cleaning ? '清理中…' : '清理无主文件' }}
                </button>
                <button class="btn" @click="load">
                  <c-icon name="refresh" :size="14" /> 重新统计
                </button>
              </div>
            </c-card>

            <c-card title="分布情况" sub="按归属对象与文件分类统计" icon="chart">
              <div class="field-label" style="margin-bottom:6px">按归属对象</div>
              <c-empty v-if="!ownerRows.length" title="还没有上传过附件" />
              <table v-else class="data-table" style="font-size:var(--fs-sm)">
                <thead><tr><th>归属</th><th style="text-align:right">数量</th><th style="text-align:right">占用</th></tr></thead>
                <tbody>
                  <tr v-for="r in ownerRows" :key="r.label">
                    <td>{{ r.label }}</td>
                    <td style="text-align:right">{{ r.n }}</td>
                    <td style="text-align:right">{{ r.size_text }}</td>
                  </tr>
                </tbody>
              </table>

              <div class="field-label" style="margin:16px 0 6px">按文件分类</div>
              <table v-if="usage.by_category.length" class="data-table" style="font-size:var(--fs-sm)">
                <thead><tr><th>分类</th><th style="text-align:right">数量</th><th style="text-align:right">占用</th></tr></thead>
                <tbody>
                  <tr v-for="r in usage.by_category" :key="r.category">
                    <td>{{ r.category }}</td>
                    <td style="text-align:right">{{ r.n }}</td>
                    <td style="text-align:right">{{ r.size_text }}</td>
                  </tr>
                </tbody>
              </table>
              <div v-else class="muted" style="font-size:var(--fs-sm)">暂无数据</div>

              <div v-if="orphanInfo" class="note warn mt-4">
                <c-icon name="alert" :size="16" />
                <div style="font-size:var(--fs-sm)">
                  检测到 <strong>{{ orphanInfo.files }}</strong> 个无主文件：{{ orphanInfo.note }}。
                  可点击左侧「清理无主文件」释放空间。
                </div>
              </div>
            </c-card>
          </div>
        </template>
      </div>`
  };

  CRM.settings = CRM.settings || {};
  CRM.settings.AttachmentStorePanel = AttachmentPanel;

})(window.CRM);
