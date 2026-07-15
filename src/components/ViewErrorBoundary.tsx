import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
  /** Etichetta vista per messaggio errore (es. "Studio"). */
  label?: string;
  onRetry?: () => void;
};

type State = {
  error: Error | null;
};

/** Cattura errori render/chunk lazy e mostra UI recuperabile. */
export class ViewErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[ViewErrorBoundary${this.props.label ? `:${this.props.label}` : ""}]`, error, info);
  }

  private retry = () => {
    this.setState({ error: null });
    this.props.onRetry?.();
  };

  render() {
    if (this.state.error) {
      const label = this.props.label ?? "view";
      return (
        <div className="panel-empty danger" role="alert">
          <p>
            <strong>{label}</strong> — errore di caricamento.
          </p>
          <p className="subtle sm">{this.state.error.message}</p>
          <button type="button" className="btn btn--ghost" onClick={this.retry}>
            Riprova
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
