import { useMemo, useState } from 'react'
import { Check, Circle, Monitor, Moon, Palette, Sparkles, Sun } from 'lucide-react'
import {
  createThemeTokens,
  RESOLVED_THEME_OPTIONS,
  THEME_OPTIONS,
  THEME_TOKENS,
  normalizeAppearanceSettings,
  resolveTheme,
  type AppearanceSettings,
  type ThemePreference
} from '@shared/theme'
import { SHADER_LABELS, themeConfig } from '../themes/themeEngine'

const ACCENTS = [
  { id: 'gold', label: 'Solar gold', color: '#ffd166' },
  { id: 'amber', label: 'Amber', color: '#ff9f43' },
  { id: 'cyan', label: 'Ion cyan', color: '#52e6e8' },
  { id: 'blue', label: 'Electric blue', color: '#5b9dff' },
  { id: 'violet', label: 'Ultraviolet', color: '#a98aff' },
  { id: 'magenta', label: 'Signal magenta', color: '#ed72dc' },
  { id: 'emerald', label: 'Emerald', color: '#50dc98' },
  { id: 'rose', label: 'Rose', color: '#ff7f9e' }
] as const

const STUDIO_TABS = [
  { id: 'themes', label: 'Themes', icon: Sparkles },
  { id: 'colors', label: 'Colours', icon: Palette },
  { id: 'display', label: 'Display', icon: Monitor },
  { id: 'effects', label: 'Effects', icon: Circle }
] as const

type StudioTab = (typeof STUDIO_TABS)[number]['id']

