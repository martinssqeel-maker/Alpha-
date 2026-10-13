// Public download page.
//
// Reads the latest release straight from the public GitHub Releases API — the
// same source the desktop updater uses — and hands out the direct installer
// link to everyone. No session, no account.
const REPO = 'martinssqeel-maker/Alpha-'
const RELEASE_API = `https://api.github.com/repos/${REPO}/releases/latest`
const RELEASES_PAGE = `https://github.com/${REPO}/releases/latest`

const els = {
  status: document.querySelector('[data-status]'),
  version: document.querySelector('[data-version]'),
  size: document.querySelector('[data-size]'),
  notes: document.querySelector('[data-notes]'),
  checksum: document.querySelector('[data-checksum]'),
  link: document.querySelector('[data-download-link]')
}

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return null
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
}

function setStatus(message, kind) {
  if (!els.status) return
  els.status.textContent = message || ''
  els.status.dataset.kind = kind || ''
}

function renderRelease(release) {
  if (els.version) els.version.textContent = `Version ${release.version}`
  const size = formatSize(release.size)
  if (els.size) els.size.textContent = size ? `Installer · ${size}` : 'Windows installer'
  if (els.notes) {
    els.notes.textContent = release.notes || ''
    els.notes.hidden = !release.notes
  }
  if (els.checksum) {
    els.checksum.textContent = release.sha512 ? `SHA-512 ${release.sha512}` : ''
    els.checksum.hidden = !release.sha512
  }
  if (els.link) els.link.href = release.url
}

async function load() {
  try {
    const res = await fetch(RELEASE_API, { headers: { Accept: 'application/vnd.github+json' } })
    if (!res.ok) throw new Error(`GitHub API answered ${res.status}`)
    const release = await res.json()

    const version = String(release.tag_name || '').replace(/^v/i, '')
    const asset = (release.assets || []).find((a) => /\.exe$/i.test(a.name))
    if (!version || !asset) throw new Error('No Windows installer is published yet.')

    renderRelease({
      version,
      url: asset.browser_download_url,
      size: asset.size,
      notes: String(release.body || '').trim() || null,
      sha512: null
    })
    setStatus('', '')
  } catch (error) {
    // The button keeps its static fallback href (the public releases page),
    // so a failed lookup still never dead-ends the visitor.
    if (els.link) els.link.href = RELEASES_PAGE
    if (els.version) els.version.textContent = 'Windows'
    if (els.size) els.size.textContent = 'Latest release'
    setStatus(`Could not load release details — the download button opens the releases page. (${error.message})`, 'error')
  }
}

void load()
