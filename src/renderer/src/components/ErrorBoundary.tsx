import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Shown above the error; helps identify which surface failed. */
  label?: string
}

interface State {
  error: Error | null
}

/**
 * Catches renderer crashes so a single broken panel cannot leave the whole
 * window blank. The message stays generic — stack traces go to the console,
 * where they are useful, rather than into the UI.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Keep the real error in the developer console; never render it to the user.
    console.error('[renderer] unhandled error in', this.props.label ?? 'app', error, info.componentStack)
  }

  private reset = (): void => this.setState({ error: null })

  render(): ReactNode {
    if (!this.state.error) return this.props.children
    return (
      <div className="crash-state" role="alert">
        <div className="card" style={{ maxWidth: 460 }}>
          <h2 className="text-base font-semibold mb-1">
            {this.props.label ? `${this.props.label} ran into a problem` : 'Something went wrong'}
          </h2>
          <p className="text-sm mb-4" style={{ color: 'var(--text-secondary)' }}>
            The rest of the workspace is still running. Try again — if it keeps happening, the details were written to the application log.
          </p>
          <div className="flex gap-2">
            <button className="btn primary" onClick={this.reset}>Try again</button>
            <button className="btn" onClick={() => window.location.reload()}>Reload window</button>
          </div>
        </div>
      </div>
    )
  }
}
