# dsh-token-trim

Trim tool results **before they enter the model context** — structural summaries, head/tail caps, repeat
deltas, and an artifact spill you can search back. Ships with a context index and a **measured savings view**
inside the conversation.

> Not a proxy, not a middleware you have to trust: every rewrite is reproducible, the original is always on
> disk, and the model can read it back with `guard_query`.

## Install

```bash
dsh plugin add dsh-token-trim
```

Restart DSH. You get:

- `token-trim` (host): rewrites tool results on `tools/post-execute`;
- `token-trim-index` (host): a small system-prompt section listing recent artifacts and touched paths;
- **Savings** view tab next to Chat / Trajectory / Stats, plus the `guard_query` tool.

## What it does

| rule | applies to | behaviour |
| --- | --- | --- |
| **structural summary** | JSON-shaped results from `cordis_inspect_*`, `plugin_manager`, `grep`, `skill`, `list_agents`, CUA window dumps | keeps the shape (keys, counts, ids), replaces verbose bodies with pointers |
| **head/tail cap** | long text from `pwsh`, `job_output`, … | keeps the first 72% and last 28% of the cap, inserts an artifact pointer + line count |
| **repeat delta** | any tool in `deltaTools` | if the same tool+args runs again and the diff is < 60% of the full text, send only the diff |
| **unchanged pointer** | same as above | sends `[unchanged · same as #N · artifact <id>]` |

Everything else is left alone: `edit`, `write`, `todo`, sub-agent messages, images, multi-block results,
reasoning, and any result under `minChars` (default 1200).

## Measured on the author's machine

19 days of real sessions, 279 rewrites, not a benchmark script:

| metric | value |
| --- | --- |
| characters rewritten | 3,493,915 → 876,875 (**−74.9%**) |
| tokens not re-sent | ≈ 800K |
| tools affected | `pwsh` 163, `cordis_inspect_query` 58, `plugin_manager` 20, `grep` 9, `read` 14, … |
| bill estimate (compaction tuning × this layer) | **−41.4%** (offline replay) |
| suspected rework deducted | 16 reruns, **−0.13%** |
| **net bill estimate** | **−41.3%** |

Read those two numbers carefully:

- **−74.9%** is the character cut **only over the results this plugin actually rewrote**. It is not the bill:
  small results, the system prompt, tool definitions and reasoning are outside the hook.
- **−41.4%** is a bill-level model: earlier compaction (−31%) composed with this rule layer (−15% of the bill,
  measured by replaying 1,518 real tool results), minus rework. It is a replay estimate, not an invoice.
- The Savings tab shows the same split: gross, suspected-rework deduction, net — so you can see when the
  plugin starts to hurt instead of help.
- **Measured replay (in the tab).** Reads the real session logs and charges each rewrite once at the miss
  price and once per later request until the next compaction; the threshold side replays the measured
  per-step deltas under the current policy (`0.4 / 0.12`) and the shipped default (`0.8 / 0.16`). On the
  author's session this came out at **−30.6% compaction + −5.3% trimming ≈ −35.8% net**; the −41.3% figure
  is the older corpus-level model kept as a comparison. Rewrites from before session ids existed are counted
  but not priced, and the tab says so.

### How rework is counted (revised 2026-11-17)

An earlier version paired rewrites by `tool + target` only, which counted two edits to the same file or a
`read` with `offset/limit` as rework. Measured against 7 days of session logs (8,528 tool calls), that rule
flagged 3,431 pairs of which only **48** had identical arguments. The estimator now records an argument
fingerprint and splits the signal:

| signal | rule | effect on the number |
| --- | --- | --- |
| **confirmed rerun** | same session + tool + target + identical arguments, within 30 min | deducted |
| **likely follow-up** | same target, different arguments, previous result was truncated/summarized, within 5 min | shown, **not** deducted |
| legacy rows (no fingerprint) | old rule, flagged as `legacy` | deducted, marked |

Deduction is still `count × average step cost` — an honest approximation, not a measurement of the extra step.
The sample sizes are visible in the tab, so you can judge them yourself.

### How the defaults were tuned (2026-11-17)

