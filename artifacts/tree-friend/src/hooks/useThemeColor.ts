import { useEffect } from "react";
import { useTheme } from "next-themes";

/**
 * Syncs the browser's `<meta name="theme-color">` tags with the app's
 * resolved theme. Browsers use this for the Android Chrome address-bar
 * tint, the iOS Safari status-bar tint (when in PWA standalone mode), and
 * the Windows / macOS title-bar overlay color.
 *
 * Two meta tags are emitted:
 *   1. `<meta name="theme-color">` (no media) -- always the currently
 *      resolved theme's color. This is what most browsers actually read.
 *   2. `<meta name="theme-color" media="(prefers-color-scheme: dark)">` --
 *      a fallback for the brief moment before next-themes resolves the
 *      stored preference (avoids a flash of the wrong color on cold
 *      start).
 *
 * The colors are kept in sync here rather than declared statically in
 * index.html because the user can toggle the theme at runtime and the
 * browser won't re-read a static meta tag.
 *
 * Brand colors used:
 *   light -- hsl(150 30% 18%) = #1f3b2a (forest green, matches --primary)
 *   dark  -- hsl(150 15% 8%)  = #111d17 (near-black green, matches --background)
 */
const LIGHT_THEME_COLOR = "#1f3b2a";
const DARK_THEME_COLOR = "#111d17";

export function useThemeColor() {
  const { resolvedTheme } = useTheme();

  useEffect(() => {
    const color = resolvedTheme === "dark" ? DARK_THEME_COLOR : LIGHT_THEME_COLOR;

    const ensureMeta = (media?: string) => {
      let selector = 'meta[name="theme-color"]';
      if (media) selector += `[media="${media}"]`;
      let el = document.head.querySelector<HTMLMetaElement>(selector);
      if (!el) {
        el = document.createElement("meta");
        el.setAttribute("name", "theme-color");
        if (media) el.setAttribute("media", media);
        document.head.appendChild(el);
      }
      return el;
    };

    // Primary tag -- always reflects the resolved theme.
    ensureMeta().setAttribute("content", color);
    // Fallback tag for the cold-start flash before next-themes resolves.
    ensureMeta("(prefers-color-scheme: dark)").setAttribute(
      "content",
      resolvedTheme === "dark" ? color : DARK_THEME_COLOR,
    );
    ensureMeta("(prefers-color-scheme: light)").setAttribute(
      "content",
      resolvedTheme === "light" ? color : LIGHT_THEME_COLOR,
    );
  }, [resolvedTheme]);
}
