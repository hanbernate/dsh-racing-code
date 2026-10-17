/**
 * Pure half of the new-project bootstrap: a project without a flow file stays silent, so
 * the only way to create one is an explicit instruction that goes through this layer —
 * the template text, the per-node model tabs, the pre-flight plan and the protocol of the
 * two user gates.
 *
 * Everything here is pure on purpose: no `node:` import and no `@deepseek-ai/*` import
 * (see test/package.test.mjs), so each function takes plain facts — never a filesystem —
 * and the host half owns every read and write. {@link renderBootstrapTemplate} is the only
 * producer of the file's text, and its post-condition is the generator's red line: the text
 * it returns resolves through `resolveFlow` with **zero** errors.
 *
 * Nothing here picks a model for the user: {@link buildRouteChoices} narrows the pool to
 * the subagent allowlist ∩ the local llm directory and leaves every choice (default
 * `session`) to the tabs the orchestrator shows.
 *
 * @module dsh-racing-code/bootstrap
 */

/**
 * @typedef {object} Route
 * @property {string} provider
 * @property {string} model
 */

/**
 * @typedef {object} CatalogRoute
 * @property {string} provider
 * @property {string} model
 * @property {string} [note] Free-text remark shown next to the tab (authorization, upstream).
 */

/**
 * Which preset {@link renderBootstrapTemplate} writes, and the facts it needs.
 *
 * @typedef {object} BootstrapSpec
 * @property {'full'|'minimal'} template `full` is the repository's own graph; `minimal`
 *   drops the design/final/needs-code prologue.
 * @property {2|3|4} [lanes] How many stages the race group fans out to. Default 2.
 * @property {Record<string, string>} [models] Stage id → `provider/model` or the literal
 *   `session` (decision 3: an explicit "use the current session model", which never
 *   warns). Every stage of the graph gets its own front-matter entry; a missing key is
 *   rendered as `session`.
 * @property {{maxStageRepeats?: number, maxLanes?: number, maxReviewRounds?: number}} [guards]
 *   Front-matter guards; omitted keys fall back to 3 / 4 / 2.
 * @property {string} [laneDir] Front-matter `laneDir`. Omit it for the default
 *   `.worktrees` layout (`git-repo` / `none`); pass `branch` inside a worktree container,
 *   where the lane directory is the branch name (`racing/<lane-id>`).
 * @property {string} [generatedOn] ISO date stamped into a non-prompt HTML comment.
 */

/** @typedef {'ok'|'warn'|'blocked'} PlanStatus */

/**
 * @typedef {object} PlanItem
 * @property {string} item Short id of the check (stable within one call).
 * @property {PlanStatus} status `blocked` means "fix this before writing the file".
 * @property {string} detail One human sentence: what was found.
 * @property {string} [fix] Command or action that clears a warn/blocked item.
 */

/**
 * Everything {@link buildPlan} needs, computed by the host half (the pure layer never
 * touches the filesystem, and never runs a subprocess).
 *
 * @typedef {object} BootstrapFacts
 * @property {string} file Absolute target path (`flowFilePath(cwd, projectFlowPath)`).
 * @property {boolean} fileExists True when that file already exists.
 * @property {boolean} parentExists True when the file's parent directory exists.
 * @property {'worktree-container'|'git-repo'|'none'|'unknown'} gitLayout fs heuristic:
 *   `.git` is a file containing `gitdir:` with a sibling `.bare/` → `worktree-container`;
 *   `.git` is a directory → `git-repo`; no `.git` → `none`; a `gitdir:` target that
 *   does not exist → `unknown`.
 * @property {string} [laneDir] Effective `laneDir`; omitted means the default `.worktrees`.
 * @property {string|null} gitignore Contents of `<cwd>/.gitignore`, or null when there is none.
 * @property {ChoiceNode[]} nodes Choice nodes, as returned by {@link buildRouteChoices}.
 * @property {CatalogRoute[]} candidates The route pool the tabs will offer (allowlist ∩ catalog).
 */

/**
 * One tab of gate 2: a stage, its brief, and the routes the user may pick for it.
 *
 * @typedef {object} ChoiceNode
 * @property {string} id Stage id.
 * @property {'stage'|'lane'} kind `lane` for a stage that runs in a parallel lane.
 * @property {string} label Stage label, as rendered in the graph.
 * @property {string} brief Stage brief (`''` when the stage has none).
 * @property {boolean} required True for lane stages: the user must pick a route for them.
 * @property {'session'} default The tab's default option: "use the current session model".
 * @property {CatalogRoute[]} candidates Never contains `session`; may be empty.
 */