`tools/optimize-report.mjs` replays **8,551 real tool results from 7 days** (9.11M characters observed)
through the actual rule engine under different configs, and prices each rewrite by how many later requests
would still carry it:

| config | results rewritten | chars saved | bill impact | vs previous |
| --- | --- | --- | --- | --- |
| previous defaults (`minChars 2000`, `pwsh 4000`, whitelist only) | 265 | 1.13M | 90M | — |
| `minChars 1200` | 290 | 1.16M | 93M | +3% |
| + `pwsh 2500`, `inspect 8000` | 453 | 1.58M | 119M | +32% |
| + MCP tools get capped (`proxy_run 4000`) | 480 | 1.98M | 136M | +51% |
| **shipped in 0.2.0**: + `job_output 4000`, `grep 6000`, `capsDefault 6000` | 490 | 2.03M | 139M | **+55%** |
| (rejected) `read` cap 6000 | 598 | 2.23M | 164M | +83% |

The biggest miss was **MCP tools**: they were never in the whitelist, so 0.6M characters of proxy/command
output went in untouched. `capsDefault` now caps any tool that is not listed. The `read` cap is the largest
single remaining lever (+83%) and is still rejected: it previously caused re-reads that cost far more than
it saved, and that failure mode is not visible in a character-count replay.

## Safety model

1. **Fail open.** Any exception, any unexpected shape, any non-text result → the original result passes
   through untouched. A bug cannot block a tool.
2. **Single text block only.** Images, structured values and multi-block results are never rewritten.
3. **Originals are always written first**, to `~/.dsh/token-trim/artifacts/<sha16>.txt`, and the replacement
   carries that id.
4. **`guard_query`** reads inside the original, in two modes:
   - `pattern` — substring or `/regex/`, with context lines;
   - `fromLine` / `toLine` — an exact line range (1-based, inclusive, ≤400 lines), so continuing a
     truncated result costs one precise fetch instead of a full re-read.

   An artifact can be fetched **twice**; after that the tool returns the full text capped at 12K chars —
   because a third fetch costs more context than it saves.
5. **Audit trail.** Every transformation appends one line to `~/.dsh/token-trim/manifest.jsonl`
   (tool, mode, chars in/out, artifact id, session id).
6. **State is per agent.** Repeat-delta and unchanged detection are keyed by `session + tool + args`, so a
   sub-agent never receives "unchanged" for a result it never saw.

## What we tried and rejected (kept, so you don't repeat it)

- **Truncating `read` results.** Two real sessions, both truncated `read`s triggered a follow-up
  `offset/limit` read: saved 2.3K tokens, cost ~50K in extra steps. `read` is now off by default
  (`caps.read: 0`).
- **LLM summarization of logs.** Gold-recall 77.2% against the required 93.8%. Summaries lose the one line
  you need. Logs are capped, never summarized.
- **Sending "unchanged" across agents** — a real bug, fixed by the agent key above.
- **Model-based trimming (a local 4B).** Projected 3–6 points of bill for a resident 4B service; shelved.

## Configuration

Patch row `token-trim` in the DSH profile:

```yaml
- id: token-trim
  name: dsh-token-trim
  config:
    enabled: true
    dryRun: false       # record what would happen, rewrite nothing
    minChars: 1200
    capsDefault: 6000   # any tool not listed below
    maxFetches: 2
    caps:
      pwsh: 2500
      cordis_inspect_query: 8000
      job_output: 4000
      grep: 6000
      'mcp__local-proxy__proxy_run': 4000
      read: 0           # 0 disables a cap (content tools stay untouched)
```

`dryRun: true` is the honest way to try it: the Savings tab fills up, the context does not change.

## Savings view

The **Savings** tab (next to Chat / Trajectory / Stats) shows, per window and per session:

- net bill estimate with the rework deduction spelled out;
- measured usage read from `dsh-context-kit`'s session cache when that plugin is installed
  (hit ×1 / miss ×10 / output ×15);
- this plugin's own char cut, per tool and per session;
- the last transformations with artifact ids.

## Companion package

`dsh-token-trim` owns the runtime savings: tool trimming, the context index, the view.
**`dsh-context-kit`** separately owns compaction-threshold tuning (Settings → Context). Install both for the
full effect; either works alone.

## License

MIT
