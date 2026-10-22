/**
 * Turning a finished run into a `.alpha` macro.
 *
 * Lives in `shared/` because the renderer builds the draft when the user clicks
 * "Save as Macro", and the main process would otherwise be the only side able to
 * do it. Nothing here may import `node:*` — the renderer bundle would break.
 */

export interface MacroParam {
  name: string
  description?: string
  default?: string
  required?: boolean
}

export interface MacroStep {
  tool: string
  args: Record<string, unknown>
}

// ---------------------------------------------------------------------------
// Capturing a finished run as a macro
// ---------------------------------------------------------------------------

/** Shape of an activity row as the timeline holds it. */
export interface CapturedActivity {
  id?: string
  toolName?: string
  title?: string
  state?: string
  args?: unknown
  result?: unknown
}

/**
 * Keys whose values differ between runs of the same task, so they become
 * parameters with the recorded value as the default. Everything else is treated
 * as fixed structure.
 */
const VARIABLE_KEYS = new Set([
  'path',
  'paths',
  'command',
  'query',
  'text',
  'content',
  'url',
  'message',
  'name',
  'title',
  'target',
  'prompt',
  'value'
])

/**
 * Tools that cannot be replayed from a saved script.
 *
 * Both take a `proposalId`, which is an in-memory handle that dies with the run.
 * A macro that referenced one would fail every time it was used, so they are
 * dropped rather than saved in a broken state.
 */
const UNREPLAYABLE_TOOLS = new Set(['propose_file_patch', 'apply_approved_patch'])

export interface MacroDraftResult {
  steps: MacroStep[]
  params: MacroParam[]
  /** Tool calls that were intentionally not captured. */
  skipped: Array<{ tool: string; reason: string }>
}

/**
 * Turn a completed tool sequence into a parameterised macro.
 *
 * Only completed steps are captured — a failed call has no reproducible value,
 * and silently saving it would produce a macro that repeats the failure.
 *
 * Parameterisation is conservative: values under a known-variable key become
 * `{{name}}` placeholders *defaulting to the recorded value*, so a saved macro
 * replays exactly as it ran while still being editable into a general recipe.
 */
export function buildMacroDraft(
  activities: ReadonlyArray<CapturedActivity>,
  options: { maxSteps?: number; parameterize?: boolean } = {}
): MacroDraftResult
{
  const maxSteps = Math.min(Math.max(options.maxSteps ?? 20, 1), 20)
  const parameterize = options.parameterize !== false
  const steps: MacroStep[] = []
  const params: MacroParam[] = []
  const skipped: Array<{ tool: string; reason: string }> = []
  const usedNames = new Set<string>()

  for (const activity of activities) {
    if (steps.length >= maxSteps) break
    const tool = activity.toolName?.trim()
    if (!tool) continue
    if (activity.state !== 'completed') {
      skipped.push({ tool, reason: 'did not complete' })
      continue
    }
    if (UNREPLAYABLE_TOOLS.has(tool)) {
      skipped.push({ tool, reason: 'uses a proposal id that does not survive the run' })
      continue
    }
    const rawArgs = (activity.args ?? {}) as Record<string, unknown>
    const args: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(rawArgs)) {
      if (parameterize && typeof value === 'string' && value.trim() && VARIABLE_KEYS.has(key)) {
        let name = key
        let suffix = 2
        while (usedNames.has(name)) name = `${key}_${suffix++}`
        usedNames.add(name)
        params.push({
          name,
          description: `Value used for \`${key}\` in ${tool}`,
          default: value,
          required: false
        })
        args[key] = `{{${name}}}`
      } else {
        args[key] = value
      }
    }
    steps.push({ tool, args })
  }

  return { steps, params, skipped }
}

/** A short, editable name from the captured run. */
export function suggestMacroName(activities: ReadonlyArray<CapturedActivity>): string {
  const tools = activities
    .filter((a) => a.state === 'completed' && a.toolName && !UNREPLAYABLE_TOOLS.has(a.toolName))
    .map((a) => a.toolName as string)
  if (!tools.length) return 'Saved workflow'
  const labels: Record<string, string> = {
    run_approved_command: 'Run command',
    create_or_write_file: 'Write file',
    create_directory: 'Create folder',
    move_or_rename_file: 'Move file',
    read_project_file: 'Read file',
    search_project: 'Search project',
    list_project_files: 'List files',
    find_and_launch_app: 'Open app',
    inspect_window_ui: 'Inspect window',
    interact_with_window_element: 'Act on window',
    clipboard_bridge: 'Clipboard',
    create_or_edit_office_document: 'Write document'
  }
  const first = labels[tools[0]] ?? tools[0].replace(/_/g, ' ')
  const extra = tools.length - 1
  return extra > 0 ? `${first} + ${extra} more` : first
}
