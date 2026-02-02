"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState, useTransition } from "react";
import type { DragEvent, MouseEvent } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import { StaffStatus } from "@prisma/client";

import { reorderStaffAction, type StaffListEntry } from "@/app/backoffice/[location]/staff/actions";
import { StaffDirectorySkeleton } from "@/components/staff/StaffDirectorySkeleton";
import { getReadableTextColor, toRgba } from "@/lib/color";

async function parseJsonResponse(response: Response) {
  const raw = await response.text();
  if (!raw.trim().length) return null;
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error("Antwort konnte nicht gelesen werden.");
  }
}

function sortStaff(records: StaffListEntry[]): StaffListEntry[] {
  return [...records].sort((a, b) => {
    const orderA = a.calendarOrder ?? Number.MAX_SAFE_INTEGER;
    const orderB = b.calendarOrder ?? Number.MAX_SAFE_INTEGER;
    if (orderA !== orderB) return orderA - orderB;
    const nameA = (a.displayName || `${a.firstName} ${a.lastName}`).trim().toLowerCase();
    const nameB = (b.displayName || `${b.firstName} ${b.lastName}`).trim().toLowerCase();
    return nameA.localeCompare(nameB);
  });
}

interface StaffDirectoryProps {
  locationSlug: string;
  initialStaff: StaffListEntry[];
  readOnly?: boolean;
  readOnlyReason?: string;
}

