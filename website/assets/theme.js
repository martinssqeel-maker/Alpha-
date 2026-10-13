// Appearance preference for the public website.
//
// This preference is local to the website. The desktop app stores its theme in
// its own settings database. Loaded from <head> without `defer` so the palette
// is applied before the first paint instead of flashing the wrong one.
const KEY = 'alpha-theme'
const root = document.documentElement

function stored() {
  try {
    const value = localStorage.getItem(KEY)
    return value === 'light' || value === 'dark' ? value : null
  } catch {
    return null
  }
}

/** The visitor's explicit choice, else what the operating system asks for. */
function preferred() {
  if (stored()) return stored()
  try {
    return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark'
  } catch {
    return 'dark'
  }
}

function apply(theme, persist) {
  root.dataset.theme = theme
  if (persist) {
    try {
      localStorage.setItem(KEY, theme)
    } catch {
      /* storage unavailable — the choice simply does not persist */
    }
  }
  // Keep the browser chrome in step with the page.
  const meta = document.querySelector('meta[name="theme-color"]')
  if (meta) meta.setAttribute('content', theme === 'light' ? '#f2f3f6' : '#0c0f14')
  const label = theme === 'light' ? 'Switch to the dark palette' : 'Switch to the light palette'
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    button.setAttribute('aria-label', label)
    button.setAttribute('aria-pressed', theme === 'light' ? 'true' : 'false')
    button.title = label
  }
}

apply(preferred(), false)

document.addEventListener('DOMContentLoaded', () => {
  apply(root.dataset.theme === 'light' ? 'light' : 'dark', false)
  for (const button of document.querySelectorAll('[data-theme-toggle]')) {
    button.addEventListener('click', () => {
      apply(root.dataset.theme === 'light' ? 'dark' : 'light', true)
    })
  }
})

// Follow the system only while no explicit choice has been made.
try {
  window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
    if (!stored()) apply(preferred(), false)
  })
} catch {
  /* older browsers: leave the initial value in place */
}
