"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { cn } from "@/lib/utils";

const LINKS = [
  { href: "/playground", label: "Playground" },
  { href: "/verdicts", label: "Verdicts" },
  { href: "/analytics", label: "Analytics" },
  { href: "/apps", label: "Apps" },
  { href: "/evaluation", label: "Evaluation" },
];

export function MainNav() {
  const pathname = usePathname();
  return (
    <nav aria-label="Main">
      <ul className="flex flex-wrap gap-1">
        {LINKS.map((l) => {
          const active = pathname === l.href || pathname.startsWith(`${l.href}/`);
          return (
            <li key={l.href}>
              <Link
                href={l.href}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-md px-3 py-1.5 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                  active ? "bg-primary text-primary-foreground" : "text-slate-700 hover:bg-muted",
                )}
              >
                {l.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
