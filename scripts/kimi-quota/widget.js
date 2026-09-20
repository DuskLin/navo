// 展示已启用的 Navo 账号；不推断 Desktop 登录账号或当前会话调度账号。
;(() => {
  if (document.getElementById('navo-quota-widget')) return
  const host = document.createElement('div')
  host.id = 'navo-quota-widget'
  host.style.cssText = 'position:fixed;z-index:1000;-webkit-app-region:no-drag;pointer-events:none'
  const root = host.attachShadow({ mode: 'open' })
  root.innerHTML = `<style>
    :host {font:12px var(--font-ui,-apple-system,BlinkMacSystemFont,sans-serif);color:var(--color-text,#303238);--n-muted:var(--color-text-muted,#85858b);--n-surface:var(--color-surface-sunken,#f6f6f7);--n-hover:var(--color-hover,#eeeeef);--n-line:var(--color-line,#e7e7e9)}
    *{box-sizing:border-box}button{font:inherit;color:inherit;cursor:pointer;-webkit-app-region:no-drag}
    [hidden]{display:none!important}.bar{display:flex;align-items:center;gap:6px;pointer-events:auto;height:32px}
    .accounts{display:flex;gap:8px;overflow-x:auto;scroll-snap-type:x mandatory;scrollbar-width:none;min-width:0;padding:2px 0}
    .accounts::-webkit-scrollbar{display:none}
    .account{flex:0 0 var(--card-width,252px);scroll-snap-align:start;display:flex;align-items:center;justify-content:space-between;gap:8px;height:30px;padding:4px 10px;border:1px solid color-mix(in srgb,var(--n-line) 65%,transparent);border-radius:var(--radius-md,8px);background:color-mix(in srgb,var(--n-surface) 72%,var(--color-bg,#fff));white-space:nowrap;transition:background .15s,border-color .15s}
    .account:hover,.account[aria-expanded=true],.session-summary:hover,.session-summary[aria-expanded=true]{border-color:var(--color-line-strong,#d7d7db);background:var(--n-hover)}
    button:focus-visible{outline:2px solid var(--color-text-muted,#8b8b90);outline-offset:2px}
    .identity{display:flex;align-items:center;gap:6px;min-width:0}.provider{font-size:9px;font-weight:650;letter-spacing:.1px;color:var(--n-muted);border:1px solid var(--n-line);border-radius:4px;padding:2px 3px;line-height:12px;background:var(--color-bg,#fff)}
    .name{max-width:52px;overflow:hidden;text-overflow:ellipsis;font-weight:550;font-size:11px}.stat{display:flex;align-items:center;gap:4px;font-size:11px;font-variant-numeric:tabular-nums}.muted{color:var(--n-muted)}
    .track{width:24px;height:3px;background:var(--n-line);border-radius:4px;overflow:hidden}.fill{height:100%;background:#438e72;border-radius:4px;transition:width .25s}
    .nav{flex:0 0 20px;width:20px;height:24px;padding:0;border:0;border-radius:6px;background:transparent;color:var(--n-muted);font-size:17px;transition:background .15s}.nav:hover:not(:disabled){background:var(--n-hover)}.nav:disabled{opacity:.25;cursor:default}
    .empty{padding:5px 10px;color:#8a8f99;white-space:nowrap}
    .panel,.session-panel{position:fixed;width:340px;padding:18px;border:1px solid var(--n-line);border-radius:var(--radius-lg,12px);background:var(--color-menu-bg,var(--color-bg,#fff));box-shadow:0 16px 48px #00000014,0 2px 8px #00000008;pointer-events:auto;animation:navo-appear .14s ease-out}
    .session-summary{flex:none;width:300px;height:30px;display:flex;align-items:center;justify-content:space-between;gap:0;margin-right:6px;padding:0 9px;border:1px solid var(--n-line);border-radius:var(--radius-md,8px);background:var(--n-surface);font-variant-numeric:tabular-nums;white-space:nowrap;transition:background .15s,border-color .15s}
    .session-icon{display:flex;align-items:center;color:var(--n-muted);padding-right:5px}.session-icon svg{width:14px;height:14px}
    .session-summary.small{width:48px;justify-content:center}.session-summary.small .metric{display:none}.session-summary.small .session-icon{padding:0}
    .session-summary .metric{font-size:11px;display:flex;align-items:baseline;justify-content:center;gap:4px;padding:0 9px;border-left:1px solid var(--n-line);line-height:14px}
    .session-summary .metric:last-child{padding-right:0}.metric .value{font-weight:600;color:var(--color-text-strong,var(--color-text,#303238));letter-spacing:-.15px}.metric .unit{font-size:10px;color:var(--n-muted);font-weight:400}
    h3{font-size:13px;font-weight:600;letter-spacing:-.15px;margin:0 0 6px}.sub{font-size:11px;color:var(--n-muted);line-height:1.75}.account-name{font-size:12px;margin-top:16px;font-weight:550;overflow-wrap:anywhere}
    .row{margin:14px 0 18px}.labels{display:flex;justify-content:space-between;gap:10px;margin-bottom:8px;font-variant-numeric:tabular-nums}.labels strong{font-weight:550}.large{width:100%;height:4px}.reset{margin-top:8px;font-size:10px;color:var(--n-muted)}
    .session-details{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:0 6px;margin-top:16px}
    .session-details .labels{grid-column:1/-1;margin:0;padding:11px 0;border-bottom:1px solid var(--n-line);font-size:11px;align-items:baseline}.session-details .labels>span:last-child{text-align:right}
    .session-details .labels:nth-child(-n+3){grid-column:auto;display:flex;flex-direction:column;gap:7px;background:var(--n-surface);border:0;border-radius:8px;padding:12px 9px;margin-bottom:8px}
    .session-details .labels:nth-child(-n+3)>span:first-child{font-size:10px}.session-details .labels:nth-child(-n+3)>span:last-child{font-size:15px;font-weight:600;letter-spacing:-.4px;text-align:left;white-space:nowrap}
    .session-details .labels:nth-child(2)>span:last-child{font-size:13px}.session-details .labels:last-child{border:0;color:var(--n-muted);font-size:10px}.method{border-top:1px solid var(--n-line);margin-top:4px;padding-top:12px}.method summary{font-size:11px;color:var(--n-muted);cursor:pointer}.method .sub{margin-top:10px}
    footer{border-top:1px solid var(--n-line);padding-top:12px;display:flex;align-items:center;justify-content:space-between;gap:8px;font-size:10px;color:var(--n-muted)}.refresh{border:1px solid var(--n-line);border-radius:6px;background:var(--n-surface);padding:4px 8px;font-size:10px}.refresh:hover{background:var(--n-hover)}.warn{color:#ba8540}
    @keyframes navo-appear{from{opacity:0;transform:translateY(-3px)}to{opacity:1;transform:translateY(0)}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
    :host([compact]) .account .track{display:none}:host([compact]) .account{gap:4px;padding:4px 6px}:host([compact]) .name{max-width:48px}
  </style><div class="bar"><button class="session-summary" aria-label="查看当前会话 Token 统计" aria-expanded="false"><span class="session-icon" aria-hidden="true"><svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.25" stroke-linecap="round" stroke-linejoin="round"><path d="M1.5 8h3l2-4.5 3 9 2-4.5h3"/></svg></span><span class="metric speed">— tok/s</span><span class="metric tokens">— tok</span><span class="metric cache">缓存 —</span></button><button class="nav prev" aria-label="向左查看账号" hidden>‹</button><div class="accounts" role="group" aria-label="Navo 已启用账号额度"></div><button class="nav next" aria-label="向右查看账号" hidden>›</button></div>
  <section class="panel" aria-label="账号额度详情" hidden><h3>Navo 账号额度 <span class="sub">实验版</span></h3><div class="sub">Navo 已启用账号 · 非 Desktop 登录账号绑定</div><div class="account-name"></div><div class="details"></div><footer><span class="status"></span><button class="refresh">重新读取</button></footer></section>
  <section class="session-panel" aria-label="当前会话 Token 统计" hidden><h3>当前会话 Token 统计</h3><div class="session-details"></div><details class="method"><summary>数据来源与统计口径</summary><div class="sub">来源：本机 Kimi 会话日志。累计已报告用量包含主代理和子代理；Token 总量包含输入、输出、缓存读取与写入，不代表当前上下文长度。缓存命中率按已完整报告的输入 Token 加权。</div><div class="sub">速率是主代理最近一次完成的模型输出 Token ÷ 实际生成耗时，不含首 Token 等待和工具执行时间；并非逐秒实时速率。</div></details></section>`
  document.body.append(host)
  const $ = (s) => root.querySelector(s)
  let data = null,
    failed = false,
    selected = '',
    disabled = false,
    cardWidth = 252
  const cards = new Map()
  const values = [
    ['fiveHour', '5h', '5 小时窗口'],
    ['weekly', '周', '7 天窗口'],
    ['monthly', '月', '月度窗口']
  ]
  const hasWindow = (w) =>
    !!w && [w.limit, w.used, w.remaining].some((v) => typeof v === 'number' && Number.isFinite(v))
  const percent = (w, checkedAt) => {
    if (
      !w ||
      !checkedAt ||
      Date.now() - checkedAt > 120000 ||
      (w.resetAt && Date.parse(w.resetAt) <= Date.now())
    )
      return null
    if (!Number.isFinite(w.remaining) || !Number.isFinite(w.limit) || w.limit <= 0) return null
    return Math.max(0, Math.min(100, (w.remaining / w.limit) * 100))
  }
  const stale = () => failed || !data || Date.now() - data.exportedAt > 20000
  function sessionMetrics() {
    const id = location.pathname.match(/\/sessions\/(session_[a-zA-Z0-9_-]+)(?:\/|$)/)?.[1]
    const metric = id && !stale() ? data?.sessions?.[id] : null
    const valid = metric?.complete
    const speed =
      valid && Number.isFinite(metric.tokensPerSecond) ? metric.tokensPerSecond.toFixed(1) : '—'
    const total = valid && Number.isFinite(metric.totalTokens) ? metric.totalTokens : null
    const hit =
      valid && Number.isFinite(metric.cacheHitRate)
        ? (metric.cacheHitRate * 100).toFixed(1) + '%'
        : '—'
    $('.speed').innerHTML = `<span class="value">${speed}</span> <span class="unit">tok/s</span>`
    const tokenLabel =
      total === null
        ? '— tok'
        : new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 }).format(
            total
          ) + ' tok'
    $('.tokens').innerHTML =
      `<span class="value">${tokenLabel.replace(' tok', '')}</span><span class="unit">tok</span>`
    $('.cache').innerHTML = `<span class="unit">缓存</span> <span class="value">${hit}</span>`
    const reason = stale()
      ? 'Navo 同步已停止'
      : !id
        ? '当前页面不是会话'
        : !metric
          ? '未找到对应本机会话记录'
          : !valid
            ? '正在同步会话日志'
            : `${metric.requests} 次已报告用量 · ${metric.agents} 个代理`
    const detail = $('.session-details')
    detail.replaceChildren()
    for (const [label, value] of [
      ['最近生成速率', speed + ' tok/s'],
      ['累计已报告 Token', total === null ? '—' : total.toLocaleString('zh-CN')],
      ['缓存命中率', hit],
      [
        '输入 / 输出',
        valid ? `${metric.input.toLocaleString()} / ${metric.output.toLocaleString()}` : '—'
      ],
      [
        '缓存读取 / 写入',
        valid ? `${metric.cacheRead.toLocaleString()} / ${metric.cacheWrite.toLocaleString()}` : '—'
      ],
      [
        '速率记录时间',
        valid && metric.speedAt ? new Date(metric.speedAt).toLocaleString('zh-CN') : '—'
      ],
      ['状态', reason]
    ]) {
      const row = document.createElement('div')
      row.className = 'labels'
      const name = document.createElement('span')
      name.textContent = label
      name.className = 'muted'
      const text = document.createElement('span')
      text.textContent = value
      row.append(name, text)
      detail.append(row)
    }
    $('.session-summary').title =
      `${reason}；最近生成 ${speed} tok/s；累计 ${total ?? '—'} Token；缓存命中 ${hit}。点击查看统计口径。`
  }
  const provider = (a) =>
    ({ kimi: 'Kimi', 'opencode-go': 'Go', deepseek: 'DS' })[a.provider || 'kimi'] || '账号'
  const balanceText = (a) =>
    stale() || !a.checkedAt || Date.now() - a.checkedAt > 120000
      ? '等待更新'
      : a.balance?.balances
          ?.map((b) => `${b.currency} ${Number(b.balance).toFixed(2)}`)
          .join(' · ') || '暂无余额'
  const meter = (p, large = false) =>
    `<div class="track ${large ? 'large' : ''}"><div class="fill" style="width:${p ?? 0}%;background:${p !== null && p < 20 ? '#d99444' : '#438e72'}"></div></div>`
  function close() {
    $('.panel').hidden = true
    $('.session-panel').hidden = true
    $('.session-summary').setAttribute('aria-expanded', 'false')
    for (const button of cards.values()) button.setAttribute('aria-expanded', 'false')
  }
  function details() {
    const a = data?.accounts.find((x) => x.id === selected)
    if (!a) {
      close()
      return
    }
    $('.account-name').textContent = `${provider(a)} · ${a.name}` + (a.enabled ? '' : '（已停用）')
    $('.details').innerHTML = values
      .filter(([key]) => hasWindow(a[key]))
      .map(([key, , label]) => {
        const p = stale() ? null : percent(a[key], a.checkedAt)
        const time = Date.parse(a[key]?.resetAt || '')
        const reset = Number.isFinite(time)
          ? new Date(time).toLocaleString('zh-CN', {
              month: 'numeric',
              day: 'numeric',
              hour: '2-digit',
              minute: '2-digit'
            }) + ' 重置'
          : '重置时间未知'
        return `<div class="row"><div class="labels"><span>${label}</span><strong>${p === null ? '等待更新' : '剩余 ' + Math.round(p) + '%'}</strong></div>${meter(p, true)}<div class="reset">${reset}</div></div>`
      })
      .join('')
    if (a.balance?.balances?.length) {
      $('.details').replaceChildren()
      const row = document.createElement('p')
      row.textContent = '按量付费余额：' + balanceText(a)
      $('.details').append(row)
    }
    $('.status').textContent = stale()
      ? 'Navo 未连接或数据同步已停止'
      : !a.checkedAt || Date.now() - a.checkedAt > 120000
        ? '额度已过期，等待 Navo 更新'
        : `额度更新于 ${new Date(a.checkedAt).toLocaleTimeString('zh-CN')}`
    $('.status').classList.toggle('warn', stale())
  }
  function render() {
    const accounts = data?.accounts || []
    for (const [id, button] of cards)
      if (!accounts.some((a) => a.id === id)) {
        button.remove()
        cards.delete(id)
      }
    $('.empty')?.remove()
    if (!accounts.length) {
      const empty = document.createElement('span')
      empty.className = 'empty'
      empty.textContent = failed ? '等待 Navo 连接' : '暂无可展示额度的账号'
      $('.accounts').append(empty)
    }
    accounts.forEach((a, index) => {
      let button = cards.get(a.id)
      if (!button) {
        button = document.createElement('button')
        button.className = 'account'
        button.innerHTML =
          '<span class="identity"><span class="provider"></span><span class="name"></span></span><span class="stats" style="display:contents"></span>'
        button.setAttribute('aria-expanded', 'false')
        button.onclick = () => {
          const same = selected === a.id && !$('.panel').hidden
          close()
          selected = a.id
          if (!same) {
            $('.panel').hidden = false
            button.setAttribute('aria-expanded', 'true')
            details()
            position()
          }
        }
        cards.set(a.id, button)
      }
      if ($('.accounts').children[index] !== button)
        $('.accounts').insertBefore(button, $('.accounts').children[index] || null)
      button.querySelector('.provider').textContent = provider(a)
      button.querySelector('.name').textContent = a.name
      button.setAttribute('aria-label', `查看 ${a.name} 额度`)
      button.title = `${provider(a)} · ${a.name}${a.enabled ? '' : '（已停用）'} · 剩余额度 · 点击查看详情`
      button.querySelector('.stats').innerHTML = values
        .filter(([key]) => hasWindow(a[key]))
        .map(([key, label]) => {
          const p = stale() ? null : percent(a[key], a.checkedAt)
          return `<span class="stat"><span class="muted">${label}</span>${meter(p)}<span>${p === null ? '—' : Math.round(p) + '%'}</span></span>`
        })
        .join('')
      if (a.balance?.balances?.length) button.querySelector('.stats').textContent = balanceText(a)
    })
    if (!$('.panel').hidden) details()
    position()
  }
  async function refresh() {
    try {
      const r = await fetch('/assets/navo-quota-data.json?t=' + Date.now(), { cache: 'no-store' })
      if (!r.ok) throw new Error('not ready')
      const next = await r.json()
      if (!Array.isArray(next.accounts)) throw new Error('invalid data')
      disabled = next.enabled === false
      data = {
        ...next,
        accounts: next.accounts.filter(
          (a) =>
            a.enabled === true &&
            (values.some(([key]) => hasWindow(a[key])) || a.balance?.balances?.length)
        )
      }
      failed = false
    } catch {
      failed = true
    }
    render()
  }
  function arrows() {
    const list = $('.accounts')
    $('.prev').disabled = list.scrollLeft < 2
    $('.next').disabled = list.scrollLeft + list.clientWidth >= list.scrollWidth - 2
  }
  function position() {
    const showAccounts = data?.accountQuota !== false
    const showSession = data?.sessionStats !== false
    $('.accounts').hidden = !showAccounts
    $('.session-summary').hidden = !showSession
    $('.session-summary').style.marginRight = showAccounts ? '' : '0'
    if (!showAccounts && !$('.panel').hidden) close()
    if (!showSession && !$('.session-panel').hidden) close()
    if (showSession) sessionMetrics()
    const header = [...document.querySelectorAll('.chat-header')].find(
      (el) => el.getBoundingClientRect().width > 0
    )
    const spacer = header?.querySelector('.ch-spacer')
    if (!header || !spacer || disabled || (!showAccounts && !showSession)) {
      host.style.display = 'none'
      return
    }
    const r = header.getBoundingClientRect(),
      s = spacer.getBoundingClientRect()
    // 使用真实弹性空白区，左右留白；不再用固定偏移猜测操作按钮位置。
    const whole = Math.floor(s.width - 48)
    const sessionWidth = showSession ? (whole >= (showAccounts ? 600 : 300) ? 300 : 48) : 0
    $('.session-summary').classList.toggle('small', sessionWidth === 48)
    const sessionGap = showAccounts && showSession ? 12 : 0
    const available = whole - sessionWidth - sessionGap
    if (showAccounts ? available < 155 : whole < sessionWidth) {
      host.style.display = 'none'
      return
    }
    const n = Math.max(1, data?.accounts.length || 1)
    let count = Math.max(1, Math.min(3, n, Math.floor((available + 8) / 260)))
    let overflow = n > count
    if (overflow) count = Math.max(1, Math.min(count, Math.floor((available - 52 + 8) / 260)))
    overflow = n > count
    if (!showAccounts) count = 0
    const navWidth = showAccounts && overflow && available >= 207 ? 52 : 0
    cardWidth = count
      ? Math.min(252, Math.floor((available - navWidth - (count - 1) * 8) / count))
      : 0
    const accountsWidth = count ? count * cardWidth + (count - 1) * 8 : 0
    host.toggleAttribute('compact', cardWidth < 230)
    host.style.setProperty('--card-width', `${cardWidth}px`)
    host.style.display = ''
    host.style.top = `${r.top + (r.height - 32) / 2}px`
    host.style.right = `${innerWidth - s.right + 24}px`
    host.style.width = `${accountsWidth + navWidth + sessionWidth + sessionGap}px`
    host.dataset.visibleCount = String(count)
    $('.prev').hidden = $('.next').hidden = !navWidth
    $('.accounts').style.width = `${accountsWidth}px`
    $('.panel').style.top = `${r.bottom + 8}px`
    $('.panel').style.right = `${Math.max(12, innerWidth - s.right + 24)}px`
    $('.session-panel').style.top = `${r.bottom + 8}px`
    $('.session-panel').style.left =
      `${Math.max(12, Math.min(innerWidth - 352, host.getBoundingClientRect().left))}px`
    arrows()
  }
  $('.prev').onclick = () => $('.accounts').scrollBy({ left: -(cardWidth + 8), behavior: 'smooth' })
  $('.next').onclick = () => $('.accounts').scrollBy({ left: cardWidth + 8, behavior: 'smooth' })
  $('.accounts').addEventListener('scroll', arrows)
  $('.accounts').addEventListener(
    'wheel',
    (e) => {
      if ($('.accounts').scrollWidth > $('.accounts').clientWidth) {
        e.preventDefault()
        $('.accounts').scrollLeft += Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY
      }
    },
    { passive: false }
  )
  $('.refresh').onclick = refresh
  $('.session-summary').onclick = () => {
    const wasOpen = !$('.session-panel').hidden
    close()
    if (!wasOpen) {
      $('.session-panel').hidden = false
      $('.session-summary').setAttribute('aria-expanded', 'true')
      sessionMetrics()
    }
  }
  document.addEventListener('pointerdown', (e) => {
    if (!e.composedPath().includes(host)) close()
  })
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') close()
  })
  window.addEventListener('resize', position)
  setInterval(position, 800)
  setInterval(refresh, 5000)
  position()
  void refresh()
})()
