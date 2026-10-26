"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import {
  LayoutDashboard,
  Inbox,
  ShieldCheck,
  Package,
  BookOpen,
  Building2,
  Waypoints,
  ClipboardCheck,
  type LucideIcon,
} from "lucide-react";
import { cn } from "@/lib/cn";

interface NavItem {
  href: string;
  label: string;
  icon: LucideIcon;
  match: (path: string) => boolean;
  count?: "open" | "approvals";
}

/**
 * Three groups, because the product has three kinds of work: operating the
 * desk, looking things up, and inspecting the agent. Mixing them in one flat
 * row made the engineering surfaces look like part of a salesperson's day.
 */
const GROUPS: { label: string; items: NavItem[] }[] = [
  {
    label: "Operations",
    items: [
      { href: "/", label: "Overview", icon: LayoutDashboard, match: (p) => p === "/" },
      {
        href: "/inbox",
        label: "Requests",
        icon: Inbox,
        match: (p) => p.startsWith("/inbox") || p.startsWith("/cases") || p.startsWith("/quotes"),
        count: "open",
      },
      { href: "/approvals", label: "Approvals", icon: ShieldCheck, match: (p) => p.startsWith("/approvals"), count: "approvals" },
    ],
  },
  {
    label: "Reference",
    items: [
      { href: "/catalog", label: "Catalog", icon: Package, match: (p) => p.startsWith("/catalog") },
      { href: "/library", label: "Technical library", icon: BookOpen, match: (p) => p.startsWith("/library") },
      { href: "/customers", label: "Accounts", icon: Building2, match: (p) => p.startsWith("/customers") },
    ],
  },
  {
    label: "Agent",
    items: [
      { href: "/agent-lab", label: "Agent lab", icon: Waypoints, match: (p) => p.startsWith("/agent-lab") },
      { href: "/evaluations", label: "Evaluations", icon: ClipboardCheck, match: (p) => p.startsWith("/evaluations") },
    ],
  },
];