/**
 * Render the whole flow file: front matter (format version, guards, optional `laneDir`,
 * and a `models:` entry for every stage — the given route, or `session`), the mermaid
 * graph, a deletable `## 首次清单` checklist (git / worktree / ignore commands, not part of
 * the prompt), and one `### <id>` brief per stage so `flow_stages` can answer with
 * instructions.
 *
 * Preconditions: `template` is `'full'` or `'minimal'`; `lanes` is 2, 3 or 4 and does not
 * exceed `guards.maxLanes`; every `models` value is `session` or a `provider/model` string;
 * every `models` key is a stage of the rendered graph.
 *
 * Postconditions: the returned text resolves through `resolveFlow` with zero errors and
 * every stage has a non-empty brief — a spec that cannot satisfy this is rejected instead
 * of written (`write` never lands a half-valid file).
 *
 * @param {BootstrapSpec} spec
 * @returns {string} The complete file text — the same text the preview shows and the write lands.
 * @throws {Error} Message starting with `BOOTSTRAP_TEMPLATE_INVALID` when the spec is unusable
 *   (unknown preset, lanes outside 2–4 or above `maxLanes`, a model value that is neither
 *   `session` nor a route) or when the rendered text would not resolve with zero errors.
 */
export function renderBootstrapTemplate(spec) {
  throw new Error('not implemented')
}

/**
 * Build gate 2's tabs: one node per stage, in flow order, each carrying the routes the user
 * may pick from (default: `session`, which is never listed as a candidate).
 *
 * The candidate pool is the subagent allowlist intersected with the local llm directory.
 * `allowedModels === null` (the allowlist service is unavailable) skips the check instead
 * of reporting every route as unauthorized; `allowedModels: []` is a known-empty allowlist
 * and yields no candidate at all (the tabs then only offer `session`).
 *
 * @param {{stages?: {id: string, label?: string, brief?: string, instruction?: string}[],
 *          lanes?: ({id: string, joinAt?: string}|string)[],
 *          allowedModels?: Route[]|null,
 *          catalog?: CatalogRoute[]|null}} [input] `stages` is in flow order and is usually
 *   the resolved flow's stage list (`instruction` is read as the brief when `brief` is
 *   absent); `lanes` names the stages that run in a parallel lane, `joinAt` naming the
 *   stage that reviews them.
 * @returns {{nodes: ChoiceNode[], notes: string[]}} `notes` are diagnostic lines — a
 *   `BOOTSTRAP_*` code plus a sentence — for the orchestrator's questions and the tool output.
 *   When a lane names its `joinAt`, the notes also carry the reviewer's self-preference
 *   advisory (a tab that reuses a lane's model would review a model it agrees with), naming
 *   the reviewer so the orchestrator can ask about it.
 */
export function buildRouteChoices(input) {
  throw new Error('not implemented')
}

/**
 * Build the pre-flight plan shown with the preview: what the orchestrator must check (and,
 * for `warn`/`blocked`, fix with the user's consent) before the file is written.
 *
 * The facts that matter: the target file and its parent directory, the git layout
 * (`worktree-container` → an "open the lanes" `git worktree add` command; `git-repo` →
 * `.gitignore` must ignore the default lane dir; `none` → blocked until `git init`;
 * `unknown` → warn about the broken `gitdir:`), the effective `laneDir`, the route pool,
 * and the required lane picks. Nothing here runs a subprocess.
 *
 * @param {BootstrapFacts} facts
 * @returns {PlanItem[]}
 */
export function buildPlan(facts) {
  throw new Error('not implemented')
}

/**
 * Decide the absolute target of the write and prove that it stays inside `cwd`.
 *
 * Containment is string-level and posix-shaped (the pure layer has no `node:path`):
 * a relative `projectFlowPath` is joined to `cwd`, `.` and `..` are folded away, and the
 * result must be `cwd` itself or a descendant of it. An absolute `projectFlowPath` is
 * accepted only when it already is inside `cwd`. An empty `projectFlowPath` means the
 * default `doc/racing-code.md`; a `cwd` that is not an absolute path cannot anchor
 * containment and is rejected as well.
 *
 * @param {{cwd: string, projectFlowPath: string}} input
 * @returns {{ok: true, file: string}
 *   | {ok: false, code: 'BOOTSTRAP_TARGET_OUTSIDE_ROOT', message: string}}
 */
export function checkBootstrapTarget(input) {
  throw new Error('not implemented')
}

/**
 * The two-gate protocol as text. A project without a flow file stays silent — no section,
 * no diagnostics — so this text is the only place the interaction contract lives, and the
 * tool must return it with every preview.
 *
 * One element per step, in order: preview (`write:false` only) → gate 1 confirms the
 * structure before any model question → gate 2 picks a route per node (lanes required,
 * default `session`) → `write:true` lands the file → `BOOTSTRAP_RESTART_REQUIRED`, because
 * only a new session picks the file up → the git / worktree / `.gitignore` commands stay
 * with the orchestrator, never with the plugin.
 *
 * @param {{file: string, lanes: number}} input
 * @returns {string[]} Nine steps, never empty; `file` and `lanes` appear in the text.
 */
export function bootstrapProtocol(input) {
  throw new Error('not implemented')
}