export default function StaffDirectory({ locationSlug, initialStaff, readOnly = false, readOnlyReason }: StaffDirectoryProps) {
  const [records, setRecords] = useState<StaffListEntry[]>(() => sortStaff(initialStaff));
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<StaffStatus | "all">("all");
  const [draggingId, setDraggingId] = useState<string | null>(null);
  const [dropTargetId, setDropTargetId] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveSuccess, setSaveSuccess] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const suppressClickRef = useRef(false);
  const successTimer = useRef<number | null>(null);
  const pendingOrderRef = useRef<{ orderedIds: string[]; fallback: StaffListEntry[] } | null>(null);
  const [isPending, startTransition] = useTransition();

  useEffect(() => {
    setRecords(sortStaff(initialStaff));
  }, [initialStaff]);

  useEffect(() => () => {
    if (successTimer.current) window.clearTimeout(successTimer.current);
  }, []);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(async () => {
      setLoading(true);
      try {
        const params = new URLSearchParams();
        if (search.trim()) params.set("q", search.trim());
        if (statusFilter !== "all") params.set("status", statusFilter);
        params.set("_", Date.now().toString());
        const response = await fetch(`/api/backoffice/${locationSlug}/staff?${params.toString()}`, {
          signal: controller.signal,
          cache: "no-store",
        });
        const payload = await parseJsonResponse(response);
        if (!payload) throw new Error("Mitarbeiter konnten nicht geladen werden.");
        if (!response.ok) throw new Error(payload.error ?? "Mitarbeiter konnten nicht geladen werden.");
        if (active) setRecords(sortStaff(payload.data));
      } catch (error) {
        if ((error as Error).name !== "AbortError") console.error(error);
      } finally {
        if (active) setLoading(false);
      }
    }, 250);
    return () => {
      active = false;
      controller.abort();
      window.clearTimeout(timeout);
    };
  }, [locationSlug, search, statusFilter]);

  const filteredRecords = useMemo(() => {
    const term = search.trim().toLowerCase();
    return sortStaff(records).filter((staff) => {
      if (statusFilter !== "all" && staff.status !== statusFilter) return false;
      if (!term) return true;
      const composite = [staff.displayName, staff.firstName, staff.lastName, staff.email, staff.phone]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      return composite.includes(term);
    });
  }, [records, search, statusFilter]);

  const canReorder = !readOnly && !loading && !saving && !isPending && filteredRecords.length > 1;

  const applyOrder = useCallback((orderedIds: string[], fallbackSnapshot: StaffListEntry[]) => {
    setSaving(true);
    setSaveError(null);
    if (successTimer.current) window.clearTimeout(successTimer.current);
    setSaveSuccess(false);
    startTransition(() => {
      reorderStaffAction(locationSlug, orderedIds)
        .then((result) => {
          if (!result.success) {
            throw new Error(result.error);
          }
          setRecords(sortStaff(result.staff));
          setSaveSuccess(true);
          successTimer.current = window.setTimeout(() => setSaveSuccess(false), 4000);
        })
        .catch((error: unknown) => {
          console.error("[staff:reorder] failed", error);
          setSaveError(error instanceof Error ? error.message : "Reihenfolge konnte nicht gespeichert werden.");
          setRecords(sortStaff(fallbackSnapshot));
        })
        .finally(() => {
          setSaving(false);
        });
    });
  }, [locationSlug]);

  const reorderLocally = useCallback((items: StaffListEntry[], sourceId: string, targetId: string) => {
    const sourceIndex = items.findIndex((entry) => entry.id === sourceId);
    const targetIndex = items.findIndex((entry) => entry.id === targetId);
    if (sourceIndex === -1 || targetIndex === -1 || sourceIndex === targetIndex) {
      return null;
    }
    const next = items.map((entry) => ({ ...entry }));
    const [item] = next.splice(sourceIndex, 1);
    next.splice(targetIndex, 0, item);
    next.forEach((entry, index) => {
      entry.calendarOrder = index;
    });
    return next;
  }, []);

  const handleReorder = useCallback((sourceId: string, targetId: string) => {
    setRecords((current) => {
      const next = reorderLocally(current, sourceId, targetId);
      if (!next) {
        return current;
      }
      pendingOrderRef.current = {
        orderedIds: next.map((entry) => entry.id),
        fallback: current.map((entry) => ({ ...entry })),
      };
      return next;
    });
  }, [reorderLocally]);

  const handleDragStart = (event: DragEvent<HTMLLIElement>, id: string) => {
    if (!canReorder) return;
    setDraggingId(id);
    setDropTargetId(id);
    event.dataTransfer?.setData("text/plain", id);
    event.dataTransfer?.setDragImage(event.currentTarget, 10, 10);
  };

  const handleDragEnter = (event: DragEvent<HTMLLIElement>, id: string) => {
    if (!canReorder || !draggingId || id === dropTargetId) return;
    event.preventDefault();
    setDropTargetId(id);
  };

  const handleDragOver = (event: DragEvent<HTMLLIElement>) => {
    if (!canReorder || !draggingId) return;
    event.preventDefault();
    event.dataTransfer!.dropEffect = "move";
  };

