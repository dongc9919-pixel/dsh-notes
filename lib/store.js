/**
 * dsh-notes — 便签数据仓库（Host 侧）。
 *
 * 设计要点：
 *   - 数据落在 `<DSH_HOME>/dsh-notes/notes.v1.json`，不写死任何绝对路径；
 *   - 纯 JSON、原子替换（temp + rename），损坏时明确报错而不是静默清空；
 *   - 串行队列保证同一进程内多次读改写不互相覆盖；
 *   - UI（HTTP 路由）与 Agent 工具调用**同一套** store 方法，行为完全一致。
 */

import * as fs from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { randomBytes } from 'node:crypto'

/** 便签生命周期状态。 */
export const STATUSES = ['backlog', 'doing', 'done', 'archived']

/** 字段上限。 */
export const LIMITS = {
  title: 200,
  body: 40000,
  category: 40,
  tags: 30,
  tagLength: 40,
  notes: 5000,
}

/** DSH 的 HOME（读环境变量，退回 ~/.dsh）。 */
export function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv
  return join(homedir(), '.dsh')
}

/** 默认数据目录：`<DSH_HOME>/dsh-notes`。 */
export function defaultDataDir() {
  return join(dshHome(), 'dsh-notes')
}

const isRecord = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const fail = (message, code = 'bad-request') => Object.assign(new Error(message), { code })
const newId = () => 'n_' + Date.now().toString(36) + randomBytes(4).toString('hex')

function normalizeTags(tags) {
  if (!Array.isArray(tags)) throw fail('标签必须是数组')
  const out = []
  const seen = new Set()
  for (const item of tags) {
    if (typeof item !== 'string') throw fail('标签必须是文本')
    const tag = item.trim()
    if (!tag) continue
    if (tag.length > LIMITS.tagLength || /[\x00-\x1f]/.test(tag)) {
      throw fail(`每个标签最多 ${LIMITS.tagLength} 字符，且不能含控制字符`)
    }
    const key = tag.toLowerCase()
    if (!seen.has(key)) {
      out.push(tag)
      seen.add(key)
    }
  }
  if (out.length > LIMITS.tags) throw fail(`每条便签最多 ${LIMITS.tags} 个标签`)
  return out
}

/** 校验并归一化一次写入（创建或局部更新）。 */
function normalizePatch(patch, { creating = false } = {}) {
  if (!isRecord(patch)) throw fail('便签必须是对象')
  const out = {}
  if (patch.title !== undefined) {
    if (typeof patch.title !== 'string') throw fail('标题必须是文本')
    const v = patch.title.trim()
    if (!v && creating) throw fail('标题不能为空')
    if (v.length > LIMITS.title) throw fail(`标题最多 ${LIMITS.title} 字符`)
    out.title = v
  } else if (creating) {
    throw fail('标题不能为空')
  }
  if (patch.body !== undefined) {
    if (typeof patch.body !== 'string') throw fail('正文必须是文本')
    if (patch.body.includes('\0')) throw fail('正文含非法字符')
    if (patch.body.length > LIMITS.body) throw fail(`正文最多 ${LIMITS.body} 字符`)
    out.body = patch.body
  }
  if (patch.category !== undefined) {
    if (typeof patch.category !== 'string') throw fail('分类必须是文本')
    const v = patch.category.trim()
    if (v.length > LIMITS.category) throw fail(`分类最多 ${LIMITS.category} 字符`)
    out.category = v
  }
  if (patch.status !== undefined) {
    if (!STATUSES.includes(patch.status)) throw fail('状态无效')
    out.status = patch.status
  }
  if (patch.priority !== undefined) {
    const v = patch.priority
    if (v !== null && (!Number.isInteger(v) || v < 1 || v > 5)) throw fail('优先级必须是 1–5 的整数或空')
    out.priority = v
  }
  if (patch.tags !== undefined) out.tags = normalizeTags(patch.tags)
  if (patch.sessionId !== undefined) {
    const v = patch.sessionId
    if (v !== null && typeof v !== 'string') throw fail('会话 id 必须是文本')
    out.sessionId = v && v.trim() ? v.trim() : null
  }
  return out
}

/** 精简投影：工具与列表用，避免把整篇正文塞进每一行。 */
export function summarize(note, { withBody = false } = {}) {
  return {
    id: note.id,
    title: note.title,
    category: note.category,
    status: note.status,
    priority: note.priority,
    tags: note.tags,
    sessionId: note.sessionId,
    createdAt: note.createdAt,
    updatedAt: note.updatedAt,
    revision: note.revision,
    ...(withBody ? { body: note.body } : {}),
  }
}

