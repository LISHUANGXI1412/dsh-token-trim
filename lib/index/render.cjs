// render.cjs — 把"路径 + artifact"渲染成一段稳定的索引文本，并裁剪到 token 上限。
//
// 格式（设计草案 §3 + 2026-11-14 评审修正）：
//   [context index · 2 compactions]
//   artifacts:
//     a1b2c3  pwsh   test/run.mjs       4.1K  trunc
//     7a7644  read                     99 / full 12.6K  need
//     d4e5f6  read   src/serialize.mjs 11.9K  need ×3
//     … (+3 more)
//   paths:
//     E:\dsh的工作区\reports\eviction-plan.md
//     … (+12 more)
//   ↳ 原文：guard_query(id, pattern) 或 read ~/.dsh/token-guard/artifacts/<id>.txt
//
// 头部**不带 step**（A2）：step 每步都变，会让"同值零事件"保护失效；
// step 只进审计。compactions 在一个压缩周期内是稳定的。
//
// 渲染是纯函数：同样的输入 → 同样的输出（可单测、可回放）。
const { estimateTokens } = require('./tokens.cjs')

function clampInt(value, fallback, min, max) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.min(max, Math.floor(n)))
}

// 把过长的目标列从"头部"压缩，保留尾部（文件名/级别更有信息）
function shorten(text, maxChars) {
  if (typeof text !== 'string') return ''
  if (text.length <= maxChars) return text
  return `…${text.slice(-(maxChars - 1))}`
}

function emptyResult(step, compactions) {
  return {
    text: '',
    chars: 0,
    estTokens: 0,
    step,
    compactions,
    pathLines: 0,
    artifactLines: 0,
    droppedPaths: 0,
    droppedArtifacts: 0,
    totalPaths: 0,
    totalArtifacts: 0,
    overBudget: false,
  }
}

function renderBody({ paths, artifacts, totalPaths, totalArtifacts, compactions, targetChars, hint = true }) {
  const lines = [`[context index · ${compactions} compaction${compactions === 1 ? '' : 's'}]`]

  if (totalArtifacts > 0) {
    lines.push('artifacts:')
    if (artifacts.length === 0) {
      lines.push(`  … (+${totalArtifacts} more)`)
    } else {
      const targetWidth = artifacts.reduce((w, a) => Math.max(w, shorten(a.target, targetChars).length), 4)
      for (const artifact of artifacts) {
        const id = String(artifact.id).padEnd(6)
        const tool = String(artifact.tool).slice(0, 6).padEnd(6)
        const target = shorten(artifact.target ?? '', targetChars).padEnd(targetWidth)
        const size = String(artifact.size ?? '—')
        const dup = Number(artifact.dup) > 1 ? ` ×${artifact.dup}` : ''
        const status = `${artifact.status ?? '—'}${dup}`
        lines.push(`  ${id}  ${tool}  ${target}  ${size}  ${status}`)
      }
      const dropped = totalArtifacts - artifacts.length
      if (dropped > 0) lines.push(`  … (+${dropped} more)`)
    }
  }

  if (totalPaths > 0) {
    lines.push('paths:')
    if (paths.length === 0) {
      lines.push(`  … (+${totalPaths} more)`)
    } else {
      for (const p of paths) lines.push(`  ${p}`)
      const dropped = totalPaths - paths.length
      if (dropped > 0) lines.push(`  … (+${dropped} more)`)
    }
  }

  // 取回提示：没有它，id 对模型就是一串无意义的字符。
  if (totalArtifacts > 0 && hint) {
    lines.push('↳ 原文：guard_query(id, pattern) 或 read ~/.dsh/token-guard/artifacts/<id>.txt')
  }

  return lines.join('\n')
}

/**
 * 生成索引文本。
 * @param {object} opts
 * @param {string[]} opts.paths        最近使用在前，已归一化、已脱敏
 * @param {object[]} opts.artifacts    最近在前 {id,tool,target,size,status,dup}
 * @param {number} opts.step           只进审计，不进文本（A2）
 * @param {number} opts.compactions
 * @param {object} opts.limits         {maxTokens, pathLimit, artifactLimit, targetChars, hint}
 */
function buildIndex(opts = {}) {
  const { paths = [], artifacts = [], step = 0, compactions = 0 } = opts
  const limits = opts.limits ?? {}
  const maxTokens = clampInt(limits.maxTokens, 1000, 120, 100000)
  const pathLimit = clampInt(limits.pathLimit, 40, 1, 200)
  const artifactLimit = clampInt(limits.artifactLimit, 20, 1, 100)
  const targetChars = clampInt(limits.targetChars, 48, 12, 120)

  const safePaths = Array.isArray(paths) ? paths.filter((p) => typeof p === 'string' && p) : []
  const safeArtifacts = Array.isArray(artifacts) ? artifacts.filter((a) => a && typeof a === 'object') : []
  const totalPaths = safePaths.length
  const totalArtifacts = safeArtifacts.length

  if (totalPaths === 0 && totalArtifacts === 0) return emptyResult(step, compactions)

  // 1) 条数上限（硬约束：paths ≤ pathLimit、artifacts ≤ artifactLimit）
  let shownPaths = safePaths.slice(0, pathLimit)
  let shownArtifacts = safeArtifacts.slice(0, artifactLimit)

  // 2) token 上限：先裁路径（最不常用在尾部），再裁 artifact，直到放得下
  for (;;) {
    const text = renderBody({
      paths: shownPaths,
      artifacts: shownArtifacts,
      totalPaths,
      totalArtifacts,
      compactions,
      targetChars,
      hint: limits.hint !== false,
    })
    const estTokens = estimateTokens(text)
    if (estTokens <= maxTokens) {
      return {
        text,
        chars: text.length,
        estTokens,
        step,
        compactions,
        pathLines: shownPaths.length,
        artifactLines: shownArtifacts.length,
        droppedPaths: totalPaths - shownPaths.length,
        droppedArtifacts: totalArtifacts - shownArtifacts.length,
        totalPaths,
        totalArtifacts,
        overBudget: false,
      }
    }
    if (shownPaths.length > 0) {
      const drop = Math.max(1, Math.ceil(shownPaths.length * 0.2))
      shownPaths = shownPaths.slice(0, Math.max(0, shownPaths.length - drop))
      continue
    }
    if (shownArtifacts.length > 0) {
      const drop = Math.max(1, Math.ceil(shownArtifacts.length * 0.2))
      shownArtifacts = shownArtifacts.slice(0, Math.max(0, shownArtifacts.length - drop))
      continue
    }
    // 只剩两个 "(+N more)" 标记还是超预算：说明上限配得过小，硬性返回
    return {
      text,
      chars: text.length,
      estTokens,
      step,
      compactions,
      pathLines: 0,
      artifactLines: 0,
      droppedPaths: totalPaths,
      droppedArtifacts: totalArtifacts,
      totalPaths,
      totalArtifacts,
      overBudget: true,
    }
  }
}

module.exports = { buildIndex, renderBody, shorten }
