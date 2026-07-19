import { createRoot } from "react-dom/client";
// Eruda mobile console - remove after debugging
if (typeof window !== "undefined") {
  const script = document.createElement("script");
  script.src = "https://cdn.jsdelivr.net/npm/eruda";
  script.onload = () => (window as any).eruda.init();
  document.head.appendChild(script);
}
import { Component, type ErrorInfo, type ReactNode } from "react";
import App from "./App";
import "./index.css";
import { setBaseUrl, setAuthTokenGetter } from "@workspace/api-client-react";
setBaseUrl(import.meta.env.VITE_API_BASE_URL ?? "");


class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { error: null };
  }
  static getDerivedStateFromError(error: Error) {
    return { error };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("App crashed:", error, info);
  }
  render() {
    if (this.state.error) {
      const isDev = import.meta.env.DEV;
      return (
        <div style={{ padding: "2rem", fontFamily: "system-ui, sans-serif", textAlign: "center", color: "#333" }}>
          <h2 style={{ fontSize: "1.5rem", marginBottom: "0.5rem" }}>Something went wrong</h2>
          <p style={{ color: "#666", marginBottom: "1.5rem" }}>
            Please refresh the page. If the issue persists, contact support.
          </p>
          <button
            onClick={() => window.location.reload()}
            style={{ padding: "0.5rem 1.5rem", background: "#2d4a30", color: "white", border: "none", borderRadius: "2rem", cursor: "pointer", fontSize: "0.9rem" }}
          >
            Refresh Page
          </button>
          {isDev && (
            <pre style={{ marginTop: "2rem", whiteSpace: "pre-wrap", wordBreak: "break-word", textAlign: "left", background: "#fee", padding: "1rem", borderRadius: "0.5rem", fontSize: "0.75rem", color: "red" }}>
              {this.state.error.message}{"\n\n"}{this.state.error.stack}
            </pre>
          )}
        </div>
      );
    }
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(
  <ErrorBoundary>
    <App />
  </ErrorBoundary>
);
