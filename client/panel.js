// dsh-token-trim 的会话视图（Web 客户端插件）。
// 位置：对话上方的 View 标签行（conversation.view），与「对话 / 轨迹 / 统计」并列。
// 数据：tokenTrim/status + /report + /bill + /replay（均无参数，筛选在客户端）。
window.__ModuleLoader__.load({
  id: 'dsh-token-trim',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const EN = {
      label: 'Savings',
      title: 'Savings',
      subtitle: 'Measured from real session logs: compaction tuning + tool-result trimming, minus rework.',
      liveTitle: 'Bill saved (measured, net)',
      eq: 'net =',
      compaction: 'compaction tuning',
      rules: 'tool trimming',
      rework: 'suspected rework',
      continuation: 'likely follow-up reads',
      notDeducted: '(not deducted)',
      sample: 'samples',
      aligned: 'aligned',
      legacy: 'legacy rows (no session id)',
      stale: 'new rewrites pending · auto-refresh within 60s',
      policy: 'policy',
      modelTitle: 'fixed model (historical)',
      modelNote: 'Config-level replay from 2026-11-15: compaction −31% × rules −15% ≈ −41%. Kept for comparison; trust the measured number above.',
      charsTitle: 'Trimming detail',
      charsScope: 'this window',
      events: 'results rewritten',
      chars: 'characters',
      savedChars: 'saved',
      tokens: 'est. tokens',
      denom: 'The percentage is measured only over the results this plugin actually rewrote.',
      usageTitle: 'Bill usage (measured)',
      usageNote: 'From the dsh-context-kit session cache: hit ×1, miss ×10, output ×15.',
      usageHit: 'cache hit',
      usageMiss: 'miss',
      usageOut: 'output',
      usageCost: 'cost',
      sessionsTitle: 'By session',
      recentTitle: 'Recent rewrites',
      refresh: 'Refresh',
      busy: 'Loading…',
      auto: 'Live',
      paused: 'Paused',
      updated: 'updated',
      replayBtn: 'Run replay',
      replayBusy: 'Replaying…',
      runAll: 'All sessions',
      runThis: 'This session',
      empty: 'Nothing rewritten yet. token-guard only records results it actually changed.',
      none: 'No manifest yet — the plugin is idle, or dryRun never wrote anything.',
      dry: 'dryRun is ON: nothing is being rewritten.',
      error: 'Error',
      tool: 'tool',
      count: 'n',
      last: 'last',
      focus: 'Focus',
      clear: 'clear',
    }

    const ZH = {
      label: '节省',
      title: '账单节省',
      subtitle: '来自真实会话日志：压缩阈值调优 + 工具结果治理，再扣掉返工。',
      liveTitle: '账单净节省（实测）',
      eq: '即',
      compaction: '压缩阈值调优',
      rules: '工具治理',
      rework: '疑似返工',
      continuation: '疑似补读',
      notDeducted: '（未扣减）',
      sample: '样本',
      aligned: '已对齐',
      legacy: '条无会话 id（不计价）',
      stale: '有新改写待计入 · 60 秒内自动更新',
      policy: '策略',
      modelTitle: '固定模型（历史口径）',
      modelNote: '2026-11-15 的语料级回放：压缩 −31% × 规则 −15% ≈ −41%。保留作对照，以上面的实测为准。',
      charsTitle: '工具治理明细',
      charsScope: '本窗口',
      events: '条结果被改写',
      chars: '字符',
      savedChars: '省下',
      tokens: '约合 token',
      denom: '百分比的分母只是本插件实际改写过的工具结果。',
      usageTitle: '账单用量（实测）',
      usageNote: '来自 dsh-context-kit 的会话日志缓存：命中 ×1、未命中 ×10、输出 ×15。',
      usageHit: '缓存命中',
      usageMiss: '未命中',
      usageOut: '输出',
      usageCost: '成本',
      sessionsTitle: '按会话',
      recentTitle: '最近改写',
      refresh: '刷新',
      busy: '读取中…',
      auto: '实时',
      paused: '已暂停',
      updated: '更新于',
      replayBtn: '实测回放',
      replayBusy: '回放中…',
      runAll: '全部会话',
      runThis: '本会话',
      empty: '还没有被改写的工具结果。token-trim 只记录真正改过的结果。',
      none: '还没有 manifest —— 插件空闲，或 dryRun 从未写过盘。',
      dry: 'dryRun 已开启：内容没有被改写。',
      error: '出错',
      tool: '工具',
      count: '次数',
      last: '最近',
      focus: '聚焦',
      clear: '取消',
    }

    const CSS = [
      '.tg_view { display: flex; flex-direction: column; gap: 12px; padding: 18px 22px 40px; max-width: 920px; box-sizing: border-box; }',
      '.tg_head h2 { margin: 0 0 4px; font-size: 16px; }',
      '.tg_head p { margin: 0; opacity: .7; font-size: 12px; }',
      '.tg_row { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }',
      '.tg_card { border: 1px solid rgba(127,127,127,.25); border-radius: 10px; padding: 12px; display: flex; flex-direction: column; gap: 8px; }',
      '.tg_card.muted { opacity: .72; }',
      '.tg_cardhead { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }',
      '.tg_cardhead strong { font-size: 13px; }',
      '.tg_hero { display: flex; align-items: baseline; gap: 10px; flex-wrap: wrap; }',
      '.tg_hero .tg_big { font-size: 30px; }',
      '.tg_seg { display: inline-flex; border: 1px solid rgba(127,127,127,.35); border-radius: 8px; overflow: hidden; }',
      '.tg_seg button { border: 0; background: transparent; color: inherit; padding: 4px 10px; font-size: 12px; cursor: pointer; }',
      '.tg_seg button.on { background: rgba(37,99,235,.18); font-weight: 600; }',
      '.tg_btn { border: 1px solid rgba(127,127,127,.35); background: transparent; color: inherit; border-radius: 8px; padding: 4px 10px; cursor: pointer; font-size: 12px; }',
      '.tg_btn:disabled { opacity: .5; cursor: default; }',
      '.tg_big { font-size: 24px; font-weight: 600; font-variant-numeric: tabular-nums; }',
      '.tg_meta { font-size: 11px; opacity: .65; }',
      '.tg_note { font-size: 11px; opacity: .55; line-height: 1.5; }',
      '.tg_warn { font-size: 12px; color: #d97706; }',
      '.tg_err { font-size: 12px; color: #dc2626; }',
      '.tg_table { width: 100%; border-collapse: collapse; font-size: 12px; }',
      '.tg_table th, .tg_table td { text-align: left; padding: 3px 6px; border-bottom: 1px solid rgba(127,127,127,.16); font-variant-numeric: tabular-nums; }',
      '.tg_table th { font-weight: 600; opacity: .7; }',
      '.tg_table td.num, .tg_table th.num { text-align: right; }',
      '.tg_table tr.clickable { cursor: pointer; }',
      '.tg_table tr.clickable:hover td { background: rgba(127,127,127,.08); }',
      '.tg_table tr.on td { background: rgba(37,99,235,.12); }',
      '.tg_ev { display: flex; gap: 8px; align-items: baseline; font-size: 12px; padding: 2px 0; border-bottom: 1px solid rgba(127,127,127,.1); }',
      '.tg_ev .t { min-width: 72px; opacity: .6; font-variant-numeric: tabular-nums; }',
      '.tg_ev .tg_target { opacity: .8; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; flex: 1 1 120px; }',
      '.tg_chip { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: rgba(127,127,127,.18); }',
      '.tg_chip.warn { background: rgba(217,119,6,.18); }',
    ].join('\n')

    const fmtBig = (value) => {
      if (!Number.isFinite(value)) return '—'
      if (Math.abs(value) >= 1e9) return (value / 1e9).toFixed(2) + 'B'
      if (Math.abs(value) >= 1e6) return (value / 1e6).toFixed(1) + 'M'
      if (Math.abs(value) >= 1e3) return Math.round(value / 1e3) + 'K'
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
          const message = response && response.error ? response.error.message : 'token trim remote call failed'
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
      const [replay, setReplay] = React.useState(null)
      const [days, setDays] = React.useState(0)
      const [focus, setFocus] = React.useState('')
      const [busy, setBusy] = React.useState(false)
      const [replayBusy, setReplayBusy] = React.useState(false)
      const [error, setError] = React.useState('')
      const [status, setStatus] = React.useState(null)
      const [auto, setAuto] = React.useState(true)
      const [updatedAt, setUpdatedAt] = React.useState(0)

      const load = React.useCallback(function (force, silent) {
        if (!silent) setBusy(true)
        return Promise.all([
          loadReport(api, force),
          api.status().catch(function () { return null }),
          api.bill().catch(function () { return null }),
        ])
          .then(function (results) {
            setData(results[0])
            if (results[1]) setStatus(results[1])
            if (results[2]) setBill(results[2])
            setUpdatedAt(Date.now())
          })
          .catch(function (cause) { setError(String(cause && cause.message ? cause.message : cause)) })
          .then(function () { if (!silent) setBusy(false) })
      }, [api])

      const runReplay = React.useCallback(function (silent) {
        if (!silent) setReplayBusy(true)
        return api.replay()
          .then(function (value) { setReplay(value) })
          .catch(function (cause) { setError(String(cause && cause.message ? cause.message : cause)) })
          .then(function () { setReplayBusy(false) })
      }, [api])

      React.useEffect(function () { load(false, false) }, [load])

      // 实时：视图可见时每 5 秒静默重读；切回页面立即补一次。
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

      // 回放很贵（解压日志在 worker 里也要 2–5 秒）：首次进入自动跑一次，之后最多 60 秒一次，
      // 且同一条改写批次不重复跑。忙碌时跳过，避免排队。
      const replayMeta = React.useRef({ at: 0, records: -1 })
      React.useEffect(function () {
        if (!data || !auto || replayBusy) return
        const records = data.records || 0
        const first = replay === null
        const changed = records !== replayMeta.current.records
        const elapsed = Date.now() - replayMeta.current.at
        if (!first && !(changed && elapsed > 60000)) return
        replayMeta.current = { at: Date.now(), records }
        runReplay(true)
      }, [data, auto, replay, replayBusy, runReplay])

      const model = data ? viewModel(data, focus, days) : null
      const rows = []

      if (error) rows.push(h('div', { className: 'tg_err' }, t('error') + ': ' + error))
      if (status && status.dryRun) rows.push(h('div', { className: 'tg_warn' }, t('dry')))
      if (data && !data.available) rows.push(meta(t('none')))

      if (model) {
        const rt = replay && replay.totals ? replay.totals : null
        const netModel = bill && Number.isFinite(bill.netPct) ? bill.netPct : 41.3
        const reworkPct = bill && bill.rework && Number.isFinite(bill.rework.pctOfBaseline) ? bill.rework.pctOfBaseline : 0
        const netMeasured = rt ? rt.totalPct - reworkPct : 0

        // 1) 实测净节省（压缩阈值 + 工具治理 − 疑似返工），放首位
        rows.push(h('div', { className: 'tg_card' },
          h('div', { className: 'tg_hero' },
            h('span', { className: 'tg_big' }, rt ? '−' + pct(netMeasured) : '—'),
            h('span', { className: 'tg_meta' }, t('liveTitle'))),
          h('div', { className: 'tg_row' },
            meta(rt ? t('compaction') + ' +' + pct(rt.compactionPct) : t('compaction') + ' …'),
            meta(rt ? t('rules') + ' +' + pct(rt.rulePct) : t('rules') + ' …'),
            meta(t('rework') + ' −' + reworkPct.toFixed(2) + '%'),
            bill && bill.rework && bill.rework.continuation
              ? meta(t('continuation') + ' ' + bill.rework.continuation + ' ' + t('notDeducted'))
              : null),
          h('div', { className: 'tg_row' },
            meta(rt ? t('eq') + ' +' + pct(rt.totalPct) + ' − ' + reworkPct.toFixed(2) + '%' : ''),
            rt ? meta(t('sample') + ' ' + rt.sessions + ' · ' + t('aligned') + ' ' + rt.aligned + '/' + rt.events) : null,
            rt && rt.legacy ? meta(rt.legacy + ' ' + t('legacy')) : null,
            rt && replay.policy ? meta(t('policy') + ' ' + replay.policy.thresholdRatio + ' / ' + replay.policy.retainRatio) : null,
            rt && data && data.records !== replayMeta.current.records && !replayBusy ? meta(t('stale')) : null),
          h('div', { className: 'tg_note' },
            rt
              ? '反事实回放：压缩按当前策略 vs 出厂 0.8/0.16；工具治理按每条改写结果的实际存活步数计费。'
              : '点「实测回放」按真实会话日志计算。'),
          replayBusy ? h('div', { className: 'tg_note' }, t('replayBusy')) : null))

        // 2) 固定模型（次要，明确标注）
        rows.push(h('div', { className: 'tg_card muted' },
          h('div', { className: 'tg_cardhead' },
            h('strong', null, t('modelTitle')),
            meta('−' + netModel.toFixed(1) + '%')),
          h('div', { className: 'tg_note' }, t('modelNote'))))

        // 3) 工具治理明细（字符口径）
        rows.push(h('div', { className: 'tg_card' },
          h('div', { className: 'tg_cardhead' },
            h('strong', null, t('charsTitle')),
            meta(t('charsScope') + ' · ' + model.totals.events + ' ' + t('events'))),
          h('div', { className: 'tg_row' },
            h('span', { className: 'tg_big' }, '−' + pct(model.totals.cutPct)),
            meta(fmtBig(model.totals.orig) + ' → ' + fmtBig(model.totals.vis) + ' ' + t('chars')),
            meta(t('savedChars') + ' ' + fmtBig(model.totals.saved) + ' ≈ ' + fmtBig(model.totals.tokens) + ' tok')),
          h('table', { className: 'tg_table' },
            h('thead', null, h('tr', null,
              h('th', null, t('tool')),
              h('th', { className: 'num' }, t('count')),
              h('th', { className: 'num' }, t('savedChars')))),
            h('tbody', null, model.tools.slice(0, 6).map((tool) =>
              h('tr', { key: tool.name },
                h('td', null, tool.name),
                h('td', { className: 'num' }, tool.events),
                h('td', { className: 'num' }, fmtBig(tool.saved)))))),
          h('div', { className: 'tg_note' }, t('denom'))))

        // 4) 账单用量
        if (bill && bill.available && bill.totals) {
          const bt = bill.totals
          rows.push(h('div', { className: 'tg_card' },
            h('div', { className: 'tg_cardhead' },
              h('strong', null, t('usageTitle')),
              meta(bt.sessions + ' ' + t('sample') + ' · ' + fmtBig(bt.steps) + ' steps')),
            h('div', { className: 'tg_row' },
              meta(t('usageHit') + ' ' + fmtBig(bt.hit)),
              meta(t('usageMiss') + ' ' + fmtBig(bt.miss)),
              meta(t('usageOut') + ' ' + fmtBig(bt.out)),
              meta(t('usageCost') + ' ' + fmtBig(bt.cost))),
            h('div', { className: 'tg_note' }, t('usageNote')),
            bill.updatedAt ? meta(t('updated') + ' ' + timeOf(bill.updatedAt)) : null))
        }

        // 5) 按会话
        rows.push(h('div', { className: 'tg_card' },
          h('div', { className: 'tg_cardhead' },
            h('strong', null, t('sessionsTitle')),
            focus ? h('button', { className: 'tg_btn', type: 'button', onClick: function () { setFocus('') } }, t('clear')) : null,
            !focus && sessionId ? h('button', { className: 'tg_btn', type: 'button', onClick: function () { setFocus(sessionId) } }, t('runThis')) : null),
          h('table', { className: 'tg_table' },
            h('thead', null, h('tr', null,
              h('th', null, ''),
              h('th', { className: 'num' }, t('count')),
              h('th', { className: 'num' }, t('savedChars')),
              h('th', null, t('last')))),
            h('tbody', null, model.sessions.slice(0, 10).map((row) =>
              h('tr', {
                key: row.id,
                className: 'clickable' + (model.selected && model.selected.id === row.id ? ' on' : ''),
                onClick: function () { setFocus(model.selected && model.selected.id === row.id ? '' : row.id) },
              },
                h('td', null, row.id === 'legacy' ? 'legacy' : shortId(row.id)),
                h('td', { className: 'num' }, row.events),
                h('td', { className: 'num' }, fmtBig(row.saved)),
                h('td', { className: 'tg_meta' }, timeOf(row.last))))))))

        // 6) 最近改写
        rows.push(h('div', { className: 'tg_card' },
          h('div', { className: 'tg_cardhead' }, h('strong', null, t('recentTitle'))),
          ...model.events.slice(0, 10).map(function (row, index) {
            return h('div', { className: 'tg_ev', key: index },
              h('span', { className: 't' }, timeOf(row.ts).slice(5)),
              h('span', { className: 'tg_chip' }, row.tool + ' · ' + row.mode),
              h('span', { className: 'tg_meta' }, fmtBig(row.orig) + '→' + fmtBig(row.vis)),
              h('span', { className: 'tg_target' }, row.target || ''),
              row.dryRun ? h('span', { className: 'tg_chip warn' }, 'dry') : null)
          })))

        if (status) {
          const where = []
          if (status.artifactDir) where.push(meta(status.artifactDir))
          if (status.manifest) where.push(meta(status.manifest))
          if (where.length) rows.push(h('div', { className: 'tg_card muted' }, ...where))
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
          h('button', { className: 'tg_btn', type: 'button', disabled: replayBusy, onClick: function () { return runReplay(false) } },
            replayBusy ? t('replayBusy') : t('replayBtn')),
          h('button', { className: 'tg_btn', type: 'button', onClick: function () { setAuto(function (value) { return !value }) } },
            auto ? t('auto') : t('paused')),
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
