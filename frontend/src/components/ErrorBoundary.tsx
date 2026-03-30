import { Component, type ReactNode, type ErrorInfo } from "react";

interface Props {
  children: ReactNode;
  /** Optional custom fallback UI. If omitted, uses the full-screen crash page. */
  fallback?: "tab" | "full";
}

interface State {
  hasError: boolean;
  error: Error | null;
}

export default class ErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Synced crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.hasError) {
      // Compact inline fallback for individual tabs
      if (this.props.fallback === "tab") {
        return (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              height: "100%",
              color: "var(--text-dim, rgba(255,255,255,0.5))",
              fontFamily: "var(--font-mono, monospace)",
              gap: "12px",
              padding: "24px",
              textAlign: "center",
            }}
          >
            <p style={{ fontSize: "0.8rem", textTransform: "uppercase", letterSpacing: "0.1em" }}>
              Something went wrong
            </p>
            <p style={{ fontSize: "0.7rem", opacity: 0.6 }}>
              {this.state.error?.message || "An unexpected error occurred."}
            </p>
            <button
              onClick={() => this.setState({ hasError: false, error: null })}
              style={{
                padding: "6px 16px",
                border: "1px solid var(--outline, rgba(255,255,255,0.2))",
                background: "transparent",
                color: "var(--text, #fff)",
                cursor: "pointer",
                fontFamily: "var(--font-mono, monospace)",
                fontSize: "0.75rem",
                textTransform: "uppercase",
                letterSpacing: "0.05em",
              }}
            >
              [ RETRY ]
            </button>
          </div>
        );
      }

      // Full-screen crash page (default, used for the top-level boundary)
      return (
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            justifyContent: "center",
            height: "100vh",
            background: "#000",
            color: "#fff",
            fontFamily: "monospace",
            gap: "16px",
            padding: "24px",
            textAlign: "center",
          }}
        >
          <h1 style={{ fontSize: "2rem", margin: 0 }}>SOMETHING WENT WRONG</h1>
          <p style={{ color: "rgba(255,255,255,0.5)", fontSize: "0.875rem" }}>
            {this.state.error?.message || "An unexpected error occurred."}
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: "8px 24px",
              border: "1px solid #fff",
              background: "transparent",
              color: "#fff",
              cursor: "pointer",
              fontFamily: "monospace",
              fontSize: "0.875rem",
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            [ RELOAD ]
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
