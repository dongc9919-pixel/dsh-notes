/**
 * dsh-notes — Host 半边。
 *
 * 职责：
 *   1. 注册一条 HTTP 路由 `/dsh-notes/api`（prefix），给浏览器半边读写便签；
 *   2. 注册 Agent 工具 `notes`，让模型在会话里直接读出便签内容、把便签和会话串起来；
 *   3. 两者共用同一份 `createNoteStore`，行为一致。
 *
 * 认证：复用 DSH 自己的 `connection.admit()`，只放行 owner peer
 * （需求里便签属于私有数据，不允许跨站或非 owner 访问）。
 */

import { createNoteStore, defaultDataDir, summarize, STATUSES } from './store.js'
import { ocrImageBuffer, ocrSupport } from './ocr.js'
import { formatText } from './format.js'
import { testFeishu, listTables, listFields, listRecords, toText, resolveFeishuAuth, resolveAppToken } from './feishu.js'
import { createSourceStore, createWecomCredStore } from './sources.js'
import { testWecom, listSheets as wecomListSheets, listRecords as wecomListRecords, parseDocId } from './wecom.js'

export const name = 'dsh-notes'

/** 可选依赖：没有 webServer / connection 时插件照常加载，只是拿不到对应入口。 */
export const inject = []

const API_PREFIX = '/dsh-notes/api'

function getService(ctx, key) {
  try {
    return typeof ctx.get === 'function' ? ctx.get(key) : ctx[key]
  } catch {
    return undefined
  }
}

