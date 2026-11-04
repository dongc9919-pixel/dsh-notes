/**
 * dsh-notes — Client 半边（浏览器）。
 *
 * 两处注册，同一个 id 'dsh-notes'（宿主靠这两个相等值把「点了哪一行」与
 * 「渲染哪个面板」对上）：
 *   · sidebar.panellist（list，id = 'dsh-notes'）—— 左侧导航栏那一个入口；
 *   · main（keyed，key = 'dsh-notes'）—— 点侧栏后右侧显示的面板。
 *
 * 数据全部经 Host 路由 `/dsh-notes/api` 读写；会话联动走 ctx.uiWorkspace。
 */

window.__ModuleLoader__.load({
  id: 'dsh-notes',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const React = require('react')
    const { useState, useEffect, useRef, useMemo, useSyncExternalStore, useCallback } = React
    const h = React.createElement

    const NS = 'dsh-notes'
    const API = '/dsh-notes/api'
    const STATUSES = ['backlog', 'doing', 'done', 'archived']

    // ───────────────────────── 字典 ─────────────────────────
    const zh = {
      'nav': '便签',
      'title': '便签',
      'subtitle': '记录需求、维护基本信息、按分类整理，并可与会话串起来。',
      'new': '新建便签',
      'search': '搜索标题、正文、标签',
      'all': '全部',
      'allCategories': '全部分类',
      'empty': '还没有便签。点「新建便签」记下第一个需求。',
      'emptyFiltered': '没有符合条件的便签。',
      'selectHint': '从左侧选择一条便签，或新建一条。',
      'refresh': '刷新',
      'save': '保存',
      'saving': '保存中…',
      'cancel': '取消',
      'delete': '删除',
      'deleteConfirm': '确定删除这条便签？此操作不可撤销。',
      'untitled': '未命名便签',
      'field.title': '标题',
      'field.titlePlaceholder': '一句话说清这个需求',
      'field.category': '分类',
      'field.categoryPlaceholder': '例如：产品需求 / 运维 / 学习',
      'field.status': '状态',
      'field.priority': '优先级',
      'field.tags': '标签',
      'field.tagsPlaceholder': '用逗号分隔，例如：紧急, 前端',
      'field.body': '正文 / 需求详情',
      'field.bodyPlaceholder': '把需求背景、目标、验收标准记下来…',
      'priority.none': '无',
      'status.backlog': '待办',
      'status.doing': '进行中',
      'status.done': '已完成',
      'status.archived': '已归档',
      'session.title': '关联会话',
      'session.none': '未关联任何会话',
      'session.link': '关联当前会话',
      'session.unlink': '解除关联',
      'session.open': '打开会话',
      'session.start': '基于此便签开始工作会话',
      'session.startHint': '新建一个会话，并把便签内容预填进输入框，方便直接做需求分析。',
      'session.noCurrent': '当前没有打开的会话，请先打开或新建一个会话后再关联。',
      'session.started': '已新建工作会话，便签内容已填入输入框。',
      'meta': '创建 {created} · 更新 {updated}',
      'error.load': '加载便签失败：{msg}',
      'error.save': '保存失败：{msg}',
      'error.delete': '删除失败：{msg}',
      'ocr.button': '从截图识别',
      'ocr.hint': '支持点选 / 粘贴(Ctrl+V) / 拖入截图，本机识别文字，再自动按语义归类成 1、2、3 条（不改写原文）填进新便签草稿，你确认再保存。原图不留存。',
      'ocr.busy': '识别中…',
      'ocr.formatting': '识别完成，正在按语义归类排版…',
      'ocr.done': '已识别并按语义归类排版，请核对文字后保存。',
      'ocr.doneRaw': '已识别（自动排版失败，已保留原文），请核对后保存。',
      'ocr.fail': '识别失败',
      'ocr.empty': '没识别到文字，换一张更清晰的截图试试。',
      'ocr.notImage': '请选择图片文件（PNG/JPG 等）。',
      'ocr.unsupported': '当前宿主不支持本机 OCR。',
      'format.button': '整理排版',
      'format.busy': '排版中…',
      'format.done': '已按语义归类排版（仅分类编号，未改写原文）。',
      'format.fail': '排版失败',
      'format.empty': '正文为空，先填入内容再整理。',
    }
    const en = {
      'nav': 'Notes',
      'title': 'Notes',
      'subtitle': 'Capture requirements, keep their basic info, organize by category, and link them to sessions.',
      'new': 'New note',
      'search': 'Search title, body, tags',
      'all': 'All',
      'allCategories': 'All categories',
      'empty': 'No notes yet. Click "New note" to capture your first requirement.',
      'emptyFiltered': 'No notes match the filter.',
      'selectHint': 'Pick a note on the left, or create a new one.',
      'refresh': 'Refresh',
      'save': 'Save',
      'saving': 'Saving…',
      'cancel': 'Cancel',
      'delete': 'Delete',
      'deleteConfirm': 'Delete this note? This cannot be undone.',
      'untitled': 'Untitled note',
      'field.title': 'Title',
      'field.titlePlaceholder': 'One line describing the requirement',
      'field.category': 'Category',
      'field.categoryPlaceholder': 'e.g. Product / Ops / Learning',
      'field.status': 'Status',
      'field.priority': 'Priority',
      'field.tags': 'Tags',
      'field.tagsPlaceholder': 'Comma separated, e.g. urgent, frontend',
      'field.body': 'Body / details',
      'field.bodyPlaceholder': 'Background, goal, acceptance criteria…',
      'priority.none': 'None',
      'status.backlog': 'Backlog',
      'status.doing': 'In progress',
      'status.done': 'Done',
      'status.archived': 'Archived',
      'session.title': 'Linked session',
      'session.none': 'Not linked to any session',
      'session.link': 'Link current session',
      'session.unlink': 'Unlink',
      'session.open': 'Open session',
      'session.start': 'Start a working session from this note',
      'session.startHint': 'Opens a new session with the note content pre-filled in the composer.',
      'session.noCurrent': 'No session is currently open. Open or create one first, then link.',
      'session.started': 'New working session created with the note pre-filled.',
      'meta': 'Created {created} · Updated {updated}',
      'error.load': 'Failed to load notes: {msg}',
      'error.save': 'Save failed: {msg}',
      'error.delete': 'Delete failed: {msg}',
      'ocr.button': 'Recognize from screenshot',
      'ocr.hint': 'Click / paste (Ctrl+V) / drop a screenshot. Text is recognized locally, then grouped into numbered items by meaning (no rewriting) in a new draft; review and save. The image is not kept.',
      'ocr.busy': 'Recognizing…',
      'ocr.formatting': 'Recognized. Grouping into numbered items…',
      'ocr.done': 'Recognized and grouped into numbered items. Review the text, then save.',
      'ocr.doneRaw': 'Recognized (auto-format failed; original text kept). Review, then save.',
      'ocr.fail': 'Recognition failed',
      'ocr.empty': 'No text found. Try a clearer screenshot.',
      'ocr.notImage': 'Please choose an image file (PNG/JPG…).',
      'ocr.unsupported': 'This host does not support local OCR.',
      'format.button': 'Tidy up',
      'format.busy': 'Formatting…',
      'format.done': 'Grouped into numbered items (wording preserved).',
      'format.fail': 'Formatting failed',
      'format.empty': 'Body is empty; add some text first.',
    }

    // ───────────────────────── HTTP ─────────────────────────
    async function api(path, body) {
      const init = body !== undefined
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }
        : { method: 'GET' }
      const res = await fetch(API + path, init)
      let data
      try { data = await res.json() } catch { data = { ok: false, error: '响应不是 JSON' } }
      return data
    }

    // ───────────────────────── 轻量快照 store ─────────────────────────
    function createNotesStore() {
      let state = { phase: 'idle', notes: [], error: null }
      const listeners = new Set()
      const emit = () => { for (const listener of listeners) { try { listener() } catch { /* ignore */ } } }
      const set = (patch) => { state = { ...state, ...patch }; emit() }
      return {
        subscribe: (listener) => { listeners.add(listener); return () => listeners.delete(listener) },
        getSnapshot: () => state,
        async refresh() {
          try {
            const res = await api('/notes')
            if (!res || res.ok !== true) throw new Error(res?.error || '加载失败')
            set({ notes: Array.isArray(res.result?.notes) ? res.result.notes : [], phase: 'ready', error: null })
          } catch (error) {
            set({ phase: 'error', error: String(error?.message ?? error) })
            throw error
          }
        },
      }
    }

    // ───────────────────────── CSS ─────────────────────────
    const CSS = `
.notes-page{display:flex;flex-direction:column;height:100%;min-height:0;color:var(--dsw-alias-label-primary);font-size:13px;position:relative}
.notes-head{display:flex;align-items:center;gap:10px;padding:14px 18px 12px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.notes-head h1{font-size:15px;font-weight:600;margin:0}
.notes-head .notes-sub{color:var(--dsw-alias-label-secondary);font-size:12px;margin-top:2px}
.notes-head .notes-spacer{flex:1}
.notes-btn{display:inline-flex;align-items:center;gap:6px;border:1px solid var(--dsw-alias-border-l2);background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border-radius:7px;padding:5px 11px;font-size:12.5px;cursor:pointer;line-height:1.2}
.notes-btn:hover{background:var(--dsw-alias-interactive-bg-hover)}
.notes-btn.primary{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:#fff}
.notes-btn.primary:hover{background:var(--dsw-alias-button-primary-hover)}
.notes-btn.danger{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l2)}
.notes-btn.danger:hover{background:var(--dsw-alias-interactive-bg-hover-danger)}
.notes-btn.sm{padding:3px 8px;font-size:12px;border-radius:6px}
.notes-btn:disabled{opacity:.55;cursor:default}
.notes-body{flex:1;display:flex;min-height:0}
.notes-list{width:300px;flex:none;display:flex;flex-direction:column;border-right:1px solid var(--dsw-alias-border-l1);min-height:0}
.notes-filters{padding:10px 12px;display:flex;flex-direction:column;gap:8px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.notes-input,.notes-select,.notes-textarea{width:100%;box-sizing:border-box;background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:7px;padding:6px 9px;font-size:12.5px;font-family:inherit;outline:none}
.notes-input:focus,.notes-select:focus,.notes-textarea:focus{border-color:var(--dsw-alias-brand-primary)}
.notes-textarea{resize:vertical;min-height:clamp(260px,44vh,560px);line-height:1.6}
.notes-row-filters{display:flex;gap:8px}
.notes-row-filters .notes-select{flex:1}
.notes-statusfilter{display:flex;gap:6px;flex-wrap:wrap}
.notes-chip{border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-secondary);border-radius:99px;padding:2px 10px;font-size:12px;cursor:pointer}
.notes-chip.on{background:var(--dsw-alias-brand-primary-soft);border-color:var(--dsw-alias-brand-primary);color:var(--dsw-alias-label-primary)}
.notes-items{flex:1;overflow-y:auto;min-height:0}
.notes-item{padding:10px 13px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer;display:flex;flex-direction:column;gap:4px}
.notes-item:hover{background:var(--dsw-alias-interactive-bg-hover)}
.notes-item.on{background:var(--dsw-alias-interactive-bg-active);border-left:3px solid var(--dsw-alias-brand-primary);padding-left:10px}
.notes-item .notes-ititle{font-weight:600;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.notes-item .notes-iexcerpt{color:var(--dsw-alias-label-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.notes-item .notes-imeta{display:flex;gap:6px;flex-wrap:wrap;align-items:center;font-size:11px;color:var(--dsw-alias-label-tertiary)}
.notes-badge{font-size:11px;padding:1px 7px;border-radius:99px;border:1px solid var(--dsw-alias-border-l2);color:var(--dsw-alias-label-secondary)}
.notes-badge.s-doing{border-color:var(--dsw-alias-state-business-primary);color:var(--dsw-alias-state-business-primary)}
.notes-badge.s-done{border-color:var(--dsw-alias-state-success-primary);color:var(--dsw-alias-state-success-primary)}
.notes-badge.s-archived{opacity:.7}
.notes-badge.p{background:var(--dsw-alias-bg-layer-2)}
.notes-empty{padding:26px 18px;text-align:center;color:var(--dsw-alias-label-tertiary);font-size:12.5px;line-height:1.6}
.notes-editor{flex:1;min-width:0;display:flex;flex-direction:column;min-height:0;overflow-y:auto}
.notes-editor-inner{padding:16px 20px 28px;display:flex;flex-direction:column;gap:12px;max-width:820px}
.notes-field{display:flex;flex-direction:column;gap:5px}
.notes-label{font-size:12px;color:var(--dsw-alias-label-secondary);font-weight:500}
.notes-grid2{display:flex;gap:12px}
.notes-grid2>.notes-field{flex:1}
.notes-editor-actions{display:flex;gap:8px;align-items:center;padding-top:4px;flex-wrap:wrap}
.notes-editor-actions .notes-spacer{flex:1}
.notes-msg{font-size:12px;color:var(--dsw-alias-state-error-primary);min-height:16px}
.notes-msg.ok{color:var(--dsw-alias-state-success-primary)}
.notes-ocr-bar{display:flex;align-items:center;gap:10px;flex-wrap:wrap;padding:10px 20px;border-bottom:1px dashed var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-2)}
.notes-ocr-bar .notes-ocr-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.45;flex:1;min-width:180px}
.notes-editor.dragover{outline:2px dashed var(--dsw-alias-brand-primary);outline-offset:-8px}
.notes-body-actions{display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:2px}
.notes-overlay{position:absolute;inset:0;background:rgba(0,0,0,.32);display:flex;align-items:center;justify-content:center;z-index:50;padding:24px}
.notes-modal{background:var(--dsw-alias-bg-layer-1);border:1px solid var(--dsw-alias-border-l2);border-radius:12px;width:min(760px,100%);max-height:min(86vh,760px);display:flex;flex-direction:column;box-shadow:0 12px 40px rgba(0,0,0,.28);overflow:hidden}
.ni-head{display:flex;align-items:flex-start;gap:12px;padding:14px 18px;border-bottom:1px solid var(--dsw-alias-border-l1)}
.ni-head .ni-title{font-size:14.5px;font-weight:600}
.ni-head .ni-sub{font-size:12px;color:var(--dsw-alias-label-secondary);margin-top:2px}
.ni-head .notes-spacer{flex:1}
.ni-head .notes-btn{margin-left:auto}
.ni-body{padding:14px 18px 18px;display:flex;flex-direction:column;gap:12px;overflow-y:auto;min-height:0}
.ni-hint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.ni-actions{display:flex;gap:8px;align-items:center;padding-top:4px;position:sticky;bottom:0;background:var(--dsw-alias-bg-layer-1)}
.ni-actions .notes-spacer{flex:1}
.ni-tables,.ni-sources,.ni-cols{display:flex;gap:8px;flex-wrap:wrap}
.ni-source{display:flex;align-items:center;gap:8px;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:5px 8px}
.ni-cols{align-items:flex-start}
.ni-cols>.notes-field{flex:1;min-width:130px}
.ni-records-head{display:flex;align-items:center;gap:10px;font-size:12px;color:var(--dsw-alias-label-secondary)}
.ni-records{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;max-height:300px;overflow-y:auto}
.ni-row{display:flex;align-items:center;gap:9px;padding:7px 11px;border-bottom:1px solid var(--dsw-alias-border-l1);cursor:pointer;font-size:12.5px}
.ni-row:last-child{border-bottom:none}
.ni-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.ni-row.on{background:var(--dsw-alias-interactive-bg-active)}
.ni-rowtitle{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ni-provider{display:flex;gap:8px;flex-wrap:wrap;padding-bottom:4px;border-bottom:1px dashed var(--dsw-alias-border-l1)}
.ni-wecom{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:11px 13px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:10px}
.ni-row{cursor:pointer}
.ni-row.current{box-shadow:inset 2px 0 0 var(--dsw-alias-brand-primary)}
.ni-rowmeta{display:flex;gap:6px;margin-left:auto;flex:none}
.ni-preview{border:1px solid var(--dsw-alias-border-l2);border-radius:9px;background:var(--dsw-alias-bg-layer-2);padding:11px 13px;display:flex;flex-direction:column;gap:6px}
.ni-preview-head{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
.ni-preview-title{font-size:13.5px;font-weight:600}
.ni-preview-meta{display:flex;gap:6px;flex-wrap:wrap}
.ni-preview-body{font-size:12.5px;color:var(--dsw-alias-label-secondary);white-space:pre-wrap;line-height:1.55;max-height:120px;overflow:auto}
.ni-mapbox{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:9px 12px}
.ni-mapbox>summary{cursor:pointer;font-size:12.5px;color:var(--dsw-alias-label-secondary);user-select:none}
.ni-mapbox[open]>summary{margin-bottom:10px}
.ni-mapfield{display:flex;flex-direction:column;gap:5px;flex:1;min-width:130px}
.ni-maphint{font-size:11px;color:var(--dsw-alias-label-tertiary);line-height:1.4}
.notes-session{border:1px solid var(--dsw-alias-border-l1);border-radius:9px;padding:11px 13px;background:var(--dsw-alias-bg-layer-2);display:flex;flex-direction:column;gap:8px}
.notes-session .notes-stitle{font-size:12.5px;font-weight:600}
.notes-session .notes-sid{font-family:ui-monospace,monospace;font-size:11.5px;color:var(--dsw-alias-label-secondary);word-break:break-all}
.notes-session .notes-sactions{display:flex;gap:8px;flex-wrap:wrap}
.notes-session .notes-shint{font-size:11.5px;color:var(--dsw-alias-label-tertiary);line-height:1.5}
.notes-meta{font-size:11.5px;color:var(--dsw-alias-label-tertiary)}
`

    // ───────────────────────── 图标 ─────────────────────────
    function NotesIcon(owner) {
      const size = typeof owner?.size === 'number' && owner.size > 0 ? owner.size : 16
      return h('svg', {
        width: size, height: size, viewBox: '0 0 16 16', fill: 'none',
        stroke: 'currentColor', strokeWidth: '1.3', strokeLinecap: 'round',
        strokeLinejoin: 'round', 'aria-hidden': 'true', focusable: 'false',
      },
        h('path', { d: 'M3 2.2h10a1 1 0 0 1 1 1v6.6L10.9 13.8H3a1 1 0 0 1-1-1V3.2a1 1 0 0 1 1-1Z' }),
        h('path', { d: 'M10.9 13.8V9.8h4' }),
        h('path', { d: 'M4.6 5.3h6.8M4.6 7.7h6.8M4.6 10.1h3.4' }),
      )
    }

    // ───────────────────────── 面板 ─────────────────────────
    function fmtTime(ms) {
      if (!ms) return '—'
      try {
        const d = new Date(ms)
        const p = (n) => String(n).padStart(2, '0')
        return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
      } catch { return '—' }
    }
    const blankDraft = () => ({ id: null, title: '', body: '', category: '', tags: [], status: 'backlog', priority: null, sessionId: null })
    const fromNote = (note) => ({
      id: note.id,
      title: note.title || '',
      body: note.body || '',
      category: note.category || '',
      tags: Array.isArray(note.tags) ? note.tags.slice() : [],
      status: note.status || 'backlog',
      priority: typeof note.priority === 'number' ? note.priority : null,
      sessionId: note.sessionId || null,
      createdAt: note.createdAt,
      updatedAt: note.updatedAt,
    })

    function NotesPanelView(props) {
      const t = typeof props.tr === 'function' ? props.tr : (typeof props.t === 'function' ? props.t : (k) => k)
      const store = props.store
      const session = props.session
      const snapshot = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot)

      const [selectedId, setSelectedId] = useState(null)
      const [draft, setDraft] = useState(blankDraft)
      const [dirty, setDirty] = useState(false)
      const [busy, setBusy] = useState(false)
      const [message, setMessage] = useState(null) // { kind:'ok'|'err', text }
      const [query, setQuery] = useState('')
      const [statusFilter, setStatusFilter] = useState('all')
      const [categoryFilter, setCategoryFilter] = useState('all')
      const [ocrBusy, setOcrBusy] = useState(false)
      const [formatBusy, setFormatBusy] = useState(false)
      const [dragOver, setDragOver] = useState(false)
      const fileInputRef = useRef(null)

      // 飞书表格导入弹窗状态
      const blankImp = () => ({ open: false, step: 'source', provider: 'feishu', appTokenInput: '', tables: [], tablesError: '', tableId: '', fieldNames: [], rows: [], mapping: {}, mappingOpen: false, previewId: '', selected: [], sources: [], error: '', busy: false, wecom: { corpid: '', secretInput: '', configured: false } })
      const [imp, setImp] = useState(blankImp)
      const [importBusy, setImportBusy] = useState(false)

      const notes = snapshot.notes || []

      useEffect(() => {
        let alive = true
        store.refresh().catch((error) => {
          if (alive) setMessage({ kind: 'err', text: t('error.load').replace('{msg}', String(error?.message ?? error)) })
        })
        return () => { alive = false }
      }, [])

      const categories = useMemo(() => {
        const set = new Set()
        for (const note of notes) if (note.category) set.add(note.category)
        return [...set].sort()
      }, [notes])

      const filtered = useMemo(() => {
        const q = query.trim().toLowerCase()
        return notes.filter((note) => {
          if (statusFilter !== 'all' && note.status !== statusFilter) return false
          if (categoryFilter !== 'all' && (note.category || '') !== categoryFilter) return false
          if (q) {
            const hay = [note.title, note.body, note.category, ...(note.tags || [])].join('\n').toLowerCase()
            if (!hay.includes(q)) return false
          }
          return true
        })
      }, [notes, query, statusFilter, categoryFilter])

      const patchDraft = (patch) => { setDraft((prev) => ({ ...prev, ...patch })); setDirty(true) }

      const selectNote = (note) => {
        if (dirty && draft.id !== note.id) {
          // 放弃当前未保存改动（保持轻量：切换即丢弃未保存草稿）
        }
        setSelectedId(note.id)
        setDraft(fromNote(note))
        setDirty(false)
        setMessage(null)
      }

      const startNew = () => {
        setSelectedId(null)
        setDraft(blankDraft())
        setDirty(true)
        setMessage(null)
      }

      // ── 截图识别（本机 OCR）：选图 / 粘贴 / 拖入 → 填进草稿，你确认再存 ──
      const readAsDataUrl = (file) => new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => resolve(String(reader.result || ''))
        reader.onerror = () => reject(reader.error || new Error('读取图片失败'))
        reader.readAsDataURL(file)
      })

      const deriveTitle = (lines, raw) => {
        const list = (lines || []).map((x) => String(x).trim()).filter(Boolean)
        const isMeta = (l) => /^(企业微信|微信|钉钉|飞书|客户群|.*群\b|今天|昨天|上午|下午|刚刚|\d{1,2}[:：]\d{2})/.test(l) && l.length <= 24
        for (const l of list) {
          if (isMeta(l)) continue
          return l.length > 42 ? l.slice(0, 42) + '…' : l
        }
        return (raw || '').slice(0, 42) || t('untitled')
      }

      const recognizeImage = async (file) => {
        if (!file) return
        if (!/^image\//.test(file.type || '')) { setMessage({ kind: 'err', text: t('ocr.notImage') }); return }
        setOcrBusy(true)
        setMessage(null)
        try {
          const dataUrl = await readAsDataUrl(file)
          const res = await api('/ocr', { image: dataUrl })
          if (!res.ok) throw new Error(res.error || t('ocr.fail'))
          const lines = Array.isArray(res.result?.lines) ? res.result.lines : []
          const rawText = String(res.result?.text || '')
          if (!rawText.trim()) { setMessage({ kind: 'err', text: t('ocr.empty') }); return }
          // 识别后紧接着「按语义归类 + 编号排版」；失败就保留原文。
          let body = rawText
          let formatted = false
          try {
            setMessage({ kind: 'ok', text: t('ocr.formatting') })
            const fr = await api('/format', { text: rawText })
            if (fr && fr.ok && fr.result && typeof fr.result.text === 'string' && fr.result.text.trim()) {
              body = fr.result.text
              formatted = true
            }
          } catch { /* 排版失败不影响识别结果 */ }
          setSelectedId(null)
          setDraft({ ...blankDraft(), title: deriveTitle(lines, body), body, status: 'backlog' })
          setDirty(true)
          setMessage({ kind: 'ok', text: formatted ? t('ocr.done') : t('ocr.doneRaw') })
        } catch (error) {
          setMessage({ kind: 'err', text: t('ocr.fail') + '：' + String(error?.message ?? error) })
        } finally {
          setOcrBusy(false)
        }
      }

      const onPickFile = (event) => {
        const file = event?.target?.files?.[0]
        if (event?.target) event.target.value = ''
        void recognizeImage(file)
      }

      const onPaste = (event) => {
        const items = event?.clipboardData?.items
        if (!items) return
        for (const item of items) {
          if (item && item.type && item.type.startsWith('image/')) {
            const file = item.getAsFile()
            if (file) { event.preventDefault(); void recognizeImage(file); return }
          }
        }
      }

      const onDrop = (event) => {
        const file = event?.dataTransfer?.files?.[0]
        if (file) { event.preventDefault(); void recognizeImage(file) }
      }

      const onDragOver = (event) => { if (event) event.preventDefault() }

      const extractAppToken = (input) => {
        const s = String(input || '').trim()
        const m = s.match(/\/(?:base|bitable)\/([A-Za-z0-9]+)/)
        if (m) return m[1]
        const m2 = s.match(/[?&]app_token=([A-Za-z0-9]+)/)
        if (m2) return m2[1]
        return s
      }
      const extractDocId = (input) => {
        const s = String(input || '').trim()
        if (!s) return ''
        const q = s.match(/[?&]docid=([A-Za-z0-9_\-%.]+)/i)
        if (q) return decodeURIComponent(q[1])
        const p = s.match(/\/(?:smartsheet|doc|sheet)\/([A-Za-z0-9_\-%.]+)/i)
        if (p) return decodeURIComponent(p[1])
        return s
      }
      const autoMap = (fieldNames) => {
        const pick = (kws) => fieldNames.find((n) => kws.some((k) => String(n).toLowerCase().includes(k))) || ''
        const title = pick(['标题', '名称', '主题', 'title', 'name'])
        const body = pick(['描述', '详情', '说明', '内容', '需求', 'body', 'desc'])
        return {
          // 标题列不要和正文列撞车：没找到明确的标题列时，退回第一个列
          title: title || fieldNames.find((n) => n !== body) || fieldNames[0] || '',
          body,
          category: pick(['分类', '类型', '模块', '类别', 'category', 'type']),
          priority: pick(['优先', '紧急', '级别', 'priority']),
          tags: pick(['标签', 'tag', '标记']),
        }
      }
      const set = (patch) => setImp((prev) => ({ ...prev, ...patch }))
      const loadSources = async () => {
        try { const r = await api('/sources'); if (r.ok) set({ sources: r.result.sources || [] }) } catch { /* ignore */ }
      }
      const openImport = () => {
        setImp({ ...blankImp(), open: true })
        void loadSources()
        api('/wecom/credentials').then((r) => { if (r.ok && r.result) set({ wecom: { corpid: r.result.corpid || '', configured: Boolean(r.result.configured), secretInput: '' } }) }).catch(() => {})
      }
      const closeImport = () => setImp(blankImp())
      const saveWecomCred = async () => {
        set({ busy: true, error: '' })
        try {
          const r = await api('/wecom/credentials', { corpid: imp.wecom?.corpid || '', secret: imp.wecom?.secretInput || '' })
          if (!r.ok) throw new Error(r.error || '保存失败')
          set({ busy: false, wecom: { ...imp.wecom, configured: Boolean(r.result.configured), secretInput: '' } })
          setMessage({ kind: 'ok', text: '企业微信凭证已保存到本机。' })
        } catch (e) { set({ busy: false, error: String(e.message || e) }) }
      }
      const doLoadTables = async () => {
        set({ busy: true, error: '', tablesError: '' })
        try {
          if (imp.provider === 'wecom') {
            const docid = extractDocId(imp.appTokenInput)
            const r = await api('/wecom/sheets', { docid })
            if (!r.ok) throw new Error(r.error || '读取失败')
            const tables = (r.result.sheets || []).map((s) => ({ tableId: s.sheetId, name: s.title }))
            // 只有一个子表时直接选中，省一次点击
            set({ busy: false, step: 'table', appToken: docid, tables, tableId: tables.length === 1 ? tables[0].tableId : '', tablesError: r.result.sheetsError || '' })
          } else {
            const r = await api('/feishu/tables', { appToken: imp.appTokenInput })
            if (!r.ok) throw new Error(r.error || '读取失败')
            // 服务端可能把 wiki 链接解析成了真正的 app_token，这里记住真实值
            const appToken = r.result.appToken || extractAppToken(imp.appTokenInput)
            const tables = r.result.tables || []
            set({ busy: false, step: 'table', appToken, tables, tableId: tables.length === 1 ? tables[0].tableId : '', tablesError: r.result.tablesError || '' })
          }
        } catch (e) { set({ busy: false, error: String(e.message || e) }) }
      }
      const doLoadPreview = async () => {
        set({ busy: true, error: '' })
        try {
          let r
          if (imp.provider === 'wecom') r = await api('/wecom/preview', { docid: imp.appToken, sheetId: imp.tableId })
          else r = await api('/feishu/preview', { appToken: imp.appToken, tableId: imp.tableId })
          if (!r.ok) throw new Error(r.error || '读取失败')
          const fieldNames = r.result.fieldNames || []
          const rows = r.result.rows || []
          const mapping = autoMap(fieldNames)
          // 默认只勾「标题非空」的行，避免把空行导成「无标题」便签
          const usable = rows.filter((x) => String(x.cells?.[mapping.title] || '').trim() !== '')
          set({
            busy: false, step: 'records', fieldNames, rows, mapping, mappingOpen: false,
            previewId: (usable[0] || rows[0])?.recordId || '',
            selected: usable.map((x) => x.recordId),
          })
        } catch (e) { set({ busy: false, error: String(e.message || e) }) }
      }
      const doImport = async () => {
        setImportBusy(true); set({ error: '' })
        try {
          let r
          if (imp.provider === 'wecom') r = await api('/wecom/import', { docid: imp.appToken, sheetId: imp.tableId, recordIds: imp.selected, mapping: imp.mapping, defaults: { status: 'backlog' } })
          else r = await api('/feishu/import', { appToken: imp.appToken, tableId: imp.tableId, recordIds: imp.selected, mapping: imp.mapping, defaults: { status: 'backlog' } })
          if (!r.ok) throw new Error(r.error || '导入失败')
          await store.refresh()
          const from = imp.provider === 'wecom' ? '企业微信' : '飞书'
          setImp(blankImp())
          setMessage({ kind: 'ok', text: '已从' + from + '导入 ' + (r.result.count || 0) + ' 条便签，去左侧列表查看。' })
        } catch (e) { set({ error: String(e.message || e) }) } finally { setImportBusy(false) }
      }
      const doRemoveSource = async (id) => {
        try { await api('/sources/delete', { id }); await loadSources() } catch { /* ignore */ }
      }
      // 弹窗内既改状态又触发动作：先合并状态，再解引用动作标志
      const applyPatch = (p) => {
        if (p.removeId !== undefined) { void doRemoveSource(p.removeId) }
        setImp((prev) => ({ ...prev, ...p }))
        if (p.loadTables) void doLoadTables()
        if (p.loadPreview) void doLoadPreview()
        if (p.saveWecom) void saveWecomCred()
      }

      // 「整理排版」：把正文按语义归类成编号列表（不改写原文）。
      const formatBody = async () => {
        const src = String(draft.body || '').trim()
        if (!src) { setMessage({ kind: 'err', text: t('format.empty') }); return }
        setFormatBusy(true)
        setMessage(null)
        try {
          const res = await api('/format', { text: src })
          if (!res.ok) throw new Error(res.error || t('format.fail'))
          const out = String(res.result?.text || '')
          if (out.trim()) { patchDraft({ body: out }); setMessage({ kind: 'ok', text: t('format.done') }) }
          else setMessage({ kind: 'err', text: t('format.empty') })
        } catch (error) {
          setMessage({ kind: 'err', text: t('format.fail') + '：' + String(error?.message ?? error) })
        } finally { setFormatBusy(false) }
      }

      const doSave = async () => {
        if (!draft.title.trim()) { setMessage({ kind: 'err', text: t('field.title') + ' — ' + t('untitled') }); return }
        setBusy(true)
        try {
          const payload = {
            title: draft.title,
            body: draft.body,
            category: draft.category,
            tags: draft.tags,
            status: draft.status,
            priority: draft.priority,
          }
          if (draft.id) payload.id = draft.id
          const res = await api('/notes', payload)
          if (!res.ok) throw new Error(res.error || '保存失败')
          await store.refresh()
          const note = res.result?.note
          if (note) { setSelectedId(note.id); setDraft(fromNote(note)) }
          setDirty(false)
          setMessage({ kind: 'ok', text: t('save') + ' ✓' })
        } catch (error) {
          setMessage({ kind: 'err', text: t('error.save').replace('{msg}', String(error?.message ?? error)) })
        } finally { setBusy(false) }
      }

      const doDelete = async () => {
        if (!draft.id) return
        if (typeof window !== 'undefined' && typeof window.confirm === 'function' && !window.confirm(t('deleteConfirm'))) return
        setBusy(true)
        try {
          const res = await api('/delete', { id: draft.id })
          if (!res.ok) throw new Error(res.error || '删除失败')
          await store.refresh()
          setSelectedId(null); setDraft(blankDraft()); setDirty(false)
          setMessage({ kind: 'ok', text: t('delete') + ' ✓' })
        } catch (error) {
          setMessage({ kind: 'err', text: t('error.delete').replace('{msg}', String(error?.message ?? error)) })
        } finally { setBusy(false) }
      }

      const quickStatus = async (status) => {
        if (!draft.id) { patchDraft({ status }); return }
        setBusy(true)
        try {
          const res = await api('/notes', { id: draft.id, status })
          if (!res.ok) throw new Error(res.error || '保存失败')
          await store.refresh()
          if (res.result?.note) setDraft(fromNote(res.result.note))
          setMessage({ kind: 'ok', text: t('save') + ' ✓' })
        } catch (error) {
          setMessage({ kind: 'err', text: t('error.save').replace('{msg}', String(error?.message ?? error)) })
        } finally { setBusy(false) }
      }

      const linkCurrent = async () => {
        if (!draft.id) { setMessage({ kind: 'err', text: t('selectHint') }); return }
        const current = session?.current?.()
        if (!current) { setMessage({ kind: 'err', text: t('session.noCurrent') }); return }
        setBusy(true)
        try {
          const res = await api('/link', { id: draft.id, sessionId: current })
          if (!res.ok) throw new Error(res.error || '失败')
          await store.refresh()
          if (res.result?.note) setDraft(fromNote(res.result.note))
          setMessage({ kind: 'ok', text: t('session.link') + ' ✓' })
        } catch (error) {
          setMessage({ kind: 'err', text: String(error?.message ?? error) })
        } finally { setBusy(false) }
      }

      const unlink = async () => {
        if (!draft.id) return
        setBusy(true)
        try {
          const res = await api('/link', { id: draft.id, sessionId: '' })
          if (!res.ok) throw new Error(res.error || '失败')
          await store.refresh()
          if (res.result?.note) setDraft(fromNote(res.result.note))
          setMessage({ kind: 'ok', text: t('session.unlink') + ' ✓' })
        } catch (error) {
          setMessage({ kind: 'err', text: String(error?.message ?? error) })
        } finally { setBusy(false) }
      }

      const openLinked = () => { if (draft.sessionId) session?.open?.(draft.sessionId) }

      const startWork = async () => {
        const text = composePrompt(t, draft)
        const ok = session?.seedNewSession?.(text)
        if (!ok) { setMessage({ kind: 'err', text: t('session.noCurrent') }); return }
        setMessage({ kind: 'ok', text: t('session.started') })
        if (draft.id) {
          try {
            const res = await api('/notes', { id: draft.id, status: 'doing' })
            if (res.ok && res.result?.note) { await store.refresh(); setDraft(fromNote(res.result.note)) }
          } catch { /* 状态更新失败不影响已发起会话 */ }
        }
      }

      const draftTagsText = (draft.tags || []).join(', ')

      // 左侧列表
      const listNode = h('div', { className: 'notes-list' },
        h('div', { className: 'notes-filters' },
          h('input', {
            className: 'notes-input', placeholder: t('search'), value: query,
            onChange: (e) => setQuery(e.target.value),
          }),
          h('div', { className: 'notes-row-filters' },
            h('select', {
              className: 'notes-select', value: categoryFilter,
              onChange: (e) => setCategoryFilter(e.target.value),
            },
              h('option', { value: 'all' }, t('allCategories')),
              categories.map((c) => h('option', { key: c, value: c }, c)),
            ),
          ),
          h('div', { className: 'notes-statusfilter' },
            [{ k: 'all', label: t('all') }, ...STATUSES.map((s) => ({ k: s, label: t('status.' + s) }))].map((item) =>
              h('button', {
                key: item.k,
                className: 'notes-chip' + (statusFilter === item.k ? ' on' : ''),
                onClick: () => setStatusFilter(item.k),
              }, item.label),
            ),
          ),
        ),
        h('div', { className: 'notes-items' },
          filtered.length === 0
            ? h('div', { className: 'notes-empty' }, notes.length === 0 ? t('empty') : t('emptyFiltered'))
            : filtered.map((note) => h('div', {
                key: note.id,
                className: 'notes-item' + (note.id === selectedId ? ' on' : ''),
                onClick: () => selectNote(note),
              },
                h('div', { className: 'notes-ititle' }, note.title || t('untitled')),
                note.body ? h('div', { className: 'notes-iexcerpt' }, String(note.body).replace(/\s+/g, ' ').slice(0, 90)) : null,
                h('div', { className: 'notes-imeta' },
                  note.category ? h('span', { className: 'notes-badge' }, note.category) : null,
                  h('span', { className: 'notes-badge s-' + (note.status || 'backlog') }, t('status.' + (note.status || 'backlog'))),
                  note.priority ? h('span', { className: 'notes-badge p' }, 'P' + note.priority) : null,
                  note.sessionId ? h('span', { className: 'notes-badge' }, '⚓') : null,
                ),
              )),
        ),
      )

      // 右侧编辑器
      const showEditor = selectedId !== null || dirty

      const ocrBar = h('div', { className: 'notes-ocr-bar' },
        h('button', {
          className: 'notes-btn', disabled: ocrBusy,
          onClick: () => fileInputRef.current && fileInputRef.current.click(),
        }, ocrBusy ? t('ocr.busy') : t('ocr.button')),
        h('input', {
          ref: fileInputRef, type: 'file', accept: 'image/*',
          style: { display: 'none' }, onChange: onPickFile,
        }),
        h('span', { className: 'notes-ocr-hint' }, t('ocr.hint')),
      )

      const editorNode = h('div', {
        className: 'notes-editor' + (dragOver ? ' dragover' : ''),
        onPaste,
        onDrop: (e) => { setDragOver(false); onDrop(e) },
        onDragOver: (e) => { onDragOver(e); setDragOver(true) },
        onDragLeave: () => setDragOver(false),
      },
        ocrBar,
        !showEditor
          ? h('div', { className: 'notes-empty' }, t('selectHint'))
          : h('div', { className: 'notes-editor-inner' },
              h('div', { className: 'notes-field' },
                h('label', { className: 'notes-label' }, t('field.title')),
                h('input', {
                  className: 'notes-input', value: draft.title, placeholder: t('field.titlePlaceholder'),
                  onChange: (e) => patchDraft({ title: e.target.value }),
                }),
              ),
              h('div', { className: 'notes-grid2' },
                h('div', { className: 'notes-field' },
                  h('label', { className: 'notes-label' }, t('field.category')),
                  h('input', {
                    className: 'notes-input', value: draft.category, placeholder: t('field.categoryPlaceholder'),
                    onChange: (e) => patchDraft({ category: e.target.value }),
                  }),
                ),
                h('div', { className: 'notes-field' },
                  h('label', { className: 'notes-label' }, t('field.priority')),
                  h('select', {
                    className: 'notes-select', value: draft.priority == null ? '' : String(draft.priority),
                    onChange: (e) => patchDraft({ priority: e.target.value === '' ? null : Number(e.target.value) }),
                  },
                    h('option', { value: '' }, t('priority.none')),
                    [1, 2, 3, 4, 5].map((p) => h('option', { key: p, value: String(p) }, 'P' + p)),
                  ),
                ),
              ),
              h('div', { className: 'notes-field' },
                h('label', { className: 'notes-label' }, t('field.tags')),
                h('input', {
                  className: 'notes-input', value: draftTagsText, placeholder: t('field.tagsPlaceholder'),
                  onChange: (e) => patchDraft({ tags: e.target.value.split(/[,，]/).map((s) => s.trim()).filter(Boolean) }),
                }),
              ),
              h('div', { className: 'notes-field' },
                h('label', { className: 'notes-label' }, t('field.status')),
                h('div', { className: 'notes-statusfilter' },
                  STATUSES.map((s) => h('button', {
                    key: s, className: 'notes-chip' + (draft.status === s ? ' on' : ''),
                    onClick: () => quickStatus(s),
                  }, t('status.' + s))),
                ),
              ),
              h('div', { className: 'notes-field' },
                h('label', { className: 'notes-label' }, t('field.body')),
                h('textarea', {
                  className: 'notes-textarea', value: draft.body, placeholder: t('field.bodyPlaceholder'),
                  onChange: (e) => patchDraft({ body: e.target.value }),
                }),
                h('div', { className: 'notes-body-actions' },
                  h('button', { className: 'notes-btn sm', onClick: formatBody, disabled: formatBusy || !String(draft.body || '').trim() },
                    formatBusy ? t('format.busy') : t('format.button')),
                ),
              ),
              // 会话联动
              h('div', { className: 'notes-session' },
                h('div', { className: 'notes-stitle' }, t('session.title')),
                draft.sessionId
                  ? h('div', { className: 'notes-sid' }, draft.sessionId)
                  : h('div', { className: 'notes-meta' }, t('session.none')),
                h('div', { className: 'notes-sactions' },
                  h('button', { className: 'notes-btn sm', onClick: linkCurrent, disabled: busy }, t('session.link')),
                  draft.sessionId ? h('button', { className: 'notes-btn sm', onClick: openLinked }, t('session.open')) : null,
                  draft.sessionId ? h('button', { className: 'notes-btn sm', onClick: unlink, disabled: busy }, t('session.unlink')) : null,
                ),
                h('div', { className: 'notes-shint' },
                  t('session.startHint'),
                  h('div', { style: { marginTop: '8px' } },
                    h('button', { className: 'notes-btn', onClick: startWork, disabled: busy }, t('session.start')),
                  ),
                ),
              ),
              message ? h('div', { className: 'notes-msg' + (message.kind === 'ok' ? ' ok' : '') }, message.text) : h('div', { className: 'notes-msg' }),
              h('div', { className: 'notes-editor-actions' },
                h('button', { className: 'notes-btn primary', onClick: doSave, disabled: busy }, busy ? t('saving') : t('save')),
                h('button', { className: 'notes-btn', onClick: () => { if (draft.id) { const n = notes.find((x) => x.id === draft.id); if (n) selectNote(n) } else { startNew() } }, disabled: busy }, t('cancel')),
                h('div', { className: 'notes-spacer' }),
                draft.id ? h('button', { className: 'notes-btn danger', onClick: doDelete, disabled: busy }, t('delete')) : null,
              ),
              draft.id && draft.createdAt
                ? h('div', { className: 'notes-meta' }, t('meta').replace('{created}', fmtTime(draft.createdAt)).replace('{updated}', fmtTime(draft.updatedAt)))
                : null,
            ),
      )

      return h('div', { className: 'notes-page' },
        h('div', { className: 'notes-head' },
          h('div', null,
            h('h1', null, t('title')),
            h('div', { className: 'notes-sub' }, t('subtitle')),
          ),
          h('div', { className: 'notes-spacer' }),
          h('button', { className: 'notes-btn', onClick: openImport, disabled: busy }, '从表格导入'),
          h('button', { className: 'notes-btn', onClick: () => store.refresh().catch(() => {}), disabled: busy }, t('refresh')),
          h('button', { className: 'notes-btn primary', onClick: startNew }, t('new')),
        ),
        snapshot.phase === 'error'
          ? h('div', { className: 'notes-empty' }, t('error.load').replace('{msg}', snapshot.error || ''))
          : h('div', { className: 'notes-body' }, listNode, editorNode),
        imp.open
          ? h('div', { className: 'notes-overlay', onClick: closeImport },
              h('div', { className: 'notes-modal', onClick: (e) => e.stopPropagation() },
                h('div', { className: 'ni-head' },
                  h('div', { className: 'ni-title' }, '从表格导入（飞书多维表格 / 企业微信智能表格）'),
                  h('div', { className: 'ni-sub' }, '只读拉取，挑行生成便签草稿；不会修改你的表格。'),
                  h('button', { className: 'notes-btn sm', onClick: closeImport }, '关闭'),
                ),
                tableImportStep(t, imp, applyPatch, closeImport, doImport, importBusy),
              ),
            )
          : null,
      )
    }

    // ───────────────── 表格导入弹窗（飞书 / 企微） ─────────────────
    function tableImportStep(t, s, set, close, onImport, importBusy) {
      const providerSwitch = h('div', { className: 'ni-provider' },
        h('button', { className: 'notes-btn sm' + (s.provider !== 'wecom' ? ' primary' : ''), onClick: () => set({ provider: 'feishu', step: 'source', tables: [], tableId: '', error: '' }) }, '飞书多维表格'),
        h('button', { className: 'notes-btn sm' + (s.provider === 'wecom' ? ' primary' : ''), onClick: () => set({ provider: 'wecom', step: 'source', tables: [], tableId: '', error: '' }) }, '企业微信智能表格'),
      )
      if (s.step === 'source') {
        const wecomPanel = h('div', { className: 'ni-wecom' },
          h('div', { className: 'ni-hint' }, '企业微信需要「CorpID + 自建应用 Secret」——这是平台强制的，无法绕过；但可以自己创建：管理后台→我的企业（CorpID）→应用管理→自建→创建应用（Secret），并给应用开「文档/智能表格」权限。凭证只存本机。'),
          h('div', { className: 'ni-cols' },
            h('div', { className: 'notes-field' },
              h('label', { className: 'notes-label' }, 'CorpID'),
              h('input', { className: 'notes-input', value: s.wecom?.corpid || '', placeholder: 'ww开头的一串', onChange: (e) => set({ wecom: { ...s.wecom, corpid: e.target.value } }) }),
            ),
            h('div', { className: 'notes-field' },
              h('label', { className: 'notes-label' }, 'Secret' + (s.wecom?.configured ? '（已保存，留空则沿用）' : '')),
              h('input', { className: 'notes-input', type: 'password', value: s.wecom?.secretInput || '', placeholder: s.wecom?.configured ? '已保存' : '自建应用的 Secret', onChange: (e) => set({ wecom: { ...s.wecom, secretInput: e.target.value } }) }),
            ),
          ),
          h('div', { className: 'ni-actions' },
            h('span', { className: 'ni-hint' }, s.wecom?.configured ? '✓ 本机已保存企微凭证' : '尚未保存企微凭证'),
            h('div', { className: 'notes-spacer' }),
            h('button', { className: 'notes-btn sm', disabled: s.busy || !(s.wecom?.corpid || '').trim(), onClick: () => set({ saveWecom: true }) }, '保存企微凭证'),
          ),
        )
        return h('div', { className: 'ni-body' },
          providerSwitch,
          s.error ? h('div', { className: 'notes-msg' }, s.error) : null,
          s.provider === 'wecom' ? wecomPanel : null,
          h('div', { className: 'notes-field' },
            h('label', { className: 'notes-label' }, s.provider === 'wecom' ? '智能表格链接 / docid' : '多维表格链接 / token'),
            h('input', {
              className: 'notes-input', value: s.appTokenInput,
              placeholder: s.provider === 'wecom' ? '粘贴智能表格 URL（含 docid=…）或 docid' : '粘贴多维表格链接（…/base/xxxx 或 …/wiki/xxxx）或 app_token',
              onChange: (e) => set({ appTokenInput: e.target.value }),
            }),
            h('div', { className: 'ni-hint' }, s.provider === 'wecom'
              ? '提示：需把该智能表格授权给自建应用，且应用已开文档权限。'
              : '提示：需已把该多维表格「添加」给飞书应用，且应用具备多维表格只读权限。'),
          ),
          s.sources.length
            ? h('div', { className: 'notes-field' },
                h('label', { className: 'notes-label' }, '已保存的来源'),
                h('div', { className: 'ni-sources' }, s.sources.map((src) =>
                  h('div', { key: src.id, className: 'ni-source' },
                    h('button', {
                      className: 'notes-btn sm',
                      onClick: () => set({ provider: src.provider === 'wecom' ? 'wecom' : 'feishu', appTokenInput: src.provider === 'wecom' ? src.docid : src.appToken }),
                    }, (src.provider === 'wecom' ? '[企微] ' : '[飞书] ') + src.name),
                    h('span', { className: 'ni-hint' }, src.tableName || src.sheetTitle || src.tableId || src.sheetId),
                    h('button', { className: 'notes-btn sm danger', onClick: () => set({ removeId: src.id }) }, '删除'),
                  ),
                )),
              )
            : null,
          h('div', { className: 'ni-actions' },
            h('button', { className: 'notes-btn', onClick: close }, t('cancel')),
            h('div', { className: 'notes-spacer' }),
            h('button', { className: 'notes-btn primary', disabled: s.busy || !s.appTokenInput.trim(), onClick: () => set({ loadTables: true }) },
              s.busy ? '读取中…' : '下一步：选择数据表'),
          ),
        )
      }
      if (s.step === 'table') {
        return h('div', { className: 'ni-body' },
          s.error ? h('div', { className: 'notes-msg' }, s.error) : null,
          h('div', { className: 'notes-field' },
            h('label', { className: 'notes-label' }, '选择数据表'),
            s.tables.length === 0
              ? h('div', { className: 'ni-hint' }, '这个多维表格里没有可读的数据表（可能是权限不足）。')
              : h('div', { className: 'ni-tables' }, s.tables.map((tb) =>
                  h('button', { key: tb.tableId, className: 'notes-btn sm' + (s.tableId === tb.tableId ? ' primary' : ''), onClick: () => set({ tableId: tb.tableId }) }, tb.name),
                )),
          ),
          s.error ? null : (s.tablesError ? h('div', { className: 'notes-msg' }, s.tablesError) : null),
          h('div', { className: 'ni-actions' },
            h('button', { className: 'notes-btn', onClick: () => set({ step: 'source' }) }, '上一步'),
            h('div', { className: 'notes-spacer' }),
            h('button', { className: 'notes-btn primary', disabled: s.busy || !s.tableId, onClick: () => set({ loadPreview: true }) },
              s.busy ? '读取中…' : '下一步：选择记录'),
          ),
        )
      }
      // records
      const cols = s.fieldNames
      const mapSelect = (key, label, hint) => h('div', { className: 'ni-mapfield' },
        h('label', { className: 'notes-label' }, label),
        h('select', { className: 'notes-select', value: s.mapping[key] || '', onChange: (e) => set({ mapping: { ...s.mapping, [key]: e.target.value } }) },
          h('option', { value: '' }, '（不使用）'),
          cols.map((c) => h('option', { key: c, value: c }, c)),
        ),
        hint ? h('div', { className: 'ni-maphint' }, hint) : null,
      )

      // 用当前映射本地推算「这条记录会变成什么样的便签」，让映射看得见
      const previewOf = (row) => {
        const pick = (col) => (col && row.cells && col in row.cells ? String(row.cells[col]).trim() : '')
        const priRaw = pick(s.mapping.priority)
        const pri = parsePriority(priRaw)
        const tagsRaw = pick(s.mapping.tags)
        return {
          title: pick(s.mapping.title) || '（无标题）',
          body: pick(s.mapping.body),
          category: pick(s.mapping.category),
          priority: pri,
          priorityRaw: pri ? '' : priRaw,
          tags: tagsRaw ? tagsRaw.split(/[,，、;；]/).map((x) => x.trim()).filter(Boolean) : [],
        }
      }
      const previewRow = s.rows.find((r) => r.recordId === s.previewId) || s.rows.find((r) => s.selected.includes(r.recordId)) || s.rows[0]
      const pv = previewRow ? previewOf(previewRow) : null

      return h('div', { className: 'ni-body' },
        s.error ? h('div', { className: 'notes-msg' }, s.error) : null,

        h('div', { className: 'ni-records-head' },
          h('span', null, '共 ' + s.rows.length + ' 行，已选 ' + s.selected.length + ' 行'),
          h('button', { className: 'notes-btn sm', onClick: () => set({ selected: s.selected.length === s.rows.length ? [] : s.rows.map((r) => r.recordId) }) },
            s.selected.length === s.rows.length ? '全不选' : '全选'),
        ),
        h('div', { className: 'ni-records' },
          s.rows.length === 0
            ? h('div', { className: 'ni-hint' }, '没有读到记录。')
            : s.rows.map((r) => {
                const p = previewOf(r)
                const on = s.selected.includes(r.recordId)
                return h('div', {
                  key: r.recordId,
                  className: 'ni-row' + (on ? ' on' : '') + (previewRow && r.recordId === previewRow.recordId ? ' current' : ''),
                  onClick: () => set({ previewId: r.recordId }),
                },
                  h('input', {
                    type: 'checkbox', checked: on,
                    onClick: (e) => e.stopPropagation(),
                    onChange: (e) => set({ selected: e.target.checked ? [...s.selected, r.recordId] : s.selected.filter((x) => x !== r.recordId) }),
                  }),
                  h('span', { className: 'ni-rowtitle' }, p.title),
                  h('span', { className: 'ni-rowmeta' },
                    p.category ? h('span', { className: 'notes-badge' }, p.category) : null,
                    p.priority ? h('span', { className: 'notes-badge p' }, 'P' + p.priority) : null,
                  ),
                )
              }),
        ),

        // ── 实时预览：勾哪行就看它变成什么便签 ──
        pv
          ? h('div', { className: 'ni-preview' },
              h('div', { className: 'ni-preview-head' }, '导入后长这样（示例：' + pv.title + '）'),
              h('div', { className: 'ni-preview-title' }, pv.title),
              pv.category || pv.priority || pv.tags.length
                ? h('div', { className: 'ni-preview-meta' },
                    pv.category ? h('span', { className: 'notes-badge' }, pv.category) : null,
                    pv.priority ? h('span', { className: 'notes-badge p' }, 'P' + pv.priority) : null,
                    pv.priorityRaw ? h('span', { className: 'notes-badge' }, '优先级原文：' + pv.priorityRaw) : null,
                    pv.tags.map((tg) => h('span', { key: tg, className: 'notes-badge' }, tg)),
                  )
                : null,
              h('div', { className: 'ni-preview-body' }, pv.body || '（这一行没有正文；可以换一个「正文/需求描述列」）'),
            )
          : null,

        // 列映射收在折叠里：默认已自动猜好，不必每次都看
        h('details', { className: 'ni-mapbox', open: s.mappingOpen === true },
          h('summary', null, '字段映射（把表格的列对应到便签字段）'),
          h('div', { className: 'ni-cols' },
            mapSelect('title', '标题列', '必填。便签的标题取自这一列'),
            mapSelect('body', '正文列', '需求详情 / 描述，会填进便签正文'),
            mapSelect('category', '分类列', '可选，填进便签的「分类」'),
            mapSelect('priority', '优先级列', '可选。支持「高/中/低」「P1~P5」「1~5」'),
            mapSelect('tags', '标签列', '可选。多个标签用逗号分隔'),
          ),
          h('div', { className: 'ni-hint' }, '提示：上面的「导入后长这样」会跟着这里的选择实时变化。'),
        ),

        h('div', { className: 'ni-actions' },
          h('button', { className: 'notes-btn', onClick: () => set({ step: 'table' }) }, '上一步'),
          h('div', { className: 'notes-spacer' }),
          h('button', { className: 'notes-btn primary', disabled: importBusy || s.selected.length === 0, onClick: onImport },
            importBusy ? '导入中…' : ('导入选中 ' + s.selected.length + ' 条成便签')),
        ),
      )
    }

    /** 「高/中/低」「P1~P5」「1~5」→ 1~5；无法识别返回 null。 */
    function parsePriority(raw) {
      const s = String(raw || '').trim()
      if (!s) return null
      const n = s.match(/[1-5]/)
      if (n && /^[pP]?\s*[1-5]$/.test(s)) return Number(n[0])
      if (/急|最高|紧急|very high|urgent/i.test(s)) return 1
      if (/^高|high/i.test(s)) return 2
      if (/^中|medium|normal/i.test(s)) return 3
      if (/^低|low/i.test(s)) return 4
      if (n) return Number(n[0])
      return null
    }

    function composePrompt(t, draft) {
      const lines = []
      lines.push('【便签需求】' + (draft.title || t('untitled')))
      const meta = []
      if (draft.category) meta.push('分类：' + draft.category)
      if (draft.priority) meta.push('优先级：P' + draft.priority)
      if (draft.tags && draft.tags.length) meta.push('标签：' + draft.tags.join('、'))
      if (meta.length) lines.push(meta.join(' | '))
      lines.push('')
      if (draft.body) lines.push(draft.body)
      lines.push('')
      lines.push('---')
      lines.push('请基于以上便签内容做需求分析。')
      return lines.join('\n')
    }

    // ───────────────────────── apply ─────────────────────────
    function apply(ctx) {
      const store = createNotesStore()
      const t = ctx.locale.bind(NS)

      // 字典
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-notes: dictionaries')

      // 样式
      ctx.effect(() => {
        if (typeof document === 'undefined' || !document.head) return () => {}
        const id = 'dsh-notes/styles'
        let tag = typeof document.querySelector === 'function'
          ? document.querySelector('style[data-plugin-css="' + id + '"]')
          : null
        if (!tag) {
          tag = document.createElement('style')
          tag.dataset.plugin = NS
          tag.dataset.pluginCss = id
          document.head.appendChild(tag)
        }
        tag.textContent = CSS
        return () => { try { if (tag && tag.parentNode) tag.parentNode.removeChild(tag) } catch { /* ignore */ } }
      }, 'dsh-notes: styles')

      // 会话联动（全部走可选服务，缺了也不报错）
      const svc = (key) => { try { return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key] } catch { return undefined } }
      const session = {
        current() {
          try {
            const uw = svc('uiWorkspace')
            const id = uw?.mainReference?.sessionId
              || uw?.selection?.getSnapshot?.()?.sessionId
              || svc('sessions')?.list?.getSnapshot?.()?.current
            return typeof id === 'string' && id ? id : null
          } catch { return null }
        },
        open(id) { try { svc('uiWorkspace')?.openSession?.(id) } catch { /* ignore */ } },
        seedNewSession(prompt) {
          try {
            const uw = svc('uiWorkspace')
            if (uw && typeof uw.startSession === 'function') {
              uw.startSession(undefined, { prompt, whenDraftExists: 'append' })
              return true
            }
          } catch { /* ignore */ }
          return false
        },
      }

      const controller = () => ({ store, session, tr: t })

      ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
        name: 'sidebar.panellist',
        id: NS,
        order: 40,
        label: () => t('nav'),
        locale: NS,
      }, NotesIcon))

      ctx.slots.inject('main', () => ctx.slots.register({
        name: 'main',
        key: NS,
        locale: NS,
        inject: controller,
      }, NotesPanelView))
    }

    const inject = ['slots', 'locale']

    exports.apply = apply
    exports.inject = inject
    exports.name = NS
    exports.NotesPanelView = NotesPanelView
    exports.NotesIcon = NotesIcon
    exports.createNotesStore = createNotesStore
    exports.composePrompt = composePrompt
    return module.exports
  },
})
