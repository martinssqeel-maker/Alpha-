interface Shortcut {
  keys: string[]
  label: string
  hint?: string
}

interface Group {
  title: string
  note: string
  items: Shortcut[]
}

/**
 * Every entry below is implemented in the renderer; nothing aspirational is
 * listed. If a shortcut is removed from the code it must be removed here too.
 */
const GROUPS: Group[] = [
  {
    title: 'Conversation',
    note: 'The prompt box in the chat workspace.',
    items: [
      { keys: ['Enter'], label: 'Send the message' },
      { keys: ['Shift', 'Enter'], label: 'Insert a new line' },
      { keys: ['Esc'], label: 'Stop the response that is running', hint: 'Only while a response is streaming.' },
      { keys: ['Double-click'], label: 'Rename the conversation title', hint: 'On the title in the chat header.' },
      { keys: ['Enter'], label: 'Save a renamed title' },
      { keys: ['Esc'], label: 'Cancel an in-progress rename' }
    ]
  },
  {
    title: 'Terminal',
    note: 'The integrated Terminal panel.',
    items: [{ keys: ['Enter'], label: 'Run the typed command' }]
  },
  {
    title: 'Dialogs',
    note: 'Approval and account dialogs.',
    items: [
      { keys: ['Esc'], label: 'Close the Account dialog' },
      { keys: ['Tab'], label: 'Move to the next control' },
      { keys: ['Shift', 'Tab'], label: 'Move to the previous control' }
    ]
  },
  {
    title: 'Editing text',
    note: 'Standard text fields and the prompt box.',
    items: [
      { keys: ['Ctrl', 'X'], label: 'Cut the selection' },
      { keys: ['Ctrl', 'C'], label: 'Copy the selection' },
      { keys: ['Ctrl', 'V'], label: 'Paste' },
      { keys: ['Ctrl', 'A'], label: 'Select all text in the field' }
    ]
  }
]

const IS_MAC = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || '')

function labelFor(key: string): string {
  if (key === 'Ctrl') return IS_MAC ? '⌘' : 'Ctrl'
  if (key === 'Shift') return IS_MAC ? '⇧' : 'Shift'
  if (key === 'Enter') return IS_MAC ? '↩' : 'Enter'
  if (key === 'Esc') return 'Esc'
  if (key === 'Tab') return IS_MAC ? '⇥' : 'Tab'
  return key
}

export default function ShortcutList() {
  return (
    <div className="shortcut-groups">
      {GROUPS.map((group) => (
        <div key={group.title} className="shortcut-group">
          <div className="shortcut-group-head">
            <span className="shortcut-group-title">{group.title}</span>
            <span className="shortcut-group-note">{group.note}</span>
          </div>
          <div className="shortcut-rows">
            {group.items.map((item) => (
              <div key={`${group.title}-${item.label}-${item.keys.join('+')}`} className="shortcut-row">
                <span className="shortcut-keys">
                  {item.keys.map((k, i) => (
                    <span key={`${k}-${i}`} className="kbd-group">
                      {i > 0 && <span className="kbd-plus">+</span>}
                      <kbd className="kbd">{labelFor(k)}</kbd>
                    </span>
                  ))}
                </span>
                <span className="shortcut-label">
                  {item.label}
                  {item.hint && <span className="shortcut-hint">{item.hint}</span>}
                </span>
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