function readBody(req) {
  return new Promise((resolveBody, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > 24 * 1024 * 1024) {
        reject(new Error('请求体过大'))
        try { req.destroy() } catch { /* ignore */ }
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolveBody(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.statusCode = status
  res.setHeader('content-type', 'application/json; charset=utf-8')
  res.setHeader('cache-control', 'no-store')
  res.end(body)
}

/** 用 DSH 自己的连接鉴权，只放行 owner。 */
function authenticate(ctx, req) {
  const connection = getService(ctx, 'connection')
  if (!connection || typeof connection.admit !== 'function') {
    return { ok: false, status: 503, code: 'auth-unavailable', error: 'DSH 认证服务不可用' }
  }
  try {
    const admission = connection.admit(req)
    if (!admission || typeof admission !== 'object') {
      return { ok: false, status: 401, code: 'unauthorized', error: '未授权的请求' }
    }
    if ('rejection' in admission) {
      const status = typeof admission.rejection === 'number' ? admission.rejection : 401
      return { ok: false, status, code: 'forbidden', error: '请求未通过 DSH 信任检查' }
    }
    const peer = admission.peer
    if (!peer || typeof peer !== 'object') {
      return { ok: false, status: 401, code: 'unauthorized', error: '缺少有效 Peer 凭证' }
    }
    if (peer.principal?.kind !== 'owner') {
      return { ok: false, status: 403, code: 'forbidden', error: '便签属于私有数据，需要 owner 权限' }
    }
    return { ok: true }
  } catch (error) {
    return { ok: false, status: 403, code: 'auth-error', error: '认证检查失败: ' + (error?.message ?? String(error)) }
  }
}

function safeMessage(error) {
  if (error && typeof error.message === 'string' && error.message) return error.message
  return String(error)
}

/** 当前默认模型（用于「按语义归类排版」这类模型调用），拿不到就用配置里的默认值。 */
function resolveSelection(ctx) {
  try {
    const svc = getService(ctx, 'agentDefaultModel')
    const sel = svc && typeof svc.currentSelection === 'function' ? svc.currentSelection() : undefined
    if (sel && typeof sel.provider === 'string' && typeof sel.model === 'string' && sel.model) return sel
  } catch { /* ignore */ }
  return { provider: 'multiagent-workbuddy', model: 'workbuddy/deepseek-v4.1-flash' }
}

/** 去掉值为空字符串的键，避免把空覆盖传给飞书客户端。 */
function stripEmpty(obj) {
  const out = {}
  for (const [k, v] of Object.entries(obj || {})) {
    if (typeof v === 'string') { if (v.trim()) out[k] = v.trim() } else if (v !== undefined && v !== null) out[k] = v
  }
  return out
}

/** 把「高/中/低」「P1~P5」「1~5」等优先级原文转成 1~5，识别不了返回 null。 */
function parsePriorityText(raw) {
  const s = String(raw || '').trim()
  if (!s) return null
  if (/^[pP]\s*[1-5]$/.test(s)) return Number(s.replace(/[^1-5]/g, ''))
  if (/^[1-5]$/.test(s)) return Number(s)
  if (/急|最高|紧急|urgent|very\s*high/i.test(s)) return 1
  if (/^高|high/i.test(s)) return 2
  if (/^中|medium|normal|一般/i.test(s)) return 3
  if (/^低|low|minor/i.test(s)) return 4
  const n = s.match(/[1-5]/)
  return n ? Number(n[0]) : null
}

/** 注册 HTTP 路由。 */
function registerHttp(ctx, store, log, sourceStore, wecomCred) {
  const webServer = getService(ctx, 'webServer')
  if (!webServer || typeof webServer.register !== 'function') {
    log?.warn?.('[dsh-notes] 宿主没有 webServer 服务，浏览器半边将拿不到数据')
    return
  }
  ctx.effect(() => webServer.register({
    kind: 'prefix',
    path: API_PREFIX,
    handler: async (req, res) => {
      const auth = authenticate(ctx, req)
      if (!auth.ok) return sendJson(res, auth.status, { ok: false, code: auth.code, error: auth.error })
      try {
        const url = new URL(req.url ?? '/', 'http://localhost')
        const path = url.pathname.startsWith(API_PREFIX)
          ? url.pathname.slice(API_PREFIX.length) || '/'
          : '/'
        let body = {}
        if (req.method === 'POST') {
          const raw = await readBody(req)
          if (raw.trim() !== '') {
            try { body = JSON.parse(raw) }
            catch { return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' }) }
          }
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) {
          return sendJson(res, 400, { ok: false, error: '请求体必须是 JSON 对象' })
        }

        if (req.method === 'GET' && path === '/notes') {
          return sendJson(res, 200, { ok: true, result: { notes: await store.list() } })
        }
        if (req.method === 'GET' && path === '/note') {
          const id = url.searchParams.get('id') ?? ''
          const note = id ? await store.get(id) : null
          return sendJson(res, 200, { ok: true, result: { note } })
        }
        if (req.method === 'POST' && path === '/notes') {
          const note = await store.upsert(body)
          return sendJson(res, 200, { ok: true, result: { note } })
        }
        if (req.method === 'POST' && path === '/delete') {
          const id = typeof body.id === 'string' ? body.id.trim() : ''
          if (!id) return sendJson(res, 400, { ok: false, error: 'id 必填' })
          const removed = await store.remove(id)
          return sendJson(res, 200, { ok: true, result: { removed } })
        }
        if (req.method === 'POST' && path === '/link') {
          const id = typeof body.id === 'string' ? body.id.trim() : ''
          if (!id) return sendJson(res, 400, { ok: false, error: 'id 必填' })
          const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId.trim() : null
          const note = await store.linkSession(id, sessionId)
          return sendJson(res, 200, { ok: true, result: { note } })
        }
        if (req.method === 'GET' && path === '/ocr-status') {
          return sendJson(res, 200, { ok: true, result: ocrSupport() })
        }
        if (req.method === 'POST' && path === '/ocr') {
          // 只接收图片、识别完立刻丢弃，不写库、不留原图。
          const raw = typeof body.image === 'string' ? body.image : ''
          if (!raw) return sendJson(res, 400, { ok: false, error: '缺少 image' })
          const comma = raw.indexOf(',')
          const b64 = raw.startsWith('data:') && comma >= 0 ? raw.slice(comma + 1) : raw
          let buffer
          try { buffer = Buffer.from(b64, 'base64') }
          catch { return sendJson(res, 400, { ok: false, error: '图片 base64 无效' }) }
          if (!buffer || buffer.length === 0) return sendJson(res, 400, { ok: false, error: '图片为空' })
          if (buffer.length > 20 * 1024 * 1024) return sendJson(res, 413, { ok: false, error: '图片过大（上限 20MB）' })
          const ocr = await ocrImageBuffer(buffer)
          if (!ocr.ok) {
            const status = ocr.code === 'bad-request' ? 400 : ocr.code === 'ocr-unavailable' ? 501 : 500
            return sendJson(res, status, { ok: false, code: ocr.code, error: ocr.error })
          }
          return sendJson(res, 200, { ok: true, result: { text: ocr.text, lines: ocr.lines, lang: ocr.lang } })
        }
        if (req.method === 'POST' && path === '/format') {
          // 只做「语义归类 + 编号排版」，不改写原文；失败时客户端回落到原文。
          const text = typeof body.text === 'string' ? body.text : ''
          if (!text.trim()) return sendJson(res, 400, { ok: false, error: '缺少 text' })
          const llm = getService(ctx, 'llm')
          const out = await formatText({ llm, selection: resolveSelection(ctx) }, text)
          if (!out.ok) {
            const status = out.code === 'bad-request' ? 400 : out.code === 'llm-unavailable' ? 501 : 502
            return sendJson(res, status, { ok: false, code: out.code, error: out.error })
          }
          return sendJson(res, 200, { ok: true, result: { text: out.text } })
        }
        // ── 飞书多维表格（只读） ──
        const feishuStatus = (r) => {
          if (r.ok) return sendJson(res, 200, { ok: true, result: r })
          const status = r.code === 'bad-request' ? 400 : r.code === 'no-app' || r.code === 'no-secret-ref' || r.code === 'no-secret' ? 412 : 502
          return sendJson(res, status, { ok: false, code: r.code, error: r.error })
        }
        if (req.method === 'GET' && path === '/feishu/status') {
          const overrides = stripEmpty({ appId: url.searchParams.get('appId') || '', secretRef: url.searchParams.get('secretRef') || '', appToken: url.searchParams.get('appToken') || '' })
          return feishuStatus(await testFeishu(ctx, overrides))
        }
        if (req.method === 'POST' && path === '/feishu/tables') {
          const auth = await resolveFeishuAuth(ctx, stripEmpty({ appId: body.appId, secretRef: body.secretRef }))
          if (!auth.ok) return feishuStatus(auth)
          const resolved = await resolveAppToken(auth, String(body.appToken || '').trim())
          if (!resolved.ok) return feishuStatus({ ok: false, code: resolved.code, error: resolved.error })
          const tablesResult = await listTables(auth, resolved.appToken)
          if (!tablesResult.ok) {
            return sendJson(res, 502, { ok: false, code: tablesResult.code, error: tablesResult.error, appToken: resolved.appToken })
          }
          return sendJson(res, 200, { ok: true, result: { tables: tablesResult.tables, appToken: resolved.appToken, wikiToken: resolved.wikiToken } })
        }
        if (req.method === 'POST' && path === '/feishu/fields') {
          const auth = await resolveFeishuAuth(ctx, stripEmpty({ appId: body.appId, secretRef: body.secretRef }))
          if (!auth.ok) return feishuStatus(auth)
          return feishuStatus(await listFields(auth, String(body.appToken || '').trim(), String(body.tableId || '').trim()))
        }
        if (req.method === 'POST' && path === '/feishu/preview') {
          const auth = await resolveFeishuAuth(ctx, stripEmpty({ appId: body.appId, secretRef: body.secretRef }))
          if (!auth.ok) return feishuStatus(auth)
          const resolved = await resolveAppToken(auth, String(body.appToken || '').trim())
          if (!resolved.ok) return feishuStatus({ ok: false, code: resolved.code, error: resolved.error })
          const rec = await listRecords(auth, resolved.appToken, String(body.tableId || '').trim(), { pageSize: 100, maxPages: 3 })
          if (!rec.ok) return feishuStatus(rec)
          const fieldsResult = await listFields(auth, resolved.appToken, String(body.tableId || '').trim())
          const fieldNames = fieldsResult.ok ? fieldsResult.fields.map((f) => f.name) : []
          const rows = rec.records.map((r) => {
            const flat = {}
            for (const [k, v] of Object.entries(r.fields || {})) flat[k] = toText(v)
            return { recordId: r.recordId, cells: flat }
          })
          return sendJson(res, 200, { ok: true, result: { fieldNames, rows } })
        }
        if (req.method === 'POST' && path === '/feishu/import') {
          const auth = await resolveFeishuAuth(ctx, stripEmpty({ appId: body.appId, secretRef: body.secretRef }))
          if (!auth.ok) return feishuStatus(auth)
          const resolved = await resolveAppToken(auth, String(body.appToken || '').trim())
          if (!resolved.ok) return feishuStatus({ ok: false, code: resolved.code, error: resolved.error })
          const appToken = resolved.appToken
          const tableId = String(body.tableId || '').trim()
          const rec = await listRecords(auth, appToken, tableId, { pageSize: 100, maxPages: 5 })
          if (!rec.ok) return feishuStatus(rec)
          const wanted = Array.isArray(body.recordIds) ? new Set(body.recordIds.filter((x) => typeof x === 'string')) : null
          const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping : {}
          const base = body.defaults && typeof body.defaults === 'object' ? body.defaults : {}
          const imported = []
          for (const r of rec.records) {
            if (wanted && !wanted.has(r.recordId)) continue
            const pick = (col) => (col && r.fields && col in r.fields ? toText(r.fields[col]).trim() : '')
            const title = pick(mapping.title) || ('飞书记录 ' + r.recordId.slice(-6))
            const bodyText = pick(mapping.body)
            const tagsRaw = pick(mapping.tags)
            const tags = tagsRaw ? tagsRaw.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean) : []
            const pri = parsePriorityText(pick(mapping.priority))
            const note = await store.upsert({
              title,
              body: bodyText,
              category: pick(mapping.category) || (typeof base.category === 'string' ? base.category : ''),
              status: typeof base.status === 'string' && STATUSES.includes(base.status) ? base.status : 'backlog',
              priority: Number.isInteger(pri) && pri >= 1 && pri <= 5 ? pri : null,
              tags,
            })
            imported.push({ recordId: r.recordId, noteId: note.id, title: note.title })
          }
          return sendJson(res, 200, { ok: true, result: { imported, count: imported.length } })
        }
        if (req.method === 'GET' && path === '/feishu/sources') {
          return sendJson(res, 200, { ok: true, result: { sources: await sourceStore.list() } })
        }
        if (req.method === 'POST' && path === '/feishu/sources') {
          const source = await sourceStore.upsert(body)
          return sendJson(res, 200, { ok: true, result: { source } })
        }
        if (req.method === 'POST' && path === '/feishu/sources/delete') {
          const id = typeof body.id === 'string' ? body.id.trim() : ''
          if (!id) return sendJson(res, 400, { ok: false, error: 'id 必填' })
          const removed = await sourceStore.remove(id)
          return sendJson(res, 200, { ok: true, result: { removed } })
        }
        // ── 企业微信智能表格（只读） ──
        const wecomStatus = (r) => {
          if (r.ok) return sendJson(res, 200, { ok: true, result: r })
          const status = r.code === 'bad-request' || r.code === 'no-credential' ? 400 : /token-failed|40001|40013/.test(r.code || '') ? 412 : 502
          return sendJson(res, status, { ok: false, code: r.code, error: r.error })
        }
        const wecomCredOf = async (body) => {
          const saved = await wecomCred.get()
          const corpid = String(body.corpid || '').trim() || saved.corpid
          const secret = String(body.secret || '').trim() || saved.secret
          return { corpid, secret }
        }
        if (req.method === 'GET' && path === '/wecom/status') {
          const saved = await wecomCred.get()
          const docid = parseDocId(url.searchParams.get('docid') || '')
          if (!saved.configured) return sendJson(res, 200, { ok: true, result: { configured: false } })
          return wecomStatus(await testWecom(saved, docid))
        }
        if (req.method === 'POST' && path === '/wecom/credentials') {
          const saved = await wecomCred.set({ corpid: body.corpid, secret: body.secret })
          return sendJson(res, 200, { ok: true, result: saved })
        }
        if (req.method === 'GET' && path === '/wecom/credentials') {
          const saved = await wecomCred.get()
          return sendJson(res, 200, { ok: true, result: { corpid: saved.corpid, configured: saved.configured } })
        }
        if (req.method === 'POST' && path === '/wecom/sheets') {
          const cred = await wecomCredOf(body)
          if (!cred.corpid || !cred.secret) return wecomStatus({ ok: false, code: 'no-credential', error: '请先填写并保存企业微信 CorpID 与 Secret' })
          return wecomStatus(await wecomListSheets(cred, parseDocId(body.docid)))
        }
        if (req.method === 'POST' && path === '/wecom/preview') {
          const cred = await wecomCredOf(body)
          if (!cred.corpid || !cred.secret) return wecomStatus({ ok: false, code: 'no-credential', error: '请先填写并保存企业微信 CorpID 与 Secret' })
          const docid = parseDocId(body.docid)
          const sheetId = String(body.sheetId || '').trim()
          const rec = await wecomListRecords(cred, docid, sheetId, { limit: 100, maxPages: 3 })
          if (!rec.ok) return wecomStatus(rec)
          return sendJson(res, 200, { ok: true, result: { fieldNames: rec.fieldTitles || [], rows: rec.records.map((r) => ({ recordId: r.recordId, cells: r.cells })) } })
        }
        if (req.method === 'POST' && path === '/wecom/import') {
          const cred = await wecomCredOf(body)
          if (!cred.corpid || !cred.secret) return wecomStatus({ ok: false, code: 'no-credential', error: '请先填写并保存企业微信 CorpID 与 Secret' })
          const docid = parseDocId(body.docid)
          const sheetId = String(body.sheetId || '').trim()
          const rec = await wecomListRecords(cred, docid, sheetId, { limit: 100, maxPages: 5 })
          if (!rec.ok) return wecomStatus(rec)
          const wanted = Array.isArray(body.recordIds) ? new Set(body.recordIds.filter((x) => typeof x === 'string')) : null
          const mapping = body.mapping && typeof body.mapping === 'object' ? body.mapping : {}
          const base = body.defaults && typeof body.defaults === 'object' ? body.defaults : {}
          const imported = []
          for (const r of rec.records) {
            if (wanted && !wanted.has(r.recordId)) continue
            const pick = (col) => (col && r.cells && col in r.cells ? String(r.cells[col]).trim() : '')
            const title = pick(mapping.title) || ('企微记录 ' + r.recordId.slice(-6))
            const tagsRaw = pick(mapping.tags)
            const pri = parsePriorityText(pick(mapping.priority))
            const note = await store.upsert({
              title,
              body: pick(mapping.body),
              category: pick(mapping.category) || (typeof base.category === 'string' ? base.category : ''),
              status: typeof base.status === 'string' && STATUSES.includes(base.status) ? base.status : 'backlog',
              priority: Number.isInteger(pri) && pri >= 1 && pri <= 5 ? pri : null,
              tags: tagsRaw ? tagsRaw.split(/[,，、;；]/).map((s) => s.trim()).filter(Boolean) : [],
            })
            imported.push({ recordId: r.recordId, noteId: note.id, title: note.title })
          }
          return sendJson(res, 200, { ok: true, result: { imported, count: imported.length } })
        }
        // 通用来源（feishu / wecom 共用）
        if (req.method === 'GET' && path === '/sources') {
          return sendJson(res, 200, { ok: true, result: { sources: await sourceStore.list() } })
        }
        if (req.method === 'POST' && path === '/sources') {
          const source = await sourceStore.upsert(body)
          return sendJson(res, 200, { ok: true, result: { source } })
        }
        if (req.method === 'POST' && path === '/sources/delete') {
          const id = typeof body.id === 'string' ? body.id.trim() : ''
          if (!id) return sendJson(res, 400, { ok: false, error: 'id 必填' })
          const removed = await sourceStore.remove(id)
          return sendJson(res, 200, { ok: true, result: { removed } })
        }
        return sendJson(res, 404, { ok: false, error: '未知接口: ' + path })
      } catch (error) {
        const code = typeof error?.code === 'string' ? error.code : undefined
        const status = code === 'bad-request' ? 400 : 500
        return sendJson(res, status, { ok: false, error: safeMessage(error), ...(code ? { code } : {}) })
      }
    },
  }), 'dsh-notes: http route')
}

/** 注册 Agent 工具。 */
function registerTools(ctx, store, log) {
  const tools = getService(ctx, 'tools')
  if (!tools || typeof tools.register !== 'function') {
    log?.debug?.('[dsh-notes] 这个部署没有 tools 服务，跳过便签工具注册')
    return
  }
  const text = (value) => [{ type: 'text', text: JSON.stringify(value, null, 2) }]
  ctx.effect(() => tools.register({
    name: 'notes',
    description:
      '便签（Notes）：记录需求、维护需求基本信息与分类。' +
      'action=list 列出；get 读取；create 新建；update 修改；delete 删除；' +
      'setStatus 改状态（backlog/doing/done/archived）；linkSession 关联当前会话。' +
      '当用户要求「根据便签开工 / 做需求分析」时，先 list 或 get 读出便签内容，再据此推进。',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'get', 'create', 'update', 'delete', 'setStatus', 'linkSession'],
          description: '要执行的动作。',
        },
        id: { type: 'string', description: '便签 id（get/update/delete/setStatus/linkSession 必填）。' },
        title: { type: 'string', description: '标题（create 必填）。' },
        body: { type: 'string', description: '正文 / 需求详情。' },
        category: { type: 'string', description: '分类。' },
        tags: { type: 'array', items: { type: 'string' }, description: '标签数组。' },
        status: { type: 'string', enum: STATUSES, description: '状态。' },
        priority: { type: 'number', description: '优先级 1–5。' },
        sessionId: { type: 'string', description: '关联的 DSH 会话 id（linkSession 用；传空字符串解除关联）。' },
        withBody: { type: 'boolean', description: 'list 时是否包含正文。' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', properties: { ok: { type: 'boolean' }, data: {} }, required: ['ok'] },
      render: (_args, value) => text(value),
    },
    async execute(args) {
      const input = args ?? {}
      const action = String(input.action ?? 'list')
      try {
        if (action === 'list') {
          const all = await store.list()
          return { ok: true, data: all.map((n) => summarize(n, { withBody: Boolean(input.withBody) })) }
        }
        if (action === 'get') {
          const id = String(input.id ?? '').trim()
          if (!id) return { ok: false, error: 'get 需要 id' }
          const note = await store.get(id)
          return { ok: true, data: note ? summarize(note, { withBody: true }) : null }
        }
        if (action === 'create') {
          const note = await store.upsert({
            title: input.title,
            body: input.body,
            category: input.category,
            tags: input.tags,
            status: input.status,
            priority: input.priority,
            sessionId: input.sessionId,
          })
          return { ok: true, data: summarize(note, { withBody: true }) }
        }
        const id = String(input.id ?? '').trim()
        if (!id) return { ok: false, error: `${action} 需要 id` }
        if (action === 'delete') {
          const removed = await store.remove(id)
          return { ok: removed, data: { id, removed } }
        }
        if (action === 'setStatus') {
          const note = await store.upsert({ id, status: input.status })
          return { ok: true, data: summarize(note) }
        }
        if (action === 'linkSession') {
          const note = await store.linkSession(id, input.sessionId)
          return { ok: true, data: summarize(note) }
        }
        // update
        const note = await store.upsert({
          id,
          title: input.title,
          body: input.body,
          category: input.category,
          tags: input.tags,
          status: input.status,
          priority: input.priority,
          sessionId: input.sessionId,
        })
        return { ok: true, data: summarize(note, { withBody: true }) }
      } catch (error) {
        return { ok: false, error: safeMessage(error) }
      }
    },
  }), 'dsh-notes: notes tool')
}

export function apply(ctx) {
  const log = (() => {
    try { return ctx.logger } catch { return undefined }
  })()
  let store
  try {
    store = createNoteStore(defaultDataDir())
  } catch (error) {
    log?.error?.('[dsh-notes] 初始化便签仓库失败：' + safeMessage(error))
    return
  }
  let sourceStore
  try {
    sourceStore = createSourceStore()
  } catch (error) {
    log?.error?.('[dsh-notes] 初始化表格来源配置失败：' + safeMessage(error))
    sourceStore = { list: async () => [], upsert: async () => { throw new Error('来源配置不可用') }, remove: async () => false }
  }
  let wecomCred
  try {
    wecomCred = createWecomCredStore()
  } catch (error) {
    log?.error?.('[dsh-notes] 初始化企微凭证存储失败：' + safeMessage(error))
    wecomCred = { get: async () => ({ corpid: '', secret: '', configured: false }), set: async () => ({ configured: false }) }
  }
  registerHttp(ctx, store, log, sourceStore, wecomCred)
  registerTools(ctx, store, log)
  try { log?.info?.('[dsh-notes] 便签插件已加载（' + store.path + '）') } catch { /* ignore */ }
}
