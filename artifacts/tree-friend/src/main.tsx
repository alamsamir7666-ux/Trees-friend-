import { createRoot } from "react-dom/client";
// Eruda mobile console — DEV ONLY. Never load in production.
// Loads from CDN only when VITE_API_BASE_URL is set to a local/localhost
// address, which guarantees this is a development session.
if (typeof window !== "undefined" && import.meta.env.DEV) {
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
        <div
          className="flex flex-col items-center justify-center min-h-[100dvh] gap-3 px-8 py-12 text-center bg-background text-foreground"
          style={{ fontFamily: "system-ui, sans-serif" }}
        >
          <h2 className="text-xl font-semibold mb-2">Something went wrong</h2>
          <p className="text-sm text-muted-foreground mb-6 max-w-md">
            Please refresh the page. If the issue persists, contact support.
          </p>
          <button
            onClick={() => window.location.reload()}
            className="px-6 py-2 rounded-full bg-primary text-primary-foreground hover:bg-primary/90 transition-colors text-sm font-medium cursor-pointer"
          >
            Refresh Page
          </button>
          {isDev && (
            <pre
              className="mt-8 w-full max-w-2xl text-left text-xs whitespace-pre-wrap break-words bg-destructive/10 text-destructive border border-destructive/20 p-4 rounded-lg"
            >
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
