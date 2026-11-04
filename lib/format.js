/**
 * dsh-notes — 「按语义归类 + 编号排版」（不是总结）。
 *
 * 关键约束：**只做断句 / 归类 / 编号**，绝不总结、不改写、不新增信息；
 * 专有名词、人名、时间、金额、数量、URL、代码等逐字保留。
 *
 * 走宿主 `llm` 服务：provider/model 取 `agentDefaultModel.currentSelection()`，
 * 没有就走配置默认值。任何失败都返回 { ok:false, ... }，客户端回落到原文。
 */

const SYSTEM_PROMPT = [
  '你是需求整理助手。任务：把用户给出的原始聊天/口述文本，按语义归类整理成编号列表（1、2、3……），让阅读更清晰。',
  '',
  '硬性规则（务必遵守）：',
  '1) 绝对不能总结、提炼、改写或缩写，也不能新增原文里没有的信息。只做「断句 + 归类 + 排顺序」。',
  '2) 保留原文措辞：专有名词、人名、地名、时间、金额、数量、比例、URL、代码等必须逐字保留，不要替换同义词。',
  '2.1) 唯一允许的改动：修正明显由 OCR 造成的断字/错字（例如把被拆开的「支扌寺」还原为「支持」、把「测讠式」还原为「测试」）；只在该字词含义毫无歧义时修正，不要臆测内容。',
  '3) 说同一件事的句子合并成一条；不同的事分成不同条。每条是一句完整通顺的话。',
  '4) 去掉纯寒暄、称呼、应答（如「在吗」「收到」「好的」「谢谢」）和单独的时间戳（如「今天 14:32」）；但若这些内容里夹带有效信息，保留其有效部分。',
  '5) 保留原文语言（中文就用中文，夹杂的英文术语原样保留）。',
  '6) 输出格式：只输出整理后的编号列表，每行形如「1. ……」。不要标题、不要前言、不要解释、不要任何额外说明文字。',
  '7) 如果原文本身已经是清晰的分条/编号，就沿用原有分条并规整编号，不要重新拆分或改写。',
  '8) 如果文本太短、无法分条，就原样输出，不要为了凑条数而硬拆。',
].join('\n')

/** 清理模型输出：去代码围栏、去前后空行。 */
function sanitize(text) {
  let s = String(text ?? '').trim()
  s = s.replace(/^```[a-zA-Z]*\s*\n?/, '').replace(/\n?```\s*$/, '')
  return s.trim()
}

/** 把模型流式返回的 chunk 收集成纯文本。 */
async function collectText(stream, signal, timeoutMs) {
  let out = ''
  let failure = null
  const timer = setTimeout(() => { try { signal?.abort?.() } catch { /* ignore */ } }, timeoutMs)
  try {
    for await (const chunk of stream) {
      if (!chunk || typeof chunk !== 'object') continue
      if (chunk.type === 'text-delta' && typeof chunk.text === 'string') out += chunk.text
      else if (chunk.type === 'finish') {
        const kind = chunk.reason && chunk.reason.kind
        if (kind === 'error' || kind === 'aborted') failure = chunk.reason?.failure?.message || kind
      }
    }
  } finally {
    clearTimeout(timer)
  }
  return { out, failure }
}

/**
 * @param {object} deps { llm, selection, timeoutMs }
 * @param {string} text 原始文本
 */
export async function formatText({ llm, selection, timeoutMs = 60000 }, text) {
  const raw = String(text ?? '').trim()
  if (!raw) return { ok: false, code: 'bad-request', error: '文本为空' }
  if (!llm || typeof llm.stream !== 'function') return { ok: false, code: 'llm-unavailable', error: '宿主没有 llm 服务' }
  const provider = selection && typeof selection.provider === 'string' ? selection.provider : ''
  const model = selection && typeof selection.model === 'string' ? selection.model : ''
  if (!provider || !model) return { ok: false, code: 'no-model', error: '没有可用的默认模型' }

  const controller = new AbortController()
  let stream
  try {
    stream = llm.stream({
      provider,
      model,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: [{ type: 'text', text: raw }] }],
      maxTokens: 2000,
      signal: controller.signal,
    })
  } catch (error) {
    return { ok: false, code: 'llm-call-failed', error: error?.message ?? String(error) }
  }

  let collected
  try {
    collected = await collectText(stream, controller.signal, timeoutMs)
  } catch (error) {
    return { ok: false, code: 'llm-call-failed', error: error?.message ?? String(error) }
  }
  if (collected.failure) return { ok: false, code: 'llm-failed', error: collected.failure }
  const cleaned = sanitize(collected.out)
  if (!cleaned) return { ok: false, code: 'llm-empty', error: '模型没有返回内容' }
  return { ok: true, text: cleaned }
}
