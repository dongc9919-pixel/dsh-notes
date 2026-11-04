#!/usr/bin/env node
/**
 * dsh-notes 静态自检（CI 用，无第三方依赖）。
 *
 * 检查项：
 *   1. 所有 JS 文件语法合法（node --check 等价，用 vm 编译）
 *   2. 所有 JSON 文件可解析，且 locale 含 meta.title / meta.description
 *   3. cordis.patch.yml 结构合法（insert 列表、id/name 字段）
 *   4. package.json 清单自洽：dsh.bundle.patch 存在、exports 指向真实文件、icon 合法
 *   5. 源码不含硬编码密钥 / 私密链接
 *   6. Host 半边可被 import（会执行模块顶层代码）
 *   7. Client 半边在模拟 loader 下可加载，并注册到预期槽位
 *
 * 退出码：0 全部通过；1 有失败项。
 */

import { readFile, readdir, stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { dirname, join, relative, resolve } from 'node:path'
import { spawnSync } from 'node:child_process'
import vm from 'node:vm'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')

const results = []
const record = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  const mark = ok ? '  ok  ' : ' FAIL '
  console.log(`[${mark}] ${name}${detail ? ' — ' + detail : ''}`)
}

async function walk(dir, acc = []) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git') continue
    const full = join(dir, entry.name)
    if (entry.isDirectory()) await walk(full, acc)
    else acc.push(full)
  }
  return acc
}

// ── 1. JS 语法 ──────────────────────────────────────────────
async function checkJsSyntax(files) {
  const jsFiles = files.filter((f) => f.endsWith('.js') || f.endsWith('.mjs'))
  const bad = []
  for (const file of jsFiles) {
    // 用 node --check 检查：ESM 与 CommonJS 都能正确解析
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
    if (result.status !== 0) {
      const detail = (result.stderr || '').split('\n').filter(Boolean).slice(0, 3).join(' ')
      bad.push(`${relative(ROOT, file)}: ${detail}`)
    }
  }
  record('JS 语法', bad.length === 0, bad.length ? bad.join(' ; ') : `${jsFiles.length} 个文件`)
}

// ── 2. JSON 与 locale ──────────────────────────────────────
async function checkJson(files) {
  const jsonFiles = files.filter((f) => f.endsWith('.json'))
  const bad = []
  for (const file of jsonFiles) {
    try {
      JSON.parse(await readFile(file, 'utf8'))
    } catch (error) {
      bad.push(`${relative(ROOT, file)}: ${error.message}`)
    }
  }
  record('JSON 可解析', bad.length === 0, bad.length ? bad.join(' ; ') : `${jsonFiles.length} 个文件`)

  const localeDir = join(ROOT, 'locale')
  const localeFiles = jsonFiles.filter((f) => f.startsWith(localeDir))
  const missing = []
  for (const file of localeFiles) {
    const data = JSON.parse(await readFile(file, 'utf8'))
    if (!data?.meta?.title || !data?.meta?.description) {
      missing.push(relative(ROOT, file))
    }
  }
  record('locale 含 meta.title/description', localeFiles.length > 0 && missing.length === 0,
    missing.length ? '缺少: ' + missing.join(', ') : `${localeFiles.length} 个语言`)
}

// ── 3. cordis.patch.yml ────────────────────────────────────
async function checkPatch() {
  const file = join(ROOT, 'cordis.patch.yml')
  let text
  try {
    text = await readFile(file, 'utf8')
  } catch {
    return record('cordis.patch.yml', false, '文件不存在')
  }
  // 极简结构校验：必须有 insert 段、id 与 name
  const hasInsert = /^\s*-\s*insert:\s*$/m.test(text)
  const hasId = /^\s*-\s*id:\s*\S+/m.test(text)
  const hasName = /^\s*name:\s*\S+/m.test(text)
  const problems = []
  if (!hasInsert) problems.push('缺少 insert 段')
  if (!hasId) problems.push('缺少 id')
  if (!hasName) problems.push('缺少 name')
  record('cordis.patch.yml 结构', problems.length === 0, problems.join(' ; ') || 'insert + id + name')
}

