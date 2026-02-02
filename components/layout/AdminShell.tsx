/**
 * AdminShell – globale Backoffice-Shell mit Navigation, Standortwechsel & User-Menü.
 * Client-Komponente, damit Navigationsstatus & Location-Switch interaktiv funktionieren.
 */
"use client";

import Image from "next/image";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { formatISO } from "date-fns";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  Menu,
  LogOut,
  CalendarDays,
  Users,
  Bell,
  Settings,
  BarChart3,
  LineChart,
  Briefcase,
  Layers,
  Tag,
  UserCog,
  X,
  Search,
  Building2,
  BellRing,
  Warehouse,
  MapPin,
  Cog,
  ChevronDown,
  Clock3,
  Power,
} from "lucide-react";
import { BookingPinSessionProvider, useBookingPinSession } from "@/components/dashboard/BookingPinSessionContext";
import { ToastProvider, useToast } from "@/components/ui/ToastProvider";
import { IncomingCallListener } from "@/components/cti/IncomingCallListener";
import { isAdminRole } from "@/lib/access-control";

type NavItem = {
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  segment?: string;
  children?: NavItem[];
};

type NavGroup = {
  title: string;
  items: NavItem[];
};

const ROLE_LABELS: Record<string, string> = {
  OWNER: "Inhaber",
  ADMIN: "Administrator",
  MANAGER: "Teamleitung",
  STAFF: "Mitarbeiter",
  VIEWER: "Leserechte",
};

const NAV_GROUPS: NavGroup[] = [
  {
    title: "Unternehmen",
    items: [
      {
        label: "Unternehmen verwalten",
        icon: Building2,
        children: [
          { label: "Mitarbeiter", icon: UserCog, segment: "staff" },
          { label: "Erinnerungen", icon: BellRing, segment: "reminders" },
          { label: "Leistungen", icon: Layers, segment: "services" },
          { label: "Kategorien", icon: Tag, segment: "categories" },
          { label: "Ressourcen", icon: Warehouse, segment: "resources" },
          { label: "Standorte", icon: MapPin, segment: "locations" },
          { label: "Einstellungen", icon: Cog, segment: "settings" },
        ],
      },
    ],
  },
  {
    title: "Kalender & Termine",
    items: [
      { label: "Dashboard", icon: BarChart3, segment: "dashboard" },
      { label: "Statistik", icon: LineChart, segment: "analytics" },
      { label: "Kalender", icon: CalendarDays, segment: "calendar" },
      { label: "Termine", icon: Briefcase, segment: "appointments" },
    ],
  },
  {
    title: "Kunden & Kommunikation",
    items: [
      { label: "Kunden", icon: Users, segment: "customers" },
      { label: "Marketing", icon: Bell, segment: "marketing" },
    ],
  },
  {
    title: "Produkt & Team",
    items: [
      { label: "Leistungen", icon: Layers, segment: "services" },
      { label: "Kategorien", icon: Tag, segment: "categories" },
      { label: "Mitarbeiter", icon: UserCog, segment: "staff" },
      { label: "Einstellungen", icon: Settings, segment: "settings" },
    ],
  },
];

const STAFF_SEGMENTS = new Set(["dashboard", "calendar", "appointments", "customers"]);

function filterNavGroups(groups: NavGroup[], allowedSegments: Set<string>): NavGroup[] {
  return groups
    .map((group) => {
      const items = group.items
        .map((item) => {
          if (item.children?.length) {
            const children = item.children.filter((child) => child.segment && allowedSegments.has(child.segment));
            if (!children.length) return null;
            return { ...item, children };
          }
          if (item.segment && allowedSegments.has(item.segment)) {
            return item;
          }
          return null;
        })
        .filter((item): item is NavItem => Boolean(item));
      if (!items.length) return null;
      return { ...group, items };
    })
    .filter((group): group is NavGroup => Boolean(group));
}

interface AdminShellProps {
  children: ReactNode;
  locations: Array<{ slug: string; name: string }>;
  currentLocation?: string;
  user?: { name: string; role: string; tenant?: string };
  permissionKeys?: string[];
}

function formatRoleLabel(role: string | null | undefined): string | null {
  if (!role) return null;
  const normalized = role.trim().toUpperCase();
  return ROLE_LABELS[normalized] ?? role;
}

