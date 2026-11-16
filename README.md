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
reasoning, and any result under `minChars` (default 2000).

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

## Safety model

1. **Fail open.** Any exception, any unexpected shape, any non-text result → the original result passes
   through untouched. A bug cannot block a tool.
2. **Single text block only.** Images, structured values and multi-block results are never rewritten.
3. **Originals are always written first**, to `~/.dsh/token-trim/artifacts/<sha16>.txt`, and the replacement
   carries that id.
4. **`guard_query(id, pattern)`** searches inside the original (substring or `/regex/`, with context lines).
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
    minChars: 2000
    maxFetches: 2
    caps:
      pwsh: 4000
      cordis_inspect_query: 12000
      read: 0           # 0 disables a cap
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
