/**
 * dsh-quickshot · 宿主半边
 *
 * 职责只有三件：
 *  1. 把原生小工具（quickshot.exe）准备好并常驻起来，让它替我们占住那个系统级快捷键；
 *  2. 开一条长轮询接口，把"热键工具截好、放在队列里的图"交给网页半边；
 *  3. 需要弹系统提示框 / 把 DSH 窗口叫到前台时，代为调用那个小工具。
 *
 * 为什么截图要在原生程序里做：浏览器里的浮层只能覆盖 DSH 自己的窗口，
 * 而"微信式框选"必须盖住整个屏幕、1:1 抓像素，只有 Win32 能做到。
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const isWindows = process.platform === 'win32'

/** 数据目录：队列、编译产物、日志都放这里，随 DSH 的 HOME 走。 */
function dataDir() {
  const home = process.env.DSH_HOME
    || (process.env.DSH_PROFILE_DIR ? path.dirname(process.env.DSH_PROFILE_DIR) : null)
    || path.join(os.homedir(), '.dsh')
  return path.join(home, 'quickshot')
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 找一个能编译 C# 的编译器（Windows 自带，不用另装）。 */
function cscPath() {
  const root = process.env.SystemRoot ?? 'C:\\Windows'
  for (const arch of ['Framework64', 'Framework']) {
    const candidate = path.join(root, 'Microsoft.NET', arch, 'v4.0.30319', 'csc.exe')
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/**
 * 确保原生小工具可用，返回它的绝对路径。
 *
 * 优先用包里已经编好的 exe；没有就用系统自带编译器从 .cs 现场编一份到数据目录。
 * 放在数据目录而不是包目录，是因为 Windows 会锁住"正在运行的 exe 所在的整个文件夹"，
 * 那会让以后安装/更新任何插件都报错。
 */
async function ensureExe(log) {
  const dir = dataDir()
  const bin = path.join(dir, 'bin')
  fs.mkdirSync(bin, { recursive: true })

  const source = path.join(here, 'native', 'quickshot.cs')
  const shipped = path.join(here, 'native', 'quickshot.exe')

  // 每次构建放到自己的子目录，永不覆盖正在运行的那一份。
  // Windows 不允许改写"正在运行的 exe"，直接覆盖会让更新失败。
  let stamp = 'shipped'
  if (!fs.existsSync(shipped)) {
    if (!fs.existsSync(source)) throw new Error('缺少 native/quickshot.cs')
    stamp = String(Math.round(fs.statSync(source).mtimeMs))
  }
  const buildDir = path.join(bin, `build-${stamp}`)
  fs.mkdirSync(buildDir, { recursive: true })
  const target = path.join(buildDir, 'quickshot.exe')

  if (fs.existsSync(target)) return target

  if (fs.existsSync(shipped)) {
    fs.copyFileSync(shipped, target)
    return target
  }

  const csc = cscPath()
  if (csc === null) throw new Error('找不到 C# 编译器，无法生成截图工具')
  log('正在编译截图工具（第一次使用，几秒钟）')
  await new Promise((resolve, reject) => {
    const child = spawn(csc, [
      '/nologo', '/target:winexe', '/optimize',
      `/out:${target}`,
      '/r:System.Windows.Forms.dll', '/r:System.Drawing.dll',
      source,
    ], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk) => { stderr += chunk })
    child.once('error', reject)
    child.once('close', (code) => {
      if (code !== 0 || !fs.existsSync(target)) reject(new Error(`编译失败：${stderr.trim() || code}`))
      else resolve()
    })
  })

  // 顺手清掉旧构建（正在跑的那份删不掉，跳过即可）
  for (const name of fs.readdirSync(bin)) {
    if (name === `build-${stamp}` || !name.startsWith('build-')) continue
    try {
      fs.rmSync(path.join(bin, name), { recursive: true, force: true })
    } catch { /* 还在用，下次再清 */ }
  }
  return target
}

/** 从队列里取一张已经截好的图，取走即删除。 */
function takeCapture(queueDir) {
  let names
  try {
    names = fs.readdirSync(queueDir).filter((name) => name.startsWith('ready-') && name.endsWith('.json')).sort()
  } catch {
    return null
  }
  for (const name of names) {
    const metaPath = path.join(queueDir, name)
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'))
      fs.rmSync(metaPath, { force: true })
      const png = typeof meta.png === 'string' ? meta.png : null
      if (png === null || !fs.existsSync(png)) continue
      const bytes = fs.readFileSync(png)
      fs.rmSync(png, { force: true })
      if (bytes.length === 0) continue
      return `data:image/png;base64,${bytes.toString('base64')}`
    } catch {
      fs.rmSync(metaPath, { force: true })
    }
  }
  return null
}

function sendJson(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(payload),
    'cache-control': 'no-store',
  })
  res.end(payload)
}

