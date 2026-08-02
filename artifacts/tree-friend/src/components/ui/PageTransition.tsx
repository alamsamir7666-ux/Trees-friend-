/**
 * PageTransition - lightweight CSS-only fade transition between routes.
 * Uses a CSS animation triggered by a key change on the location.
 * No framer-motion needed - pure Tailwind + CSS keyframe.
 *
 * IMPORTANT: The animation MUST only animate `opacity`, never `transform`.
 * See the comment on `@keyframes pageFadeIn` in index.css for the full
 * rationale — short version: a retained `transform` on this wrapper
 * becomes the containing block for every `position: fixed` descendant
 * (chat lightbox, action-menu bottom sheet, click-away catcher, etc.),
 * which breaks their viewport-relative positioning.
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
