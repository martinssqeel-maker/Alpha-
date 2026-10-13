import { withContext } from './db'

// Maintenance mode is a row in public.system_settings ('maintenance'), written by
// the admin portal. It is enforced here, on the server: while it is active,
// ordinary accounts cannot start a sign-in or fetch a download, and they get an
// explanation instead of a generic failure. Administrators keep full access so
// there is always a way back in.

export interface MaintenanceState {
  active: boolean
  message: string | null
}

export async function maintenanceState(): Promise<MaintenanceState> {
  try {
    return await withContext(null, 'anon', async (q) => {
      const row = (
        await q.query<{ value: { active?: boolean; message?: string } | null }>(
          "select value from public.system_settings where key = 'maintenance'"
        )
      ).rows[0]
      const value = row?.value ?? null
      const active = Boolean(value && typeof value === 'object' && value.active)
      const message =
        value && typeof value === 'object' && typeof value.message === 'string' && value.message.trim()
          ? value.message.trim()
          : null
      return { active, message }
    })
  } catch {
    // An unreadable settings row must never take the product down.
    return { active: false, message: null }
  }
}

export interface MaintenanceProblem {
  status: 503
  code: string
  message: string
}

/** Refuse an ordinary account while maintenance is on; administrators pass. */
export function maintenanceProblem(
  state: MaintenanceState,
  isAdmin: boolean
): MaintenanceProblem | null {
  if (!state.active || isAdmin) return null
  return {
    status: 503,
    code: 'maintenance',
    message:
      state.message ||
      'Alpha is briefly offline for maintenance. Please try again in a few minutes.'
  }
}
