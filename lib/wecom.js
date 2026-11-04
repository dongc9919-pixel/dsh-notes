/**
 * dsh-notes — 企业微信「智能表格」只读接入。
 *
 * 平台要求：任何企微开放接口都必须用「企业 CorpID + 自建应用 Secret」换 access_token，
 * 这一步无法绕过（不是本插件能省掉的）。但应用可以自己创建：
 *   企微管理后台 → 我的企业（看 CorpID）→ 应用管理 → 自建 → 创建应用（拿 Secret）
 *   → 给应用开「文档/智能表格」可见范围与权限。
 *
 * 严格只读：只调 get_sheet / get_fields / get_records 三个接口。
 * 代码里不含任何密钥；corpid/secret 由使用者在界面里填写并存进本机（见 config）。
 */

const WECOM_HOST = 'https://qyapi.weixin.qq.com'

function safeMsg(e) { return e && typeof e.message === 'string' && e.message ? e.message : String(e) }

async function httpJson(url, options = {}, timeoutMs = 20000) {
  const signal = AbortSignal.timeout ? AbortSignal.timeout(timeoutMs) : undefined
  const res = await fetch(url, { ...options, signal })
  const txt = await res.text()
  let json
  try { json = JSON.parse(txt) } catch { json = null }
  if (!json) throw new Error('企微返回非 JSON（HTTP ' + res.status + '）：' + txt.slice(0, 200))
  return json
}

const tokenCache = new Map() // corpid|hash(secret) -> { token, exp }

function cacheKey(corpid, secret) {
  // 用 secret 的长度与前 4 位做弱指纹，避免把 secret 明文当键长期驻留
  return corpid + '|' + secret.length + '|' + secret.slice(0, 4)
}

export async function getAccessToken(corpid, corpsecret) {
  if (!corpid || !corpsecret) return { ok: false, code: 'no-credential', error: '缺少 CorpID 或 Secret' }
  const key = cacheKey(corpid, corpsecret)
  const cached = tokenCache.get(key)
  if (cached && cached.exp > Date.now() + 60_000) return { ok: true, token: cached.token }
  try {
    const url = WECOM_HOST + '/cgi-bin/gettoken?corpid=' + encodeURIComponent(corpid) + '&corpsecret=' + encodeURIComponent(corpsecret)
    const j = await httpJson(url)
    if (j.errcode !== 0 || !j.access_token) {
      const hint = j.errcode === 40013 ? '（CorpID 无效）' : j.errcode === 40001 ? '（Secret 无效或与 CorpID 不匹配）' : ''
      return { ok: false, code: 'token-failed-' + j.errcode, error: '获取 access_token 失败：errcode=' + j.errcode + ' ' + (j.errmsg || '') + hint }
    }
    const ttl = Number(j.expires_in) > 0 ? Number(j.expires_in) : 7200
    tokenCache.set(key, { token: j.access_token, exp: Date.now() + ttl * 1000 })
    return { ok: true, token: j.access_token }
  } catch (error) {
    return { ok: false, code: 'token-error', error: safeMsg(error) }
  }
}

async function smartsheetPost(corpid, corpsecret, method, body) {
  const t = await getAccessToken(corpid, corpsecret)
  if (!t.ok) return t
  try {
    const j = await httpJson(WECOM_HOST + '/cgi-bin/wedoc/smartsheet/' + method + '?access_token=' + encodeURIComponent(t.token), {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body || {}),
    })
    if (j.errcode !== 0) {
      const map = {
        48002: '（无接口权限：需给自建应用开通文档/智能表格权限，并把表格加入应用可见范围）',
        60020: '（IP 不在可信 IP 列表：请把本机出口 IP 加入应用的企业可信 IP）',
        301002: '（无权限操作该文档：请把该智能表格授权给应用）',
        40001: '（access_token 或 Secret 无效）',
      }
      return { ok: false, code: 'wecom-' + j.errcode, error: '企微接口 errcode=' + j.errcode + ' ' + (j.errmsg || '') + (map[j.errcode] || '') }
    }
    return { ok: true, data: j }
  } catch (error) {
    return { ok: false, code: 'wecom-error', error: safeMsg(error) }
  }
}

