"use client";

import { useEffect, useMemo, useRef, useState, useTransition } from "react";
import { PlusCircle, Layers, X, Loader2, Pencil, Trash2 } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

import { useToast } from "@/components/ui/ToastProvider";
import type {
  ServiceCategoryOption,
  ServiceCreateInput,
  ServiceCreateResult,
  ServiceListEntry,
  StaffOption,
} from "@/types/services";

interface ServiceManagerProps {
  services: ServiceListEntry[];
  staff: StaffOption[];
  categories: ServiceCategoryOption[];
  onCreate: (input: ServiceCreateInput) => Promise<ServiceCreateResult>;
  onUpdate?: (serviceId: string, input: ServiceCreateInput) => Promise<ServiceCreateResult>;
  onDelete?: (serviceId: string) => Promise<ServiceCreateResult>;
  showTillhubFields?: boolean;
}

const durationOptions = Array.from({ length: (240 / 5) }, (_, index) => (index + 1) * 5);
type DrawerMode = { type: "create" } | { type: "edit"; serviceId: string };

export function ServiceManager({
  services,
  staff,
  categories,
  onCreate,
  onUpdate,
  onDelete,
  showTillhubFields = false,
}: ServiceManagerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { pushToast } = useToast();
  const [drawerMode, setDrawerMode] = useState<DrawerMode | null>(null);
  const [isPending, startTransition] = useTransition();

  const [name, setName] = useState("");
  const [price, setPrice] = useState("49.90");
  const [description, setDescription] = useState("");
  const [tagsInput, setTagsInput] = useState("");
  const [duration, setDuration] = useState(45);
  const [priceVisible, setPriceVisible] = useState(true);
  const [showDurationOnline, setShowDurationOnline] = useState(true);
  const [onlineBookable, setOnlineBookable] = useState(true);
  const [tillhubProductId, setTillhubProductId] = useState("");
  const [selectedStaffIds, setSelectedStaffIds] = useState<string[]>([]);
  const [selectedAddOns, setSelectedAddOns] = useState<string[]>([]);
  const [staffDropdownOpen, setStaffDropdownOpen] = useState(false);
  const staffDropdownRef = useRef<HTMLDivElement | null>(null);
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>(categories[0]?.id ?? "");
  const [searchTerm, setSearchTerm] = useState("");
  const [categoryFilterId, setCategoryFilterId] = useState("all");

  const serviceById = useMemo(() => new Map(services.map((service) => [service.id, service])), [services]);
  const drawerOpen = drawerMode !== null;
  const isEditMode = drawerMode?.type === "edit";
  const editingServiceId = drawerMode?.type === "edit" ? drawerMode.serviceId : null;
  const editingAvailable = Boolean(onUpdate);
  const deletionAvailable = Boolean(onDelete);
  const addOnUsageMap = useMemo(() => {
    const map = new Map<string, ServiceListEntry[]>();
    services.forEach((service) => {
      service.addOnServiceIds.forEach((addOnId) => {
        if (addOnId === service.id) return;
        const existing = map.get(addOnId);
        if (existing) {
          if (!existing.some((entry) => entry.id === service.id)) {
            existing.push(service);
          }
        } else {
          map.set(addOnId, [service]);
        }
      });
    });
    return map;
  }, [services]);
  const normalizedSearch = useMemo(() => searchTerm.trim().toLowerCase(), [searchTerm]);
  const visibleServices = useMemo(() => {
    return services.filter((service) => {
      if (categoryFilterId !== "all" && service.category?.id !== categoryFilterId) {
        return false;
      }
      if (!normalizedSearch) return true;
      const nameMatch = service.name.toLowerCase().includes(normalizedSearch);
      const descriptionMatch = service.description?.toLowerCase().includes(normalizedSearch) ?? false;
      return nameMatch || descriptionMatch;
    });
  }, [categoryFilterId, normalizedSearch, services]);
  const availableAddOnServices = useMemo(() => {
    if (!editingServiceId) return services;
    return services.filter((service) => service.id !== editingServiceId);
  }, [services, editingServiceId]);
  const editingAddOnParents = useMemo(() => {
    if (!editingServiceId) return [];
    return addOnUsageMap.get(editingServiceId) ?? [];
  }, [addOnUsageMap, editingServiceId]);
  const categoriesHref = useMemo(
    () => pathname?.replace(/\/services\/?$/, "/categories") ?? "/categories",
    [pathname],
  );

  const handleToggleStaff = (staffId: string) => {
    setSelectedStaffIds((current) =>
      current.includes(staffId) ? current.filter((id) => id !== staffId) : [...current, staffId],
    );
  };

  const handleToggleAllStaff = () => {
    if (selectedStaffIds.length === staff.length) {
      setSelectedStaffIds([]);
    } else {
      setSelectedStaffIds(staff.map((member) => member.id));
    }
  };

  const handleToggleAddOn = (serviceId: string) => {
    if (editingServiceId && serviceId === editingServiceId) {
      return;
    }
    setSelectedAddOns((current) =>
      current.includes(serviceId) ? current.filter((id) => id !== serviceId) : [...current, serviceId],
    );
  };

  const resetForm = () => {
    setName("");
    setPrice("49.90");
    setDescription("");
    setTagsInput("");
    setDuration(45);
    setPriceVisible(true);
    setShowDurationOnline(true);
    setOnlineBookable(true);
    setTillhubProductId("");
    setSelectedStaffIds([]);
    setSelectedAddOns([]);
    setStaffDropdownOpen(false);
    setSelectedCategoryId(categories[0]?.id ?? "");
  };

  const openCreateDrawer = () => {
    resetForm();
    setDrawerMode({ type: "create" });
  };

  const openEditDrawer = (serviceId: string) => {
    if (!onUpdate) {
      pushToast({ variant: "error", message: "Bearbeiten ist derzeit nicht verfügbar." });
      return;
    }
    const service = serviceById.get(serviceId);
    if (!service) {
      pushToast({ variant: "error", message: "Leistung wurde nicht gefunden." });
      return;
    }
    setName(service.name);
    setPrice(service.price.toFixed(2));
    setDescription(service.description ?? "");
    setTagsInput(service.tags.join(", "));
    setDuration(service.duration);
    setPriceVisible(service.priceVisible);
    setShowDurationOnline(service.showDurationOnline);
    setOnlineBookable(service.onlineBookable);
    setTillhubProductId(service.tillhubProductId ?? "");
    setSelectedStaffIds(service.staffIds);
    setSelectedAddOns(service.addOnServiceIds.filter((id) => id !== service.id));
    setSelectedCategoryId(service.category?.id ?? categories[0]?.id ?? "");
    setDrawerMode({ type: "edit", serviceId });
  };

  const closeDrawer = () => {
    if (isPending) return;
    setDrawerMode(null);
    resetForm();
  };

  const handleSubmit = () => {
    if (drawerMode?.type === "edit" && !onUpdate) {
      pushToast({ variant: "error", message: "Bearbeiten ist derzeit nicht verfügbar." });
      return;
    }
    if (!drawerMode) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      pushToast({ variant: "error", message: "Bitte einen Namen eingeben." });
      return;
    }
    const numericPrice = Number.parseFloat(price.replace(",", "."));
    if (!Number.isFinite(numericPrice) || numericPrice < 0) {
      pushToast({ variant: "error", message: "Bitte einen gültigen Preis eingeben." });
      return;
    }
    if (!selectedCategoryId) {
      pushToast({ variant: "error", message: "Bitte eine Kategorie auswählen." });
      return;
    }

    startTransition(async () => {
      const tags = tagsInput
        .split(",")
        .map((tag) => tag.trim())
        .filter((tag) => tag.length > 0);
      const payload: ServiceCreateInput = {
        name: trimmedName,
        price: Number(numericPrice.toFixed(2)),
        description: description.trim() || undefined,
        duration,
        staffIds: selectedStaffIds,
        priceVisible,
        showDurationOnline,
        onlineBookable,
        tillhubProductId: showTillhubFields ? normalizeId(tillhubProductId) : undefined,
        addOnServiceIds: selectedAddOns,
        categoryId: selectedCategoryId,
        tags,
      };

      const result =
        drawerMode.type === "edit" && onUpdate
          ? await onUpdate(drawerMode.serviceId, payload)
          : await onCreate(payload);
      if (!result.success) {
        pushToast({ variant: "error", message: result.error });
        return;
      }
      pushToast({
        variant: "success",
        message: drawerMode.type === "edit" ? "Leistung aktualisiert." : "Leistung erstellt.",
      });
      resetForm();
      setDrawerMode(null);
      router.refresh();
    });
  };

  useEffect(() => {
    if (!staffDropdownOpen) return undefined;
    const handler = (event: MouseEvent) => {
      if (staffDropdownRef.current && !staffDropdownRef.current.contains(event.target as Node)) {
        setStaffDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handler);
    return () => document.removeEventListener("mousedown", handler);
  }, [staffDropdownOpen]);

  useEffect(() => {
    if (!editingServiceId) return;
    setSelectedAddOns((current) => current.filter((id) => id !== editingServiceId));
  }, [editingServiceId]);

  useEffect(() => {
    const validIds = new Set(services.map((service) => service.id));
    setSelectedAddOns((current) => current.filter((id) => validIds.has(id)));
  }, [services]);

  const selectedStaff = staff.filter((member) => selectedStaffIds.includes(member.id));
  const allStaffSelected = staff.length > 0 && selectedStaffIds.length === staff.length;
  const canCreate = categories.length > 0;

  useEffect(() => {
    if (!drawerOpen) return;
    if (!categories.length) {
      setSelectedCategoryId("");
      return;
    }
    setSelectedCategoryId((current) => {
      if (current && categories.some((category) => category.id === current)) {
        return current;
      }
      return categories[0].id;
    });
  }, [drawerOpen, categories]);

  useEffect(() => {
    if (drawerOpen) return;
    if (!categories.length) {
      setSelectedCategoryId("");
      return;
    }
    setSelectedCategoryId((current) =>
      current && categories.some((category) => category.id === current) ? current : categories[0].id,
    );
  }, [categories, drawerOpen]);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-zinc-900">Leistungen verwalten</h2>
        <button
          type="button"
          onClick={() => {
            if (!canCreate) return;
            openCreateDrawer();
          }}
          disabled={!canCreate}
          className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-500"
        >
          <PlusCircle className="h-4 w-4" /> Erfassen
        </button>
      </div>

      {!canCreate && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
          <span>Bitte erstelle zunaechst mindestens eine Kategorie, bevor du Leistungen erfasst.</span>{" "}
          <Link href={categoriesHref} className="font-semibold text-amber-900 underline decoration-amber-400">
            Zu den Kategorien
          </Link>
        </div>
      )}

      {services.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 bg-white/80 px-6 py-12 text-center text-sm text-zinc-500">
          Noch keine Leistungen angelegt. Klicke auf <span className="font-semibold">Erfassen</span>, um zu starten.
        </div>
      ) : (
        <>
          <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_260px]">
            <div className="space-y-1">
              <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="service-search">
                Suche
              </label>
              <input
                id="service-search"
                type="search"
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="Service suchen…"
                className="h-11 w-full rounded-lg border border-zinc-300 px-3 text-sm text-zinc-700 shadow-sm focus:border-zinc-500 focus:outline-none"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="service-category-filter">
                Kategorie
              </label>
              <select
                id="service-category-filter"
                value={categoryFilterId}
                onChange={(event) => setCategoryFilterId(event.target.value)}
                className="h-11 w-full rounded-lg border border-zinc-300 bg-white px-3 text-sm text-zinc-700 shadow-sm focus:border-zinc-500 focus:outline-none"
              >
                <option value="all">Alle Kategorien</option>
                {categories.map((category) => (
                  <option key={category.id} value={category.id}>
                    {category.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          {(searchTerm.trim().length > 0 || categoryFilterId !== "all") && (
            <div>
              <button
                type="button"
                onClick={() => {
                  setSearchTerm("");
                  setCategoryFilterId("all");
                }}
                className="min-h-[44px] text-sm font-semibold text-zinc-600 underline decoration-zinc-300 underline-offset-4 hover:text-zinc-800"
              >
                Filter zurücksetzen
              </button>
            </div>
          )}
          {visibleServices.length === 0 ? (
            <div className="rounded-xl border border-dashed border-zinc-200 bg-white/80 px-6 py-10 text-center text-sm text-zinc-500">
              Keine Leistungen gefunden.
            </div>
          ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {visibleServices.map((service) => {
            const assigned = service.staffIds
              .map((id) => staff.find((entry) => entry.id === id))
              .filter(Boolean) as StaffOption[];
            const usedAsAddOnBy = addOnUsageMap.get(service.id) ?? [];
            return (
              <article key={service.id} className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
                <header className="flex items-start justify-between gap-3">
                  <div>
                    <h3 className="text-lg font-semibold text-zinc-900">{service.name}</h3>
                    {service.description && (
                      <p className="mt-1 text-sm text-zinc-600">{service.description}</p>
                    )}
                    {(service.category || usedAsAddOnBy.length > 0) && (
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        {service.category && (
                          <span className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-widest text-zinc-600">
                            <Layers className="h-3 w-3" /> {service.category.name}
                          </span>
                        )}
                        {usedAsAddOnBy.length > 0 && (
                          <span className="inline-flex items-center gap-2 rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] font-semibold uppercase tracking-widest text-amber-700">
                            <Layers className="h-3 w-3" /> Add-on
                          </span>
                        )}
                      </div>
                    )}
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-semibold text-zinc-700">
                      {service.priceVisible
                        ? new Intl.NumberFormat("de-DE", {
                            style: "currency",
                            currency: "EUR",
                          }).format(service.price)
                        : "Preis verborgen"}
                    </span>
                    {(editingAvailable || deletionAvailable) && (
                      <div className="flex items-center gap-1">
                        {editingAvailable && (
                          <button
                            type="button"
                            onClick={() => openEditDrawer(service.id)}
                            disabled={isPending}
                            className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed"
                          >
                            <Pencil className="h-3 w-3" /> Bearbeiten
                          </button>
                        )}
                        {deletionAvailable && (
                          <button
                            type="button"
                            onClick={() => {
                              if (isPending) return;
                              if (!onDelete) {
                                pushToast({ variant: "error", message: "Löschen ist derzeit nicht verfügbar." });
                                return;
                              }
                              const confirmed = window.confirm(
                                `Leistung "${service.name}" wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.`,
                              );
                              if (!confirmed) {
                                return;
                              }
                              startTransition(async () => {
                                const result = await onDelete(service.id);
                                if (!result.success) {
                                  pushToast({ variant: "error", message: result.error });
                                  return;
                                }
                                pushToast({ variant: "success", message: "Leistung gelöscht." });
                                if (drawerMode?.type === "edit" && drawerMode.serviceId === service.id) {
                                  resetForm();
                                  setDrawerMode(null);
                                }
                                router.refresh();
                              });
                            }}
                            disabled={isPending}
                            className="inline-flex items-center gap-1 rounded-full border border-rose-200 px-3 py-1 text-xs font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed"
                          >
                            <Trash2 className="h-3 w-3" /> Löschen
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </header>

                <dl className="mt-4 grid gap-2 text-xs text-zinc-600">
                  <div className="flex justify-between">
                    <dt>Dauer</dt>
                    <dd>{service.duration} Min.</dd>
                  </div>
                  <div className="flex justify-between">
                    <dt>Online buchbar</dt>
                    <dd>{service.onlineBookable ? "Ja" : "Nein"}</dd>
                  </div>
                  {usedAsAddOnBy.length > 0 && (
                    <div>
                      <dt className="font-medium text-zinc-700">Als Add-on in</dt>
                      <dd className="mt-1 flex flex-wrap gap-2">
                        {usedAsAddOnBy.map((parent) => (
                          <span
                            key={parent.id}
                            className="inline-flex items-center gap-1 rounded-full border border-amber-200 bg-amber-50 px-2 py-1 text-[11px] text-amber-700"
                          >
                            <Layers className="h-3 w-3" /> {parent.name}
                          </span>
                        ))}
                      </dd>
                    </div>
                  )}
                  <div>
                    <dt className="font-medium text-zinc-700">Mitarbeiter:innen</dt>
                    {assigned.length === 0 ? (
                      <dd className="mt-1 text-zinc-500">Noch keiner zugewiesen.</dd>
                    ) : (
                      <dd className="mt-1 flex flex-wrap gap-2">
                        {assigned.map((member) => (
                          <span
                            key={member.id}
                            className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-600"
                          >
                            <span
                              className="h-2 w-2 rounded-full"
                              style={{ backgroundColor: member.color }}
                            />
                            {member.name}
                          </span>
                        ))}
                      </dd>
                    )}
                  </div>
                  {service.addOnServiceIds.length > 0 && (
                    <div>
                      <dt className="font-medium text-zinc-700">Zusatzleistungen</dt>
                      <dd className="mt-1 flex flex-wrap gap-2">
                        {service.addOnServiceIds
                          .map((id) => serviceById.get(id))
                          .filter(Boolean)
                          .map((addOn) => (
                            <span
                              key={addOn!.id}
                              className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-[11px] text-zinc-600"
                            >
                              <Layers className="h-3 w-3" /> {addOn!.name}
                            </span>
                          ))}
                      </dd>
                    </div>
                  )}
                  {service.tags.length > 0 && (
                    <div>
                      <dt className="font-medium text-zinc-700">Tags</dt>
                      <dd className="mt-1 flex flex-wrap gap-2">
                        {service.tags.map((tag) => (
                          <span
                            key={tag}
                            className="inline-flex items-center rounded-full border border-zinc-200 bg-white px-2 py-0.5 text-[11px] text-zinc-600"
                          >
                            #{tag}
                          </span>
                        ))}
                      </dd>
                    </div>
                  )}
                </dl>

                <footer className="mt-4 text-[11px] text-zinc-400">
                  Aktualisiert: {new Date(service.updatedAt).toLocaleDateString("de-DE")}
                </footer>
              </article>
            );
          })}
        </div>
          )}
        </>
      )}

      {drawerOpen && (
        <div
          className="fixed inset-0 z-[1400] flex justify-end bg-black/40"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeDrawer();
            }
          }}
        >
          <div className="flex h-full w-full max-w-lg flex-col rounded-l-3xl border border-zinc-200 bg-white shadow-2xl">
            <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900 text-white">
                  <Layers className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-xs uppercase tracking-widest text-zinc-400">
                    {isEditMode ? "Leistung" : "Neue Leistung"}
                  </p>
                  <h2 className="text-2xl font-semibold text-zinc-900">
                    {isEditMode ? "Leistung bearbeiten" : "Leistung erfassen"}
                  </h2>
                  <p className="text-sm text-zinc-500">
                    {isEditMode
                      ? "Aktualisiere Details, Preise und Zuständigkeiten."
                      : `Lege Leistungen für ${staff.length > 0 ? "dein Team" : "deinen Standort"} an.`}
                  </p>
                </div>
              </div>
              <button
                type="button"
                className="rounded-full border border-zinc-300 p-2 text-zinc-500 transition hover:bg-zinc-100"
                onClick={() => {
                  closeDrawer();
                }}
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="space-y-6">
                <section className="space-y-3">
                  <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="service-name">
                    Name
                  </label>
                  <input
                    id="service-name"
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    placeholder="z. B. Haarschnitt"
                    disabled={isPending}
                  />
                </section>

                {categories.length > 0 ? (
                  <section className="space-y-3">
                    <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="service-category">
                      Kategorie
                    </label>
                    <select
                      id="service-category"
                      value={selectedCategoryId}
                      onChange={(event) => setSelectedCategoryId(event.target.value)}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      disabled={isPending}
                    >
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </section>
                ) : (
                  <section className="rounded-lg border border-dashed border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-500">
                    Noch keine Kategorien vorhanden. Erstelle zuerst eine Kategorie.
                  </section>
                )}

                <section className="grid gap-4 md:grid-cols-2">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="service-price">
                      Grundpreis
                    </label>
                    <input
                      id="service-price"
                      type="number"
                      step="0.01"
                      min="0"
                      value={price}
                      onChange={(event) => setPrice(event.target.value)}
                      className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      placeholder="49.90"
                      disabled={isPending}
                    />
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="service-duration">
                      Grunddauer
                    </label>
                    <select
                      id="service-duration"
                      value={duration}
                      onChange={(event) => setDuration(Number(event.target.value))}
                      className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      disabled={isPending}
                    >
                      {durationOptions.map((minutes) => (
                        <option key={minutes} value={minutes}>
                          {minutes} Minuten
                        </option>
                      ))}
                    </select>
                  </div>
                </section>

                <section className="space-y-3">
                  <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="service-description">
                    Beschreibung
                  </label>
                  <textarea
                    id="service-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={4}
                    placeholder="Kurzbeschreibung der Leistung"
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    disabled={isPending}
                  />
                </section>

                <section className="space-y-2">
                  <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="service-tags">
                    Tags (optional)
                  </label>
                  <input
                    id="service-tags"
                    type="text"
                    value={tagsInput}
                    onChange={(event) => setTagsInput(event.target.value)}
                    placeholder="z. B. balayage, farbe, kurzhaar"
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    disabled={isPending}
                  />
                  <p className="text-xs text-zinc-500">Kommagetrennte Suchbegriffe für die Leistungssuche im Kalender.</p>
                </section>

                {showTillhubFields && (
                  <section className="space-y-2">
                    <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="service-tillhub">
                      Tillhub Produkt-ID (optional)
                    </label>
                    <input
                      id="service-tillhub"
                      type="text"
                      value={tillhubProductId}
                      onChange={(event) => setTillhubProductId(event.target.value)}
                      placeholder="z. B. 3aa17d4e-347e-495a-b5c1-bc56290f219b"
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      disabled={isPending}
                    />
                    <p className="text-xs text-zinc-500">
                      Hinterlege die Tillhub Produkt-ID damit der Artikel in geparkte Vorgänge auf dem iPad erscheint.
                      Die ID findest du in der Adresszeile vom Tillhub-Dashboard, Artikel bearbeiten.
                    </p>
                  </section>
                )}

                <section className="space-y-3">
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="service-voucher">
                      Gutscheincode abfragen
                    </label>
                    <select
                      id="service-voucher"
                      className="mt-2 w-full rounded-md border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm text-zinc-500"
                      disabled
                    >
                      <option>Ohne Gutschein (folgt später)</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="service-tax">
                      Steuerart
                    </label>
                    <select
                      id="service-tax"
                      className="mt-2 w-full rounded-md border border-zinc-200 bg-zinc-100 px-3 py-2 text-sm text-zinc-500"
                      disabled
                    >
                      <option>Keine Steuer hinterlegt (folgt später)</option>
                    </select>
                  </div>
                </section>

                <section className="space-y-2 rounded-lg border border-zinc-200 bg-zinc-50 px-4 py-3">
                  <label className="flex items-start gap-2 text-sm text-zinc-700">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                      checked={priceVisible}
                      onChange={(event) => setPriceVisible(event.target.checked)}
                      disabled={isPending}
                    />
                    <span>
                      Preis bei der Online-Buchung anzeigen
                      <span className="block text-xs text-zinc-500">
                        Wenn aktiviert, ist der Preis auf der Online-Buchungsseite sichtbar. Deaktiviere die Option für individuelle Preisgestaltung vor Ort.
                      </span>
                    </span>
                  </label>
                  <label className="flex items-start gap-2 text-sm text-zinc-700">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                      checked={showDurationOnline}
                      onChange={(event) => setShowDurationOnline(event.target.checked)}
                      disabled={isPending}
                    />
                    <span>Leistungsdauer bei der Onlinebuchung anzeigen</span>
                  </label>
                  <label className="flex items-start gap-2 text-sm text-zinc-700">
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                      checked={onlineBookable}
                      onChange={(event) => setOnlineBookable(event.target.checked)}
                      disabled={isPending}
                    />
                    <span>Leistung bei der Online-Buchung anzeigen</span>
                  </label>
                </section>

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-zinc-900">Mitarbeiterauswahl</h3>
                  {staff.length === 0 ? (
                    <p className="text-xs text-zinc-500">Noch keine Mitarbeitenden vorhanden.</p>
                  ) : (
                    <div ref={staffDropdownRef} className="relative">
                      <div
                        role="button"
                        tabIndex={0}
                        onClick={() => {
                          if (!isPending) setStaffDropdownOpen((prev) => !prev);
                        }}
                        onKeyDown={(event) => {
                          if ((event.key === "Enter" || event.key === " ") && !isPending) {
                            event.preventDefault();
                            setStaffDropdownOpen((prev) => !prev);
                          }
                        }}
                        className={`min-h-[44px] w-full cursor-pointer rounded-md border px-3 py-2 text-sm transition focus:outline-none focus:ring-2 focus:ring-zinc-900/10 ${
                          staffDropdownOpen ? "border-zinc-900 shadow-sm" : "border-zinc-300 hover:border-zinc-400"
                        }`}
                      >
                        {selectedStaff.length === 0 ? (
                          <span className="text-zinc-500">Mitarbeiter auswählen</span>
                        ) : (
                          <div className="flex flex-wrap items-center gap-2">
                            {selectedStaff.slice(0, 2).map((member) => (
                              <span
                                key={member.id}
                                className="inline-flex items-center gap-2 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-700"
                              >
                                <span
                                  className="h-2 w-2 rounded-full"
                                  style={{ backgroundColor: member.color }}
                                />
                                {member.name}
                                <button
                                  type="button"
                                  onClick={(event) => {
                                    event.stopPropagation();
                                    if (!isPending) handleToggleStaff(member.id);
                                  }}
                                  className="ml-1 text-[10px] text-zinc-400 transition hover:text-zinc-600"
                                >
                                  ×
                                </button>
                              </span>
                            ))}
                            {selectedStaff.length > 2 && (
                              <span className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-600">
                                + {selectedStaff.length - 2} Mitarbeiter
                              </span>
                            )}
                          </div>
                        )}
                      </div>

                      {staffDropdownOpen && (
                        <div className="absolute z-[1500] mt-2 w-full rounded-lg border border-zinc-200 bg-white shadow-xl">
                          <button
                            type="button"
                            onClick={() => {
                              if (!isPending) handleToggleAllStaff();
                            }}
                            className="flex w-full items-center justify-between rounded-t-lg px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-50"
                          >
                            <span className="flex items-center gap-2">
                              <span
                                className={`flex h-4 w-4 items-center justify-center rounded border ${
                                  allStaffSelected ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 text-transparent"
                                }`}
                              >
                                ✓
                              </span>
                              Alle Mitarbeiter
                            </span>
                            <span className="text-xs text-zinc-400">{staff.length}</span>
                          </button>
                          <div className="max-h-56 overflow-y-auto border-t border-zinc-100">
                            {staff.map((member) => {
                              const selected = selectedStaffIds.includes(member.id);
                              return (
                                <button
                                  type="button"
                                  key={member.id}
                                  onClick={() => {
                                    if (!isPending) handleToggleStaff(member.id);
                                  }}
                                  className="flex w-full items-center gap-2 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-50"
                                >
                                  <span
                                    className={`flex h-4 w-4 items-center justify-center rounded border ${
                                      selected ? "border-zinc-900 bg-zinc-900 text-white" : "border-zinc-300 text-transparent"
                                    }`}
                                  >
                                    ✓
                                  </span>
                                  <span className="flex items-center gap-2">
                                    <span
                                      className="h-2 w-2 rounded-full"
                                      style={{ backgroundColor: member.color }}
                                    />
                                    {member.name}
                                  </span>
                                </button>
                              );
                            })}
                          </div>
                        </div>
                      )}
                    </div>
                  )}
                </section>

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-zinc-900">Zusatzleistungen</h3>
                  <p className="text-xs text-zinc-500">
                    Stelle sicher, dass mehrere Services pro Buchung in den Einstellungen aktiviert sind, um Zusatzleistungen im Buchungsprozess anzubieten.
                  </p>
                  {editingAddOnParents.length > 0 && (
                    <p className="text-xs text-amber-700">
                      Diese Leistung ist aktuell als Zusatzleistung in:{" "}
                      {editingAddOnParents.map((parent) => parent.name).join(", ")}.
                    </p>
                  )}
                  {availableAddOnServices.length === 0 ? (
                    <p className="text-xs text-zinc-500">Noch keine weiteren Leistungen vorhanden.</p>
                  ) : (
                    <div className="grid gap-2">
                      {availableAddOnServices.map((service) => {
                        const selected = selectedAddOns.includes(service.id);
                        return (
                          <label
                            key={service.id}
                            className={`flex items-center justify-between rounded-lg border px-3 py-2 text-sm transition ${
                              selected ? "border-zinc-900 bg-zinc-100" : "border-zinc-200 hover:border-zinc-400"
                            }`}
                          >
                            <span>{service.name}</span>
                            <input
                              type="checkbox"
                              checked={selected}
                              onChange={() => handleToggleAddOn(service.id)}
                              className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                              disabled={isPending}
                            />
                          </label>
                        );
                      })}
                    </div>
                  )}
                </section>

                <section className="space-y-3">
                  <h3 className="text-sm font-semibold text-zinc-900">Ressourcen</h3>
                  <p className="text-xs text-zinc-500">Ressourcenmanagement wird in einer späteren Iteration ergänzt.</p>
                </section>
              </div>
            </div>

            <footer className="flex items-center justify-between border-t border-zinc-200 px-6 py-4">
              <button
                type="button"
                onClick={closeDrawer}
                className="rounded-full border border-zinc-300 px-4 py-2 text-sm text-zinc-600 transition hover:bg-zinc-100"
              >
                Abbrechen
              </button>
              <button
                type="button"
                onClick={handleSubmit}
                disabled={isPending}
                className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-500"
              >
                {isPending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> {isEditMode ? "Aktualisieren …" : "Speichern …"}
                  </>
                ) : (
                  (isEditMode ? "Aktualisieren" : "Erstellen")
                )}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}

function normalizeId(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
