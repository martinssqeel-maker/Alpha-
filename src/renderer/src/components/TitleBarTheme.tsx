import { useEffect, useRef, useState } from 'react'
import { Check, ChevronDown, Palette } from 'lucide-react'
import { THEME_OPTIONS, THEME_TOKENS, resolveTheme } from '@shared/theme'
import { useApp } from '../store/useApp'

export default function TitleBarTheme() {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const preference = useApp((s) => s.settings?.theme ?? 'solar-flare')
  const saveSettings = useApp((s) => s.saveSettings)
  const active = THEME_OPTIONS.find((option) => option.id === preference) ?? THEME_OPTIONS[1]
  const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches
  const resolved = resolveTheme(preference, prefersDark)
  const tokens = THEME_TOKENS[resolved]

  useEffect(() => {
    if (!open) return
    const frame = window.requestAnimationFrame(() => {
      menu.current?.querySelector<HTMLElement>('[aria-checked="true"]')?.focus()
    })
    return () => window.cancelAnimationFrame(frame)
  }, [open])

  const close = (restoreFocus = false): void => {
    setOpen(false)
    if (restoreFocus) window.requestAnimationFrame(() => trigger.current?.focus())
  }

  const onMenuKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const items = Array.from(menu.current?.querySelectorAll<HTMLElement>('[role="menuitemradio"], [role="menuitem"]') ?? [])
    const index = items.indexOf(document.activeElement as HTMLElement)
    if (event.key === 'Escape') {
      event.preventDefault()
      close(true)
    } else if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const delta = event.key === 'ArrowDown' ? 1 : -1
      items[(index + delta + items.length) % items.length]?.focus()
    } else if (event.key === 'Home') {
      event.preventDefault()
      items[0]?.focus()
    } else if (event.key === 'End') {
      event.preventDefault()
      items.at(-1)?.focus()
    }
  }

  return (
    <div className="titlebar-theme-anchor no-drag">
      <button
        className="titlebar-theme-button"
        type="button"
        ref={trigger}
        aria-label={`Appearance theme: ${active.label}`}
        aria-haspopup="menu"
        aria-expanded={open}
        title={`Appearance: ${active.label}`}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="titlebar-theme-swatch" style={{ background: tokens['--accent-gradient'] }} aria-hidden="true" />
        <span className="titlebar-theme-label">{active.label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open && (
        <>
          <button className="titlebar-popover-shade" aria-label="Close theme menu" tabIndex={-1} onClick={() => close(true)} />
          <div className="titlebar-theme-menu" role="menu" aria-label="Choose appearance theme" ref={menu} onKeyDown={onMenuKeyDown}>
            <div className="titlebar-theme-menu-heading">
              <span>Appearance</span>
              <span>{THEME_OPTIONS.length - 1} themes</span>
            </div>
            {THEME_OPTIONS.map((option) => {
              const optionTheme = resolveTheme(option.id, prefersDark)
              const optionTokens = THEME_TOKENS[optionTheme]
              const selected = option.id === preference
              return (
                <button
                  type="button"
                  role="menuitemradio"
                  aria-checked={selected}
                  className={`titlebar-theme-option${selected ? ' active' : ''}`}
                  key={option.id}
                  onClick={() => {
                    close(true)
                    void saveSettings({ theme: option.id })
                  }}
                >
                  <span className="titlebar-theme-option-swatch" style={{ background: optionTokens['--accent-gradient'] }} aria-hidden="true" />
                  <span className="titlebar-theme-option-copy">
                    <span>{option.label}</span>
                    <small>{option.description}</small>
                  </span>
                  {selected && <Check size={14} aria-hidden="true" />}
                </button>
              )
            })}
            <button className="titlebar-theme-settings" type="button" role="menuitem" onClick={() => { close(); useApp.getState().setView('settings') }}>
              Open Appearance Studio <span aria-hidden="true">↗</span>
            </button>
          </div>
        </>
      )}
    </div>
  )
}
