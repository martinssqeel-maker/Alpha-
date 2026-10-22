/**
 * Delivery guard for the always-on-top control pill.
 *
 * The pill is updated from the chat event stream, which can fire at any point in
 * a window's lifecycle — while the app is quitting, while the window is being
 * destroyed, or before its document has loaded. Sending to either of those is
 * not a catchable error at the call site: it surfaces as an unhandled rejection
 * from `webContents.send`.
 *
 * The predicate is separated from the Electron code so the rule is unit-tested
 * without needing an Electron binary, and so every caller asks the same question
 * in the same order.
 */
export interface HudSurface {
  /** `dispose()` has run; nothing further may be delivered. */
  disposed: boolean
  /** The document has fired `did-finish-load` and listens for state. */
  ready: boolean
  /** `BrowserWindow.isDestroyed()` */
  windowDestroyed: boolean
  /** The window exists but has no usable `webContents` object. */
  hasWebContents: boolean
  /** `webContents.isDestroyed()` */
  contentsDestroyed: boolean
}

/**
 * Whether a state payload can be delivered to the pill right now.
 *
 * Order matters only for readability — every condition is independently fatal:
 * a disposed controller, an unloaded document, a destroyed window, a missing or
 * destroyed `webContents`.
 */
export function canDeliverHudState(surface: HudSurface): boolean {
  if (surface.disposed) return false
  if (!surface.ready) return false
  if (surface.windowDestroyed) return false
  if (!surface.hasWebContents) return false
  if (surface.contentsDestroyed) return false
  return true
}
