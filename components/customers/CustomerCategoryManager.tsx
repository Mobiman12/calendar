"use client";

import { useState, useTransition } from "react";
import { Loader2, PlusCircle, Tag, X } from "lucide-react";
import { useRouter } from "next/navigation";

import { useToast } from "@/components/ui/ToastProvider";
import type {
  CustomerCategoryCreateInput,
  CustomerCategoryCreateResult,
  CustomerCategoryListEntry,
} from "@/types/customers";

interface CustomerCategoryManagerProps {
  categories: CustomerCategoryListEntry[];
  onCreate: (input: CustomerCategoryCreateInput) => Promise<CustomerCategoryCreateResult>;
}

export function CustomerCategoryManager({ categories, onCreate }: CustomerCategoryManagerProps) {
  const router = useRouter();
  const { pushToast } = useToast();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [color, setColor] = useState("#2563eb");
  const [isPending, startTransition] = useTransition();

  const resetForm = () => {
    setName("");
    setDescription("");
    setColor("#2563eb");
  };

  const handleSubmit = () => {
    const trimmedName = name.trim();
    if (!trimmedName) {
      pushToast({ variant: "error", message: "Bitte einen Kategorienamen eingeben." });
      return;
    }

    startTransition(async () => {
      const result = await onCreate({
        name: trimmedName,
        description: description.trim() || undefined,
        color,
      });
      if (!result.success) {
        pushToast({ variant: "error", message: result.error });
        return;
      }
      pushToast({ variant: "success", message: "Kundenkategorie erstellt." });
      resetForm();
      setDrawerOpen(false);
      router.refresh();
    });
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-xl font-semibold text-zinc-900">Kundenkategorien</h2>
        <button
          type="button"
          onClick={() => setDrawerOpen(true)}
          className="inline-flex items-center gap-2 rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800"
        >
          <PlusCircle className="h-4 w-4" /> Kategorie anlegen
        </button>
      </div>

      {categories.length === 0 ? (
        <div className="rounded-xl border border-dashed border-zinc-200 bg-white/80 px-6 py-12 text-center text-sm text-zinc-500">
          Noch keine Kundenkategorien vorhanden. Lege deine erste Kategorie an, um Kund:innen zu segmentieren.
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
                <span className="inline-flex items-center gap-1 rounded-full border border-zinc-200 bg-zinc-50 px-2 py-1 text-xs text-zinc-600">
                  <Tag className="h-3 w-3" /> {category.slug}
                </span>
              </header>
              <footer className="mt-4 flex items-center justify-between text-xs text-zinc-500">
                <span>{category.customerCount} Kund:innen</span>
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
                  <p className="text-xs uppercase tracking-widest text-zinc-400">Neue Kundenkategorie</p>
                  <h2 className="text-2xl font-semibold text-zinc-900">Kategorie anlegen</h2>
                </div>
              </div>
              <button
                type="button"
                className="rounded-full border border-zinc-300 p-2 text-zinc-500 transition hover:bg-zinc-100"
                onClick={() => {
                  if (!isPending) {
                    setDrawerOpen(false);
                  }
                }}
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="space-y-6">
                <section className="space-y-3">
                  <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="customer-category-name">
                    Name
                  </label>
                  <input
                    id="customer-category-name"
                    type="text"
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    placeholder="z. B. Stammkunden"
                    disabled={isPending}
                  />
                </section>

                <section className="space-y-3">
                  <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="customer-category-description">
                    Beschreibung
                  </label>
                  <textarea
                    id="customer-category-description"
                    value={description}
                    onChange={(event) => setDescription(event.target.value)}
                    rows={4}
                    placeholder="Optionaler Hinweis zur Kategorie"
                    className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    disabled={isPending}
                  />
                </section>

                <section className="space-y-3">
                  <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="customer-category-color">
                    Farbe
                  </label>
                  <div className="flex items-center gap-3">
                    <input
                      id="customer-category-color"
                      type="color"
                      value={color}
                      onChange={(event) => setColor(event.target.value)}
                      className="h-10 w-16 rounded border border-zinc-200"
                      disabled={isPending}
                    />
                    <span className="text-xs text-zinc-500">Optional, z. B. für spätere Hervorhebungen.</span>
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
                {isPending && <Loader2 className="h-4 w-4 animate-spin" />}
                Erstellen
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  );
}
