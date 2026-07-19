/**
 * PageTransition - lightweight CSS-only fade+slide transition between routes.
 * Uses a CSS animation triggered by a key change on the location.
 * No framer-motion needed - pure Tailwind + CSS keyframe.
 */
import { useLocation } from "wouter";

export function PageTransition({ children }: { children: React.ReactNode }) {
  const [location] = useLocation();

  return (
    <div
      key={location}
      className="page-transition-enter"
      style={{ animation: "pageFadeIn 0.18s ease-out both" }}
    >
      {children}
    </div>
  );
}