// ── 4. package.json 清单自洽 ───────────────────────────────
async function checkManifest() {
  const pkgPath = join(ROOT, 'package.json')
  const pkg = JSON.parse(await readFile(pkgPath, 'utf8'))
  const problems = []

  if (!pkg.name) problems.push('缺少 name')
  if (!pkg.version) problems.push('缺少 version')
  if (!/^\d+\.\d+\.\d+/.test(pkg.version || '')) problems.push('version 不是语义化版本')

  const patchRel = pkg?.dsh?.bundle?.patch
  if (!patchRel) problems.push('缺少 dsh.bundle.patch')
  else {
    try { await stat(join(ROOT, patchRel)) } catch { problems.push('dsh.bundle.patch 指向的文件不存在: ' + patchRel) }
  }

  // exports 指向的文件必须存在（通配符跳过）
  for (const [key, value] of Object.entries(pkg.exports || {})) {
    const target = typeof value === 'string' ? value : value?.default
    if (typeof target !== 'string' || target.includes('*')) continue
    try { await stat(join(ROOT, target)) } catch { problems.push(`exports["${key}"] 指向不存在的文件: ${target}`) }
  }

  // files 里声明的路径应当能在仓库中找到（通配符只校验目录部分）
  for (const entry of pkg.files || []) {
    const base = entry.split('*')[0].replace(/\/$/, '')
    if (!base) continue
    try { await stat(join(ROOT, base)) } catch { problems.push('files 声明的路径不存在: ' + entry) }
  }

  record('package.json 清单自洽', problems.length === 0, problems.join(' ; ') || `${pkg.name}@${pkg.version}`)

  // 图标
  const iconRel = typeof pkg.icon === 'string' ? pkg.icon : './icon.svg'
  let iconOk = false
  let iconDetail = ''
  try {
    const iconPath = join(ROOT, iconRel.replace(/^\.\//, ''))
    const info = await stat(iconPath)
    const bytes = await readFile(iconPath)
    if (info.size > 256 * 1024) iconDetail = '超过 256KiB 上限'
    else if (!iconPath.endsWith('.svg')) iconOk = info.size > 0
    else iconOk = /<svg[\s>]/i.test(bytes.toString('utf8'))
    if (!iconOk && !iconDetail) iconDetail = '不是有效的 SVG'
    else if (iconOk) iconDetail = `${iconRel}, ${info.size} 字节`
  } catch {
    iconDetail = '图标文件不存在: ' + iconRel
  }
  record('图标有效', iconOk, iconDetail)
}

// ── 5. 敏感信息扫描 ────────────────────────────────────────
async function checkSecrets(files) {
  // 扫描规则本身写在代码里，必须跳过自检脚本，否则会自我误报
  const selfPath = fileURLToPath(import.meta.url)
  const patterns = [
    { label: '飞书 AppID', re: /cli_[a-z0-9]{16}/i },
    { label: '企微 CorpID', re: /\bww[a-z0-9]{15,}\b/i },
    { label: '飞书密钥引用', re: /DSH_FEISHU_APP_SECRET/ },
    { label: '知识库 token', re: /\bwikcn[A-Za-z0-9]{10,}/ },
    { label: '多维表格 token', re: /\bbascn[A-Za-z0-9]{10,}/ },
    { label: '疑似硬编码 Secret', re: /(?:secret|token|password|apiKey)\s*[:=]\s*['"][A-Za-z0-9_\-]{20,}['"]/i },
  ]
  const hits = []
  for (const file of files) {
    if (file === selfPath) continue
    if (!/\.(js|mjs|json|yml|yaml|md)$/.test(file)) continue
    const text = await readFile(file, 'utf8')
    for (const { label, re } of patterns) {
      const m = text.match(re)
      if (m) hits.push(`${relative(ROOT, file)}: ${label} -> ${m[0].slice(0, 12)}…`)
    }
  }
  record('无硬编码密钥', hits.length === 0, hits.length ? hits.join(' ; ') : '未发现敏感串')
}

// ── 6. Host 半边可 import ──────────────────────────────────
async function checkHostImport() {
  try {
    const mod = await import(new URL('../lib/index.js', import.meta.url).href)
    const problems = []
    if (typeof mod.apply !== 'function') problems.push('缺少 apply 导出')
    if (mod.name !== 'dsh-notes') problems.push('name 不是 dsh-notes')
    record('Host 半边可加载', problems.length === 0, problems.join(' ; ') || 'apply 已导出')
  } catch (error) {
    record('Host 半边可加载', false, error.message)
  }
}

// ── 7. Client 半边在模拟 loader 下可加载 ───────────────────
async function checkClientLoad() {
  const file = join(ROOT, 'lib/client.js')
  const source = await readFile(file, 'utf8')
  let captured = null
  const sandbox = {
    window: { __ModuleLoader__: { load: (mod) => { captured = mod } } },
    console,
  }
  try {
    vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' })
  } catch (error) {
    return record('Client 半边可加载', false, '执行失败: ' + error.message)
  }
  if (!captured) return record('Client 半边可加载', false, '未调用 __ModuleLoader__.load')
  if (captured.id !== 'dsh-notes') return record('Client 半边可加载', false, '注册 id 不是 dsh-notes: ' + captured.id)

  // 用假 React 跑 factory + apply，确认两个槽位都注册
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState: (init) => [typeof init === 'function' ? init() : init, () => {}],
    useEffect: () => {}, useMemo: (fn) => fn(), useRef: (v) => ({ current: v }),
    useSyncExternalStore: (_sub, get) => get(), useCallback: (fn) => fn,
  }
  const require = (name) => {
    if (name === 'react') return React
    throw new Error('未预期的模块依赖: ' + name)
  }
  let factoryModule
  try {
    factoryModule = captured.factory(require)
  } catch (error) {
    return record('Client 半边可加载', false, 'factory 执行失败: ' + error.message)
  }

  const registered = []
  const ctx = {
    get: () => undefined,
    effect: (fn) => { try { fn() } catch { /* 无 document 环境下的样式注入失败可忽略 */ } return () => {} },
    locale: { bind: () => (key) => key, register: () => () => {} },
    slots: {
      inject: (key, cb) => { registered.push({ kind: 'inject', key }); try { cb() } catch { /* ignore */ } return () => {} },
      register: (options) => { registered.push({ kind: 'register', options }); return () => {} },
    },
  }
  try {
    factoryModule.apply(ctx)
  } catch (error) {
    return record('Client 半边可加载', false, 'apply 执行失败: ' + error.message)
  }

  const registeredKeys = registered.filter((r) => r.kind === 'register').map((r) => r.options.name)
  const expected = ['sidebar.panellist', 'main']
  const missing = expected.filter((k) => !registeredKeys.includes(k))
  record('Client 半边可加载', missing.length === 0,
    missing.length ? '缺少槽位注册: ' + missing.join(', ') : '注册 ' + registeredKeys.join(' + '))

  // 侧栏 id 与 main key 必须一致（宿主靠这两个相等值对应）
  const row = registered.find((r) => r.kind === 'register' && r.options.name === 'sidebar.panellist')
  const panel = registered.find((r) => r.kind === 'register' && r.options.name === 'main')
  const sameId = row && panel && row.options.id === panel.options.key && row.options.id === 'dsh-notes'
  record('侧栏 id 与面板 key 一致', Boolean(sameId),
    sameId ? 'dsh-notes' : `sidebar.panellist.id=${row?.options.id} / main.key=${panel?.options.key}`)
}

// ── 主流程 ────────────────────────────────────────────────
async function main() {
  console.log('dsh-notes 自检\n' + '='.repeat(48))
  const files = await walk(ROOT)

  await checkJsSyntax(files)
  await checkJson(files)
  await checkPatch()
  await checkManifest()
  await checkSecrets(files)
  await checkHostImport()
  await checkClientLoad()

  const failed = results.filter((r) => !r.ok)
  console.log('='.repeat(48))
  console.log(`${results.length - failed.length}/${results.length} 通过`)
  if (failed.length) {
    console.error('\n失败项：')
    for (const f of failed) console.error(`  - ${f.name}: ${f.detail}`)
    process.exit(1)
  }
  console.log('全部通过 ✓')
}

main().catch((error) => {
  console.error('自检脚本自身出错：', error)
  process.exit(1)
})
