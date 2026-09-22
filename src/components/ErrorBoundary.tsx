// Root + per-route error boundary. A render crash in any subtree (e.g. a malformed
// LLM table hitting MarkdownLite) is caught here instead of white-screening the app.
import { Component, type ErrorInfo, type ReactNode } from 'react'

interface Props {
  children: ReactNode
  /** Optional label so the fallback can name the area that failed. */
  scope?: string
  /** When any value in this array changes, the boundary clears its error WITHOUT
   *  remounting its children (e.g. pass [pathname] to recover on navigation). */
  resetKeys?: unknown[]
  /** Custom fallback renderer; receives a reset callback. */
  fallback?: (reset: () => void, error: Error) => ReactNode
}
interface State {
  error: Error | null
}

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null }

  static getDerivedStateFromError(error: Error): State {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // Console-only observability — matches the rest of the app's logging posture.
    console.error(`[error-boundary${this.props.scope ? ` · ${this.props.scope}` : ''}]`, error, info.componentStack)
  }

  componentDidUpdate(prev: Props) {
    if (!this.state.error) return
    const a = prev.resetKeys
    const b = this.props.resetKeys
    if (a && b && (a.length !== b.length || a.some((v, i) => v !== b[i]))) {
      this.setState({ error: null })
    }
  }

  reset = () => this.setState({ error: null })

  render() {
    const { error } = this.state
    if (!error) return this.props.children
    if (this.props.fallback) return this.props.fallback(this.reset, error)
    return (
      <div className="flex min-h-[240px] flex-col items-center justify-center gap-3 px-4 py-12 text-center">
        <p className="text-[15px] font-semibold text-ink">Something went wrong rendering this view.</p>
        <p className="max-w-md text-[12.5px] text-muted">
          {this.props.scope ? `The ${this.props.scope} panel` : 'This panel'} hit an unexpected error. Your data is safe — you can retry or navigate elsewhere.
        </p>
        <button onClick={this.reset} className="btn btn-fill mt-1 !text-[12px]">Try again</button>
      </div>
    )
  }
}