export function AppShell({
  children,
  adaptiveModel,
  counts,
  publicDemo = false,
}: {
  children: ReactNode;
  /** Model name when a provider is configured, null when running offline. */
  adaptiveModel: string | null;
  counts: { open: number; approvals: number };
  /** Read-only public deployment: live runs off, shared data protected. */
  publicDemo?: boolean;
}) {
  const pathname = usePathname() ?? "/";

  return (
    <div className="flex h-full">
      {/* Full sidebar from 1280px; an icon rail below that, so a 1024px laptop
          keeps enough width for the two-column case workspace. */}
      <aside className="no-print flex w-[60px] shrink-0 flex-col border-r border-[var(--rail-hairline)] bg-[var(--rail)] xl:w-[228px]">
        <Link
          href="/"
          className="flex h-14 items-center gap-2.5 border-b border-[var(--rail-hairline)] px-[18px] xl:px-4"
          title="Sales Engine — AI Technical Sales Operations"
        >
          <span className="flex size-6 shrink-0 items-center justify-center rounded-[5px] bg-white text-[11px] font-bold tracking-tight text-[var(--rail)]">
            S
          </span>
          <span className="hidden min-w-0 xl:block">
            <span className="block truncate text-[13px] font-semibold leading-tight tracking-[-0.01em] text-[var(--rail-text-strong)]">
              Sales Engine
            </span>
            <span className="block truncate text-[11px] leading-tight text-[var(--rail-text)]">
              Technical Sales Operations
            </span>
          </span>
        </Link>

        <nav className="flex-1 overflow-y-auto px-2.5 py-3" aria-label="Primary">
          {GROUPS.map((group) => (
            <div key={group.label} className="mb-4 last:mb-0">
              <div className="mb-1 hidden px-2 text-[11px] font-medium tracking-wide text-[#6b7385] xl:block">
                {group.label}
              </div>
              <ul className="space-y-0.5">
                {group.items.map((item) => {
                  const active = item.match(pathname);
                  const count = item.count ? counts[item.count] : 0;
                  const Icon = item.icon;
                  return (
                    <li key={item.href}>
                      <Link
                        href={item.href}
                        title={item.label}
                        aria-current={active ? "page" : undefined}
                        className={cn(
                          "group relative flex h-8 items-center justify-center gap-2.5 rounded-md px-2 text-[13px] transition-colors xl:justify-start",
                          active
                            ? "bg-[var(--rail-raised)] text-[var(--rail-text-strong)]"
                            : "text-[var(--rail-text)] hover:bg-[var(--rail-raised)] hover:text-[var(--rail-text-strong)]",
                        )}
                      >
                        {active ? (
                          <span className="absolute inset-y-1.5 left-0 w-[2px] rounded-full bg-accent-400" aria-hidden />
                        ) : null}
                        <Icon className="size-4 shrink-0" strokeWidth={1.75} aria-hidden />
                        <span className="hidden flex-1 truncate xl:block">{item.label}</span>
                        {count > 0 ? (
                          <span
                            className={cn(
                              "hidden rounded px-1.5 text-[11px] font-medium tabular-nums xl:inline",
                              item.count === "approvals"
                                ? "bg-warn-500/15 text-[#f3c77a]"
                                : "bg-white/[0.07] text-[var(--rail-text)]",
                            )}
                          >
                            {count}
                          </span>
                        ) : null}
                        {count > 0 && item.count === "approvals" ? (
                          <span className="absolute right-2 top-1.5 size-1.5 rounded-full bg-warn-500 xl:hidden" aria-hidden />
                        ) : null}
                      </Link>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </nav>

        {/* What can run right now, and a plain statement that nothing here is
            real customer data. Both are facts a first-time viewer needs and
            neither deserves more than a line. */}
        <div className="space-y-2.5 border-t border-[var(--rail-hairline)] px-3 py-3">
          <div className="hidden space-y-1.5 xl:block">
            <StatusLine tone="pass" label="Deterministic engines" value="Online" />
            <StatusLine
              tone={adaptiveModel ? "accent" : "idle"}
              label="Adaptive agent"
              value={adaptiveModel ?? (publicDemo ? "Captured runs" : "Offline")}
            />
            {publicDemo ? (
              <StatusLine
                tone="idle"
                label="Public demo"
                value="Read-only"
                title="Browsing is open; changes and live model runs are switched off so every visitor sees the same data."
              />
            ) : null}
          </div>
          <div
            className="flex items-center justify-center gap-2 rounded-md border border-[var(--rail-hairline)] px-2 py-1.5 xl:justify-start"
            title="Independent portfolio project. Every company, person, product, price and document is synthetic. No private company systems or data were used."
          >
            <span className="size-1.5 shrink-0 self-start rounded-full bg-warn-500 xl:mt-1" aria-hidden />
            <span className="hidden text-[11px] leading-snug xl:block">
              <span className="block text-[var(--rail-text-strong)]">Synthetic demo data</span>
              <span className="block text-[var(--rail-text)]">Independent project · synthetic data only</span>
            </span>
          </div>
        </div>
      </aside>

      <main className="min-w-0 flex-1 overflow-y-auto bg-[var(--canvas)]">{children}</main>
    </div>
  );
}

function StatusLine({
  tone,
  label,
  value,
  title,
}: {
  tone: "pass" | "accent" | "idle";
  label: string;
  value: string;
  title?: string;
}) {
  return (
    <div className="flex items-center gap-2 text-[11px] leading-tight" title={title}>
      <span
        className={cn(
          "size-1.5 shrink-0 rounded-full",
          tone === "pass" && "bg-pass-500",
          tone === "accent" && "bg-accent-400",
          tone === "idle" && "bg-[#4b5263]",
        )}
        aria-hidden
      />
      <span className="text-[var(--rail-text)]">{label}</span>
      <span className="ml-auto truncate font-mono text-[11px] text-[#7d8597]">{value}</span>
    </div>
  );
}