export default function ThemeGallery({
  value,
  onChange,
  appearance,
  onAppearanceChange
}: {
  value: ThemePreference
  onChange: (theme: ThemePreference) => void
  appearance?: AppearanceSettings
  onAppearanceChange?: (patch: Partial<AppearanceSettings>) => void
}) {
  const [tab, setTab] = useState<StudioTab>('themes')
  const current = normalizeAppearanceSettings(appearance)
  const prefersDark = useMemo(
    () => (typeof window === 'undefined' ? true : window.matchMedia('(prefers-color-scheme: dark)').matches),
    []
  )
  const activeTheme = resolveTheme(value, prefersDark)
  const activeOption = THEME_OPTIONS.find((item) => item.id === activeTheme) ?? THEME_OPTIONS[1]
  const tokens = createThemeTokens(activeTheme, current, prefersDark)
  const update = (patch: Partial<AppearanceSettings>): void => onAppearanceChange?.(patch)

  return (
    <div className="appearance-studio">
      <div className="appearance-studio-main">
        <div className="studio-heading-row">
          <div>
            <div className="studio-kicker"><Sparkles size={13} /> APPEARANCE STUDIO</div>
            <h3>Shape your workspace</h3>
            <p>Make the whole environment feel like yours. Changes apply instantly.</p>
          </div>
          <div className="studio-saved"><span /> Saved on this device</div>
        </div>

        <div className="studio-tabs" role="tablist" aria-label="Appearance settings">
          {STUDIO_TABS.map(({ id, label, icon: Icon }) => (
            <button key={id} type="button" role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              <Icon size={14} /> {label}
            </button>
          ))}
        </div>

        <div className="studio-tab-panel" role="tabpanel">
          {tab === 'themes' && (
            <div className="studio-theme-content">
              <div className="studio-section-heading">
                <div><h4>Curated atmospheres</h4><p>Twelve distinct colour worlds, tuned for real work.</p></div>
                <div className="studio-theme-actions">
                  <button type="button" className={`studio-system-theme${value === 'system' ? ' active' : ''}`} aria-pressed={value === 'system'} onClick={() => onChange('system')}><Monitor size={13} /> Follow Windows</button>
                  <span>12 palettes</span>
                </div>
              </div>
              <div className="theme-grid studio-theme-grid" role="group" aria-label="Workspace appearance themes">
                {THEME_OPTIONS.filter((option) => option.id !== 'system').map((option) => {
                  const theme = option.id as (typeof RESOLVED_THEME_OPTIONS)[number]
                  const palette = THEME_TOKENS[theme]
                  const selected = value !== 'system' && activeTheme === option.id
                  const config = themeConfig(theme)
                  const shaderLabel = config && config.shader !== 'none' ? SHADER_LABELS[config.shader] : null
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={`theme-card studio-theme-card${theme === 'solar-flare' ? ' featured' : ''}${selected ? ' selected' : ''}`}
                      aria-pressed={selected}
                      aria-label={`${option.label}: ${option.description}${selected ? ', active theme' : ''}`}
                      onClick={() => onChange(option.id)}
                    >
                      <span className="theme-preview studio-theme-preview" style={{ background: palette['--surface-0'], borderColor: palette['--glass-border'] }} aria-hidden="true">
                        <span className="theme-preview-top" style={{ background: palette['--surface-1'] }}>
                          <i style={{ background: palette['--accent'] }} /><i style={{ background: palette['--accent-secondary'] }} /><i style={{ background: palette['--text-disabled'] }} />
                          <span style={{ background: palette['--border-strong'] }} />
                        </span>
                        <span className="theme-preview-workspace">
                          <span className="theme-preview-rail" style={{ background: palette['--surface-1'] }}>
                            <i className="mini-mark" style={{ background: palette['--accent'] }} />
                            <i style={{ background: palette['--text-tertiary'] }} /><i style={{ background: palette['--text-disabled'] }} /><i style={{ background: palette['--text-disabled'] }} />
                          </span>
                          <span className="theme-preview-main" style={{ background: palette['--surface-0'] }}>
                            <span className="mini-title" style={{ background: palette['--text-primary'] }} />
                            <span className="mini-message" style={{ background: palette['--surface-2'], borderColor: palette['--glass-border'] }}>
                              <i style={{ background: palette['--text-secondary'] }} /><i style={{ background: palette['--text-tertiary'] }} />
                            </span>
                            <span className="mini-code" style={{ background: palette['--terminal-bg'], borderColor: palette['--border-subtle'] }}>
                              <i style={{ background: palette['--code-keyword'] }} /><i style={{ background: palette['--code-string'] }} /><i style={{ background: palette['--accent'] }} />
                            </span>
                            <span className="mini-composer" style={{ background: palette['--surface-1'], borderColor: palette['--border-strong'] }}><i style={{ background: palette['--text-disabled'] }} /><b style={{ background: palette['--accent-gradient'] }} /></span>
                          </span>
                        </span>
                        <span className="theme-preview-light" style={{ background: palette['--ambient-light'] }} />
                        {shaderLabel && (
                          <span className="theme-preview-shader" data-shader={config?.shader} aria-hidden="true">
                            <em style={{ background: palette['--accent'] }} />
                            {shaderLabel}
                          </span>
                        )}
                        {selected && <span className="studio-selected-mark"><Check size={11} /> ACTIVE</span>}
                      </span>
                      <span className="theme-card-meta">
                        <span className="theme-card-label">{option.label}{selected && <Check size={14} className="theme-card-check" />}</span>
                        <span className="theme-card-desc">{option.description}</span>
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          )}

          {tab === 'colors' && (
            <div className="studio-control-panel">
              <div className="studio-section-heading"><div><h4>Accent signature</h4><p>Choose the light that marks focus, selection, and primary actions.</p></div></div>
              <div className="accent-swatches" role="group" aria-label="Accent colour">
                {ACCENTS.map((accent) => (
                  <button key={accent.id} type="button" className={`accent-swatch${current.accent === accent.id ? ' active' : ''}`} style={{ '--swatch-color': accent.color } as React.CSSProperties} aria-label={accent.label} aria-pressed={current.accent === accent.id} onClick={() => update({ accent: accent.id })}>
                    {current.accent === accent.id && <Check size={15} />}
                  </button>
                ))}
                <button type="button" className={`accent-swatch theme-swatch${current.accent === 'theme' ? ' active' : ''}`} style={{ '--swatch-color': tokens['--accent'] } as React.CSSProperties} aria-label="Use theme signature" aria-pressed={current.accent === 'theme'} onClick={() => update({ accent: 'theme' })}>
                  {current.accent === 'theme' ? <Check size={15} /> : <Sparkles size={13} />}
                </button>
              </div>
              <div className="studio-color-selection"><span className="studio-color-dot" style={{ background: current.accent === 'custom' ? current.customAccent : current.accent === 'theme' ? tokens['--accent'] : ACCENTS.find((item) => item.id === current.accent)?.color }} /><span>{current.accent === 'theme' ? `${activeOption.label} signature` : current.accent === 'custom' ? 'Custom accent' : ACCENTS.find((item) => item.id === current.accent)?.label}</span><button type="button" className="text-button" onClick={() => update({ accent: 'theme' })}>Reset</button></div>
              <label className="custom-color-control"><span><b>Custom colour</b><small>Enter a precise accent in HEX</small></span><input type="color" value={current.customAccent} onChange={(event) => update({ accent: 'custom', customAccent: event.target.value })} aria-label="Choose custom accent colour" /></label>
              <p className="studio-helper">Your accent is applied to active navigation, focus rings, buttons, selection borders, and the workspace preview.</p>
            </div>
          )}

          {tab === 'display' && (
            <div className="studio-control-panel">
              <div className="studio-section-heading"><div><h4>Display preferences</h4><p>Set the visual rhythm and contrast that feels right for long sessions.</p></div></div>
              <div className="studio-setting-block">
                <span className="studio-setting-title">Colour mode</span>
                <div className="studio-segmented" role="group" aria-label="Colour mode">
                  {[{ id: 'system', label: 'System', icon: Monitor }, { id: 'light', label: 'Light', icon: Sun }, { id: 'dark', label: 'Dark', icon: Moon }].map(({ id, label, icon: Icon }) => (
                    <button key={id} type="button" className={current.mode === id ? 'active' : ''} aria-pressed={current.mode === id} onClick={() => update({ mode: id as AppearanceSettings['mode'] })}><Icon size={14} />{label}</button>
                  ))}
                </div>
              </div>
              <div className="studio-setting-block">
                <span className="studio-setting-title">Interface density</span>
                <div className="density-options" role="group" aria-label="Interface density">
                  <button type="button" className={`density-option${current.density === 'comfortable' ? ' active' : ''}`} aria-pressed={current.density === 'comfortable'} onClick={() => update({ density: 'comfortable' })}><span className="density-glyph comfortable-glyph"><i /><i /><i /></span><b>Comfortable</b><small>More breathing room</small></button>
                  <button type="button" className={`density-option${current.density === 'compact' ? ' active' : ''}`} aria-pressed={current.density === 'compact'} onClick={() => update({ density: 'compact' })}><span className="density-glyph compact-glyph"><i /><i /><i /></span><b>Compact</b><small>More on screen</small></button>
                </div>
              </div>
              <div className="studio-setting-block studio-inline-setting"><div><span className="studio-setting-title">Corner style</span><small>Softer cards or a sharper technical profile.</small></div><div className="studio-segmented compact-segment" role="group" aria-label="Corner style"><button type="button" className={current.corners === 'soft' ? 'active' : ''} aria-pressed={current.corners === 'soft'} onClick={() => update({ corners: 'soft' })}>Soft</button><button type="button" className={current.corners === 'crisp' ? 'active' : ''} aria-pressed={current.corners === 'crisp'} onClick={() => update({ corners: 'crisp' })}>Crisp</button></div></div>
              <StudioToggle title="Reduce motion" description="Keep transitions still and respect a calmer workspace." checked={!current.animations} onChange={(checked) => update({ animations: !checked })} />
            </div>
          )}

          {tab === 'effects' && (
            <div className="studio-control-panel">
              <div className="studio-section-heading"><div><h4>Lighting & material</h4><p>Shape the glass and illumination. Effects stay restrained and GPU-conscious.</p></div></div>
              <StudioRange title="Glass clarity" description="Controls translucency and backdrop blur on floating surfaces." value={current.glassIntensity} onChange={(glassIntensity) => update({ glassIntensity })} low="Solid" high="Liquid" />
              <StudioRange title="Neon intensity" description="Adjusts the strength of accent illumination and focus glow." value={current.glowIntensity} onChange={(glowIntensity) => update({ glowIntensity })} low="Quiet" high="Luminous" />
              <div className="studio-effect-divider" />
              <StudioToggle title="Ambient lighting" description="Add a soft theme-tinted light wash behind the workspace." checked={current.ambientLighting} onChange={(ambientLighting) => update({ ambientLighting })} />
              <StudioToggle title="Animated gradients" description="Add slow movement to signature accents and elevated surfaces." checked={current.animatedGradients} onChange={(animatedGradients) => update({ animatedGradients })} />
              <StudioToggle title="Interface transitions" description="Animate selection and panel state changes." checked={current.animations} onChange={(animations) => update({ animations })} />
              <div className="studio-effect-divider" />
              <div className="studio-section-heading"><div><h4>Live background & power</h4><p>Choose whether the workspace paints a living backdrop, and how it behaves on battery.</p></div></div>
              <StudioToggle
                title="Live background"
                description="Animated galaxy, code-rain or solar field behind the workspace. Off means a static wash."
                checked={current.liveBackground}
                onChange={(liveBackground) => update({ liveBackground })}
              />
              <StudioToggle
                title="Solar Eco-Saver"
                description="Pauses the backdrop and removes neon glows. For inverter or battery-backed machines."
                checked={current.ecoMode}
                onChange={(ecoMode) => update({ ecoMode })}
              />
              <StudioToggle
                title="Engage Eco-Saver on battery"
                description="Turn the saver on automatically below 25% charge while unplugged."
                checked={current.ecoAuto}
                onChange={(ecoAuto) => update({ ecoAuto })}
              />
              <div className="studio-performance-note"><span className="studio-performance-pulse" /> <span>Eco-Saver swaps pulsing keyframes for a static indicator, so long runs cost no extra watts.</span></div>
            </div>
          )}
        </div>
      </div>

      <aside className="studio-preview-rail" aria-label="Live appearance preview">
        <div className="studio-preview-head"><div><span className="studio-live-indicator" /> LIVE PREVIEW</div><span>UPDATING</span></div>
        <div className="studio-preview-app" style={{ background: tokens['--surface-0'], color: tokens['--text-primary'], borderColor: tokens['--glass-border'] }}>
          <div className="studio-preview-titlebar" style={{ background: tokens['--surface-1'], borderColor: tokens['--border-subtle'] }}><span className="studio-preview-logo" style={{ background: tokens['--accent-gradient'] }}>A</span><span><b>Alpha AI Workspace</b><small>Build · Create · Explore</small></span><i /><i /><i /></div>
          <div className="studio-preview-body">
            <div className="studio-preview-sidebar" style={{ background: tokens['--surface-1'] }}><span className="studio-preview-nav active" style={{ background: tokens['--accent-subtle-bg'], color: tokens['--accent'] }}>⌂ <i>Home</i></span><span>⌕ <i>Projects</i></span><span>◈ <i>Models</i></span><span>⚙ <i>Settings</i></span><div className="studio-preview-profile"><span style={{ background: tokens['--accent-gradient'] }}>M</span><i><b>Workspace</b><small>Local session</small></i></div></div>
            <div className="studio-preview-canvas" style={{ background: tokens['--surface-0'] }}>
              <div className="studio-preview-greeting"><small>YOUR WORKSPACE</small><b>What are we building?</b><span>Project-aware AI, ready when you are.</span></div>
              <div className="studio-preview-chat" style={{ background: tokens['--surface-2'], borderColor: tokens['--glass-border'] }}><span className="studio-preview-avatar" style={{ background: tokens['--accent-gradient'] }}>A</span><i><b>Alpha</b><small>Ask about a project, explore an idea, or get a second pair of eyes.</small></i></div>
              <div className="studio-preview-code" style={{ background: tokens['--terminal-bg'], borderColor: tokens['--border-subtle'] }}><small>workspace.ts</small><span><i style={{ color: tokens['--code-keyword'] }}>const</i> <b style={{ color: tokens['--code-title'] }}>workspace</b> = <em style={{ color: tokens['--code-string'] }}>"ready"</em></span><span><i style={{ color: tokens['--code-keyword'] }}>return</i> <strong style={{ color: tokens['--accent'] }}>build()</strong></span></div>
              <div className="studio-preview-composer" style={{ background: tokens['--composer-bg'], borderColor: tokens['--border-strong'] }}><span>Type a message…</span><b style={{ background: tokens['--accent-gradient'] }}>↑</b></div>
            </div>
          </div>
        </div>
        <div className="studio-preview-caption"><span className="studio-preview-theme-dot" style={{ background: tokens['--accent-gradient'] }} /> <b>{activeOption.label}</b><span>Sample workspace</span></div>
        <div className="studio-preview-palette" aria-label="Current theme palette">
          {[tokens['--accent'], tokens['--accent-secondary'], tokens['--surface-2'], tokens['--surface-3']].map((color, index) => <span key={index} style={{ background: color }} />)}
          <small>PALETTE</small>
        </div>
      </aside>
    </div>
  )
}

function StudioToggle({ title, description, checked, onChange }: { title: string; description: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return <label className="studio-toggle-row"><span><b>{title}</b><small>{description}</small></span><input type="checkbox" checked={checked} onChange={(event) => onChange(event.target.checked)} /><i aria-hidden="true" /></label>
}

function StudioRange({ title, description, value, onChange, low, high }: { title: string; description: string; value: number; onChange: (value: number) => void; low: string; high: string }) {
  return <label className="studio-range-row"><span className="studio-range-head"><b>{title}</b><output>{value}%</output></span><small>{description}</small><input type="range" min="0" max="100" value={value} onChange={(event) => onChange(Number(event.target.value))} /><span className="studio-range-labels"><i>{low}</i><i>{high}</i></span></label>
}