/** 从链接或裸 id 里解析智能表格 docid。 */
export function parseDocId(input) {
  const s = String(input || '').trim()
  if (!s) return ''
  const q = s.match(/[?&]docid=([A-Za-z0-9_\-%.]+)/i)
  if (q) return decodeURIComponent(q[1])
  const p = s.match(/\/(?:smartsheet|doc|sheet)\/([A-Za-z0-9_\-%.]+)/i)
  if (p) return decodeURIComponent(p[1])
  return s
}

/** 子表列表。 */
export async function listSheets(cred, docid) {
  if (!docid) return { ok: false, code: 'bad-request', error: '缺少 docid（智能表格 id）' }
  const r = await smartsheetPost(cred.corpid, cred.secret, 'get_sheet', { docid })
  if (!r.ok) return r
  const list = r.data.sheet_list || r.data.sheets || []
  return { ok: true, sheets: list.map((x) => ({ sheetId: x.sheet_id || x.sheetId, title: x.title || x.name || '' })) }
}

/** 字段列表。 */
export async function listFields(cred, docid, sheetId) {
  const r = await smartsheetPost(cred.corpid, cred.secret, 'get_fields', { docid, sheet_id: sheetId })
  if (!r.ok) return r
  const list = r.data.fields || []
  return { ok: true, fields: list.map((f) => ({ fieldId: f.field_id || f.fieldId, title: f.field_title || f.title || '', type: f.field_type })) }
}

/** 单元格值（数组）转文本。 */
export function cellToText(v) {
  if (v === null || v === undefined) return ''
  if (!Array.isArray(v)) {
    if (typeof v === 'object') {
      if (typeof v.text === 'string') return v.text
      if (typeof v.name === 'string') return v.name
      if (typeof v.link === 'string') return v.text ? v.text : v.link
      if ('value' in v) return cellToText(v.value)
      try { return JSON.stringify(v) } catch { return '' }
    }
    return String(v)
  }
  return v.map((el) => {
    if (el === null || el === undefined) return ''
    if (typeof el === 'string' || typeof el === 'number' || typeof el === 'boolean') return String(el)
    if (typeof el === 'object') {
      if (typeof el.text === 'string') return el.text
      if (typeof el.name === 'string') return el.name
      if (typeof el.link === 'string') return el.text ? el.text : el.link
      if (el.number !== undefined) return String(el.number)
      if ('value' in el) return cellToText(el.value)
      try { return JSON.stringify(el) } catch { return '' }
    }
    return ''
  }).filter((x) => x !== '').join(', ')
}

/**
 * 拉取记录。values 可能以 field_id 或 field_title 为键，统一转成「以字段标题为键」的 cells。
 */
export async function listRecords(cred, docid, sheetId, { limit = 100, maxPages = 10 } = {}) {
  const fieldsRes = await listFields(cred, docid, sheetId)
  const idToTitle = {}
  const fieldTitles = []
  if (fieldsRes.ok) for (const f of fieldsRes.fields) { if (f.fieldId) idToTitle[f.fieldId] = f.title; fieldTitles.push(f.title) }

  const records = []
  let offset = 0
  for (let page = 0; page < maxPages; page++) {
    const r = await smartsheetPost(cred.corpid, cred.secret, 'get_records', { docid, sheet_id: sheetId, offset, limit })
    if (!r.ok) return r
    const list = r.data.records || []
    for (const rec of list) {
      const cells = {}
      const values = rec.values || rec.fields || {}
      for (const [k, v] of Object.entries(values)) {
        const title = idToTitle[k] || k
        cells[title] = cellToText(v)
      }
      records.push({ recordId: rec.record_id || rec.recordId || ('r' + records.length), cells })
    }
    const hasMore = r.data.has_more === true
    if (!hasMore || list.length === 0) break
    if (typeof r.data.next === 'number') offset = r.data.next
    else offset += limit
  }
  return { ok: true, records, fieldTitles }
}

/** 连通性 + 能力自检。 */
export async function testWecom(cred, docid) {
  const t = await getAccessToken(cred.corpid, cred.secret)
  if (!t.ok) return t
  const result = { ok: true, corpid: cred.corpid, tokenOk: true, sheets: null }
  if (docid) {
    const s = await listSheets(cred, docid)
    if (!s.ok) { result.sheetsError = s.error; result.sheetsCode = s.code } else result.sheets = s.sheets
  }
  return result
}
