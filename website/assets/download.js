// Protected download page.
//
// The installer link is only revealed to a signed-in, active account: the page
// asks the API for the current release with the session token and never links to
// an asset directly.
import {
  api,
  clearSession,
  completeOAuthReturn,
  configured,
  googleStartUrl,
  loadSession,
  providers,
  setStatus,
  show,
  signInErrorFromUrl
} from './session.js'

const els = {
  notice: document.querySelector('[data-download-notice]'),
  signedOut: document.querySelector('[data-signed-out]'),
  signedIn: document.querySelector('[data-signed-in]'),
  status: document.querySelector('[data-status]'),
  version: document.querySelector('[data-version]'),
  size: document.querySelector('[data-size]'),
  notes: document.querySelector('[data-notes]'),
  checksum: document.querySelector('[data-checksum]'),
  link: document.querySelector('[data-download-link]'),
  accountLink: document.querySelector('[data-account-link]'),
  google: document.querySelector('[data-google]'),
  googleWrap: document.querySelector('[data-google-wrap]'),
  signout: document.querySelector('[data-signout]'),
  email: document.querySelector('[data-email-out]')
}

let session = loadSession()

function formatSize(bytes) {
  if (!bytes || bytes <= 0) return null
  const mb = bytes / (1024 * 1024)
  return `${mb.toFixed(mb >= 100 ? 0 : 1)} MB`
}

function renderRelease(release) {
  if (els.email) els.email.textContent = session?.email || ''
  if (els.version) els.version.textContent = `Version ${release.version}`
  const size = formatSize(release.size)
  if (els.size) els.size.textContent = size ? `Installer · ${size}` : 'Windows installer'
  if (els.notes) els.notes.textContent = release.notes || ''
  show(els.notes, Boolean(release.notes))
  if (els.checksum) {
    els.checksum.textContent = release.sha512 ? `SHA-512 ${release.sha512}` : ''
    show(els.checksum, Boolean(release.sha512))
  }
  if (els.link) {
    els.link.href = release.url
    els.link.download = ''
    show(els.link, true)
  }
}

async function load() {
  if (!session) {
    show(els.signedIn, false)
    show(els.signedOut, true)
    return
  }
  try {
    const res = await api('/downloads/latest', { token: session.accessToken })
    if (!res?.release) throw new Error('No desktop release is published yet.')
    renderRelease(res.release)
    show(els.signedOut, false)
    show(els.signedIn, true)
    setStatus(els.status, '')
  } catch (error) {
    if (error.status === 401 || error.status === 403) {
      clearSession()
      session = null
      show(els.signedIn, false)
      show(els.signedOut, true)
      setStatus(els.status, error.message, 'error')
      return
    }
    setStatus(els.status, error.message || 'Could not load the download.', 'error')
  }
}

async function init() {
  if (!configured) {
    if (els.notice) {
      els.notice.textContent = 'Alpha Cloud is not configured for this deployment yet.'
      show(els.notice, true)
    }
    return
  }

  const urlError = signInErrorFromUrl()
  if (urlError) setStatus(els.status, urlError, 'error')

  const returned = await completeOAuthReturn()
  if (returned?.error) setStatus(els.status, returned.error, 'error')
  if (returned?.session) session = returned.session

  // Keep the visitor on this page after signing in.
  if (els.accountLink) els.accountLink.href = '/account.html?redirect=/download.html'

  const caps = await providers()
  show(els.googleWrap, caps.google)
  els.google?.addEventListener('click', () => {
    setStatus(els.status, 'Taking you to Google…', '')
    location.href = googleStartUrl('/download.html')
  })

  els.signout?.addEventListener('click', async () => {
    try {
      if (session) await api('/auth/signout', { method: 'POST', token: session.accessToken })
    } catch {
      /* best effort */
    }
    clearSession()
    session = null
    show(els.signedIn, false)
    show(els.signedOut, true)
    setStatus(els.status, 'Signed out.', 'ok')
  })

  await load()
}

void init()