const handleDrop = (event: DragEvent<HTMLLIElement>, id: string) => {
  if (!canReorder || !draggingId) return;
  event.preventDefault();
  suppressClickRef.current = true;
  handleReorder(draggingId, id);
  setDraggingId(null);
  setDropTargetId(null);
};

  const handleDragEnd = () => {
    setDraggingId(null);
    setDropTargetId(null);
  };

  const handleLinkClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (draggingId || suppressClickRef.current) {
      event.preventDefault();
      event.stopPropagation();
      suppressClickRef.current = false;
    }
  };

  const moveWithButtons = (id: string, direction: 1 | -1) => {
    if (!canReorder) return;
    const next = records.map((entry) => ({ ...entry }));
    const index = next.findIndex((entry) => entry.id === id);
    const targetIndex = index + direction;
    if (index === -1 || targetIndex < 0 || targetIndex >= next.length) {
      return;
    }
    const [item] = next.splice(index, 1);
    next.splice(targetIndex, 0, item);
    next.forEach((entry, idx) => {
      entry.calendarOrder = idx;
    });
    pendingOrderRef.current = {
      orderedIds: next.map((entry) => entry.id),
      fallback: records.map((entry) => ({ ...entry })),
    };
    setRecords(next);
    suppressClickRef.current = true;
  };

  useEffect(() => {
    const pending = pendingOrderRef.current;
    if (!pending) return;
    pendingOrderRef.current = null;
    applyOrder(pending.orderedIds, pending.fallback);
  }, [records, applyOrder]);

  if (loading && !records.length) {
    return <StaffDirectorySkeleton />;
  }

  return (
    <section className="space-y-6">
      <header className="space-y-2">
        <p className="text-xs uppercase tracking-widest text-zinc-400">Team &amp; Ressourcen</p>
        <div className="flex flex-wrap items-end gap-3">
          <h1 className="text-2xl font-semibold text-zinc-900">Mitarbeiterverwaltung</h1>
          {filteredRecords.length > 0 && (
            <span className="text-sm text-zinc-500">{filteredRecords.length} Teammitglied(er)</span>
          )}
        </div>
        <p className="text-sm text-zinc-500">
          {readOnly
            ? "Mitarbeiter werden zentral verwaltet. Änderungen im Kalender sind deaktiviert."
            : "Wähle ein Teammitglied aus, um Details wie Profilbild, Einsatzstandort oder Leistungen zu pflegen."}
        </p>
        {readOnly && (
          <div className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            {readOnlyReason ?? "Diese Ansicht ist schreibgeschützt. Verwaltung erfolgt zentral."}
          </div>
        )}
      </header>

      <div className="flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
        <div className="flex flex-wrap gap-2">
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.value}
              type="button"
              onClick={() => setStatusFilter(filter.value)}
              className={`rounded-full border px-3 py-1 text-sm transition ${
                statusFilter === filter.value
                  ? "border-zinc-900 bg-zinc-900 text-white"
                  : "border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300 hover:text-zinc-900"
              }`}
            >
              {filter.label}
            </button>
          ))}
        </div>

        <label htmlFor="staff-search" className="flex w-full max-w-sm flex-col gap-1 text-sm text-zinc-600">
          Suche nach Namen
          <div className="flex items-center rounded-full border border-zinc-200 bg-white px-3 py-2 shadow-sm focus-within:border-zinc-400">
            <svg aria-hidden viewBox="0 0 20 20" className="mr-2 h-4 w-4 text-zinc-400">
              <path
                fill="currentColor"
                d="m14.78 13.72 3.5 3.5-.66.66-3.5-3.5a6.5 6.5 0 1 1 .66-.66m-5.78 1.28a5 5 0 1 0 0-10 5 5 0 0 0 0 10"
              />
            </svg>
            <input
              id="staff-search"
              name="staff-search"
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Teammitglied finden…"
              className="w-full bg-transparent text-zinc-900 placeholder:text-zinc-400 focus:outline-none"
            />
          </div>
        </label>
      </div>

      <div className="rounded-2xl border border-zinc-200 bg-white shadow-sm">
        {loading && records.length > 0 && (
          <div className="flex items-center gap-2 border-b border-zinc-100 px-4 py-3 text-sm text-zinc-500">
            <span className="h-2 w-2 animate-pulse rounded-full bg-zinc-400" />
            Aktualisiere …
          </div>
        )}

        {canReorder && (
          <div className="px-6 pb-3 text-xs text-zinc-500">
            Ziehe Teammitglieder per Drag & Drop oder nutze die Pfeile, um die Kalender-Reihenfolge festzulegen.
          </div>
        )}
        {saving && <div className="px-6 pb-3 text-xs text-zinc-500">Reihenfolge wird gespeichert …</div>}
        {saveSuccess && !saving && !saveError && (
          <div className="px-6 pb-3 text-xs text-emerald-600">Reihenfolge gespeichert.</div>
        )}
        {saveError && <div className="px-6 pb-3 text-sm text-red-600">{saveError}</div>}

        {filteredRecords.length ? (
          <ul className="divide-y divide-zinc-100">
            {filteredRecords.map((staff) => {
              const name = (staff.displayName || `${staff.firstName} ${staff.lastName}`).trim();
              const hasColor = Boolean(staff.color);
              const textColor = hasColor ? getReadableTextColor(staff.color!) : "#111827";
              const secondaryColor = hasColor ? toRgba(textColor, textColor === "#ffffff" ? 0.75 : 0.7) : undefined;
              const avatarBackground = hasColor ? toRgba(textColor, 0.18) : undefined;
              const avatarBorder = hasColor ? toRgba(textColor, 0.3) : undefined;
              const isDragged = draggingId === staff.id;
              const isTarget = dropTargetId === staff.id && draggingId !== staff.id;
              return (
                <li
                  key={staff.id}
                  draggable={canReorder}
                  aria-grabbed={canReorder && draggingId === staff.id}
                  onDragStart={(event) => handleDragStart(event, staff.id)}
                  onDragEnter={(event) => handleDragEnter(event, staff.id)}
                  onDragOver={handleDragOver}
                  onDrop={(event) => handleDrop(event, staff.id)}
                  onDragEnd={handleDragEnd}
                  className={`relative transition ${canReorder ? "cursor-grab" : ""}`}
                >
                  {isTarget && <div className="absolute -top-px left-0 right-0 h-0.5 bg-zinc-500" />}
                  {readOnly ? (
                    <div
                      className={`flex items-center justify-between gap-4 px-4 py-4 ${isDragged ? "opacity-60" : ""}`}
                      style={hasColor ? { backgroundColor: staff.color!, color: textColor } : undefined}
                    >
                      <StaffRowContent
                        staff={staff}
                        name={name}
                        hasColor={hasColor}
                        textColor={textColor}
                        secondaryColor={secondaryColor}
                        avatarBackground={avatarBackground}
                        avatarBorder={avatarBorder}
                        canReorder={canReorder}
                        saving={saving}
                        filteredRecords={filteredRecords}
                        moveWithButtons={moveWithButtons}
                      />
                    </div>
                  ) : (
                    <Link
                      href={`/backoffice/${locationSlug}/staff/${staff.id}`}
                      onClick={handleLinkClick}
                      className={`flex items-center justify-between gap-4 px-4 py-4 transition ${
                        hasColor
                          ? "hover:opacity-95 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-white/40"
                          : "hover:bg-zinc-50"
                      } ${isDragged ? "opacity-60" : ""}`}
                      style={hasColor ? { backgroundColor: staff.color!, color: textColor } : undefined}
                    >
                      <StaffRowContent
                        staff={staff}
                        name={name}
                        hasColor={hasColor}
                        textColor={textColor}
                        secondaryColor={secondaryColor}
                        avatarBackground={avatarBackground}
                        avatarBorder={avatarBorder}
                        canReorder={canReorder}
                        saving={saving}
                        filteredRecords={filteredRecords}
                        moveWithButtons={moveWithButtons}
                      />
                    </Link>
                  )}
                </li>
              );
            })}
          </ul>
        ) : (
          <div className="px-6 py-12 text-center">
            <p className="text-lg font-semibold text-zinc-800">Keine Teammitglieder gefunden</p>
            <p className="mt-2 text-sm text-zinc-500">
              {search.trim().length || statusFilter !== "all"
                ? "Passe die Suche oder den Statusfilter an, um weitere Teammitglieder einzublenden."
                : "Die Mitarbeiter werden automatisch aus dem Admin-Dashboard übernommen."}
            </p>
          </div>
        )}
      </div>
    </section>
  );
}

