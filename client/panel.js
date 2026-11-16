// dsh-token-trim 的会话视图（Web 客户端插件）。
// 位置：对话上方的 View 标签行（conversation.view），与「对话 / 轨迹 / 统计」并列。
// 数据经 ctx.connection.rpc 调宿主 tokenTrim 服务（方法无参数，筛选在客户端）。
window.__ModuleLoader__.load({
  id: 'dsh-token-trim',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const EN = {
      label: 'Savings',
      title: 'Tool savings',
      subtitle: 'What token-trim removed before tool results entered the model context.',
      here: 'This session',
      all: 'All sessions',
      allTime: 'All time',
      days7: '7 days',
      days30: '30 days',
      refresh: 'Refresh',
      busy: 'Loading…',
      auto: 'Live',
      paused: 'Paused',
      updated: 'updated',
      error: 'Error',
      events: 'results rewritten',
      chars: 'characters',
      saved: 'saved',
      tokens: 'est. tokens',
      denom: 'The percentage below is measured only over the tool results token-trim actually rewrote. Small results, the system prompt, and reasoning are outside the hook.',
      billNote: 'Bill-level estimate (offline replay, 2026-11-15): compaction tuning ≈ −31%, this rule layer ≈ −15%, multiplied ≈ −41%. A fixed model — the live numbers are the event and character counts below.',
      billTitle: 'Bill saved (estimate)',
      netTitle: 'Bill saved (net estimate)',
      gross: 'gross',
      rework: 'rework',
      reworkTitle: 'Rework (suspected)',
      reworkSignal: 'repeats',
      reworkCost: 'cost (hit-equivalents)',
      reworkNote: 'Same rewritten result re-run within 30 minutes in one session, charged at the average step cost. This is the deduction applied to the headline.',
      reworkDuplicates: 'Bill-wide duplicate calls (not attributed):',
      billMeasured: 'Measured usage',
      billMeasuredNote: 'Read from the dsh-context-kit session-log cache: hit ×1, miss ×10, output ×15 (DeepSeek price ratio). This is the real usage side, not a projection.',
      billSessions: 'sessions',
      billSteps: 'steps',
      billCompactions: 'compactions',
      billHit: 'cache hit',
      billMiss: 'miss',
      billOut: 'output',
      billCost: 'cost (hit-equivalents)',
      billUnavailable: 'No measured bill yet — install dsh-context-kit so its session-log cache exists, then this card fills itself.',
      billUpdated: 'cache updated',
      replayBtn: 'Measured replay',
      replayBusy: 'Replaying…',
      replayTitle: 'Measured from session logs',
      replaySaved: 'of the bill (counterfactual)',
      replaySessions: 'sessions',
      replayAligned: 'aligned rewrites',
      replayLegacy: 'legacy (unsessioned)',
      replayCost: 'current bill',
      replayCounterfactual: 'without trimming',
      replayNote: 'Reads the real session logs: each rewritten result is charged once as a miss and then once per later request until the next compaction. Only rewrites with a session id can be aligned; legacy rows are counted but not priced.',
      pluginsTitle: 'This plugin, measured',
      tools: 'By tool',
      sessions: 'By session',
      recent: 'Recent transformations',
      count: 'n',
      cut: 'cut',
      last: 'last seen',
      legacy: 'Before session tracking',
      empty: 'Nothing rewritten yet in this session. token-trim only records results it actually changed.',
      none: 'No manifest yet — the plugin is idle, or dryRun never wrote anything.',
      dry: 'dryRun is ON: nothing is being rewritten, so these numbers are hypothetical.',
      where: 'Originals',
      tool: 'tool',
      mode: 'mode',
      focus: 'Focus',
      allFocus: 'clear',
    }

    const ZH = {
      label: '节省',
      title: '工具节省',
      subtitle: 'token-trim 在工具结果进入模型上下文之前，替我们砍掉了什么。',
      here: '本会话',
      all: '全部会话',
      allTime: '全部',
      days7: '7 天',
      days30: '30 天',
      refresh: '刷新',
      busy: '读取中…',
      auto: '实时',
      paused: '已暂停',
      updated: '更新于',
      error: '出错',
      events: '条结果被改写',
      chars: '字符',
      saved: '省下',
      tokens: '约合 token',
      denom: '下面的百分比，分母只是「token-trim 实际改写过的工具结果」。小结果、系统提示、推理都不在钩子里。',
      billNote: '账单级估算（离线回放，2026-11-15）：压缩阈值调优约 −31%，本规则层约 −15%，相乘约 −41%。这是固定模型——实时变化的是下面的事件与字符统计。',
      billTitle: '账单节省（估算）',
      netTitle: '账单净节省（估算）',
      gross: '毛节省',
      rework: '返工扣减',
      reworkTitle: '返工（疑似）',
      reworkSignal: '次重跑',
      reworkCost: '成本（命中当量）',
      reworkNote: '同一会话里，同一条被改写的结果在 30 分钟内又被重跑，按平均步成本计费。这就是上面大字里扣掉的那部分。',
      reworkDuplicates: '全账单重复调用（未归因）：',
      billMeasured: '实测用量',
      billMeasuredNote: '来自 dsh-context-kit 的会话日志缓存：命中 ×1、未命中 ×10、输出 ×15（DeepSeek 价格比）。这是真实用量侧，不是推算。',
      billSessions: '个会话',
      billSteps: '步',
      billCompactions: '次压缩',
      billHit: '缓存命中',
      billMiss: '未命中',
      billOut: '输出',
      billCost: '成本（命中当量）',
      billUnavailable: '还没有实测账单 —— 装上 dsh-context-kit 生成会话日志缓存后，这张卡会自动填上。',
      billUpdated: '缓存更新于',
      replayBtn: '实测回放',
      replayBusy: '回放中…',
      replayTitle: '会话日志实测',
      replaySaved: '账单占比（反事实）',
      replaySessions: '个会话',
      replayAligned: '条已对齐',
      replayLegacy: '条无会话 id',
      replayCost: '当前账单',
      replayCounterfactual: '未治理时',
      replayNote: '读真实会话日志：每条被改写的结果先按一次未命中计费，之后每个仍包含它的请求按命中计费，直到下一次压缩。只有带 session id 的改写能对齐；legacy 行只计数、不计价。',
      pluginsTitle: '本插件实测',
      tools: '按工具',
      sessions: '按会话',
      recent: '最近变换',
      count: '次数',
      cut: '削减',
      last: '最近',
      legacy: '会话统计上线前',
      empty: '本会话还没有被改写的工具结果。token-trim 只记录真正改过的结果。',
      none: '还没有 manifest —— 插件空闲，或 dryRun 从未写过盘。',
      dry: 'dryRun 已开启：内容没有被改写，这些数字只是“如果真改会怎样”。',
      where: '原文位置',
      tool: '工具',
      mode: '模式',
      focus: '聚焦',
      allFocus: '取消',
    }

    const CSS = [
      '.tg_view { display: flex; flex-direction: column; gap: 14px; padding: 18px 22px 40px; max-width: 960px; box-sizing: border-box; }',
      '.tg_head h2 { margin: 0 0 4px; font-size: 16px; }',
      '.tg_head p { margin: 0; opacity: .7; font-size: 12px; }',
      '.tg_row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
      '.tg_card { border: 1px solid rgba(127,127,127,.25); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 10px; }',
      '.tg_cardhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.tg_cardhead strong { font-size: 13px; }',
      '.tg_seg { display: inline-flex; border: 1px solid rgba(127,127,127,.35); border-radius: 8px; overflow: hidden; }',
      '.tg_seg button { border: 0; background: transparent; color: inherit; padding: 4px 10px; font-size: 12px; cursor: pointer; }',
      '.tg_seg button.on { background: rgba(37,99,235,.18); font-weight: 600; }',
      '.tg_btn { border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 12px; }',
      '.tg_btn:disabled { opacity: .5; cursor: default; }',
      '.tg_big { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }',
      '.tg_meta { font-size: 11px; opacity: .65; }',
      '.tg_note { font-size: 11px; opacity: .6; line-height: 1.5; }',
      '.tg_warn { font-size: 12px; color: #d97706; }',
      '.tg_err { font-size: 12px; color: #dc2626; }',
      '.tg_table { width: 100%; border-collapse: collapse; font-size: 12px; }',
      '.tg_table th, .tg_table td { text-align: left; padding: 4px 6px; border-bottom: 1px solid rgba(127,127,127,.18); font-variant-numeric: tabular-nums; }',
      '.tg_table th { font-weight: 600; opacity: .75; }',
      '.tg_table td.num, .tg_table th.num { text-align: right; }',
      '.tg_table tr.clickable { cursor: pointer; }',
      '.tg_table tr.clickable:hover td { background: rgba(127,127,127,.08); }',
      '.tg_table tr.on td { background: rgba(37,99,235,.12); }',
      '.tg_ev { display: flex; gap: 8px; align-items: baseline; font-size: 12px; padding: 3px 0; border-bottom: 1px solid rgba(127,127,127,.12); }',
      '.tg_ev .t { min-width: 74px; opacity: .65; font-variant-numeric: tabular-nums; }',
      '.tg_ev .tg_target { opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 140px; }',
      '.tg_chip { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: rgba(127,127,127,.18); }',
      '.tg_chip.warn { background: rgba(217,119,6,.18); }',
    ].join('\n')

    const fmtBig = (value) => {
      if (!Number.isFinite(value)) return '—'
      if (value >= 1e9) return (value / 1e9).toFixed(2) + 'B'
      if (value >= 1e6) return (value / 1e6).toFixed(1) + 'M'
      if (value >= 1e3) return Math.round(value / 1e3) + 'K'
      return String(Math.round(value))
    }
    const pct = (value) => (Number.isFinite(value) ? value.toFixed(1) + '%' : '—')
    const timeOf = (ts) => {
      if (!ts) return '—'
      const d = new Date(ts)
      const pad = (n) => String(n).padStart(2, '0')
      return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
    }
    const shortId = (id) => {
      const s = String(id || '')
      if (s === 'legacy') return s
      return s.length > 10 ? s.slice(0, 8) : s
    }
    const meta = (value) => h('div', { className: 'tg_meta' }, value)
    const TOK_PER_CHAR = 0.306

    const cache = { at: 0, data: null, loading: null }
    function loadReport(api, force) {
      if (!force && cache.data && Date.now() - cache.at < 15000) return Promise.resolve(cache.data)
      if (cache.loading) return cache.loading
      cache.loading = api.report()
        .then(function (data) { cache.at = Date.now(); cache.data = data; cache.loading = null; return data })
        .catch(function (cause) { cache.loading = null; throw cause })
      return cache.loading
    }

    function makeT(ctx) {
      try {
        ctx.locale.register('token-trim', { en: EN, zh: ZH })
      } catch {}
      let bound
      try {
        bound = ctx.locale.bind('token-trim')
      } catch {}
      return function t(key, fallback) {
        try {
          if (typeof bound === 'function') {
            const value = bound(key)
            if (typeof value === 'string' && value) return value
          } else if (bound && typeof bound[key] === 'string') {
            return bound[key]
          }
        } catch {}
        let id = 'en'
        try {
          id = ctx.locale.getLocale().id
        } catch {}
        const dict = id === 'zh' ? ZH : EN
        return dict[key] || fallback || key
      }
    }

    function makeApi(ctx) {
      function call(method, args) {
        return ctx.connection.rpc.call('/api', 'tokenTrim/' + method, { args: args || {} }, undefined).then(function (response) {
          if (response && response.ok) return response.value
          const message = response && response.error ? response.error.message : 'token guard remote call failed'
          const error = new Error(message)
          error.code = response && response.error ? response.error.code : 'REMOTE_FAILED'
          throw error
        })
      }
      return {
        report: () => call('report', {}),
        status: () => call('status', {}),
        bill: () => call('bill', {}),
        replay: () => call('replay', {}),
      }
    }

    function viewModel(data, focus, days) {
      const cutoff = days > 0 ? Date.now() - days * 86400000 : 0
      const sessions = (data.sessions || []).filter(function (s) { return !cutoff || s.last >= cutoff })
      const selected = focus ? sessions.find(function (s) { return s.id === focus }) || null : null
      const pool = selected ? [selected] : sessions
      const totals = { events: 0, orig: 0, vis: 0, saved: 0 }
      const toolMap = new Map()
      for (const s of pool) {
        totals.events += s.events
        totals.orig += s.orig
        totals.vis += s.vis
        totals.saved += s.saved
        for (const tool of s.tools || []) {
          const cur = toolMap.get(tool.name) || { name: tool.name, events: 0, saved: 0 }
          cur.events += tool.events
          cur.saved += tool.saved
          toolMap.set(tool.name, cur)
        }
      }
      totals.cutPct = totals.orig ? Number(((1 - totals.vis / totals.orig) * 100).toFixed(1)) : 0
      totals.tokens = Math.round(totals.saved * TOK_PER_CHAR)
      const events = (data.events || []).filter(function (e) {
        if (cutoff && e.ts < cutoff) return false
        return selected ? e.session === selected.id : true
      })
      return {
        sessions,
        selected,
        totals,
        tools: [...toolMap.values()].sort(function (a, b) { return b.saved - a.saved }),
        events,
      }
    }

    function Seg(props) {
      const options = [
        { value: 0, label: props.t('allTime') },
        { value: 7, label: props.t('days7') },
        { value: 30, label: props.t('days30') },
      ]
      return h('div', { className: 'tg_seg' }, options.map((opt) =>
        h('button', {
          key: opt.value,
          type: 'button',
          className: props.value === opt.value ? 'on' : '',
          onClick: function () { props.onChange(opt.value) },
        }, opt.label),
      ))
    }

    function Panel(props) {
      const t = props.t
      const api = props.api
      const sessionId = props.sessionId || ''
      const [data, setData] = React.useState(null)
      const [bill, setBill] = React.useState(null)
      const [days, setDays] = React.useState(0)
      const [focus, setFocus] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [status, setStatus] = React.useState(null)
      const [auto, setAuto] = React.useState(true)
      const [updatedAt, setUpdatedAt] = React.useState(0)
      const [replay, setReplay] = React.useState(null)
      const [replayBusy, setReplayBusy] = React.useState(false)

      const load = React.useCallback(function (force, silent) {
        if (!silent) setBusy(true)
        setError('')
        return Promise.all([loadReport(api, force), api.status().catch(function () { return null }), api.bill().catch(function () { return null })])
          .then(function (results) {
            setData(results[0])
            if (results[1]) setStatus(results[1])
            if (results[2]) setBill(results[2])
            setUpdatedAt(Date.now())
          })
          .catch(function (cause) { setError(String(cause && cause.message ? cause.message : cause)) })
          .then(function () { if (!silent) setBusy(false) })
      }, [api])

      React.useEffect(function () { load(false, false) }, [load])

      // 实时刷新：视图可见时每 5 秒静默重读（不闪 loading）；切回页面立即补一次。
      React.useEffect(function () {
        if (!auto) return undefined
        const tick = function () {
          if (typeof document !== 'undefined' && document.hidden) return
          load(true, true).catch(function () {})
        }
        const timer = setInterval(tick, 5000)
        const onVisible = function () {
          if (typeof document !== 'undefined' && !document.hidden) load(true, true).catch(function () {})
        }
        if (typeof document !== 'undefined') document.addEventListener('visibilitychange', onVisible)
        return function () {
          clearInterval(timer)
          if (typeof document !== 'undefined') document.removeEventListener('visibilitychange', onVisible)
        }
      }, [auto, load])

      const runReplay = React.useCallback(function () {
        setReplayBusy(true)
        setError('')
        return api.replay()
          .then(function (value) { setReplay(value) })
          .catch(function (cause) { setError(String(cause && cause.message ? cause.message : cause)) })
          .then(function () { setReplayBusy(false) })
      }, [api])

      const model = data ? viewModel(data, focus, days) : null
      const rows = []

      if (error) rows.push(h('div', { className: 'tg_err' }, t('error') + ': ' + error))
      if (status && status.dryRun) rows.push(h('div', { className: 'tg_warn' }, t('dry')))
      if (data && !data.available) rows.push(meta(t('none')))

      if (model) {
        const scope = focus ? shortId(focus) : t('all')
        const totalPct = bill && Number.isFinite(bill.totalPct) ? bill.totalPct : 41.4
        const compactionPct = bill && Number.isFinite(bill.compactionPct) ? bill.compactionPct : 31
        const rulesPct = bill && Number.isFinite(bill.rulesPct) ? bill.rulesPct : 15

        // 1) 账单净节省（毛节省 − 疑似返工）
        const netPct = bill && Number.isFinite(bill.netPct) ? bill.netPct : totalPct
        const reworkPct = bill && bill.rework && Number.isFinite(bill.rework.pctOfBaseline) ? bill.rework.pctOfBaseline : 0
        rows.push(h('div', { className: 'tg_card' },
          h('div', { className: 'tg_row' },
            h('span', { className: 'tg_big' }, '−' + netPct.toFixed(1) + '%'),
            h('span', { className: 'tg_meta' }, t('netTitle'))),
          h('div', { className: 'tg_row' },
            meta(t('gross') + ' −' + totalPct.toFixed(1) + '%'),
            meta(t('rework') + ' −' + reworkPct.toFixed(2) + '%'),
            meta('压缩阈值 −' + compactionPct + '% × 规则层 −' + rulesPct + '%')),
          h('div', { className: 'tg_note' }, t('billNote'))))

        // 2) 实测用量（来自会话日志缓存）
        if (bill && bill.available && bill.totals) {
          const bt = bill.totals
          rows.push(h('div', { className: 'tg_card' },
            h('div', { className: 'tg_cardhead' }, h('strong', null, t('billMeasured'))),
            h('div', { className: 'tg_row' },
              meta(bt.sessions + ' ' + t('billSessions') + ' · ' + bt.steps + ' ' + t('billSteps') + ' · ' + bt.compactions + ' ' + t('billCompactions')),
              meta(t('billCost') + ' ' + fmtBig(bt.cost))),
            h('div', { className: 'tg_row' },
              meta(t('billHit') + ' ' + fmtBig(bt.hit)),
              meta(t('billMiss') + ' ' + fmtBig(bt.miss)),
              meta(t('billOut') + ' ' + fmtBig(bt.out))),
            h('div', { className: 'tg_note' }, t('billMeasuredNote')),
            bill.updatedAt ? meta(t('billUpdated') + ' ' + timeOf(bill.updatedAt)) : null))
        } else {
          rows.push(h('div', { className: 'tg_card' },
            h('div', { className: 'tg_cardhead' }, h('strong', null, t('billMeasured'))),
            meta(t('billUnavailable'))))
        }

        // 3) 返工（疑似），计入上方扣减
        if (bill && bill.rework) {
          const rw = bill.rework
          rows.push(h('div', { className: 'tg_card' },
            h('div', { className: 'tg_cardhead' }, h('strong', null, t('reworkTitle'))),
            h('div', { className: 'tg_row' },
              meta(rw.suspected + ' ' + t('reworkSignal') + ' · ' + rw.windowMinutes + ' min'),
              meta(t('reworkCost') + ' ' + fmtBig(rw.costEquiv)),
              meta('−' + Number(rw.pctOfBaseline || 0).toFixed(2) + '%')),
            h('div', { className: 'tg_note' }, t('reworkNote')),
            bill.totals ? meta(t('reworkDuplicates') + ' ' + fmtBig(bill.totals.duplicates) + ' / ' + fmtBig(bill.totals.distinctCalls)) : null))
        }

        // 4) 会话日志实测（反事实回放，按需）
        if (replay && replay.totals) {
          const rt = replay.totals
          rows.push(h('div', { className: 'tg_card' },
            h('div', { className: 'tg_cardhead' }, h('strong', null, t('replayTitle'))),
            h('div', { className: 'tg_row' },
              h('span', { className: 'tg_big' }, '−' + Number(rt.savedPct || 0).toFixed(2) + '%'),
              meta(t('replaySaved'))),
            h('div', { className: 'tg_row' },
              meta(rt.sessions + ' ' + t('replaySessions')),
              meta(t('replayAligned') + ' ' + rt.aligned + '/' + rt.events),
              meta(t('replayLegacy') + ' ' + (rt.legacy || 0))),
            h('div', { className: 'tg_row' },
              meta(t('replayCost') + ' ' + fmtBig(rt.costCurrent)),
              meta(t('replayCounterfactual') + ' ' + fmtBig(rt.baselineCost))),
            h('div', { className: 'tg_note' }, t('replayNote'))))
        }

        // 5) 本插件实测（字符口径）
        rows.push(h('div', { className: 'tg_card' },
          h('div', { className: 'tg_cardhead' }, h('strong', null, t('pluginsTitle'))),
          h('div', { className: 'tg_row' },
            h('span', { className: 'tg_big' }, '−' + pct(model.totals.cutPct)),
            h('span', { className: 'tg_meta' }, scope + ' · ' + model.totals.events + ' ' + t('events')),
            h('span', { className: 'tg_meta' }, fmtBig(model.totals.orig) + ' → ' + fmtBig(model.totals.vis) + ' ' + t('chars'))),
          h('div', { className: 'tg_row' },
            meta(t('saved') + ' ' + fmtBig(model.totals.saved) + ' ' + t('chars')),
            meta(t('tokens') + ' ~' + fmtBig(model.totals.tokens))),
          h('div', { className: 'tg_note' }, t('denom'))))

        rows.push(h('div', { className: 'tg_card' },
          h('div', { className: 'tg_cardhead' }, h('strong', null, t('tools'))),
          h('table', { className: 'tg_table' },
            h('thead', null, h('tr', null,
              h('th', null, t('tool')),
              h('th', { className: 'num' }, t('count')),
              h('th', { className: 'num' }, t('saved')))),
            h('tbody', null, model.tools.slice(0, 8).map((tool) =>
              h('tr', { key: tool.name },
                h('td', null, tool.name),
                h('td', { className: 'num' }, tool.events),
                h('td', { className: 'num' }, fmtBig(tool.saved))))))))

        rows.push(h('div', { className: 'tg_card' },
          h('div', { className: 'tg_cardhead' },
            h('strong', null, t('sessions')),
            focus ? h('button', { className: 'tg_btn', type: 'button', onClick: function () { setFocus('') } }, t('allFocus')) : null,
            !focus && sessionId ? h('button', { className: 'tg_btn', type: 'button', onClick: function () { setFocus(sessionId) } }, t('here')) : null),
          h('table', { className: 'tg_table' },
            h('thead', null, h('tr', null,
              h('th', null, ''),
              h('th', { className: 'num' }, t('count')),
              h('th', { className: 'num' }, t('saved')),
              h('th', null, t('last')))),
            h('tbody', null, model.sessions.slice(0, 12).map((row) =>
              h('tr', {
                key: row.id,
                className: 'clickable' + (model.selected && model.selected.id === row.id ? ' on' : ''),
                onClick: function () { setFocus(model.selected && model.selected.id === row.id ? '' : row.id) },
              },
                h('td', null, row.id === 'legacy' ? t('legacy') : shortId(row.id)),
                h('td', { className: 'num' }, row.events),
                h('td', { className: 'num' }, fmtBig(row.saved)),
                h('td', { className: 'tg_meta' }, timeOf(row.last))))))))

        rows.push(h('div', { className: 'tg_card' },
          h('div', { className: 'tg_cardhead' }, h('strong', null, t('recent'))),
          ...model.events.slice(0, 15).map(function (row, index) {
            return h('div', { className: 'tg_ev', key: index },
              h('span', { className: 't' }, timeOf(row.ts).slice(5)),
              h('span', { className: 'tg_chip' }, row.tool + ' · ' + row.mode),
              h('span', { className: 'tg_meta' }, fmtBig(row.orig) + '→' + fmtBig(row.vis)),
              h('span', { className: 'tg_target' }, row.target || ''),
              row.artifact ? h('span', { className: 'tg_meta' }, row.artifact) : null,
              row.dryRun ? h('span', { className: 'tg_chip warn' }, 'dry') : null)
          })))

        if (status) {
          const where = []
          if (status.artifactDir) where.push(meta(status.artifactDir))
          if (status.manifest) where.push(meta(status.manifest))
          if (where.length) rows.push(h('div', { className: 'tg_card' },
            h('div', { className: 'tg_cardhead' }, h('strong', null, t('where'))),
            ...where))
        }
      }

      return h('div', { className: 'tg_view' },
        h('div', { className: 'tg_head' },
          h('h2', null, t('title')),
          h('p', null, t('subtitle'))),
        h('div', { className: 'tg_row' },
          h(Seg, { t: t, value: days, onChange: setDays }),
          h('button', { className: 'tg_btn', type: 'button', disabled: busy, onClick: function () { return load(true, false) } },
            busy ? t('busy') : t('refresh')),
          h('button', { className: 'tg_btn', type: 'button', disabled: replayBusy, onClick: runReplay },
            replayBusy ? t('replayBusy') : t('replayBtn')),
          h('button', {
            className: 'tg_btn',
            type: 'button',
            onClick: function () { setAuto(function (value) { return !value }) },
          }, auto ? t('auto') : t('paused')),
          updatedAt ? h('span', { className: 'tg_meta' }, t('updated') + ' ' + new Date(updatedAt).toLocaleTimeString()) : null),
        ...rows)
    }

    return {
      inject: ['slots', 'connection', 'locale'],
      apply(ctx) {
        const style = document.createElement('style')
        style.dataset.plugin = 'dsh-token-trim'
        style.textContent = CSS
        document.head.appendChild(style)
        ctx.effect(function () {
          return function () { style.remove() }
        })

        const t = makeT(ctx)
        const api = makeApi(ctx)

        // View 标签行：与「对话 / 轨迹 / 统计」并列
        ctx.slots.inject('conversation.view', function () {
          return ctx.slots.register({
            name: 'conversation.view',
            id: 'token-trim',
            order: 50,
            label: function () { return t('label', 'Savings') },
            inject: function () { return { api: api, t: t } },
          }, Panel)
        })
      },
    }
  },
})
