/**
 * dsh-notes — 飞书多维表格（Bitable）只读接入。
 *
 * 设计：
 *   - 复用 DSH 里已配置的飞书应用：appId/secretRef 优先取插件 Config，
 *     否则读 `<DSH_HOME>/integrations/dsh-feishu/config.json` 的第一个 bot；
 *     secret 通过宿主 `credentials.resolve(secretRef)` 在运行时取（不落库、不打日志）。
 *   - 严格只读：只调 list tables / fields / records 三个接口，绝不写用户表格。
 *   - 任何失败返回 { ok:false, code, error }，把飞书的 code/msg 原样带出，便于定位权限问题。
 */

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { dshHome } from './store.js'

const FEISHU_HOST = 'https://open.feishu.cn'

function safeMsg(e) {
  if (e && typeof e.message === 'string' && e.message) return e.message
  return String(e)
}

/** 从宿主配置里找现成的飞书应用（appId + secretRef）。 */
export async function discoverFeishuApp() {
  try {
    const p = join(dshHome(), 'integrations', 'dsh-feishu', 'config.json')
    const raw = await readFile(p, 'utf8')
    const cfg = JSON.parse(raw)
    const bot = Array.isArray(cfg?.bots) ? cfg.bots[0] : null
    if (bot && typeof bot.appId === 'string' && typeof bot.secretRef === 'string') {
      return { appId: bot.appId, secretRef: bot.secretRef, botName: bot.botName || '', domain: bot.domain || 'feishu' }
    }
  } catch { /* 没配置就返回 null */ }
  return null
}

/** 解析出可用的 { appId, secret }；Config 覆盖优先。 */
export async function resolveFeishuAuth(ctx, overrides = {}) {
  const discovered = await discoverFeishuApp()
  const appId = (overrides.appId && overrides.appId.trim()) || discovered?.appId || ''
  const secretRef = (overrides.secretRef && overrides.secretRef.trim()) || discovered?.secretRef || ''
  if (!appId) return { ok: false, code: 'no-app', error: '找不到飞书 appId：请在插件配置里填，或在 dsh-im 里接入飞书' }
  if (!secretRef) return { ok: false, code: 'no-secret-ref', error: '找不到飞书 secretRef' }

  let secret = ''
  try {
    const credentials = typeof ctx.get === 'function' ? ctx.get('credentials') : ctx.credentials
    if (credentials && typeof credentials.resolve === 'function') {
      const resolved = await credentials.resolve(secretRef)
      secret = resolved && typeof resolved.value === 'string' ? resolved.value : ''
    }
  } catch { /* 继续走环境变量兜底 */ }
  if (!secret && process.env[secretRef]) secret = process.env[secretRef]
  if (!secret) return { ok: false, code: 'no-secret', error: '凭据库里取不到飞书 secret（' + secretRef + '）' }
  return { ok: true, appId, secret, botName: discovered?.botName || '', domain: discovered?.domain || 'feishu' }
}

// ── token 缓存（按 appId） ──
const tokenCache = new Map() // appId -> { token, exp }

async function httpJson(url, options = {}, timeoutMs = 20000) {
  const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
  const res = await fetch(url, { ...options, signal })
  const text = await res.text()
  let json
  try { json = JSON.parse(text) } catch { json = null }
  if (!json) throw new Error('飞书返回非 JSON（HTTP ' + res.status + '）：' + text.slice(0, 200))
  return { status: res.status, json }
}

export async function getTenantToken(auth) {
  const cached = tokenCache.get(auth.appId)
  if (cached && cached.exp > Date.now() + 60_000) return { ok: true, token: cached.token }
  try {
    const { json } = await httpJson(FEISHU_HOST + '/open-apis/auth/v3/tenant_access_token/internal', {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ app_id: auth.appId, app_secret: auth.secret }),
    })
    if (json.code !== 0 || !json.tenant_access_token) {
      return { ok: false, code: 'token-failed', error: '获取 tenant_access_token 失败：code=' + json.code + ' msg=' + (json.msg || '') }
    }
    const ttl = Number(json.expire) > 0 ? Number(json.expire) : 7200
    tokenCache.set(auth.appId, { token: json.tenant_access_token, exp: Date.now() + ttl * 1000 })
    return { ok: true, token: json.tenant_access_token }
  } catch (error) {
    return { ok: false, code: 'token-error', error: safeMsg(error) }
  }
}

async function apiGet(auth, path) {
  const t = await getTenantToken(auth)
  if (!t.ok) return t
  try {
    const { json } = await httpJson(FEISHU_HOST + path, { headers: { authorization: 'Bearer ' + t.token } })
    if (json.code !== 0) {
      return { ok: false, code: 'feishu-' + json.code, error: '飞书接口返回 code=' + json.code + ' msg=' + (json.msg || '') }
    }
    return { ok: true, data: json.data }
  } catch (error) {
    return { ok: false, code: 'feishu-error', error: safeMsg(error) }
  }
}