const STATUS_FILTERS: Array<{ value: StaffStatus | "all"; label: string }> = [
  { value: "all", label: "Alle" },
  { value: StaffStatus.ACTIVE, label: "Aktiv" },
  { value: StaffStatus.INVITED, label: "Onboarding" },
  { value: StaffStatus.LEAVE, label: "Abwesend" },
  { value: StaffStatus.INACTIVE, label: "Inaktiv" },
];

function StatusBadge({ status, tone }: { status: StaffStatus; tone?: { text: string } }) {
  if (tone) {
    return (
      <span
        className="inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium"
        style={{
          color: tone.text,
          borderColor: toRgba(tone.text, 0.35),
          backgroundColor: toRgba(tone.text, 0.15),
        }}
      >
        {STATUS_LABELS[status]}
      </span>
    );
  }
  return (
    <span className={`inline-flex items-center rounded-full border px-3 py-1 text-xs font-medium ${STATUS_STYLES[status]}`}>
      {STATUS_LABELS[status]}
    </span>
  );
}

const STATUS_LABELS: Record<StaffStatus, string> = {
  [StaffStatus.ACTIVE]: "Aktiv",
  [StaffStatus.INVITED]: "Onboarding",
  [StaffStatus.LEAVE]: "Abwesend",
  [StaffStatus.INACTIVE]: "Inaktiv",
};

