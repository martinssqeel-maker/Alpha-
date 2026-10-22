/**
 * Pure input helpers for the desktop layer.
 *
 * These live outside `computerUseService` on purpose: that module imports
 * Electron, which cannot be loaded in the Vitest environment (and is not loaded
 * by any other unit under test). Keeping the string-shaping rules here means the
 * rules themselves are covered by tests rather than only exercised on a Windows
 * machine.
 */

/**
 * Reduce a keystroke spec to Windows `SendKeys` syntax.
 *
 * `SendKeys` treats `+ ^ % ~ ( ) { } [ ]` as control characters, so the spec may
 * contain only those plus alphanumerics, space, dot and dash — a spec is a
 * shortcut, never text. Control characters are stripped and the length is
 * capped, because an unbounded spec is an unbounded number of synthetic
 * keystrokes sent to whatever window happens to be focused.
 */
export function normalizeKeys(keys: string): string {
  const cleaned = String(keys ?? '')
    .replace(/[^0-9a-zA-Z^%~+(){}[\]\-. ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 120)
  return cleaned || '^v'
}

/**
 * Make a value safe to hand to a child process environment block.
 *
 * NUL terminates the environment block on Windows, so it is removed rather than
 * allowed to truncate everything after it. The length cap matches the practical
 * limit of one environment variable; larger payloads (document bodies, clipboard
 * text) are passed through a temp file instead of an environment value.
 */
export function sanitizeEnvValue(value: string): string {
  return String(value ?? '')
    .replace(/\0/g, '')
    .slice(0, 32_000)
}

/**
 * Elements of a UI Automation tree that the agent may address by number.
 *
 * The list is shared by the inspect/interact/click scripts; if they disagreed,
 * `[3]` would mean one control when inspected and another when clicked.
 */
export const INTERACTIVE_CONTROL_TYPES = [
  'Button',
  'Edit',
  'MenuItem',
  'Document',
  'ComboBox',
  'CheckBox',
  'RadioButton',
  'TabItem',
  'Hyperlink',
  'ListItem',
  'Slider',
  'Spinner',
  'TreeItem',
  'Text',
  'SplitButton',
  'ToolBar',
  'Pane'
] as const

/** Clamp a model-supplied element number to a sane, 1-based index. */
export function clampElementId(value: unknown, max = 150): number {
  const parsed = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(parsed)) return 1
  return Math.min(Math.max(1, Math.trunc(parsed)), max)
}