/** 从任意飞书链接/裸 token 里解析出候选 token 与类型。 */
export function parseFeishuInput(input) {
  const s = String(input || '').trim()
  if (!s) return { kind: 'none', token: '' }
  let m = s.match(/\/(?:base|bitable)\/([A-Za-z0-9]+)/)
  if (m) return { kind: 'app', token: m[1] }
  m = s.match(/\/wiki\/([A-Za-z0-9]+)/)
  if (m) return { kind: 'wiki', token: m[1] }
  m = s.match(/[?&](?:app_token|obj_token)=([A-Za-z0-9]+)/)
  if (m) return { kind: 'app', token: m[1] }
  // 裸 token：没有斜杠就当作 app_token
  if (!s.includes('/')) return { kind: 'app', token: s }
  return { kind: 'unknown', token: s }
}

/** 知识库节点 wikcn… → 真实 app_token（obj_token）。 */
export async function resolveWikiToAppToken(auth, wikiToken) {
  const r = await apiGet(auth, '/open-apis/wiki/v2/spaces/get_node?token=' + encodeURIComponent(wikiToken))
  if (!r.ok) return r
  const node = r.data?.node || {}
  const objType = node.obj_type || node.objType
  const objToken = node.obj_token || node.objToken
  if (!objToken) return { ok: false, code: 'wiki-no-obj', error: '知识库节点没有返回 obj_token' }
  if (objType && objType !== 'bitable') {
    return { ok: false, code: 'wiki-not-bitable', error: '这个知识库节点不是多维表格（类型：' + objType + '）' }
  }
  return { ok: true, appToken: objToken, wikiToken }
}

/** 把用户输入（链接/裸 token/知识库节点）解析成可用 app_token。 */
export async function resolveAppToken(auth, input) {
  const parsed = parseFeishuInput(input)
  if (parsed.kind === 'app') return { ok: true, appToken: parsed.token }
  if (parsed.kind === 'wiki') return resolveWikiToAppToken(auth, parsed.token)
  return { ok: false, code: 'bad-input', error: '无法从输入里识别 app_token：' + String(input || '').slice(0, 120) }
}

/** 列出某多维表格里的所有数据表。 */
export async function listTables(auth, appToken) {
  if (!appToken) return { ok: false, code: 'bad-request', error: '缺少 appToken（多维表格 token）' }
  const r = await apiGet(auth, '/open-apis/bitable/v1/apps/' + encodeURIComponent(appToken) + '/tables?page_size=100')
  if (!r.ok) return r
  const items = Array.isArray(r.data?.items) ? r.data.items : []
  return { ok: true, tables: items.map((t) => ({ tableId: t.table_id, name: t.name })) }
}

/** 列出某数据表的字段。 */
export async function listFields(auth, appToken, tableId) {
  if (!appToken || !tableId) return { ok: false, code: 'bad-request', error: '缺少 appToken 或 tableId' }
  const r = await apiGet(auth, '/open-apis/bitable/v1/apps/' + encodeURIComponent(appToken) + '/tables/' + encodeURIComponent(tableId) + '/fields?page_size=100')
  if (!r.ok) return r
  const items = Array.isArray(r.data?.items) ? r.data.items : []
  return { ok: true, fields: items.map((f) => ({ fieldId: f.field_id, name: f.field_name, type: f.type, uiType: f.ui_type })) }
}

/** 把任意飞书字段值转成可读文本。 */
export function toText(v) {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join(', ')
  if (typeof v === 'object') {
    if (typeof v.text === 'string') return v.text
    if (typeof v.name === 'string') return v.name
    if (typeof v.link === 'string') return v.text ? v.text + ' ' + v.link : v.link
    if (Array.isArray(v.segments)) return v.segments.map((s) => s.text || '').join('')
    if ('value' in v) return toText(v.value)
    try { return JSON.stringify(v) } catch { return '' }
  }
  return String(v)
}

/** 拉取记录（自动翻页，最多 maxPages 页）。 */
export async function listRecords(auth, appToken, tableId, { pageSize = 100, maxPages = 10 } = {}) {
  if (!appToken || !tableId) return { ok: false, code: 'bad-request', error: '缺少 appToken 或 tableId' }
  const all = []
  let pageToken = ''
  for (let page = 0; page < maxPages; page++) {
    const qs = '?page_size=' + pageSize + (pageToken ? '&page_token=' + encodeURIComponent(pageToken) : '')
    const r = await apiGet(auth, '/open-apis/bitable/v1/apps/' + encodeURIComponent(appToken) + '/tables/' + encodeURIComponent(tableId) + '/records' + qs)
    if (!r.ok) return r
    const items = Array.isArray(r.data?.items) ? r.data.items : []
    for (const it of items) all.push({ recordId: it.record_id, fields: it.fields || {} })
    if (!r.data?.has_more || !r.data?.page_token) break
    pageToken = r.data.page_token
  }
  return { ok: true, records: all }
}

/** 连通性 + 能力自检：拿 token，并尝试列出某 appToken 的表（可选）。 */
export async function testFeishu(ctx, overrides = {}) {
  const auth = await resolveFeishuAuth(ctx, overrides)
  if (!auth.ok) return auth
  const token = await getTenantToken(auth)
  if (!token.ok) return token
  const result = { ok: true, appId: auth.appId, botName: auth.botName, tokenOk: true, tables: null }
  const appToken = (overrides.appToken || '').trim()
  if (appToken) {
    const tables = await listTables(auth, appToken)
    if (!tables.ok) { result.tablesError = tables.error; result.tablesCode = tables.code }
    else result.tables = tables.tables
  }
  return result
}
