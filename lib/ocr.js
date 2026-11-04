/**
 * dsh-notes — 截图识别（本机 OCR）。
 *
 * 思路：把浏览器传上来的图片 base64 解码后写进**系统临时目录**，先用
 * System.Drawing 放大到约 2.5 倍（小字识别率显著提升），再调用 Windows
 * 自带的 OCR 引擎（Windows.Media.Ocr，中文 zh-Hans-CN）抽文字，最后把临时
 * 图片、放大副本和脚本**立刻删除**——原图不落库、不留存。
 *
 * 为什么走 PowerShell 5.1（System32 里的 powershell.exe）：
 *   - WinRT 的 OCR API 只有 Windows 有，Node/Electron（V8/Chromium）拿不到；
 *     本机 64 位 PowerShell 5.1 能直接调 WinRT。
 *   - 实测 zh-Hans-CN 引擎 + 2.5 倍放大对中文截图的识别质量足以做「需求草稿」。
 *
 * 容错：任何一步失败都返回 { ok:false, code, error }，绝不让插件或请求崩。
 */

import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'

const PS_CANDIDATES = [
  'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
  'C:\\WINDOWS\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
]

/** 内联 OCR 脚本：放大 → 识别 → JSON 写进 OutPath（UTF-8）。 */
const PS_SCRIPT = `param([string]$ImagePath, [string]$ScaledPath, [string]$OutPath)
$ErrorActionPreference = 'Stop'
$enc = New-Object System.Text.UTF8Encoding($false)
function Write-Json($obj) {
  $json = $obj | ConvertTo-Json -Depth 6 -Compress
  [System.IO.File]::WriteAllText($OutPath, $json, $enc)
}
try {
  Add-Type -AssemblyName System.Drawing | Out-Null
  Add-Type -AssemblyName System.Runtime.WindowsRuntime | Out-Null
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Storage.StorageFile, Windows.Foundation, ContentType=WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Foundation, ContentType=WindowsRuntime]
  $asTaskGeneric = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
      $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation\`1'
  })[0]
  function Await($op, $t) {
    $task = $asTaskGeneric.MakeGenericMethod($t).Invoke($null, @($op))
    $task.Wait(-1) | Out-Null
    $task.Result
  }
  # ── 1. System.Drawing 放大到约 2.5 倍（宽上限 3200）──
  $src = [System.Drawing.Image]::FromFile($ImagePath)
  try {
    $ow = [double]$src.Width
    $oh = [double]$src.Height
    $scale = 1.0
    if ($ow -gt 0 -and $ow * 2.5 -le 3200) { $scale = 2.5 }
    elseif ($ow -gt 0) { $scale = [Math]::Min(2.5, 3200.0 / $ow) }
    if ($scale -lt 1.0) { $scale = 1.0 }
    $nw = [int][Math]::Max(1, [Math]::Round($ow * $scale))
    $nh = [int][Math]::Max(1, [Math]::Round($oh * $scale))
    $bmp = New-Object System.Drawing.Bitmap($nw, $nh)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    try {
      $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
      $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
      $g.DrawImage($src, 0, 0, $nw, $nh)
    } finally { $g.Dispose() }
    $bmp.Save($ScaledPath, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
  } finally { $src.Dispose() }

  # ── 2. WinRT OCR 识别放大后的图 ──
  $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ScaledPath)) ([Windows.Storage.StorageFile])
  $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
  $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $bitmap = Await ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage([Windows.Globalization.Language]::new('zh-Hans-CN'))
  if ($null -eq $engine) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if ($null -eq $engine) { Write-Json @{ ok = $false; code = 'no-ocr-engine'; error = '系统没有可用的 OCR 语言引擎' }; exit 0 }
  $result = Await ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  $lines = @()
  foreach ($ln in $result.Lines) { $lines += [string]$ln.Text }
  Write-Json @{ ok = $true; lang = [string]$engine.RecognizerLanguage.LanguageTag; text = [string]$result.Text; lines = $lines }
} catch {
  Write-Json @{ ok = $false; code = 'ocr-failed'; error = $_.Exception.Message }
}
`

