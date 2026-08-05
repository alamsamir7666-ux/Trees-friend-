// components/ui/PageBreadcrumb.tsx
// Reusable breadcrumb navigation system with appealing icons for all pages

import { Link } from "wouter";
import { Home, ChevronRight } from "lucide-react";
import { cn } from "@/lib/utils";

export interface BreadcrumbCrumb {
  label: string;
  href?: string;
  icon?: React.ReactNode;
}

interface PageBreadcrumbProps {
  crumbs: BreadcrumbCrumb[];
  className?: string;
}

export function PageBreadcrumb({ crumbs, className }: PageBreadcrumbProps) {
  return (
    <nav
      aria-label="Breadcrumb"
      className={cn(
        "flex items-center gap-1 text-xs text-muted-foreground flex-wrap",
        className,
      )}
    >
      {/* Home */}
      <Link
        href="/"
        className="flex items-center gap-1 hover:text-accent transition-colors font-medium"
        aria-label="Home"
      >
        <Home className="h-3.5 w-3.5 shrink-0" />
        <span className="sr-only">Home</span>
      </Link>

      {crumbs.map((crumb, i) => {
        const isLast = i === crumbs.length - 1;
        return (
          <span key={i} className="flex items-center gap-1">
            <ChevronRight className="h-3 w-3 text-muted-foreground/50 shrink-0" />
            {crumb.href && !isLast ? (
              <Link
                href={crumb.href}
                className="flex items-center gap-1 hover:text-accent transition-colors"
              >
                {crumb.icon && <span className="shrink-0">{crumb.icon}</span>}
                {crumb.label}
              </Link>
            ) : (
              <span
                className={cn(
                  "flex items-center gap-1",
                  isLast ? "text-foreground font-medium" : "",
                )}
                aria-current={isLast ? "page" : undefined}
              >
                {crumb.icon && <span className="shrink-0">{crumb.icon}</span>}
                {crumb.label}
              </span>
            )}
          </span>
        );
      })}
    </nav>
  );
}
