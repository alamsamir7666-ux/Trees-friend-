import { useEffect, useRef, useState } from "react";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * Theme toggle with Sun/Moon icon + long-press for system menu.
 *
 * UX:
 *   - Single click  → toggles between light and dark (preserves the
 *                     quick-toggle behavior users expect from a Sun/Moon
 *                     button, like GitHub / Linear / Vercel).
 *   - Long-press    → opens a dropdown with three explicit options:
 *                     Light / Dark / System. Lets power users override
 *                     the OS preference, or revert to "follow OS".
 *
 * Industry-standard pattern: same shape as GitHub's 2024 theme toggle
 * (long-press on mobile, hover-menu on desktop), and matches the WCAG
 * recommendation that "always provide an explicit override" be available
 * even when `defaultTheme="system"` is set.
 *
 * Accessibility:
 *   - `aria-label` on the toggle button announces current resolved theme.
 *   - `aria-haspopup="menu"` and `aria-expanded` come from DropdownMenu.
 *   - Long-press uses pointer events (works for mouse + touch + pen).
 *   - The 500ms threshold matches the long-press convention used by
 *     Android ContextMenu and iOS Peek.
 */
const LONG_PRESS_MS = 500;

type ThemeChoice = "light" | "dark" | "system";

const CHOICE_LABELS: Record<ThemeChoice, string> = {
  light: "Light",
  dark: "Dark",
  system: "System",
};

export function ThemeToggle({ className = "", align = "end" }: { className?: string; align?: "start" | "center" | "end" }) {
  const { theme, setTheme, resolvedTheme } = useTheme();
  const [menuOpen, setMenuOpen] = useState(false);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const didLongPress = useRef(false);

  // Cleanup any pending long-press timer on unmount.
  useEffect(() => {
    return () => {
      if (pressTimer.current) clearTimeout(pressTimer.current);
    };
  }, []);

  const startPress = () => {
    didLongPress.current = false;
    pressTimer.current = setTimeout(() => {
      didLongPress.current = true;
      setMenuOpen(true);
    }, LONG_PRESS_MS);
  };

  const cancelPress = () => {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  };

  const handleClick = () => {
    // If the long-press fired, the dropdown is already open -- don't
    // also toggle the theme on the same interaction.
    if (didLongPress.current) {
      didLongPress.current = false;
      return;
    }
    // Quick toggle: flip light↔dark based on the *resolved* theme
    // (so clicking when in system-mode-on-a-dark-OS still feels right).
    setTheme(resolvedTheme === "dark" ? "light" : "dark");
  };

  const handleSelect = (choice: ThemeChoice) => {
    setTheme(choice);
    setMenuOpen(false);
  };

  const isCurrent = (choice: ThemeChoice) => theme === choice;

  return (
    <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
      <DropdownMenuTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className={`relative ${className}`}
          aria-label={`Toggle theme. Current: ${resolvedTheme ?? "system"}. Long-press for options.`}
          // Pointer events (not onClick + onTouchStart) so we don't fight
          // the browser's own touch-vs-click emulation on mobile.
          onPointerDown={startPress}
          onPointerUp={cancelPress}
          onPointerLeave={cancelPress}
          onPointerCancel={cancelPress}
          onClick={handleClick}
        >
          <Sun
            className={[
              "h-5 w-5 transition-all duration-300",
              resolvedTheme === "dark"
                ? "rotate-90 scale-0"
                : "rotate-0 scale-100",
            ].join(" ")}
          />
          <Moon
            className={[
              "absolute h-5 w-5 transition-all duration-300",
              resolvedTheme === "dark"
                ? "rotate-0 scale-100"
                : "-rotate-90 scale-0",
            ].join(" ")}
          />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align={align} sideOffset={6} className="min-w-[8rem]">
        <DropdownMenuLabel className="text-xs text-muted-foreground font-normal">
          Theme
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          onClick={() => handleSelect("light")}
          className="flex items-center justify-between gap-3"
        >
          <span className="flex items-center gap-2">
            <Sun className="h-4 w-4" />
            Light
          </span>
          {isCurrent("light") && <Check className="h-3.5 w-3.5 text-success-foreground" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleSelect("dark")}
          className="flex items-center justify-between gap-3"
        >
          <span className="flex items-center gap-2">
            <Moon className="h-4 w-4" />
            Dark
          </span>
          {isCurrent("dark") && <Check className="h-3.5 w-3.5 text-success-foreground" />}
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => handleSelect("system")}
          className="flex items-center justify-between gap-3"
        >
          <span className="flex items-center gap-2">
            <Monitor className="h-4 w-4" />
            System
          </span>
          {isCurrent("system") && <Check className="h-3.5 w-3.5 text-success-foreground" />}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