/**
 * 创建便签仓库。
 * @param {string} directory 数据目录（通常是 `<DSH_HOME>/dsh-notes`）
 */
export function createNoteStore(directory) {
  if (typeof directory !== 'string' || !directory) throw fail('无法定位便签数据目录', 'unavailable')
  const root = resolve(directory)
  const path = join(root, 'notes.v1.json')

  let queue = Promise.resolve()
  const enqueue = (operation) => {
    const result = queue.then(operation)
    queue = result.catch(() => {})
    return result
  }

  async function read() {
    try {
      const parent = await fs.lstat(root)
      if (!parent.isDirectory() || parent.isSymbolicLink()) throw fail('便签数据目录无效', 'unavailable')
      const info = await fs.lstat(path)
      if (!info.isFile() || info.isSymbolicLink()) throw fail('便签数据文件必须是普通文件', 'unavailable')
      const content = await fs.readFile(path, 'utf8')
      const state = JSON.parse(content)
      if (!isRecord(state) || state.version !== 1 || !isRecord(state.notes)) throw new Error('schema')
      return state
    } catch (error) {
      if (error && error.code === 'ENOENT') return { version: 1, notes: {} }
      if (error && (error.code === 'unavailable')) throw error
      throw fail('便签文件损坏或版本不兼容，已停止写入；请先备份并检查 ' + path, 'corrupt')
    }
  }

  async function publish(state) {
    await fs.mkdir(root, { recursive: true, mode: 0o700 })
    const temp = join(root, '.notes.' + randomBytes(6).toString('hex') + '.tmp')
    await fs.writeFile(temp, JSON.stringify(state, null, 2) + '\n', 'utf8')
    try {
      await fs.rename(temp, path)
    } catch (error) {
      try { await fs.rm(temp, { force: true }) } catch { /* 未提交的临时文件 */ }
      throw error
    }
  }

  return {
    path,

    /** 列出全部便签（按更新时间倒序）。 */
    list() {
      return enqueue(async () => {
        const state = await read()
        return Object.values(state.notes)
          .filter((note) => isRecord(note) && typeof note.id === 'string')
          .sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
      })
    },

    /** 读取单条。 */
    get(id) {
      return enqueue(async () => {
        const state = await read()
        const note = state.notes[id]
        return isRecord(note) ? note : null
      })
    },

    /** 新建或更新（有 id 且存在即更新，否则新建）。返回保存后的完整便签。 */
    upsert(patch) {
      return enqueue(async () => {
        const state = await read()
        const id = typeof patch?.id === 'string' && patch.id.trim() ? patch.id.trim() : null
        const existing = id && isRecord(state.notes[id]) ? state.notes[id] : null
        const t = Date.now()

        if (existing) {
          const normalized = normalizePatch(patch, { creating: false })
          if (Object.keys(normalized).length === 0) return existing
          const next = {
            ...existing,
            ...normalized,
            revision: (Number.isSafeInteger(existing.revision) ? existing.revision : 0) + 1,
            updatedAt: t,
          }
          if (!Number.isSafeInteger(next.revision)) throw fail('版本号超出范围', 'unavailable')
          await publish({ version: 1, notes: { ...state.notes, [id]: next } })
          return next
        }

        if (Object.keys(state.notes).length >= LIMITS.notes) throw fail('便签数量已达上限')
        const normalized = normalizePatch(patch, { creating: true })
        const note = {
          id: id || newId(),
          title: normalized.title,
          body: normalized.body ?? '',
          category: normalized.category ?? '',
          status: normalized.status ?? 'backlog',
          priority: normalized.priority ?? null,
          tags: normalized.tags ?? [],
          sessionId: normalized.sessionId ?? null,
          createdAt: t,
          updatedAt: t,
          revision: 1,
        }
        await publish({ version: 1, notes: { ...state.notes, [note.id]: note } })
        return note
      })
    },

    /** 删除一条。返回是否真的删除了。 */
    remove(id) {
      return enqueue(async () => {
        const state = await read()
        if (!isRecord(state.notes[id])) return false
        const notes = { ...state.notes }
        delete notes[id]
        await publish({ version: 1, notes })
        return true
      })
    },

    /** 关联/解绑一个 DSH 会话。 */
    linkSession(id, sessionId) {
      return this.upsert({ id, sessionId: sessionId ?? null })
    },
  }
}