export function AdminShell({ children, locations, currentLocation, user, permissionKeys }: AdminShellProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const isEmbedded = searchParams?.get("embed") === "1";
  const [navOpen, setNavOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false);
  const [isDesktop, setIsDesktop] = useState(false);
  const [expandedMenus, setExpandedMenus] = useState<Record<string, boolean>>({});
  const accountButtonRef = useRef<HTMLButtonElement | null>(null);
  const accountMenuRef = useRef<HTMLDivElement | null>(null);
  const isAdmin = isAdminRole(user?.role);
  const roleLabel = formatRoleLabel(user?.role);
  const tenantLabel = user?.tenant?.trim() || "Tenant";
  const permissionSet = new Set(permissionKeys ?? []);
  const canViewAnalytics = isAdmin || permissionSet.has("calendar.analytics.view");

  const pathSegments = pathname.split("/").filter(Boolean); // z.B. ["backoffice", "city-center-salon", "calendar"]
  const resolvedLocation = currentLocation ?? pathSegments[1] ?? locations[0]?.slug ?? "";
  const resolvedLocationLabel =
    locations.find((entry) => entry.slug === resolvedLocation)?.name ?? resolvedLocation;
  const activeSegment =
    pathSegments[0] === "backoffice"
      ? pathSegments[2] ?? (pathSegments.length >= 2 ? "dashboard" : undefined)
      : undefined;

  const buildHref = (segment: string) => {
    if (!resolvedLocation) {
      return "/backoffice";
    }
    return `/backoffice/${resolvedLocation}/${segment}`;
  };
  const activeLocationSegment = activeSegment ?? "calendar";
  const buildLocationHref = (slug: string) => `/backoffice/${slug}/${activeLocationSegment}`;
  const calendarTodayHref = `${buildHref("calendar")}?week=${formatISO(new Date(), { representation: "date" })}`;
  const allowedSegments = isAdmin ? null : new Set(STAFF_SEGMENTS);
  if (allowedSegments && canViewAnalytics) {
    allowedSegments.add("analytics");
  }
  const navGroups = isAdmin ? NAV_GROUPS : filterNavGroups(NAV_GROUPS, allowedSegments ?? STAFF_SEGMENTS);

  const toggleNav = () => setNavOpen((prev) => !prev);
  const closeNav = () => setNavOpen(false);
  const toggleAccountMenu = () => setAccountOpen((prev) => !prev);

  const handleLogout = async () => {
    try {
      await fetch("/auth/logout", { method: "POST", credentials: "include" });
    } finally {
      router.replace("/auth/login");
    }
  };

  useEffect(() => {
    if (!navOpen) return;
    const handleClick = (event: MouseEvent) => {
      if (navOpen) {
        const aside = document.getElementById("admin-shell-nav");
        if (aside && !aside.contains(event.target as Node)) {
          setNavOpen(false);
        }
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setNavOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [navOpen, isDesktop]);

  useEffect(() => {
    if (!accountOpen) return;
    const handleClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (accountMenuRef.current?.contains(target)) return;
      if (accountButtonRef.current?.contains(target)) return;
      setAccountOpen(false);
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setAccountOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [accountOpen]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(min-width: 1024px)");
    const handleChange = (event: MediaQueryListEvent) => {
      setIsDesktop(event.matches);
      setNavOpen(false);
    };
    setIsDesktop(media.matches);
    if (typeof media.addEventListener === "function") {
      media.addEventListener("change", handleChange);
    } else {
      media.addListener(handleChange);
    }
    return () => {
      if (typeof media.removeEventListener === "function") {
        media.removeEventListener("change", handleChange);
      } else {
        media.removeListener(handleChange);
      }
    };
  }, []);

  useEffect(() => {
    setExpandedMenus((prev) => {
      let changed = false;
      const next = { ...prev };
      NAV_GROUPS.forEach((group) => {
        group.items.forEach((item) => {
          if (item.children?.some((child) => child.segment === activeSegment)) {
            if (!next[item.label]) {
              next[item.label] = true;
              changed = true;
            }
          }
        });
      });
      return changed ? next : prev;
    });
  }, [activeSegment]);

  const toggleMenuSection = (label: string) => {
    setExpandedMenus((prev) => ({ ...prev, [label]: !prev[label] }));
  };

  return (
    <ToastProvider>
      <BookingPinSessionProvider>
        {!isEmbedded && <IncomingCallListener locationSlug={resolvedLocation} />}
        <div className="relative flex min-h-screen h-screen w-full overflow-hidden bg-zinc-100 text-zinc-900">
        {!isEmbedded && navOpen && !isDesktop && (
          <div
            className="fixed inset-0 z-[1190] bg-black/40 backdrop-blur-sm"
            role="presentation"
            onClick={closeNav}
          />
        )}
        {!isEmbedded && (
          <aside
            id="admin-shell-nav"
            className={`fixed inset-y-0 left-0 z-[1200] flex w-72 flex-col border-r border-zinc-200 bg-white shadow-xl transition-transform duration-200 ease-in-out ${
              navOpen ? "translate-x-0" : "-translate-x-full"
            }`}
          >
            <div className={`flex h-16 items-center justify-end gap-3 border-b border-zinc-200 px-6 ${isDesktop ? "hidden" : ""}`}>
              <button
                type="button"
                onClick={closeNav}
                className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-zinc-200 text-zinc-500 transition hover:text-zinc-700"
                aria-label="Navigation schließen"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <nav className="no-scrollbar flex-1 space-y-6 overflow-y-auto px-6 py-6 text-sm">
              {navGroups.map((group) => (
                <div key={group.title} className="space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">{group.title}</p>
                  <div className="space-y-1">
                    {group.items.map((item) => {
                      if (item.children && item.children.length) {
                        const isExpanded = expandedMenus[item.label] ?? false;
                        const childActive = item.children.some((child) => child.segment === activeSegment);
                        return (
                          <div key={item.label} className="space-y-1">
                            <button
                              type="button"
                              onClick={() => toggleMenuSection(item.label)}
                              className={`flex w-full items-center justify-between rounded-md px-3 py-2 text-sm font-medium transition ${
                                childActive ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
                              }`}
                              aria-expanded={isExpanded}
                              aria-controls={`submenu-${item.label}`}
                            >
                              <span className="flex items-center gap-3">
                                <item.icon className="h-4 w-4" />
                                {item.label}
                              </span>
                              <ChevronDown
                                className={`h-4 w-4 transition-transform ${isExpanded ? "rotate-180" : "rotate-0"}`}
                              />
                            </button>
                            {isExpanded && (
                              <div id={`submenu-${item.label}`} className="ml-6 space-y-1 border-l border-zinc-200 pl-3">
                                {item.children.map((child) => {
                                  const href = child.segment ? buildHref(child.segment) : "#";
                                  const isActive = activeSegment === child.segment;
                                  return (
                                    <AdminNavLink
                                      key={child.segment ?? child.label}
                                      href={href}
                                      icon={child.icon}
                                      label={child.label}
                                      active={Boolean(isActive)}
                                      onClick={closeNav}
                                    />
                                  );
                                })}
                              </div>
                            )}
                          </div>
                        );
                      }

                      const href = item.segment ? buildHref(item.segment) : "#";
                      const isActive = activeSegment === item.segment;
                      return (
                        <AdminNavLink
                          key={item.segment ?? item.label}
                          href={href}
                          icon={item.icon}
                          label={item.label}
                          active={Boolean(isActive)}
                          onClick={closeNav}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </nav>
            <div className="border-t border-zinc-200 px-6 py-4 text-xs text-zinc-500">
              © {new Date().getFullYear()} Timevex Calendar
            </div>
          </aside>
        )}

        <div className="flex min-h-0 w-full min-w-0 flex-1 flex-col transition-all duration-200">
          {!isEmbedded && (
            <header className="sticky top-0 z-[200] flex h-auto flex-wrap items-center justify-between gap-4 border-b border-zinc-200 bg-white px-4 py-3 lg:h-16 lg:flex-nowrap lg:px-8">
              <div className="flex flex-wrap items-center gap-6">
                <button
                  type="button"
                  className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-zinc-200 text-zinc-700 transition hover:border-zinc-300 hover:text-zinc-900"
                  aria-label="Navigation öffnen"
                  aria-expanded={navOpen}
                  onClick={toggleNav}
                >
                  <Menu className="h-5 w-5" />
                </button>
                <div className="flex items-center gap-2 text-sm font-semibold text-zinc-900">
                  <Link
                    href={calendarTodayHref}
                    className="inline-flex items-center"
                    aria-label="Kalender öffnen"
                  >
                    <Image src="/murmel-logo.png" alt="murmel" width={36} height={41} priority />
                  </Link>
                </div>
                <div className="relative hidden items-center gap-2 md:flex md:w-[460px] lg:w-[560px]">
                  <label className="sr-only" htmlFor="global-search">
                    Kunden oder Termine suchen
                  </label>
                  <Search className="pointer-events-none absolute left-3 h-4 w-4 text-zinc-400" />
                  <input
                    id="global-search"
                    type="search"
                    placeholder="Suche nach Kunden oder Terminen"
                    className="w-full rounded-full border border-zinc-200 bg-white py-2 pl-9 pr-4 text-sm text-zinc-700 shadow-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  />
                </div>
              </div>
              <div className="flex items-center gap-4">
                <BookingPinSessionIndicator />
                <div className="relative z-40">
                  <button
                    ref={accountButtonRef}
                    type="button"
                    onClick={toggleAccountMenu}
                    className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-white px-3 py-1.5 text-left text-xs font-semibold text-zinc-700 shadow-sm transition hover:border-zinc-300 hover:text-zinc-900"
                    aria-haspopup="menu"
                    aria-expanded={accountOpen}
                  >
                    <div className="flex flex-col items-end gap-0 leading-[1.1]">
                      <span className="text-sm font-semibold text-zinc-900">{tenantLabel}</span>
                      {roleLabel ? <span className="text-[11px] text-zinc-500">{roleLabel}</span> : null}
                      {resolvedLocationLabel ? (
                        <span className="text-[10px] text-zinc-400">{resolvedLocationLabel}</span>
                      ) : null}
                    </div>
                    <ChevronDown
                      className={`h-4 w-4 text-zinc-500 transition ${accountOpen ? "rotate-180" : ""}`}
                    />
                  </button>
                  {accountOpen && (
                    <div
                      ref={accountMenuRef}
                      className="absolute right-0 z-50 mt-2 w-64 rounded-xl border border-zinc-200 bg-white shadow-lg"
                    >
                      <div className="px-4 pt-3 text-[10px] font-semibold uppercase tracking-widest text-zinc-400">
                        Filiale wechseln
                      </div>
                      <div className="max-h-60 overflow-y-auto px-2 py-2">
                        {locations.map((loc) => {
                          const isActive = loc.slug === resolvedLocation;
                          return (
                            <Link
                              key={loc.slug}
                              href={buildLocationHref(loc.slug)}
                              onClick={() => setAccountOpen(false)}
                              className={`flex items-center justify-between rounded-lg px-3 py-2 text-sm transition ${
                                isActive ? "bg-emerald-50 text-emerald-700" : "text-zinc-700 hover:bg-zinc-100"
                              }`}
                            >
                              <span className="truncate">{loc.name}</span>
                              {isActive ? (
                                <span className="rounded-full border border-emerald-200 bg-emerald-100 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest text-emerald-700">
                                  Aktiv
                                </span>
                              ) : null}
                            </Link>
                          );
                        })}
                      </div>
                      <div className="border-t border-zinc-200 px-2 py-2">
                        <button
                          type="button"
                          onClick={() => {
                            setAccountOpen(false);
                            handleLogout();
                          }}
                          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100"
                        >
                          <LogOut className="h-4 w-4" />
                          Ausloggen
                        </button>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            </header>
          )}

          <main
            className={`min-h-0 flex-1 overflow-y-auto ${
              isEmbedded ? "bg-white px-0 py-0" : "bg-zinc-50 px-4 py-6 lg:px-8"
            }`}
          >
            {children}
          </main>
        </div>
      </div>
      </BookingPinSessionProvider>
    </ToastProvider>
  );
}

function BookingPinSessionIndicator() {
  const { actor, secondsRemaining, endSession } = useBookingPinSession();
  const { pushToast } = useToast();

  if (!actor || secondsRemaining <= 0) {
    return null;
  }

  const minutes = Math.max(0, Math.floor(secondsRemaining / 60));
  const seconds = Math.max(0, secondsRemaining % 60);
  const label = `${minutes.toString().padStart(2, "0")}:${seconds.toString().padStart(2, "0")}`;

  const handleEnd = () => {
    endSession();
    pushToast({ variant: "info", message: "Buchungsfreigabe beendet." });
  };

  return (
    <div className="flex items-center gap-2 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-1 text-xs font-semibold text-emerald-700 shadow-sm">
      <Clock3 className="h-4 w-4" aria-hidden="true" />
      <span className="tabular-nums" aria-live="polite">
        {label}
      </span>
      <button
        type="button"
        onClick={handleEnd}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-emerald-200 bg-white/40 text-emerald-700 transition hover:bg-emerald-100"
        aria-label="Buchungsfreigabe beenden"
      >
        <Power className="h-3.5 w-3.5" />
      </button>
    </div>
  );
}

function AdminNavLink({
  href,
  icon: Icon,
  label,
  active,
  onClick,
}: {
  href: string;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  active: boolean;
  onClick?: () => void;
}) {
  return (
    <Link
      href={href}
      onClick={onClick}
      className={`flex items-center gap-3 rounded-md px-3 py-2 text-sm transition ${
        active ? "bg-zinc-900 text-white" : "text-zinc-600 hover:bg-zinc-100"
      }`}
    >
      <Icon className="h-4 w-4" />
      <span className="font-medium">{label}</span>
    </Link>
  );
}
