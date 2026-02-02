"use client";

import { useEffect, useMemo, useState, useTransition } from "react";

import type { CustomerCategoryOption } from "@/types/customers";

type CustomerPayload = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phone: string | null;
  categoryId: string | null;
};

type ActionResult = {
  success: boolean;
  error?: string;
  customer?: CustomerPayload;
};

type NewCustomerFormProps = {
  locationName: string;
  categories: CustomerCategoryOption[];
  onSubmit: (formData: FormData) => Promise<ActionResult>;
};

export function NewCustomerForm({ locationName, categories, onSubmit }: NewCustomerFormProps) {
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [categoryId, setCategoryId] = useState<string>(categories[0]?.id ?? "");

  const hasCategories = categories.length > 0;
  const selectableCategories = useMemo(
    () => categories.map((category) => ({ id: category.id, name: category.name })),
    [categories],
  );

  useEffect(() => {
    if (!success) return;
    const timer = window.setTimeout(() => {
      window.close();
    }, 1800);
    return () => window.clearTimeout(timer);
  }, [success]);

  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const formData = new FormData(form);
        setError(null);
        setSuccess(null);

        startTransition(() => {
          onSubmit(formData)
            .then((result) => {
              if (!result.success || !result.customer) {
                setError(result.error ?? "Kunde konnte nicht gespeichert werden.");
                return;
              }
              setSuccess("Kunde erstellt. Dieses Fenster schließt sich gleich.");
              if (typeof window !== "undefined") {
                const { id, firstName, lastName, email, phone, categoryId: createdCategoryId } = result.customer;
                window.opener?.postMessage(
                  {
                    type: "calendar.customer.created",
                    customer: {
                      id,
                      firstName,
                      lastName,
                      email,
                      phone,
                      categoryId: createdCategoryId,
                    },
                  },
                  window.location.origin,
                );
              }
              form.reset();
              form.querySelector<HTMLInputElement>("input[name='firstName']")?.focus();
              setCategoryId(categories[0]?.id ?? "");
            })
            .catch(() => {
              setError("Kunde konnte nicht gespeichert werden.");
            });
        });
      }}
      className="space-y-6"
    >
      <section className="space-y-2">
        <p className="text-xs uppercase tracking-widest text-zinc-500">Neuer Kunde</p>
        <h1 className="text-2xl font-semibold text-zinc-900">{locationName}</h1>
        <p className="text-sm text-zinc-600">
          Erstelle einen Kunden für diesen Standort. Nach dem Speichern steht er sofort im Kalender zur Auswahl bereit.
        </p>
      </section>

      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Vorname</label>
          <input
            name="firstName"
            required
            minLength={1}
            maxLength={120}
            className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            autoFocus
          />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Nachname</label>
          <input
            name="lastName"
            required
            minLength={1}
            maxLength={120}
            className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">E-Mail</label>
          <input
            name="email"
            type="email"
            placeholder="optional"
            className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          />
        </div>
        <div>
          <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500">Telefon</label>
          <input
            name="phone"
            type="tel"
            placeholder="optional"
            maxLength={120}
            className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          />
        </div>
      </div>

      <section className="space-y-2">
        <label className="block text-xs font-semibold uppercase tracking-widest text-zinc-500" htmlFor="customer-category">
          Kategorie
        </label>
        {hasCategories ? (
          <select
            id="customer-category"
            name="categoryId"
            value={categoryId}
            onChange={(event) => setCategoryId(event.target.value)}
            disabled={pending}
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
          >
            {selectableCategories.map((category) => (
              <option key={category.id} value={category.id}>
                {category.name}
              </option>
            ))}
          </select>
        ) : (
          <>
            <div className="rounded-md border border-dashed border-zinc-200 bg-zinc-50 px-4 py-3 text-sm text-zinc-500">
              Noch keine Kundenkategorien vorhanden. Du kannst den Kunden trotzdem speichern und später zuordnen.
            </div>
            <input type="hidden" name="categoryId" value="" />
          </>
        )}
      </section>

      {error && <p className="rounded-md border border-rose-200 bg-rose-50 px-4 py-2 text-sm text-rose-700">{error}</p>}
      {success && (
        <p className="rounded-md border border-emerald-200 bg-emerald-50 px-4 py-2 text-sm text-emerald-700">
          {success}
        </p>
      )}

      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={pending}
          className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-500"
        >
          {pending ? "Speichert …" : "Kunde speichern"}
        </button>
        <button
          type="button"
          onClick={() => {
            if (typeof window !== "undefined") {
              window.close();
            }
          }}
          className="text-sm text-zinc-500 underline underline-offset-4 transition hover:text-zinc-700"
        >
          Fenster schließen
        </button>
      </div>
    </form>
  );
}