export function ocrSupport() {
  if (process.platform !== 'win32') return { supported: false, reason: 'only-windows' }
  const ps = PS_CANDIDATES.find((p) => existsSync(p))
  if (!ps) return { supported: false, reason: 'no-powershell' }
  return { supported: true, powershell: ps }
}

/** 去掉中日韩字符之间的多余空格（Windows OCR 会把每个字拆开），并整理标点。 */
function tidyLine(line) {
  let s = String(line ?? '')
  s = s.replace(/(?<=[\u4e00-\u9fff\u3000-\u303f])[ \t]+(?=[\u4e00-\u9fff\u3000-\u303f])/g, '')
  s = s.replace(/[ \t]{2,}/g, ' ')
  s = s.replace(/．/g, '.')
  s = s.replace(/\s+([，。、；：！？）])/g, '$1')
  s = s.replace(/([（])\s+/g, '$1')
  return s.trim()
}

function runPowershell(psPath, args, timeoutMs) {
  return new Promise((resolveRun) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const child = spawn(psPath, ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', ...args], { windowsHide: true })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill('SIGKILL') } catch { /* ignore */ }
      resolveRun({ ok: false, code: 'ocr-timeout', error: '识别超时（' + timeoutMs + 'ms）' })
    }, timeoutMs)
    child.stdout?.on('data', (d) => { stdout += d.toString() })
    child.stderr?.on('data', (d) => { stderr += d.toString() })
    child.on('error', (err) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ ok: false, code: 'ocr-spawn-failed', error: err.message })
    })
    child.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolveRun({ ok: true, code, stdout, stderr })
    })
  })
}

/**
 * 识别一张图片（Buffer）里的文字。
 * @returns {Promise<{ok:boolean, text?:string, lines?:string[], lang?:string, code?:string, error?:string}>}
 */
export async function ocrImageBuffer(buffer, { timeoutMs = 30000 } = {}) {
  const support = ocrSupport()
  if (!support.supported) return { ok: false, code: 'ocr-unavailable', error: '本机不支持 OCR：' + support.reason }
  if (!buffer || !buffer.length) return { ok: false, code: 'bad-request', error: '图片为空' }
  let dir
  try {
    dir = await mkdtemp(join(tmpdir(), 'dsh-notes-ocr-'))
    const tag = randomBytes(4).toString('hex')
    const imagePath = join(dir, 'in-' + tag + '.png')
    const scaledPath = join(dir, 'scaled-' + tag + '.png')
    const scriptPath = join(dir, 'ocr.ps1')
    const outPath = join(dir, 'out.json')
    await writeFile(imagePath, buffer)
    await writeFile(scriptPath, PS_SCRIPT, 'utf8')

    const run = await runPowershell(support.powershell, [scriptPath, imagePath, scaledPath, outPath], timeoutMs)
    if (!run.ok) return run

    let parsed
    try {
      parsed = JSON.parse(await readFile(outPath, 'utf8'))
    } catch {
      return { ok: false, code: 'ocr-no-output', error: 'OCR 没有产出结果' + (run.stderr ? '：' + run.stderr.slice(0, 300) : '') }
    }
    if (!parsed || parsed.ok !== true) {
      return { ok: false, code: parsed?.code || 'ocr-failed', error: parsed?.error || '识别失败' }
    }
    const rawLines = Array.isArray(parsed.lines) ? parsed.lines : String(parsed.text || '').split(/\r?\n/)
    const lines = rawLines.map(tidyLine).filter((l) => l.length > 0)
    return { ok: true, text: lines.join('\n'), lines, lang: parsed.lang || '' }
  } catch (error) {
    return { ok: false, code: 'ocr-error', error: error?.message ?? String(error) }
  } finally {
    if (dir) { try { await rm(dir, { recursive: true, force: true }) } catch { /* ignore */ } }
  }
}