function sendEmpty(res, status) {
  res.writeHead(status, { 'cache-control': 'no-store' })
  res.end()
}

const KEY_PATTERN = /^(Key[A-Z]|Digit[0-9]|F([1-9]|1[0-2]))$/
const MODIFIERS = new Set(['alt', 'control', 'shift', 'meta'])

/** 把 { code, modifiers } 变成人看的写法，例如 Alt+A。 */
function labelOf(settings) {
  const mods = (settings.modifiers ?? []).map((name) => {
    if (name === 'control' || name === 'primary') return 'Ctrl'
    if (name === 'meta') return 'Win'
    if (name === 'shift') return 'Shift'
    return 'Alt'
  })
  const key = String(settings.code ?? '').replace('Key', '').replace('Digit', '')
  return [...mods, key].filter(Boolean).join('+')
}

/** 校验一组快捷键设置是否合法；不合法返回一句人话原因。 */
function validateSettings(code, modifiers) {
  if (typeof code !== 'string' || !KEY_PATTERN.test(code)) return '按键不合法'
  if (!Array.isArray(modifiers) || modifiers.length === 0) return '至少要按住一个修饰键'
  const unknown = modifiers.find((name) => !MODIFIERS.has(name))
  if (unknown !== undefined) return `不认识的修饰键：${unknown}`
  return null
}

