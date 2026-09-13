/**
 * 附件面板组件
 * 拖拽上传 / 分类 / 图片与 PDF 预览 / 下载 / 删除 / 用量提示
 *
 * 上传走 base64 + JSON（后端零依赖），前端用 FileReader 读取。
 * 单文件超过上限时前端先拦一次，避免白传大文件。
 */
'use strict';

window.CRM = window.CRM || {};

(function (CRM) {

  const IMAGE_EXT = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp'];

  function extOf(name) {
    const i = String(name || '').lastIndexOf('.');
    return i >= 0 ? String(name).slice(i).toLowerCase() : '';
  }

  /** 文件类型图标（用已有图标集） */
  function iconOf(name, mime) {
    const ext = extOf(name);
    if (mime && mime.startsWith('image/')) return 'file';
    if (ext === '.pdf') return 'file';
    if (['.xls', '.xlsx', '.csv'].includes(ext)) return 'list';
    return 'file';
  }

  /** 读取文件为 base64（不含 data: 前缀） */
  function readAsBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const s = String(reader.result || '');
        const i = s.indexOf(',');
        resolve(i >= 0 ? s.slice(i + 1) : s);
      };
      reader.onerror = () => reject(new Error('读取文件失败'));
      reader.readAsDataURL(file);
    });
  }

  const AttachmentPanel = {
    name: 'AttachmentPanel',
    props: {
      ownerType: { type: String, required: true },   // customer | project
      ownerId: [Number, String],
      title: { type: String, default: '附件' },
      maxMb: { type: Number, default: 50 }
    },
    data() {
      return {
        data: { list: [], total: 0, total_size: 0, by_category: {}, categories: [] },
        loading: false,
        uploading: false,
        progress: '',
        dragOver: false,
        category: '其他',
        /* 预览 */
        previewOpen: false,
        previewItem: null,
        previewZoom: 1,
        editingId: null,
        editCategory: '',
        editRemark: ''
      };
    },
    computed: {
      categories() { return this.data.categories || ['合同', '报价单', '方案', '资质', '凭证', '图纸', '其他']; },
      totalText() { return CRM.util.fmtSize(this.data.total_size || 0); },
      hasAny() { return (this.data.list || []).length > 0; }
    },
    methods: {
      fmtDate: CRM.util.fmtDate,
      fmtSize: CRM.util.fmtSize,
      iconOf,

      async load() {
        if (!this.ownerId) return;
        this.loading = true;
        try {
          this.data = await CRM.api.get('/api/attachments?' +
            new URLSearchParams({ owner_type: this.ownerType, owner_id: String(this.ownerId) }).toString());
        } catch (e) {
          CRM.toast(e.message || '加载附件失败', 'error');
        } finally {
          this.loading = false;
        }
      },

      pick() { if (this.$refs.file) this.$refs.file.click(); },

      onPick(e) {
        const files = [...(e.target.files || [])];
        e.target.value = '';
        if (files.length) this.uploadFiles(files);
      },

      onDrop(e) {
        this.dragOver = false;
        const files = [...((e.dataTransfer && e.dataTransfer.files) || [])];
        if (files.length) this.uploadFiles(files);
      },

      async uploadFiles(files) {
        if (!this.ownerId) { CRM.toast('缺少归属记录', 'error'); return; }
        const limit = this.maxMb * 1024 * 1024;
        const tooBig = files.filter((f) => f.size > limit);
        if (tooBig.length) {
          CRM.toast(`${tooBig.map((f) => f.name).join('、')} 超过 ${this.maxMb} MB 上限`, 'error', 6000);
        }
        const ok = files.filter((f) => f.size <= limit);
        if (!ok.length) return;

        this.uploading = true;
        let done = 0;
        let failed = 0;
        try {
          for (const f of ok) {
            this.progress = `正在上传 ${done + failed + 1}/${ok.length}：${f.name}`;
            try {
              const content_base64 = await readAsBase64(f);
              await CRM.api.post('/api/attachments', {
                owner_type: this.ownerType,
                owner_id: Number(this.ownerId),
                file_name: f.name,
                mime_type: f.type || '',
                category: this.category,
                content_base64
              });
              done++;
            } catch (e) {
              failed++;
              CRM.toast(`${f.name} 上传失败：${e.message}`, 'error', 6000);
            }
          }
          if (done) {
            CRM.toast(`已上传 ${done} 个附件${failed ? `，${failed} 个失败` : ''}`, failed ? 'warn' : 'success');
            await this.load();
          }
        } finally {
          this.uploading = false;
          this.progress = '';
        }
      },

      /* ---------- 预览 ---------- */
      openPreview(item) {
        if (!item.previewable) {
          this.download(item);
          return;
        }
        this.previewItem = item;
        this.previewZoom = 1;
        this.previewOpen = true;
      },
      closePreview() {
        this.previewOpen = false;
        this.previewItem = null;
        this.previewZoom = 1;
      },
      zoom(delta) {
        this.previewZoom = Math.max(0.25, Math.min(4, Math.round((this.previewZoom + delta) * 100) / 100));
      },
      resetZoom() { this.previewZoom = 1; },

      /* ---------- 下载与删除 ---------- */
      download(item) {
        /* 用隐藏链接触发下载，避免预览页被替换 */
        const a = document.createElement('a');
        a.href = `/api/attachments/${item.id}/file`;
        a.download = item.file_name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
      },

      async remove(item) {
        const ok = await CRM.confirm({
          title: '删除附件',
          message: `确定删除 <strong>${item.file_name}</strong> 吗？<br>文件将从磁盘移除，此操作不可恢复（操作日志会保留记录）。`,
          danger: true
        });
        if (!ok) return;
        try {
          await CRM.api.del(`/api/attachments/${item.id}`);
          CRM.toast('附件已删除', 'success');
          if (this.previewItem && this.previewItem.id === item.id) this.closePreview();
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '删除失败', 'error');
        }
      },

      /* ---------- 编辑分类/备注 ---------- */
      startEdit(item) {
        this.editingId = item.id;
        this.editCategory = item.category;
        this.editRemark = item.remark || '';
      },
      async saveEdit(item) {
        try {
          await CRM.api.put(`/api/attachments/${item.id}/meta`, {
            category: this.editCategory,
            remark: this.editRemark
          });
          this.editingId = null;
          CRM.toast('已保存', 'success');
          await this.load();
        } catch (e) {
          CRM.toast(e.message || '保存失败', 'error');
        }
      },

      /* 预览时按 ESC 关闭 */
      onKey(e) {
        if (!this.previewOpen) return;
        if (e.key === 'Escape') this.closePreview();
        if (e.key === '+' || e.key === '=') this.zoom(0.25);
        if (e.key === '-') this.zoom(-0.25);
        if (e.key === '0') this.resetZoom();
      }
    },
    watch: {
      ownerId() { this.load(); }
    },
    mounted() {
      window.addEventListener('keydown', this.onKey);
      this.load();
    },
    beforeUnmount() {
      window.removeEventListener('keydown', this.onKey);
    },
    template: `
      <div>
        <!-- 预览层 -->
        <transition name="fade">
          <div v-if="previewOpen && previewItem" class="preview-mask" @click.self="closePreview">
            <div class="preview-box">
              <div class="preview-head">
                <c-icon name="file" :size="16" />
                <span class="pv-name">{{ previewItem.file_name }}</span>
                <span class="muted" style="font-size:var(--fs-xs)">{{ fmtSize(previewItem.file_size) }}</span>
                <div style="flex:1"></div>
                <button v-if="previewItem.is_image" class="btn btn-sm" @click="zoom(-0.25)">缩小</button>
                <button v-if="previewItem.is_image" class="btn btn-sm" @click="resetZoom">
                  {{ Math.round(previewZoom * 100) }}%
                </button>
                <button v-if="previewItem.is_image" class="btn btn-sm" @click="zoom(0.25)">放大</button>
                <button class="btn btn-sm" @click="download(previewItem)">下载</button>
                <button class="btn btn-sm" @click="closePreview">关闭</button>
              </div>
              <div class="preview-body">
                <img v-if="previewItem.is_image"
                     :src="'/api/attachments/' + previewItem.id + '/file'"
                     :style="{ transform: 'scale(' + previewZoom + ')' }"
                     :alt="previewItem.file_name" />
                <iframe v-else-if="previewItem.is_pdf"
                        :src="'/api/attachments/' + previewItem.id + '/file'"
                        title="PDF 预览"></iframe>
                <div v-else class="placeholder">
                  <p>该类型不支持在线预览，请下载后查看。</p>
                </div>
              </div>
            </div>
          </div>
        </transition>

        <!-- 头部 -->
        <div class="card-head">
          <div>
            <div class="card-title">{{ title }}</div>
            <div class="card-sub">
              共 {{ data.total }} 个文件，占用 {{ totalText }}
              <span class="muted">（单个文件上限 {{ maxMb }} MB）</span>
            </div>
          </div>
          <div class="spacer"></div>
          <select class="input input-sm" v-model="category" style="min-width:100px" title="上传到哪个分类">
            <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
          </select>
          <button class="btn btn-sm btn-primary" :disabled="uploading" @click="pick">
            <c-icon name="plus" :size="13" /> {{ uploading ? '上传中…' : '上传附件' }}
          </button>
        </div>

        <div class="card-body">
          <!-- 拖拽区 -->
          <div class="drop-zone" :class="{ over: dragOver }"
               style="padding:18px"
               @click="pick"
               @dragover.prevent="dragOver = true"
               @dragleave="dragOver = false"
               @drop.prevent="onDrop">
            <div style="font-size:var(--fs-sm)">
              {{ uploading ? progress : '把文件拖到这里，或点击选择（支持多选）' }}
            </div>
            <div class="muted" style="font-size:var(--fs-xs);margin-top:4px">
              支持 PDF / Word / Excel / 图片 / CAD(dwg·dxf) / 压缩包；
              图片与 PDF 可直接在线预览
            </div>
          </div>
          <input ref="file" type="file" multiple style="display:none" @change="onPick" />

          <!-- 列表 -->
          <div v-if="loading" class="muted mt-4">正在加载附件…</div>
          <c-empty v-else-if="!hasAny" icon="file" title="还没有附件"
                   desc="把合同扫描件、报价单、技术方案、资质证书拖进来，随时可查看。" />

          <div v-else class="mt-4">
            <div v-for="c in categories" :key="c">
              <template v-if="data.by_category[c] && data.by_category[c].length">
                <div class="att-group-title">{{ c }}（{{ data.by_category[c].length }}）</div>
                <div class="att-list">
                  <div v-for="it in data.by_category[c]" :key="it.id" class="att-item">
                    <div class="att-icon">
                      <c-icon :name="iconOf(it.file_name, it.mime_type)" :size="18" />
                    </div>
                    <div class="att-main" @click="openPreview(it)">
                      <div class="att-name">
                        {{ it.file_name }}
                        <span v-if="it.is_pdf" class="tag muted" style="font-size:10px">PDF</span>
                        <span v-else-if="it.is_image" class="tag muted" style="font-size:10px">图片</span>
                      </div>
                      <div class="att-meta muted">
                        {{ fmtSize(it.file_size) }} · {{ fmtDate(it.created_at, true) }}
                        <span v-if="it.remark"> · {{ it.remark }}</span>
                        <span v-if="it.previewable" style="color:var(--c-primary)"> · 点击预览</span>
                      </div>
                    </div>
                    <div class="att-ops">
                      <button class="btn btn-sm" @click="openPreview(it)">
                        {{ it.previewable ? '预览' : '下载' }}
                      </button>
                      <button class="btn btn-sm" @click="download(it)">下载</button>
                      <button class="btn btn-sm" @click="startEdit(it)">编辑</button>
                      <button class="btn btn-sm btn-danger" @click="remove(it)">删除</button>
                    </div>
                  </div>
                </div>
              </template>
            </div>
          </div>

          <!-- 编辑分类/备注 -->
          <div v-if="editingId" class="note mt-4">
            <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap;width:100%">
              <span style="font-size:var(--fs-sm)">编辑附件信息：</span>
              <select class="input input-sm" v-model="editCategory" style="min-width:110px">
                <option v-for="c in categories" :key="c" :value="c">{{ c }}</option>
              </select>
              <input class="input input-sm" v-model="editRemark" placeholder="备注（可选）"
                     style="flex:1 1 180px" />
              <button class="btn btn-sm btn-primary"
                      @click="saveEdit({ id: editingId })">保存</button>
              <button class="btn btn-sm" @click="editingId = null">取消</button>
            </div>
          </div>
        </div>
      </div>`
  };

  CRM.ui = CRM.ui || {};
  CRM.ui.AttachmentPanel = AttachmentPanel;

  CRM.registerAttachmentComponent = function (app) {
    app.component('c-attachments', AttachmentPanel);
  };

})(window.CRM);