const STATUS_STYLES: Record<StaffStatus, string> = {
  [StaffStatus.ACTIVE]: "bg-emerald-50 text-emerald-700 border-emerald-100",
  [StaffStatus.INVITED]: "bg-sky-50 text-sky-700 border-sky-100",
  [StaffStatus.LEAVE]: "bg-amber-50 text-amber-700 border-amber-100",
  [StaffStatus.INACTIVE]: "bg-zinc-100 text-zinc-600 border-zinc-200",
};

function getInitials(name: string) {
  const parts = name.split(" ").filter(Boolean);
  if (!parts.length) return "TM";
  return parts
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? "")
    .join("")
    || "TM";
}

function StaffRowContent({
  staff,
  name,
  hasColor,
  textColor,
  secondaryColor,
  avatarBackground,
  avatarBorder,
  canReorder,
  saving,
  filteredRecords,
  moveWithButtons,
}: {
  staff: StaffListEntry;
  name: string;
  hasColor: boolean;
  textColor: string;
  secondaryColor: string | undefined;
  avatarBackground: string | undefined;
  avatarBorder: string | undefined;
  canReorder: boolean;
  saving: boolean;
  filteredRecords: StaffListEntry[];
  moveWithButtons: (id: string, direction: 1 | -1) => void;
}) {
  const photoUrl = staff.profileImageUrl;
  return (
    <>
      <div className="flex items-center gap-3">
        <div
          className="flex h-10 w-10 items-center justify-center overflow-hidden rounded-full border text-sm font-semibold"
          style={
            hasColor
              ? {
                  backgroundColor: avatarBackground,
                  borderColor: avatarBorder,
                  color: textColor,
                }
              : undefined
          }
        >
          {photoUrl ? (
            <img src={photoUrl} alt={`${name} Foto`} className="h-full w-full object-cover" loading="lazy" />
          ) : (
            getInitials(name)
          )}
        </div>
        <div>
          <p className="text-sm font-medium" style={hasColor ? { color: textColor } : undefined}>
            {name}
          </p>
          <p className="text-xs" style={hasColor ? { color: secondaryColor } : undefined}>
            {staff.email ?? staff.phone ?? "Keine Kontaktdaten hinterlegt"}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        <StatusBadge status={staff.status} tone={hasColor ? { text: textColor } : undefined} />
        {canReorder && (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                moveWithButtons(staff.id, -1);
              }}
              disabled={saving || filteredRecords[0]?.id === staff.id}
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-500 transition enabled:hover:border-zinc-400 enabled:hover:text-zinc-900 disabled:opacity-40"
              aria-label="Nach oben verschieben"
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={(event) => {
                event.preventDefault();
                event.stopPropagation();
                moveWithButtons(staff.id, 1);
              }}
              disabled={saving || filteredRecords[filteredRecords.length - 1]?.id === staff.id}
              className="inline-flex h-7 w-7 items-center justify-center rounded border border-zinc-300 bg-white text-zinc-500 transition enabled:hover:border-zinc-400 enabled:hover:text-zinc-900 disabled:opacity-40"
              aria-label="Nach unten verschieben"
            >
              <ArrowDown className="h-3.5 w-3.5" />
            </button>
          </div>
        )}
      </div>
    </>
  );
}
