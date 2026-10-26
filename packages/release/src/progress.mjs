import { appendFileSync, writeFileSync } from "node:fs"
import { performance } from "node:perf_hooks"

/** Bounded diagnostic breadcrumbs, not acceptance evidence. No commands, arguments,
 * paths, environment, exception text or child output are written to the journal.
 * Synchronous writes precede blocking child calls so an outer kill leaves a breadcrumb.
 */
export function createProgressJournal(path, stages) {
  const allowed = new Set(stages)
  const states = new Set(["started", "passed", "failed", "command-started", "command-finished", "command-failed"])
  const started = performance.now()
  let sequence = 0
  writeFileSync(path, "", { flag: "wx", mode: 0o600 })
  return (stage, state) => {
    if (!allowed.has(stage) || !states.has(state) || sequence >= 512) throw new Error("Invalid package progress event")
    appendFileSync(path, JSON.stringify({ sequence: ++sequence, stage, state,
      elapsedMs: Math.round(performance.now() - started) }) + "\n")
  }
}
