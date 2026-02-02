"use client";

import Link from "next/link";
import { useState, useTransition } from "react";
import { Loader2, Pencil, PlusCircle, Tag, Trash2, X } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";

import { useToast } from "@/components/ui/ToastProvider";
import type {
  ServiceCategoryCreateInput,
  ServiceCategoryCreateResult,
  ServiceCategoryListEntry,
} from "@/types/services";

interface CategoryManagerProps {
  categories: ServiceCategoryListEntry[];
  onCreate: (input: ServiceCategoryCreateInput) => Promise<ServiceCategoryCreateResult>;
  onUpdate?: (categoryId: string, input: ServiceCategoryCreateInput) => Promise<ServiceCategoryCreateResult>;
  onDelete?: (categoryId: string) => Promise<ServiceCategoryCreateResult>;
}

export function CategoryManager({ categories, onCreate, onUpdate, onDelete }: CategoryManagerProps) {
  const router = useRouter();
  const pathname = usePathname();
  const { pushToast } = useToast();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [drawerMode, setDrawerMode] = useState<null | { type: "create" } | { type: "edit"; categoryId: string }>(null);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#4b5563");
  const [isPending, startTransition] = useTransition();
  const isEditMode = drawerMode?.type === "edit";

  const resetForm = () => {
    setName("");
    setDescription("");
    setColor("#4b5563");
  };

  const openCreate = () => {
    resetForm();
    setDrawerMode({ type: "create" });
    setDrawerOpen(true);
  };

  const openEdit = (category: ServiceCategoryListEntry) => {
    if (!onUpdate) return;
    setName(category.name);
    setDescription(category.description ?? "");
    setColor(category.color ?? "#4b5563");
    setDrawerMode({ type: "edit", categoryId: category.id });
    setDrawerOpen(true);
  };

  const handleDelete = (category: ServiceCategoryListEntry) => {
    if (!onDelete || isPending) return;
    const confirmed = window.confirm(
      "Wenn die Kategorie gelöscht wird, werden auch die darin enthaltenen Leistungen gelöscht. Willst Du wirklich löschen?",
    );
    if (!confirmed) return;

    startTransition(async () => {
      const result = await onDelete(category.id);
      if (!result.success) {
        pushToast({ variant: "error", message: result.error });
        return;
      }
      pushToast({ variant: "success", message: "Kategorie gelöscht." });
      setDrawerOpen(false);
      setDrawerMode(null);
      router.refresh();
    });
  };

  const handleSubmit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      pushToast({ variant: "error", message: "Bitte einen Kategorienamen eingeben." });
      return;
    }

    startTransition(async () => {
      const payload = {
        name: trimmedName,
        description: description.trim() || undefined,
        color,
      };
      const result =
        isEditMode && onUpdate && drawerMode
          ? await onUpdate(drawerMode.categoryId, payload)
          : await onCreate(payload);
      if (!result.success) {
        pushToast({ variant: "error", message: result.error });
        return;
      }
      pushToast({ variant: "success", message: isEditMode ? "Kategorie aktualisiert." : "Kategorie erstellt." });
      resetForm();
      setDrawerOpen(false);
      setDrawerMode(null);
      router.refresh();
    });
  };
  const servicesHref = pathname?.replace(/\/categories\/?$/, "/services") ?? "/services";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <h2 className="text-xl font-semibold text-zinc-900">Kategorien</h2>
          {categories.length > 0 ? (
            <Link href={servicesHref} className="text-sm font-semibold text-zinc-600 hover:text-zinc-900 underline">
              Zu den Leistungen
            </Link>
          ) : null}
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800"
        >
          <PlusCircle className="h-4 w-4" /> Kategorie anlegen
        </button>
      </div>

      {categories.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 bg-white/80 px-6 py-12 text-center text-sm text-zinc-500">
          Noch keine Kategorien vorhanden. Lege deine erste Kategorie an, um Leistungen zu gruppieren.
        </div>
      ) : (
        <div className="grid gap-4 lg:grid-cols-2">
          {categories.map((category) => (
            <article key={category.id} className="rounded-xl border border-zinc-200 bg-white p-5 shadow-sm">
              <header className="flex items-start justify-between gap-3">
                <div>
                  <h3 className="text-lg font-semibold text-zinc-900">{category.name}</h3>
                  {category.description && (
                    <p className="mt-1 text-sm text-zinc-600">{category.description}</p>
                  )}
                </div>
                <div className="flex flex-col items-end gap-2">
                  <span className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-600">
                    <Tag className="h-3 w-3" /> {category.slug}
                  </span>
                  {onUpdate ? (
                    <button
                      type="button"
                      onClick={() => openEdit(category)}
                      className="inline-flex items-center gap-1 rounded-full border border-zinc-200 px-2 py-1 text-xs font-semibold text-zinc-600 transition hover:border-zinc-300 hover:text-zinc-900"
                    >
                      <Pencil className="h-3 w-3" /> Bearbeiten
                    </button>
                  ) : null}
                  {onDelete ? (
                    <button
                      type="button"
                      onClick={() => handleDelete(category)}
                      className="inline-flex items-center gap-1 rounded-full border border-rose-200 px-2 py-1 text-xs font-semibold text-rose-600 transition hover:border-rose-300 hover:text-rose-700"
                    >
                      <Trash2 className="h-3 w-3" /> Löschen
                    </button>
                  ) : null}
                </div>
              </header>
              <footer className="mt-4 flex items-center justify-between text-xs text-zinc-500">
                <span>{category.serviceCount} Leistungen</span>
                <span>Aktualisiert: {new Date(category.updatedAt).toLocaleDateString("de-DE")}</span>
              </footer>
            </article>
          ))}
        </div>
      )}

      {drawerOpen && (
        <div
          className="fixed inset-0 z-[1400] flex justify-end bg-black/40"
          onClick={(event) => {
            if (event.target === event.currentTarget && !isPending) {
              setDrawerOpen(false);
              setDrawerMode(null);
            }
          }}
        >
          <div className="flex h-full w-full max-w-md flex-col rounded-l-3xl border border-zinc-200 bg-white shadow-2xl">
            <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
              <div className="flex items-center gap-2">
                <span className="flex h-9 w-9 items-center justify-center rounded-full bg-zinc-900 text-white">
                  <Tag className="h-4 w-4" />
                </span>
                <div>
                  <p className="text-xs uppercase tracking-widest text-zinc-400">
                    {isEditMode ? "Kategorie bearbeiten" : "Neue Kategorie"}
                  </p>
                  <h2 className="text-2xl font-semibold text-zinc-900">
                    {isEditMode ? "Kategorie bearbeiten" : "Kategorie anlegen"}
                  </h2>
                </div>
              </div>
              <button
                type="button"
                className="rounded-full border border-zinc-300 p-2 text-zinc-500 transition hover:bg-zinc-100"
                onClick={() => {
                  if (!isPending) {
                    setDrawerOpen(false);
                    setDrawerMode(null);
                  }
                }}
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="space-y-6">
                <section className="space-y-3">
                  <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="category-name">
                    Name
                  </label>
                  <input
                    id="category-name"
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    placeholder="z. B. Herren"
                    disabled={isPending}
                  />
                </section>

                <section className="space-y-3">
                  <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="category-description">
                    Beschreibung
                  </label>
                  <textarea
                    id="category-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={4}
                    placeholder="Optionale Beschreibung"
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    disabled={isPending}
                  />
                </section>

                <section className="space-y-3">
                  <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="category-color">
                    Farbe
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      id="category-color"
                      type="color"
                      value={color}
                      onChange={(event) => setColor(event.target.value)}
                      className="h-10 w-16 rounded border border-zinc-200"
                      disabled={isPending}
                    />
                    <span className="text-xs text-zinc-500">Optional, z. B. für spätere Farbcodierungen.</span>
                  </div>
                </section>
              </div>
            </div>

            <footer className="flex items-center justify-between border-t border-zinc-200 px-6 py-4">
              <button
                type="button"
                onClick={() => {
                  if (!isPending) {
                    setDrawerOpen(false);
                    resetForm();
                    setDrawerMode(null);
                  }
                }}
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
                    <Loader2 className="h-4 w-4 animate-spin" /> Speichern …
                  </>
                ) : (
                  isEditMode ? "Speichern" : "Erstellen"
                )}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
