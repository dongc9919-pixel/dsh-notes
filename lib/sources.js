/**
 * dsh-notes — 表格「来源」与「企业微信凭证」的本地存取。
 *
 * 一条来源 = 一个表格里的一个数据表 + 列映射，provider 区分 feishu / wecom。
 * 存于 `<DSH_HOME>/dsh-notes/tables.v1.json`（原子写、纯 JSON）。
 *
 * 企业微信 CorpID/Secret 单独存于 `wecom-credentials.v1.json`（仅本机、明文，
 * 便于换电脑后重新填写；不写进便签数据、不打日志）。
 */

import * as fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'
import { dshHome } from './store.js'

const fail = (m, code = 'bad-request') => Object.assign(new Error(m), { code })
const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const newId = (p) => p + '_' + Date.now().toString(36) + randomBytes(3).toString('hex')

export function dataDir() { return join(dshHome(), 'dsh-notes') }

function normalizeMapping(m) {
  const out = {}
  if (!isRecord(m)) return out
  for (const key of ['title', 'body', 'category', 'status', 'priority', 'tags']) {
    const v = m[key]
    if (typeof v === 'string' && v.trim()) out[key] = v.trim()
    else if (v === null) out[key] = null
  }
  return out
}

async function readJson(path, fallback) {
  try {
    const info = await fs.lstat(path)
    if (!info.isFile() || info.isSymbolicLink()) throw fail('文件无效', 'unavailable')
    const state = JSON.parse(await fs.readFile(path, 'utf8'))
    if (!isRecord(state) || state.version !== 1) throw new Error('schema')
    return state
  } catch (e) {
    if (e && e.code === 'ENOENT') return fallback
    if (e && e.code === 'unavailable') throw e
    throw fail('配置文件损坏：' + path, 'corrupt')
  }
}

async function writeJson(path, state) {
  await fs.mkdir(join(path, '..'), { recursive: true, mode: 0o700 })
  const temp = path + '.' + randomBytes(6).toString('hex') + '.tmp'
  await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf8')
  await fs.rename(temp, path)
}

/**
 * 统一的表格来源仓库。文件 tables.v1.json；若旧版 feishu-sources.v1.json 存在会自动兼容读取。
 */
export function createSourceStore(directory = dataDir()) {
  const root = resolve(directory)
  const path = join(root, 'tables.v1.json')
  const legacy = join(root, 'feishu-sources.v1.json')
  let queue = Promise.resolve()
  const enqueue = (op) => { const r = queue.then(op); queue = r.catch(() => {}); return r }

  async function read() {
    const state = await readJson(path, { version: 1, sources: {} })
    if (!isRecord(state.sources)) state.sources = {}
    // 兼容早期的 feishu-sources.v1.json
    if (Object.keys(state.sources).length === 0) {
      try {
        const old = await readJson(legacy, null)
        if (old && isRecord(old.sources)) {
          for (const [id, s] of Object.entries(old.sources)) state.sources[id] = { ...s, provider: 'feishu' }
        }
      } catch { /* ignore */ }
    }
    return state
  }

  return {
    path,
    list() { return enqueue(async () => Object.values((await read()).sources).sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))) },
    upsert(input) {
      return enqueue(async () => {
        const state = await read()
        const id = typeof input?.id === 'string' && input.id.trim() ? input.id.trim() : newId(input?.provider === 'wecom' ? 'ws' : 'fs')
        const prev = isRecord(state.sources[id]) ? state.sources[id] : null
        const provider = (input?.provider || prev?.provider) === 'wecom' ? 'wecom' : 'feishu'
        const name = String(input?.name ?? prev?.name ?? '').trim()
        if (!name) throw fail('来源名称不能为空')
        const base = {
          id, provider, name,
          mapping: normalizeMapping(input?.mapping ?? prev?.mapping ?? {}),
          updatedAt: Date.now(),
          createdAt: prev?.createdAt ?? Date.now(),
        }
        let source
        if (provider === 'wecom') {
          const docid = String(input?.docid ?? prev?.docid ?? '').trim()
          const sheetId = String(input?.sheetId ?? prev?.sheetId ?? '').trim()
          if (!docid || !sheetId) throw fail('docid 和 sheetId 必填')
          source = { ...base, docid, sheetId, sheetTitle: String(input?.sheetTitle ?? prev?.sheetTitle ?? '') }
        } else {
          const appToken = String(input?.appToken ?? prev?.appToken ?? '').trim()
          const tableId = String(input?.tableId ?? prev?.tableId ?? '').trim()
          if (!appToken || !tableId) throw fail('appToken 和 tableId 必填')
          source = { ...base, appToken, tableId, tableName: String(input?.tableName ?? prev?.tableName ?? '') }
        }
        await writeJson(path, { version: 1, sources: { ...state.sources, [id]: source } })
        return source
      })
    },
    remove(id) {
      return enqueue(async () => {
        const state = await read()
        if (!isRecord(state.sources[id])) return false
        const sources = { ...state.sources }; delete sources[id]
        await writeJson(path, { version: 1, sources })
        return true
      })
    },
  }
}

/** 企业微信凭证（CorpID + Secret）本地存取。 */
export function createWecomCredStore(directory = dataDir()) {
  const path = join(directory, 'wecom-credentials.v1.json')
  return {
    path,
    async get() {
      const state = await readJson(path, { version: 1, corpid: '', secret: '' })
      return { corpid: String(state.corpid || ''), secret: String(state.secret || ''), configured: Boolean(state.corpid && state.secret) }
    },
    async set({ corpid, secret }) {
      const next = { version: 1, corpid: String(corpid || '').trim(), secret: String(secret || '').trim(), updatedAt: Date.now() }
      await writeJson(path, next)
      return { corpid: next.corpid, configured: Boolean(next.corpid && next.secret) }
    },
  }
}