export function apply(ctx, config = {}) {
  const dir = dataDir()
  const queueDir = path.join(dir, 'queue')
  const settingsFile = path.join(dir, 'settings.json')
  fs.mkdirSync(queueDir, { recursive: true })

  const log = (message) => {
    try {
      fs.appendFileSync(path.join(dir, 'quickshot.log'),
        `[${new Date().toISOString()}] ${message}\n`)
    } catch { /* 记日志失败不能影响主流程 */ }
  }

  /** 读取保存过的快捷键；没有就用 cordis.patch.yml 里的配置，再没有就用 Alt+A。 */
  function loadSettings() {
    try {
      const saved = JSON.parse(fs.readFileSync(settingsFile, 'utf8'))
      if (validateSettings(saved.code, saved.modifiers) === null) return saved
    } catch { /* 还没有保存过 */ }
    const fallback = {
      code: typeof config.code === 'string' ? config.code : 'KeyA',
      modifiers: Array.isArray(config.modifiers) && config.modifiers.length > 0 ? config.modifiers : ['alt'],
    }
    return validateSettings(fallback.code, fallback.modifiers) === null
      ? fallback
      : { code: 'KeyA', modifiers: ['alt'] }
  }

  let current = loadSettings()
  let exePath = null
  let listener = null
  let disposed = false
  let listenerError = null

  function stopListener() {
    listener?.kill()
    listener = null
  }

  async function startListener() {
    if (exePath === null || disposed) return
    stopListener()
    const child = spawn(exePath, [
      '--listen', String(process.pid), exePath, queueDir, current.code, current.modifiers.join(','),
    ], { windowsHide: true, stdio: 'ignore' })
    listener = child
    child.on('error', (error) => log(`listener error: ${error.message}`))
    child.on('exit', (code) => {
      if (disposed) return
      // 退出码 2 = 系统不让我们注册这个组合（通常是被别的软件占了）
      listenerError = code === 2 ? '这个组合被别的软件占用了，换一个试试' : null
      log(`listener exited: ${code}${listenerError === null ? '' : `（${listenerError}）`}`)
    })
    listenerError = null
    log(`热键监听已启动：${labelOf(current)}`)
  }

  ctx.inject(['webServer'], (webCtx) => {
    // 网页半边来取图：最多挂 20 秒，取到就立刻返回，没有就 204。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/quickshot/pending',
      handler: async (req, res) => {
        if (req.method !== 'GET') return sendJson(res, 405, { error: 'method not allowed' })
        if (!req.headers['x-dsh-quickshot']) return sendJson(res, 403, { error: 'forbidden' })
        let wait = 20000
        try {
          const raw = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('wait')
          const parsed = Number(raw)
          if (Number.isFinite(parsed)) wait = Math.max(0, Math.min(parsed, 25000))
        } catch { /* 用默认值 */ }
        const deadline = Date.now() + wait
        for (;;) {
          const dataUrl = takeCapture(queueDir)
          if (dataUrl !== null) {
            log(`取走一张排队中的截图（${Math.round(dataUrl.length / 1024)}KB）交给网页`)
            return sendJson(res, 200, { dataUrl })
          }
          if (res.destroyed) return undefined
          if (Date.now() >= deadline) return sendEmpty(res, 204)
          await sleep(250)
        }
      },
    }), 'quickshot: pending queue')

    // 输入框里的相机按钮走这条路：当场开框选，结果直接回给页面。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/quickshot/capture',
      handler: (req, res) => {
        if (!req.headers['x-dsh-quickshot']) return sendJson(res, 403, { error: 'forbidden' })
        if (exePath === null) return sendJson(res, 503, { error: 'helper not ready' })
        const target = path.join(queueDir, `direct-${process.pid}-${Date.now()}.png`)
        const child = spawn(exePath, ['--select', target], { windowsHide: true, stdio: 'ignore' })
        child.once('error', () => sendJson(res, 500, { error: 'capture failed' }))
        child.once('close', (code) => {
          if (code !== 0 || !fs.existsSync(target)) {
            fs.rmSync(target, { force: true })
            return sendEmpty(res, 204)
          }
          const bytes = fs.readFileSync(target)
          fs.rmSync(target, { force: true })
          if (bytes.length === 0) return sendEmpty(res, 204)
          return sendJson(res, 200, { dataUrl: `data:image/png;base64,${bytes.toString('base64')}` })
        })
      },
    }), 'quickshot: inline capture')

    // 网页半边的诊断通道：把它的关键状态写进同一个日志，排错时能直接看到断在哪。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/quickshot/log',
      handler: (req, res) => {
        if (!req.headers['x-dsh-quickshot']) return sendEmpty(res, 403)
        try {
          const message = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams.get('msg')
          if (message !== null) log(`[client] ${message.slice(0, 400)}`)
        } catch { /* 坏的查询串直接忽略 */ }
        return sendEmpty(res, 204)
      },
    }), 'quickshot: client diagnostics')

    // 设置页读写快捷键：GET 拿当前值，POST 改，改完立刻重启监听器。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/quickshot/settings',
      handler: (req, res) => {
        if (!req.headers['x-dsh-quickshot']) return sendJson(res, 403, { error: 'forbidden' })
        if (req.method === 'GET') {
          return sendJson(res, 200, {
            ok: true,
            code: current.code,
            modifiers: current.modifiers,
            label: labelOf(current),
            error: listenerError,
          })
        }
        try {
          const query = new URL(req.url ?? '/', 'http://127.0.0.1').searchParams
          const code = query.get('code') ?? ''
          const modifiers = (query.get('modifiers') ?? '').split(',').map((name) => name.trim()).filter(Boolean)
          const problem = validateSettings(code, modifiers)
          if (problem !== null) return sendJson(res, 400, { ok: false, error: problem })
          current = { code, modifiers }
          fs.writeFileSync(settingsFile, JSON.stringify(current, null, 2))
          log(`快捷键改成 ${labelOf(current)}，重启监听器`)
          void startListener()
          return sendJson(res, 200, { ok: true, ...current, label: labelOf(current) })
        } catch (error) {
          return sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
        }
      },
    }), 'quickshot: settings')

    // 当前不在会话里时，弹一个系统提示框问要不要送进会话。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/quickshot/ask',
      handler: (req, res) => {
        if (!req.headers['x-dsh-quickshot']) return sendJson(res, 403, { error: 'forbidden' })
        if (exePath === null) return sendJson(res, 503, { error: 'helper not ready' })
        const child = spawn(exePath, [
          '--ask', 'DSH 截图', '请选择截图输入的会话。\n\n点「确定」后选择要接收这张截图的会话；点「取消」丢弃这张截图。',
        ], { windowsHide: true, stdio: 'ignore' })
        child.once('close', (code) => sendJson(res, 200, { ok: code === 0 }))
        child.once('error', () => sendJson(res, 500, { error: 'ask failed' }))
      },
    }), 'quickshot: ask dialog')

    // 把 DSH 主窗口叫到前台。宿主进程是桌面外壳的子进程，所以 ppid 就是外壳。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/quickshot/focus',
      handler: (req, res) => {
        if (!req.headers['x-dsh-quickshot']) return sendJson(res, 403, { error: 'forbidden' })
        if (exePath === null) return sendJson(res, 503, { error: 'helper not ready' })
        const child = spawn(exePath, ['--focus', String(process.ppid)], { windowsHide: true, stdio: 'ignore' })
        child.once('close', () => sendJson(res, 200, { ok: true }))
        child.once('error', () => sendJson(res, 500, { error: 'focus failed' }))
      },
    }), 'quickshot: focus window')
  })

  // 常驻热键监听：它自己盯住本进程，DSH 一退出它就跟着退出。
  ctx.effect(() => {
    if (!isWindows) {
      log('当前系统不是 Windows，跳过原生截图')
      return () => {}
    }
    const start = async () => {
      exePath = await ensureExe(log)
      if (disposed) return
      await startListener()
    }
    start().catch((error) => log(`启动失败：${error.message}`))
    return () => {
      disposed = true
      listener?.kill()
      listener = null
    }
  }, 'quickshot: global hotkey listener')
}
