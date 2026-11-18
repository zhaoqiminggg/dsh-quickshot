/**
 * dsh-quickshot · 网页半边
 *
 * 三件事：
 *  1. 常驻长轮询宿主，把热键截下来的图取过来；
 *  2. 有会话时就"假装粘贴"塞进输入框（这是输入框唯一公开的入口）；
 *  3. 没有会话时先问一句"请选择截图输入的会话"，同意就把 DSH 叫到前台，
 *     等你点开一个会话后再把图送进去。
 */
window.__ModuleLoader__.load({
  id: 'dsh-quickshot',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useEffect, useState } = React

    const HEADERS = { 'x-dsh-quickshot': '1' }

    /** 把网页这边的状态写进宿主日志，出问题时能直接看出断在哪一步。 */
    function report(message) {
      try {
        void fetch(`/quickshot/log?msg=${encodeURIComponent(message)}`, { headers: HEADERS, cache: 'no-store' })
      } catch { /* 诊断本身不能影响主流程 */ }
    }

    /** 排队数量的订阅（给按钮上的小角标用）。 */
    const watchers = new Set()
    function bump() {
      for (const notify of watchers) notify(pending.length)
    }

    let sessionPresent = false        // 当前有没有真的会话在显示（由探针组件维护）
    let armed = false                 // 已经问过并同意，正在等用户点开会话
    let pending = []                  // 等着投递的图片：{ blob, at }
    let flushing = false              // 正在投递，避免重入

    /** 排队超过这么久还没投出去就丢掉，免得内存里越攒越多。 */
    const PENDING_TTL = 5 * 60 * 1000

    /**
     * 找出当前会话的输入框卡片。
     *
     * 只认 DSH 自己给输入框打的标记（data-composer-card）。
     * 不能退而求其次去抓页面上"随便哪个能打字的框"——插件页、设置页的搜索框
     * 也是可编辑的，粘贴事件会打进那里，图就凭空消失了。
     */
    function composerCard() {
      return document.querySelector('[data-composer-card]')
    }

    /** 输入框里现在有几张缩略图，用来判断这次插入到底成没成。 */
    function attachmentCount() {
      const card = composerCard()
      if (card === null) return -1
      return card.querySelectorAll('img').length
    }

    /**
     * 把一张图塞进输入框。
     *
     * 两道门都试：
     *  1. 拖放（drop）—— 附件栏自己的入口，不依赖编辑器有没有光标；
     *  2. 粘贴（paste）—— 需要编辑器已经在编辑状态，所以先点一下让它聚焦。
     * 每试一次都回头数缩略图数量，真的多了才算成功，避免"以为塞进去了其实掉黑洞"。
     */
    async function insertIntoComposer(blob) {
      // 没有真会话时绝不能塞：那时页面上有个空壳输入框，塞进去等于丢进黑洞。
      if (!sessionPresent) return false
      const card = composerCard()
      if (card === null) return false

      const before = attachmentCount()
      const makeTransfer = () => {
        const file = new File([blob], `shot-${Date.now()}.png`, { type: 'image/png' })
        const transfer = new DataTransfer()
        transfer.items.add(file)
        return transfer
      }

      // 第一道：拖放
      try {
        card.dispatchEvent(new DragEvent('drop', {
          dataTransfer: makeTransfer(), bubbles: true, cancelable: true,
        }))
      } catch { /* 继续试第二道 */ }
      if (await grew(before)) return true

      // 第二道：先让它聚焦，再派一个粘贴事件
      const editable = card.querySelector('[contenteditable="true"]')
      if (editable === null) return false
      try { editable.focus(); editable.click() } catch { /* 聚焦失败也继续 */ }
      try {
        editable.dispatchEvent(new ClipboardEvent('paste', {
          clipboardData: makeTransfer(), bubbles: true, cancelable: true,
        }))
      } catch { /* 失败就交给上层重试 */ }
      return await grew(before)
    }

    /** 等一小会儿，看输入框里的缩略图是不是真的变多了。 */
    async function grew(before) {
      for (let i = 0; i < 6; i++) {
        await new Promise((resolve) => setTimeout(resolve, 150))
        const now = attachmentCount()
        if (now > before) return true
      }
      return false
    }

    /**
     * 把攒着的图依次投出去。
     *
     * 关键点：输入框可能还没挂上（刚切面板的那一瞬间），所以"投不出去"不是出错，
     * 而是稍后再试 —— 由心跳定时器负责反复调用这里。
     */
    async function flush() {
      if (flushing || pending.length === 0) return
      flushing = true
      try {
        while (pending.length > 0) {
          if (!(await insertIntoComposer(pending[0].blob))) {
            if (Date.now() - lastMissReport > 2000) {
              lastMissReport = Date.now()
              report(`还没插进去：排队 ${pending.length} 张，会话=${sessionPresent}，输入框=${composerCard() === null ? '无' : '有'}`)
            }
            return
          }
          pending.shift()
          bump()
          report(`插进去一张，剩余待贴 ${pending.length} 张`)
          await new Promise((resolve) => setTimeout(resolve, 120))
        }
        armed = false
      } finally {
        flushing = false
      }
    }

    let lastMissReport = 0

    /** 丢图 + 触发一次投递尝试。 */
    function enqueue(blob) {
      pending.push({ blob, at: Date.now() })
      bump()
      void flush()
    }

    /** 问一句要不要送进会话。返回 'ok' | 'cancel' | 'error'。 */
    async function askHost() {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 180000)
      try {
        const response = await fetch('/quickshot/ask', { headers: HEADERS, cache: 'no-store', signal: controller.signal })
        const payload = await response.json().catch(() => ({}))
        if (payload.ok === true) return 'ok'
        if (payload.ok === false) return 'cancel'
        return 'error'
      } catch {
        return 'error'
      } finally {
        clearTimeout(timer)
      }
    }

    async function focusHost() {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 5000)
      try {
        await fetch('/quickshot/focus', { headers: HEADERS, cache: 'no-store', signal: controller.signal })
      } catch { /* 叫不动就算了，用户自己点回来 */ } finally {
        clearTimeout(timer)
      }
    }

    /** 收到一张图之后的处理：有会话直接投，没会话先问。 */
    async function accept(blob) {
      report(`收到一张 ${Math.round(blob.size / 1024)}KB 的截图，会话=${sessionPresent}、已确认=${armed}`)
      if (!sessionPresent && !armed) {
        const verdict = await askHost()
        report(`提示框结果：${verdict}`)
        // 只有用户真的点了「取消」才丢图；提示框本身出错（超时、宿主没回话）时，
        // 图照样留着排队，等用户自己切回会话。
        if (verdict === 'cancel') return
        armed = true
        if (verdict === 'ok') await focusHost()
      }
      enqueue(blob)
    }

    /** 长轮询宿主队列，取到一张处理一张。 */
    async function intake(signal) {
      while (!signal.aborted) {
        try {
          const response = await fetch('/quickshot/pending?wait=20000', {
            headers: HEADERS, cache: 'no-store', signal,
          })
          if (response.status === 204) continue
          const payload = await response.json().catch(() => null)
          if (payload === null || typeof payload.dataUrl !== 'string') continue
          const blob = await (await fetch(payload.dataUrl)).blob()
          await accept(blob)
        } catch (error) {
          if (signal.aborted) return
          await new Promise((resolve) => setTimeout(resolve, 2000))
        }
      }
    }

    /**
     * 输入框里一个字都没有时，退格键从最后一张开始删附件。
     *
     * 做法是找到附件栏里最后一个"删除"按钮并点它 —— 走的是 DSH 自己的删除逻辑，
     * 所以缩略图右上角那个 × 照常能用，两种方式互不冲突。
     */
    function installBackspaceRemoval() {
      const isRemoveButton = (node) => node instanceof HTMLButtonElement
        && Array.from(node.classList).some((name) => name.endsWith('_remove'))

      const onKeyDown = (event) => {
        if (event.key !== 'Backspace') return
        // 中文输入法选词时的退格、带修饰键的退格，都不该删图
        if (event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return
        const target = event.target
        if (!(target instanceof Element)) return
        const card = target.closest('[data-composer-card]')
        if (card === null) return
        const editor = card.querySelector('[contenteditable="true"]')
        if (editor === null) return
        // 只要还有字（包括引用块里的字），退格就归输入框自己管
        const text = (editor.innerText ?? editor.textContent ?? '').replace(/\u200B/g, '').trim()
        if (text !== '') return
        const removes = Array.from(card.querySelectorAll('button')).filter(isRemoveButton)
        if (removes.length === 0) return
        event.preventDefault()
        event.stopPropagation()
        removes[removes.length - 1].click()
        try { editor.focus() } catch { /* 焦点丢了也不影响删除 */ }
      }

      document.addEventListener('keydown', onKeyDown, true)
      return () => document.removeEventListener('keydown', onKeyDown, true)
    }

    /** 会话探针：挂在只有"真的有会话"时才渲染的槽里，用来判断当前在不在会话中。 */
    function SessionProbe() {      useEffect(() => {
        sessionPresent = true
        void flush()
        return () => {
          sessionPresent = false
        }
      }, [])
      return h('span', { style: { display: 'none' }, 'aria-hidden': true })
    }

    /** 输入框里的相机按钮：不按热键也能截。排队时显示一个小角标。 */
    function ShotButton() {
      const [hover, setHover] = useState(false)
      const [waiting, setWaiting] = useState(pending.length)
      useEffect(() => {
        watchers.add(setWaiting)
        setWaiting(pending.length)
        return () => { watchers.delete(setWaiting) }
      }, [])
      return h('button', {
        type: 'button',
        title: waiting > 0 ? `截图（Alt+A）· 还有 ${waiting} 张等待插入` : '截图（Alt+A）',
        'aria-label': '截图（Alt+A）',
        onClick: () => {
          fetch('/quickshot/capture', { headers: HEADERS, cache: 'no-store' })
            .then((response) => response.ok ? response.json() : null)
            .then(async (payload) => {
              if (payload === null || typeof payload.dataUrl !== 'string') return
              const blob = await (await fetch(payload.dataUrl)).blob()
              await accept(blob)
            })
            .catch(() => {})
        },
        onMouseEnter: () => setHover(true),
        onMouseLeave: () => setHover(false),
        style: {
          position: 'relative',
          display: 'grid', placeItems: 'center',
          width: 28, height: 28, padding: 0, border: 0, borderRadius: 6,
          background: hover ? 'var(--dsw-alias-bg-secondary, rgba(127,127,127,0.18))' : 'transparent',
          color: 'inherit', cursor: 'pointer',
        },
      }, h('svg', {
        viewBox: '0 0 24 24', width: 16, height: 16, fill: 'none',
        stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round',
        'aria-hidden': true,
      },
        h('path', { d: 'M4 8V6a2 2 0 0 1 2-2h2' }),
        h('path', { d: 'M16 4h2a2 2 0 0 1 2 2v2' }),
        h('path', { d: 'M20 16v2a2 2 0 0 1-2 2h-2' }),
        h('path', { d: 'M8 20H6a2 2 0 0 1-2-2v-2' }),
        h('circle', { cx: 12, cy: 12, r: 3 }),
      ), waiting > 0 && h('span', {
        style: {
          position: 'absolute', top: -2, right: -2,
          minWidth: 14, height: 14, borderRadius: 7,
          background: 'var(--dsw-alias-state-warning, #f5a623)', color: '#1b1b1b',
          fontSize: 10, lineHeight: '14px', textAlign: 'center', fontWeight: 600,
        },
      }, String(waiting)))
    }

    /** 可选按键：A–Z、0–9、F1–F12。 */
    const KEYS = [
      ...Array.from({ length: 26 }, (_, i) => `Key${String.fromCharCode(65 + i)}`),
      ...Array.from({ length: 10 }, (_, i) => `Digit${i}`),
      ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
    ]
    const keyLabel = (code) => String(code).replace('Key', '').replace('Digit', '')
    const MODS = [['control', 'Ctrl'], ['alt', 'Alt'], ['shift', 'Shift']]

    /** 设置页：显示并修改全局快捷键。 */
    function ShotSettings() {
      const [code, setCode] = useState('KeyA')
      const [mods, setMods] = useState(['alt'])
      const [label, setLabel] = useState('Alt+A')
      const [note, setNote] = useState('')
      const [conflict, setConflict] = useState(null)

      const row = { display: 'flex', alignItems: 'center', gap: 10, padding: '7px 0', fontSize: 13 }
      const hint = { color: 'var(--dsw-alias-text-secondary, rgba(127,127,127,0.9))', fontSize: 12 }
      const chip = {
        fontFamily: 'monospace', fontSize: 13, padding: '2px 8px', borderRadius: 4,
        background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,0.15))',
      }

      const read = async () => {
        try {
          const response = await fetch('/quickshot/settings', { headers: HEADERS, cache: 'no-store' })
          const payload = await response.json()
          if (payload !== null && payload.ok === true) {
            setCode(payload.code)
            setMods(Array.isArray(payload.modifiers) ? payload.modifiers : [])
            setLabel(payload.label)
            setConflict(payload.error ?? null)
          }
        } catch { /* 宿主没起来时保持原样 */ }
      }

      useEffect(() => { void read() }, [])

      const toggle = (name) => {
        setMods((prev) => prev.includes(name) ? prev.filter((item) => item !== name) : [...prev, name])
      }

      const save = async () => {
        if (mods.length === 0) { setNote('至少要按住一个修饰键'); return }
        setNote('保存中…')
        try {
          const query = new URLSearchParams({ code, modifiers: mods.join(',') })
          const response = await fetch(`/quickshot/settings?${query.toString()}`, {
            method: 'POST', headers: HEADERS, cache: 'no-store',
          })
          const payload = await response.json()
          if (payload === null || payload.ok !== true) {
            setNote(payload?.error ?? '保存失败')
            return
          }
          setLabel(payload.label)
          setNote('已保存，正在切换…')
          // 等监听器重启后回头读一次，好发现"这个组合被别的软件占了"
          setTimeout(() => { void read().then(() => setNote('已生效')) }, 1600)
        } catch {
          setNote('保存失败')
        }
      }

      return h('div', { style: { padding: '4px 0', display: 'flex', flexDirection: 'column', gap: 4 } },
        h('div', { style: row },
          h('span', null, '全局快捷键'),
          h('span', { style: chip }, label),
          conflict !== null && h('span', { style: { color: 'var(--dsw-alias-state-warning, #d97706)' } }, conflict),
        ),
        h('div', { style: row },
          h('span', { style: hint }, '按住'),
          ...MODS.map(([name, text]) => h('label', {
            key: name,
            style: { display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' },
          },
            h('input', {
              type: 'checkbox',
              checked: mods.includes(name),
              onChange: () => { toggle(name) },
            }),
            h('span', null, text))),
        ),
        h('div', { style: row },
          h('span', { style: hint }, '再按'),
          h('select', {
            value: code,
            onChange: (event) => { setCode(event.target.value) },
            style: {
              background: 'var(--dsw-alias-bg-secondary, rgba(127,127,127,0.12))',
              color: 'inherit', border: '1px solid var(--dsw-alias-border, rgba(127,127,127,0.3))',
              borderRadius: 6, padding: '4px 8px', fontSize: 13,
            },
          }, ...KEYS.map((item) => h('option', { key: item, value: item }, keyLabel(item)))),
          h('button', {
            type: 'button',
            onClick: () => { void save() },
            style: {
              padding: '5px 14px', borderRadius: 6, border: 0, cursor: 'pointer', fontSize: 13,
              background: 'var(--dsw-alias-accent, #2f6feb)', color: '#fff',
            },
          }, '保存'),
          note !== '' && h('span', { style: hint }, note),
        ),
        h('div', { style: { ...row, ...hint } },
          '在任何窗口按下都能截图，DSH 不会被叫到前台；截完的图直接进当前会话的输入框。'),
        h('div', { style: { ...row, ...hint } },
          '如果当时不在会话里，会先弹一个提示框，确认后再选会话。'),
        h('div', { style: { ...row, ...hint } },
          '输入框里没有文字时，退格键可以从最后一张开始逐张删掉附件；缩略图右上角的 × 照常能用。'),
        h('div', { style: { ...row, color: 'var(--dsw-alias-text-secondary, rgba(127,127,127,0.6))' } },
          '版本 0.2.1'),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: 'dsh-quickshot-probe', order: 0,
        }, SessionProbe))

        ctx.slots.inject('conversation.input.left', () => ctx.slots.register({
          name: 'conversation.input.left', id: 'dsh-quickshot-button', order: 1,
        }, ShotButton))

        ctx.effect(() => installBackspaceRemoval(), 'quickshot: backspace removes attachment')

        ctx.slots.inject('settings.section', () => ctx.slots.register({
          name: 'settings.section', id: 'dsh-quickshot', order: 41, label: () => '快捷键截图',
        }, ShotSettings))

        ctx.effect(() => {
          const controller = new AbortController()
          void intake(controller.signal)
          return () => controller.abort()
        }, 'quickshot: capture intake')

        // 心跳：只要还有图排队，就每半秒试一次投递。
        // 输入框刚挂上、面板刚切回来这些时刻都不好精确捕捉，靠反复重试最稳。
        ctx.effect(() => {
          const timer = setInterval(() => {
            const now = Date.now()
            const kept = pending.filter((item) => now - item.at < PENDING_TTL)
            const dropped = pending.length - kept.length
            if (dropped > 0) {
              pending = kept
              bump()
              report(`丢弃 ${dropped} 张超过 5 分钟没能插入的图`)
            }
            if (pending.length > 0) void flush()
            else if (!flushing) armed = false
          }, 500)
          return () => clearInterval(timer)
        }, 'quickshot: delivery retry')
      },
    }
  },
})

