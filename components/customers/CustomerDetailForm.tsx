"use client";

import Link from "next/link";
import { useActionState, useEffect, useMemo, useRef, useState } from "react";
import { useFormStatus } from "react-dom";

import type { CustomerProfile, CustomerNote } from "@/lib/customer-metadata";
import { CONSENT_METHOD_OPTIONS } from "@/lib/consent-method";
import type { CustomerCategoryListEntry } from "@/types/customers";
import type {
  UpdateCustomerActionState,
  CreateCustomerNoteState,
  UpdateCustomerConsentsActionState,
  ResendCustomerPermissionLinkState,
  DeleteCustomerActionState,
} from "@/app/backoffice/[location]/customers/actions";

type ConsentScopeKey = "EMAIL" | "SMS" | "WHATSAPP";

type CustomerConsentRecord = {
  id: string;
  scope: ConsentScopeKey;
  granted: boolean;
  grantedAt: string;
  revokedAt: string | null;
  source: string;
  recordedBy: string | null;
  metadata: {
    method: string | null;
    reference: string | null;
    textVersion: string | null;
    note: string | null;
  };
};

type CustomerConsentAudit = {
  id: string;
  scope: ConsentScopeKey | null;
  action: string;
  actorType: string;
  actorName: string | null;
  createdAt: string;
  diff: Record<string, unknown> | null;
  context: Record<string, unknown> | null;
};

type TillhubCustomerAnalytics = {
  source: "TILLHUB";
  customerId: string;
  fetchedAt: string;
  summary: {
    topStaff: string | null;
    lastVisit: string | null;
    mostUsedBranch: string | null;
    averageItemsPerTransaction: number | null;
    averageBasket: number | null;
    totalReturns: number | null;
    totalTransactions: number | null;
    totalProducts: number | null;
    currency: string | null;
  };
  transactions: TillhubCustomerTransaction[];
};

type TillhubCustomerTransaction = {
  id: string;
  date: string | null;
  receiptNumber: string | null;
  staff: string | null;
  branchNumber: string | null;
  registerId: string | null;
  balanceId: string | null;
  totalGross: number | null;
  currency: string | null;
  type: string | null;
};

type CustomerDetailFormProps = {
  locationSlug: string;
  locationName: string;
  backHref?: string | null;
  isAdmin: boolean;
  vipStaffOptions: Array<{ id: string; name: string }>;
  vipSelectedStaffIds: string[];
  vipTokenExpired: boolean;
  resendPermissionAction: (
    prevState: ResendCustomerPermissionLinkState,
    formData: FormData,
  ) => Promise<ResendCustomerPermissionLinkState>;
  deleteAction?: (
    prevState: DeleteCustomerActionState,
    formData: FormData,
  ) => Promise<DeleteCustomerActionState>;
  customer: {
    id: string;
    firstName: string | null;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    categoryId: string | null;
    appointmentCount: number;
    createdAt: Date;
    profile: CustomerProfile;
    notes: CustomerNote[];
  };
  consents: CustomerConsentRecord[];
  consentAudits?: CustomerConsentAudit[];
  appointmentHistory?: Array<{
    id: string;
    startsAt: string;
    status: string;
    confirmationCode: string;
    totalAmount: number | null;
    currency: string;
    serviceNames: string[];
    staffNames: string[];
  }>;
  analytics?: {
    lastVisit: string | null;
    appointmentCount: number;
    totalAmount: number | null;
    averageAmount: number | null;
    topServiceName: string | null;
  };
  tillhubAnalytics?: TillhubCustomerAnalytics | null;
  tillhubAnalyticsError?: string | null;
  allowTillhubFetch?: boolean;
  visitCount?: number;
  categories: CustomerCategoryListEntry[];
  action: (
    prevState: UpdateCustomerActionState,
    formData: FormData,
  ) => Promise<UpdateCustomerActionState>;
  noteAction: (
    prevState: CreateCustomerNoteState,
    formData: FormData,
  ) => Promise<CreateCustomerNoteState>;
  consentAction: (
    prevState: UpdateCustomerConsentsActionState,
    formData: FormData,
  ) => Promise<UpdateCustomerConsentsActionState>;
};

const STATUS_LABELS: Record<string, string> = {
  PENDING: "Anstehend",
  CONFIRMED: "Bestätigt",
  COMPLETED: "Abgeschlossen",
  CANCELLED: "Storniert",
  NO_SHOW: "Nicht erschienen",
};

const STATUS_BADGES: Record<string, string> = {
  PENDING: "border-amber-200 bg-amber-100 text-amber-700",
  CONFIRMED: "border-emerald-200 bg-emerald-100 text-emerald-700",
  COMPLETED: "border-sky-200 bg-sky-100 text-sky-700",
  CANCELLED: "border-rose-200 bg-rose-100 text-rose-700",
  NO_SHOW: "border-zinc-300 bg-zinc-200 text-zinc-700",
};

const MAX_IMAGE_SIZE = 5 * 1024 * 1024;

const TABS = [
  { id: "general", label: "Allgemein" },
  { id: "analytics", label: "Analytik" },
  { id: "notes", label: "Notizen" },
  { id: "audits", label: "Audits" },
] as const;

type TabId = (typeof TABS)[number]["id"];

const CONSENT_CHANNELS = [
  { key: "email", scope: "EMAIL", label: "E-Mail" },
  { key: "sms", scope: "SMS", label: "SMS" },
  { key: "whatsapp", scope: "WHATSAPP", label: "WhatsApp" },
] as const;

type ConsentChannelKey = (typeof CONSENT_CHANNELS)[number]["key"];

function formatAppointmentDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatDateTime(value: string | null) {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("de-DE", {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function formatShortDate(value: string | null) {
  if (!value) return "–";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("de-DE", { day: "2-digit", month: "2-digit", year: "numeric" });
}

function formatDateTimeInput(value: string | null) {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (amount: number) => String(amount).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function formatCurrency(amount: number | null, currency = "EUR") {
  if (amount === null || Number.isNaN(amount)) return "–";
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(amount);
}

function formatNumber(value: number | null) {
  if (value === null || Number.isNaN(value)) return "–";
  return new Intl.NumberFormat("de-DE", { maximumFractionDigits: 2 }).format(value);
}

function describeConsentAudit(entry: CustomerConsentAudit) {
  const diff = entry.diff?.granted as { from?: unknown; to?: unknown } | undefined;
  if (diff && typeof diff.to === "boolean") {
    return diff.to ? "Einwilligung erteilt" : "Einwilligung widerrufen";
  }
  if (entry.action === "CREATE") return "Einwilligung erfasst";
  if (entry.action === "UPDATE") return "Einwilligung aktualisiert";
  return "Audit-Eintrag";
}

function describeConsentActor(entry: CustomerConsentAudit) {
  const performedBy = entry.context?.performedByStaff;
  if (performedBy && typeof performedBy === "object") {
    const staffName = (performedBy as { staffName?: unknown }).staffName;
    if (typeof staffName === "string" && staffName.trim().length) {
      return staffName.trim();
    }
  }
  if (entry.actorType === "SYSTEM") return "System";
  if (entry.actorType === "CUSTOMER") {
    const source = entry.context?.source;
    if (source === "online_booking") return "Kunde (Online)";
    return "Kunde";
  }
  if (entry.actorName) return entry.actorName;
  return "Unbekannt";
}

export function CustomerDetailForm({
  locationSlug,
  locationName,
  backHref = null,
  isAdmin,
  vipStaffOptions,
  vipSelectedStaffIds,
  vipTokenExpired,
  resendPermissionAction,
  deleteAction,
  customer,
  consents,
  consentAudits = [],
  appointmentHistory = [],
  analytics,
  tillhubAnalytics,
  tillhubAnalyticsError,
  allowTillhubFetch = false,
  visitCount = 0,
  categories,
  action,
  noteAction,
  consentAction,
}: CustomerDetailFormProps) {
  const [state, formAction] = useActionState(action, { success: false, error: null });
  const [noteState, noteFormAction] = useActionState(noteAction, { success: false, error: null });
  const [consentState, consentFormAction] = useActionState(consentAction, { success: false, error: null });
  const noopResend = async (current: ResendCustomerPermissionLinkState, _formData: FormData) => current;
  const [resendState, resendAction] = useActionState(
    resendPermissionAction ?? noopResend,
    { success: false, error: null },
  );
  const noopDelete = async (current: DeleteCustomerActionState, _formData: FormData) => current;
  const [deleteState, deleteFormAction] = useActionState(
    deleteAction ?? noopDelete,
    { success: false, error: null },
  );
  const [activeTab, setActiveTab] = useState<TabId>("general");
  const [photoUrl, setPhotoUrl] = useState<string | null>(customer.profile.photoUrl);
  const [uploading, setUploading] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const noteFormRef = useRef<HTMLFormElement | null>(null);
  const analyticsAbortRef = useRef<AbortController | null>(null);

  const [resolvedTillhubAnalytics, setResolvedTillhubAnalytics] = useState<TillhubCustomerAnalytics | null>(
    tillhubAnalytics ?? null,
  );
  const [resolvedTillhubAnalyticsError, setResolvedTillhubAnalyticsError] = useState<string | null>(
    tillhubAnalyticsError ?? null,
  );
  const [resolvedTillhubAnalyticsLoading, setResolvedTillhubAnalyticsLoading] = useState(false);

  const customerName = `${customer.firstName ?? ""} ${customer.lastName ?? ""}`.trim() || "Unbekannt";
  const tillhubSummary = resolvedTillhubAnalytics?.summary ?? {
    topStaff: null,
    lastVisit: null,
    mostUsedBranch: null,
    averageItemsPerTransaction: null,
    averageBasket: null,
    totalReturns: null,
    totalTransactions: null,
    totalProducts: null,
    currency: null,
  };
  const tillhubTransactions = resolvedTillhubAnalytics?.transactions ?? [];
  const tillhubCurrency = tillhubSummary?.currency ?? "EUR";
  const useTillhubAnalytics = Boolean(
    resolvedTillhubAnalytics || resolvedTillhubAnalyticsError || resolvedTillhubAnalyticsLoading,
  );
  const createdAtDate = useMemo(
    () => customer.createdAt.toISOString().slice(0, 10),
    [customer.createdAt],
  );

  useEffect(() => {
    if (state.success) {
      window.setTimeout(() => {
        const badge = document.getElementById("customer-detail-success");
        badge?.classList.add("opacity-0");
      }, 2500);
    }
  }, [state.success]);

  useEffect(() => {
    if (noteState.success) {
      noteFormRef.current?.reset();
    }
  }, [noteState.success]);

  useEffect(() => {
    setPhotoUrl(customer.profile.photoUrl);
  }, [customer.profile.photoUrl]);

  useEffect(() => {
    setResolvedTillhubAnalytics(tillhubAnalytics ?? null);
    setResolvedTillhubAnalyticsError(tillhubAnalyticsError ?? null);
    setResolvedTillhubAnalyticsLoading(false);
    analyticsAbortRef.current?.abort();
    analyticsAbortRef.current = null;
  }, [tillhubAnalytics, tillhubAnalyticsError, customer.id]);

  useEffect(() => {
    if (!allowTillhubFetch) return;
    if (activeTab !== "analytics") return;
    if (resolvedTillhubAnalytics || resolvedTillhubAnalyticsError) return;

    analyticsAbortRef.current?.abort();
    const controller = new AbortController();
    analyticsAbortRef.current = controller;
    setResolvedTillhubAnalyticsLoading(true);

    const fetchAnalytics = async () => {
      try {
        const response = await fetch(
          `/api/backoffice/${locationSlug}/customers/${customer.id}/analytics`,
          { signal: controller.signal },
        );
        const payload = await response.json().catch(() => null);
        if (!response.ok) {
          setResolvedTillhubAnalyticsError(payload?.error ?? "Tillhub-Analytik konnte nicht geladen werden.");
          return;
        }
        setResolvedTillhubAnalytics(payload?.analytics ?? null);
        setResolvedTillhubAnalyticsError(payload?.error ?? null);
      } catch (error) {
        if (error instanceof DOMException && error.name === "AbortError") return;
        setResolvedTillhubAnalyticsError("Tillhub-Analytik konnte nicht geladen werden.");
      } finally {
        setResolvedTillhubAnalyticsLoading(false);
      }
    };

    fetchAnalytics();

    return () => {
      controller.abort();
    };
  }, [
    allowTillhubFetch,
    activeTab,
    locationSlug,
    customer.id,
    resolvedTillhubAnalytics,
    resolvedTillhubAnalyticsError,
  ]);

  const consentByScope = useMemo(() => {
    return new Map(consents.map((consent) => [consent.scope, consent]));
  }, [consents]);
  const initialConsentToggles = useMemo(
    () => ({
      email: consentByScope.get("EMAIL")?.granted ?? false,
      sms: consentByScope.get("SMS")?.granted ?? false,
      whatsapp: consentByScope.get("WHATSAPP")?.granted ?? false,
    }),
    [consentByScope],
  );
  const [consentToggles, setConsentToggles] = useState<Record<ConsentChannelKey, boolean>>(initialConsentToggles);
  useEffect(() => {
    setConsentToggles(initialConsentToggles);
  }, [initialConsentToggles]);

  const auditsByScope = useMemo(() => {
    const map = new Map<ConsentScopeKey, CustomerConsentAudit[]>();
    for (const entry of consentAudits) {
      if (!entry.scope) continue;
      const existing = map.get(entry.scope) ?? [];
      existing.push(entry);
      map.set(entry.scope, existing);
    }
    return map;
  }, [consentAudits]);

  const addressLine = [customer.profile.address.street, customer.profile.address.houseNumber]
    .filter(Boolean)
    .join(" ");
  const cityLine = [customer.profile.address.postalCode, customer.profile.address.city]
    .filter(Boolean)
    .join(" ");

  const handleUploadPhoto = async (file: File | null) => {
    if (!file) return;
    if (file.size > MAX_IMAGE_SIZE) {
      setUploadError("Die Bilddatei ist zu groß (max. 5 MB).");
      return;
    }
    setUploading(true);
    setUploadError(null);
    try {
      const payload = new FormData();
      payload.set("file", file);
      const response = await fetch(
        `/api/backoffice/${locationSlug}/customers/${customer.id}/profile-image`,
        { method: "POST", body: payload },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error ?? "Bild konnte nicht hochgeladen werden.");
      }
      setPhotoUrl(data?.data?.profileImageUrl ?? null);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Upload fehlgeschlagen.");
    } finally {
      setUploading(false);
    }
  };

  const handleRemovePhoto = async () => {
    if (!photoUrl) return;
    setUploading(true);
    setUploadError(null);
    try {
      const response = await fetch(
        `/api/backoffice/${locationSlug}/customers/${customer.id}/profile-image`,
        { method: "DELETE" },
      );
      const data = await response.json();
      if (!response.ok) {
        throw new Error(data?.error ?? "Bild konnte nicht entfernt werden.");
      }
      setPhotoUrl(data?.data?.profileImageUrl ?? null);
    } catch (error) {
      setUploadError(error instanceof Error ? error.message : "Entfernen fehlgeschlagen.");
    } finally {
      setUploading(false);
    }
  };

  const topServiceLabel = analytics?.topServiceName ?? "–";
  const revenueTotal = tillhubSummary.totalProducts ?? analytics?.totalAmount ?? null;
  const averageBasket = tillhubSummary.averageBasket ?? analytics?.averageAmount ?? null;
  const transactionCount =
    tillhubSummary.totalTransactions ?? analytics?.appointmentCount ?? customer.appointmentCount ?? 0;
  const appointmentInsights = useMemo(() => {
    const upcoming: typeof appointmentHistory = [];
    const past: typeof appointmentHistory = [];
    const serviceCounts = new Map<string, number>();
    let missed = 0;
    const now = new Date();

    for (const entry of appointmentHistory) {
      const start = new Date(entry.startsAt);
      const isMissed = entry.status === "CANCELLED" || entry.status === "NO_SHOW";
      if (isMissed) {
        missed += 1;
      }
      for (const serviceName of entry.serviceNames) {
        const name = serviceName.trim();
        if (!name) continue;
        serviceCounts.set(name, (serviceCounts.get(name) ?? 0) + 1);
      }
      if (start >= now && !isMissed) {
        upcoming.push(entry);
      } else {
        past.push(entry);
      }
    }

    upcoming.sort((a, b) => new Date(a.startsAt).getTime() - new Date(b.startsAt).getTime());
    past.sort((a, b) => new Date(b.startsAt).getTime() - new Date(a.startsAt).getTime());

    const popularServices = Array.from(serviceCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([name, count]) => ({ name, count }));

    return {
      upcoming: upcoming.slice(0, 3),
      past: past.slice(0, 3),
      missed,
      popularServices,
    };
  }, [appointmentHistory]);
  const popularServices = appointmentInsights.popularServices.length
    ? appointmentInsights.popularServices
    : topServiceLabel !== "–"
      ? [{ name: topServiceLabel, count: null }]
      : [];
  const deleteReturnTo = backHref ?? `/backoffice/${locationSlug}/customers`;

  return (
    <section className="rounded-xl border border-zinc-200 bg-white px-6 py-5 shadow-sm">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-zinc-200 pb-4">
        <div className="space-y-1">
          <h3 className="text-lg font-semibold text-zinc-900">Kundendetails</h3>
          <p className="text-xs text-zinc-500">
            Bearbeite Stammdaten, analysiere Aktivitäten und pflege Notizen.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {backHref ? (
            <Link
              href={backHref}
              className="inline-flex items-center gap-2 rounded-full bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-500"
            >
              <span aria-hidden>←</span>
              Zurück zur Kundenübersicht
            </Link>
          ) : null}
          {isAdmin && deleteAction ? (
            <form
              action={deleteFormAction}
              onSubmit={(event) => {
                if (!window.confirm(`Kund:in "${customerName}" wirklich löschen?`)) {
                  event.preventDefault();
                }
              }}
            >
              <input type="hidden" name="returnTo" value={deleteReturnTo} />
              <DeleteCustomerButton />
            </form>
          ) : null}
          {state.success ? (
            <span
              id="customer-detail-success"
              className="rounded-full bg-emerald-100 px-3 py-1 text-xs font-semibold text-emerald-700 transition-opacity"
            >
              Gespeichert
            </span>
          ) : null}
        </div>
      </header>

      {deleteState.error ? (
        <p className="mt-4 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
          {deleteState.error}
        </p>
      ) : null}

      <nav className="mt-4 flex flex-wrap gap-3 border-b border-zinc-200 pb-3">
        {TABS.map((tab) => {
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              type="button"
              onClick={() => setActiveTab(tab.id)}
              className={`rounded-full px-4 py-1.5 text-sm font-semibold transition ${
                isActive
                  ? "bg-emerald-100 text-emerald-700"
                  : "text-zinc-500 hover:bg-zinc-100 hover:text-zinc-800"
              }`}
            >
              {tab.label}
            </button>
          );
        })}
      </nav>

      {activeTab === "general" && (
        <form action={formAction} className="mt-6 space-y-6">
          <input type="hidden" name="customerId" value={customer.id} />
          <input type="hidden" name="photoUrl" value={photoUrl ?? ""} />

          <div className="grid gap-6 xl:grid-cols-[1.6fr_1fr]">
            <div className="space-y-6">
              <section className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold text-zinc-900">Allgemeine Informationen</h4>
                  <div className="flex flex-wrap gap-4 text-xs font-medium text-zinc-600">
                    <label className="inline-flex items-center gap-2">
                      <input type="checkbox" name="active" defaultChecked={customer.profile.active} />
                      Aktiv
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input type="checkbox" name="newsletter" defaultChecked={customer.profile.newsletter} />
                      Newsletter
                    </label>
                    <label className="inline-flex items-center gap-2">
                      <input type="checkbox" name="b2b" defaultChecked={customer.profile.b2b} />
                      B2B
                    </label>
                  </div>
                </div>

                <div className="mt-4 flex flex-wrap items-center gap-4 rounded-xl border border-dashed border-zinc-200 bg-white/70 p-3">
                  <div className="flex h-20 w-20 items-center justify-center overflow-hidden rounded-lg border border-dashed border-zinc-200 bg-zinc-50">
                    {photoUrl ? (
                      <img src={photoUrl} alt="Kundenfoto" className="h-full w-full object-cover" />
                    ) : (
                      <span className="text-xs text-zinc-400">Kein Bild</span>
                    )}
                  </div>
                  <div className="space-y-2">
                    <div>
                      <p className="text-xs uppercase tracking-widest text-zinc-400">Kund:in</p>
                      <p className="text-base font-semibold text-zinc-900">{customerName}</p>
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => fileInputRef.current?.click()}
                        disabled={uploading}
                        className="rounded-md border border-zinc-200 px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-50 disabled:cursor-not-allowed"
                      >
                        {uploading ? "Lade hoch …" : "Foto ändern"}
                      </button>
                      <button
                        type="button"
                        onClick={handleRemovePhoto}
                        disabled={uploading || !photoUrl}
                        className="rounded-md border border-zinc-200 px-3 py-2 text-xs font-semibold text-zinc-500 transition hover:bg-zinc-50 disabled:cursor-not-allowed"
                      >
                        Foto entfernen
                      </button>
                    </div>
                    {uploadError ? (
                      <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600">
                        {uploadError}
                      </p>
                    ) : null}
                  </div>
                </div>
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => handleUploadPhoto(event.target.files?.[0] ?? null)}
                />

                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Vorname
                    <input
                      type="text"
                      name="firstName"
                      defaultValue={customer.firstName ?? ""}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      required
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Nachname
                    <input
                      type="text"
                      name="lastName"
                      defaultValue={customer.lastName ?? ""}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      required
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Geschlecht
                    <select
                      name="gender"
                      defaultValue={customer.profile.gender ?? ""}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    >
                      <option value="">Keine Auswahl</option>
                      <option value="MALE">Männlich</option>
                      <option value="FEMALE">Weiblich</option>
                      <option value="DIVERSE">Divers</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Kundennummer
                    <input
                      type="text"
                      name="customerNumber"
                      defaultValue={customer.profile.customerNumber ?? ""}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Geburtsdatum
                    <input
                      type="date"
                      name="birthDate"
                      defaultValue={customer.profile.birthDate ?? ""}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Preisbuch
                    <input
                      type="text"
                      name="priceBook"
                      defaultValue={customer.profile.priceBook ?? ""}
                      placeholder="Standard"
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Rabatt
                    <div className="flex items-center gap-2">
                      <input
                        type="number"
                        name="discount"
                        min={0}
                        max={100}
                        step={0.5}
                        defaultValue={customer.profile.discountPercent ?? ""}
                        className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      />
                      <span className="text-xs text-zinc-500">%</span>
                    </div>
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Zum ersten Mal gesehen
                    <input
                      type="date"
                      name="firstSeenAt"
                      defaultValue={customer.profile.firstSeenAt ?? createdAtDate}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700 md:col-span-2">
                    Kommentar
                    <textarea
                      name="comment"
                      defaultValue={customer.profile.comment ?? ""}
                      rows={3}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <div className="md:col-span-2 text-xs text-zinc-500">
                    Ort: <span className="rounded-full bg-zinc-200 px-2 py-0.5 text-[11px]">{locationName}</span>
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h4 className="text-sm font-semibold text-zinc-900">Kontakt</h4>
                <div className="mt-4 grid gap-4 md:grid-cols-2">
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    E-Mail
                    <input
                      type="email"
                      name="email"
                      defaultValue={customer.email ?? ""}
                      placeholder="kunde@example.com"
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Firmenname
                    <input
                      type="text"
                      name="companyName"
                      defaultValue={customer.profile.companyName ?? ""}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Telefon-Typ
                    <select
                      name="phoneType"
                      defaultValue={customer.profile.phoneType ?? "Haupt"}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    >
                      <option value="Haupt">Haupt</option>
                      <option value="Mobil">Mobil</option>
                      <option value="Privat">Privat</option>
                      <option value="Firma">Firma</option>
                    </select>
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Telefonnummer
                    <input
                      type="tel"
                      name="phone"
                      defaultValue={customer.phone ?? ""}
                      placeholder="+49 …"
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Straße
                    <input
                      type="text"
                      name="street"
                      defaultValue={customer.profile.address.street ?? ""}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Hausnr.
                    <input
                      type="text"
                      name="houseNumber"
                      defaultValue={customer.profile.address.houseNumber ?? ""}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Stadt
                    <input
                      type="text"
                      name="city"
                      defaultValue={customer.profile.address.city ?? ""}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    PLZ
                    <input
                      type="text"
                      name="postalCode"
                      defaultValue={customer.profile.address.postalCode ?? ""}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Region
                    <input
                      type="text"
                      name="state"
                      defaultValue={customer.profile.address.state ?? ""}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700">
                    Land
                    <input
                      type="text"
                      name="country"
                      defaultValue={customer.profile.address.country ?? ""}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    />
                  </label>
                  <label className="space-y-1 text-sm font-medium text-zinc-700 md:col-span-2">
                    Kategorie
                    <select
                      name="categoryId"
                      defaultValue={customer.categoryId ?? ""}
                      className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                    >
                      <option value="">Keine Kategorie</option>
                      {categories.map((category) => (
                        <option key={category.id} value={category.id}>
                          {category.name}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              </section>

              {isAdmin && vipStaffOptions.length > 0 && (
                <section className="rounded-xl border border-zinc-200 bg-white p-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-semibold text-zinc-900">Online-Buchung Freigabe</h4>
                      <p className="text-xs text-zinc-500">
                        Kunde darf nicht online buchbare Mitarbeiter buchen.
                      </p>
                    </div>
                    {vipTokenExpired && (
                      <span className="rounded-full border border-amber-200 bg-amber-50 px-3 py-1 text-[11px] font-semibold text-amber-700">
                        Freigabe ausstehend – Link abgelaufen
                      </span>
                    )}
                  </div>
                  <div className="mt-3 grid gap-2 md:grid-cols-2">
                    {vipStaffOptions.map((staff) => (
                      <label
                        key={staff.id}
                        className="flex items-center gap-2 rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700"
                      >
                        <input
                          type="checkbox"
                          name="vipStaffIds"
                          value={staff.id}
                          defaultChecked={vipSelectedStaffIds.includes(staff.id)}
                          className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                        />
                        <span>{staff.name}</span>
                      </label>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-zinc-500">
                    Bestätigungslink wird per E-Mail versendet.
                  </p>
                  {vipTokenExpired && (
                    <button
                      type="submit"
                      formAction={resendAction}
                      className="mt-3 inline-flex items-center justify-center rounded-md border border-zinc-300 px-3 py-2 text-xs font-semibold text-zinc-700 transition hover:bg-zinc-50"
                    >
                      Neuen Bestätigungslink senden
                    </button>
                  )}
                  {resendState.error && (
                    <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                      {resendState.error}
                    </p>
                  )}
                  {resendState.success && (
                    <p className="mt-2 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                      Bestätigungslink gesendet.
                    </p>
                  )}
                </section>
              )}
            </div>

            <aside className="space-y-4">
              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="grid gap-3 md:grid-cols-3">
                  <AnalyticsCard label="Umsatz" value={formatCurrency(revenueTotal, tillhubCurrency)} />
                  <AnalyticsCard label="Termine" value={`${transactionCount}`} />
                  <AnalyticsCard label="Terminausfälle" value={`${appointmentInsights.missed}`} />
                </div>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h4 className="text-sm font-semibold text-zinc-900">Zahlungsübersicht</h4>
                <div className="mt-3 space-y-1">
                  <p className="text-2xl font-semibold text-zinc-900">
                    {formatCurrency(revenueTotal, tillhubCurrency)}
                  </p>
                  <p className="text-xs text-zinc-500">
                    {transactionCount} Transaktion(en)
                    {averageBasket != null && (
                      <span> · Ø {formatCurrency(averageBasket, tillhubCurrency)}</span>
                    )}
                  </p>
                </div>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <div className="flex items-center justify-between gap-3">
                  <h4 className="text-sm font-semibold text-zinc-900">Termine</h4>
                  <span className="text-xs text-zinc-500">{transactionCount} gesamt</span>
                </div>
                <div className="mt-3 space-y-4">
                  <div>
                    <p className="text-xs uppercase tracking-widest text-zinc-400">Anstehende</p>
                    <div className="mt-2 space-y-2">
                      {appointmentInsights.upcoming.length === 0 && (
                        <p className="text-xs text-zinc-500">Keine anstehenden Termine.</p>
                      )}
                      {appointmentInsights.upcoming.map((entry) => {
                        const serviceLabel = entry.serviceNames.length
                          ? entry.serviceNames.join(", ")
                          : "–";
                        const statusLabel = STATUS_LABELS[entry.status] ?? entry.status;
                        const statusClass = STATUS_BADGES[entry.status] ?? "border-zinc-200 bg-zinc-100 text-zinc-600";
                        return (
                          <div
                            key={entry.id}
                            className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-xs text-zinc-500">{formatAppointmentDate(entry.startsAt)}</p>
                                <p className="truncate text-sm font-medium text-zinc-900">{serviceLabel}</p>
                              </div>
                              <span
                                className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${statusClass}`}
                              >
                                {statusLabel}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                  <div>
                    <p className="text-xs uppercase tracking-widest text-zinc-400">Frühere</p>
                    <div className="mt-2 space-y-2">
                      {appointmentInsights.past.length === 0 && (
                        <p className="text-xs text-zinc-500">Keine früheren Termine.</p>
                      )}
                      {appointmentInsights.past.map((entry) => {
                        const serviceLabel = entry.serviceNames.length
                          ? entry.serviceNames.join(", ")
                          : "–";
                        const statusLabel = STATUS_LABELS[entry.status] ?? entry.status;
                        const statusClass = STATUS_BADGES[entry.status] ?? "border-zinc-200 bg-zinc-100 text-zinc-600";
                        return (
                          <div
                            key={entry.id}
                            className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm"
                          >
                            <div className="flex items-center justify-between gap-2">
                              <div className="min-w-0">
                                <p className="text-xs text-zinc-500">{formatAppointmentDate(entry.startsAt)}</p>
                                <p className="truncate text-sm font-medium text-zinc-900">{serviceLabel}</p>
                              </div>
                              <span
                                className={`flex-shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-widest ${statusClass}`}
                              >
                                {statusLabel}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                </div>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white p-4">
                <h4 className="text-sm font-semibold text-zinc-900">Beliebteste Leistungen</h4>
                <div className="mt-2 space-y-2">
                  {popularServices.length === 0 && (
                    <p className="text-xs text-zinc-500">Noch keine Leistungen vorhanden.</p>
                  )}
                  {popularServices.map((service) => (
                    <div
                      key={service.name}
                      className="flex items-center justify-between rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm text-zinc-700"
                    >
                      <span className="truncate">{service.name}</span>
                      {service.count != null && (
                        <span className="ml-2 rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700">
                          {service.count}
                        </span>
                      )}
                    </div>
                  ))}
                </div>
              </section>
            </aside>
          </div>

          {state.error ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{state.error}</p>
          ) : null}

          <div className="flex items-center justify-between border-t border-zinc-200 pt-4 text-xs text-zinc-500">
            <span>Letzte Änderung wird sofort gespeichert.</span>
            <SubmitButton />
          </div>
        </form>
      )}

      {activeTab === "analytics" && (
        <div className="mt-6 space-y-6">
          {resolvedTillhubAnalyticsLoading ? (
            <p className="rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2 text-xs text-zinc-600">
              Analytik wird geladen...
            </p>
          ) : null}

          {resolvedTillhubAnalyticsError ? (
            <p className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
              {resolvedTillhubAnalyticsError}
            </p>
          ) : null}

          {useTillhubAnalytics ? (
            <>
              <section className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  <AnalyticsCard label="Renner" value={tillhubSummary?.topStaff ?? "–"} />
                  <AnalyticsCard label="Letzter Besuch" value={formatDateTime(tillhubSummary?.lastVisit ?? null)} />
                  <AnalyticsCard
                    label="Meist genutzte Filiale"
                    value={tillhubSummary?.mostUsedBranch ?? "–"}
                  />
                  <AnalyticsCard
                    label="Durchschnittliche Anzahl der Produkte pro Transaktion"
                    value={formatNumber(tillhubSummary?.averageItemsPerTransaction ?? null)}
                  />
                  <AnalyticsCard
                    label="Gesamtanzahl Retouren"
                    value={
                      tillhubSummary?.currency
                        ? formatCurrency(tillhubSummary?.totalReturns ?? null, tillhubCurrency)
                        : formatNumber(tillhubSummary?.totalReturns ?? null)
                    }
                  />
                  <AnalyticsCard
                    label="Durchschnittlicher Einkaufswert"
                    value={
                      tillhubSummary?.currency
                        ? formatCurrency(tillhubSummary?.averageBasket ?? null, tillhubCurrency)
                        : formatNumber(tillhubSummary?.averageBasket ?? null)
                    }
                  />
                  <AnalyticsCard
                    label="Gesamtanzahl Transaktionen"
                    value={formatNumber(tillhubSummary?.totalTransactions ?? null)}
                  />
                  <AnalyticsCard
                    label="Gesamtanzahl verkaufter Produkte"
                    value={
                      tillhubSummary?.currency
                        ? formatCurrency(tillhubSummary?.totalProducts ?? null, tillhubCurrency)
                        : formatNumber(tillhubSummary?.totalProducts ?? null)
                    }
                  />
                </div>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white">
                <header className="border-b border-zinc-200 px-4 py-3">
                  <h4 className="text-sm font-semibold text-zinc-900">Transaktionen</h4>
                </header>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-zinc-100 text-sm">
                    <thead className="bg-zinc-50 text-left text-xs font-semibold uppercase tracking-widest text-zinc-500">
                      <tr>
                        <th className="px-4 py-3">Datum</th>
                        <th className="px-4 py-3">Bonnummer</th>
                        <th className="px-4 py-3">Mitarbeiter</th>
                        <th className="px-4 py-3">Filialnummer</th>
                        <th className="px-4 py-3">Kassen-ID</th>
                        <th className="px-4 py-3">Kassenabschluss</th>
                        <th className="px-4 py-3 text-right">Gesamt Brutto</th>
                        <th className="px-4 py-3">Typ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100">
                      {tillhubTransactions.length === 0 && (
                        <tr>
                          <td className="px-4 py-6 text-center text-xs text-zinc-500" colSpan={8}>
                            Noch keine Transaktionen vorhanden.
                          </td>
                        </tr>
                      )}
                      {tillhubTransactions.map((entry) => (
                        <tr key={entry.id}>
                          <td className="px-4 py-3 text-zinc-700">{formatDateTime(entry.date)}</td>
                          <td className="px-4 py-3 text-zinc-700">{entry.receiptNumber ?? "–"}</td>
                          <td className="px-4 py-3 text-zinc-700">{entry.staff ?? "–"}</td>
                          <td className="px-4 py-3 text-zinc-700">{entry.branchNumber ?? "–"}</td>
                          <td className="px-4 py-3 text-zinc-700">{entry.registerId ?? "–"}</td>
                          <td className="px-4 py-3 text-zinc-700">{entry.balanceId ?? "–"}</td>
                          <td className="px-4 py-3 text-right text-zinc-700">
                            {formatCurrency(entry.totalGross ?? null, entry.currency ?? tillhubCurrency)}
                          </td>
                          <td className="px-4 py-3 text-zinc-700">{entry.type ?? "–"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          ) : (
            <>
              <section className="rounded-xl border border-zinc-200 bg-zinc-50 p-4">
                <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
                  <AnalyticsCard label="Renner" value={topServiceLabel} />
                  <AnalyticsCard label="Letzter Besuch" value={formatShortDate(analytics?.lastVisit ?? null)} />
                  <AnalyticsCard label="Gesamtbetrag" value={formatCurrency(analytics?.totalAmount ?? null)} />
                  <AnalyticsCard label="Ø Einkaufswert" value={formatCurrency(analytics?.averageAmount ?? null)} />
                  <AnalyticsCard label="Transaktionen" value={`${analytics?.appointmentCount ?? 0}`} />
                  <AnalyticsCard label="Besuche" value={`${visitCount}`} />
                  <AnalyticsCard label="Meist genutzte Filiale" value={locationName} />
                  <AnalyticsCard label="Leistungen gesamt" value={`${appointmentHistory.length}`} />
                </div>
              </section>

              <section className="rounded-xl border border-zinc-200 bg-white">
                <header className="border-b border-zinc-200 px-4 py-3">
                  <h4 className="text-sm font-semibold text-zinc-900">Transaktionen</h4>
                </header>
                <div className="overflow-x-auto">
                  <table className="min-w-full divide-y divide-zinc-100 text-sm">
                    <thead className="bg-zinc-50 text-left text-xs font-semibold uppercase tracking-widest text-zinc-500">
                      <tr>
                        <th className="px-4 py-3">Datum</th>
                        <th className="px-4 py-3">Bonnummer</th>
                        <th className="px-4 py-3">Mitarbeiter</th>
                        <th className="px-4 py-3">Leistung</th>
                        <th className="px-4 py-3 text-right">Gesamt Brutto</th>
                        <th className="px-4 py-3">Typ</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-100">
                      {appointmentHistory.length === 0 && (
                        <tr>
                          <td className="px-4 py-6 text-center text-xs text-zinc-500" colSpan={6}>
                            Noch keine Transaktionen vorhanden.
                          </td>
                        </tr>
                      )}
                      {appointmentHistory.map((entry) => {
                        const serviceLabel = entry.serviceNames.length ? entry.serviceNames.join(", ") : "–";
                        const staffLabel = entry.staffNames.length ? entry.staffNames.join(", ") : "–";
                        return (
                          <tr key={entry.id}>
                            <td className="px-4 py-3 text-zinc-700">{formatAppointmentDate(entry.startsAt)}</td>
                            <td className="px-4 py-3 text-zinc-700">{entry.confirmationCode}</td>
                            <td className="px-4 py-3 text-zinc-700">{staffLabel}</td>
                            <td className="px-4 py-3 text-zinc-700">{serviceLabel}</td>
                            <td className="px-4 py-3 text-right text-zinc-700">
                              {formatCurrency(entry.totalAmount, entry.currency)}
                            </td>
                            <td className="px-4 py-3 text-zinc-700">{STATUS_LABELS[entry.status] ?? entry.status}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </section>
            </>
          )}
        </div>
      )}

      {activeTab === "notes" && (
        <div className="mt-6 grid gap-6 xl:grid-cols-[1.3fr_1fr]">
          <section className="rounded-xl border border-zinc-200 bg-white">
            <header className="border-b border-zinc-200 px-4 py-3 text-sm font-semibold text-zinc-900">
              Kundendaten im Überblick
            </header>
            <dl className="divide-y divide-zinc-100 text-sm">
              <SummaryRow label="Name" value={customerName} />
              <SummaryRow label="Adresse" value={[addressLine, cityLine].filter(Boolean).join(", ") || "–"} />
              <SummaryRow label="E-Mail" value={customer.email ?? "–"} />
              <SummaryRow label="Telefonnummer" value={customer.phone ?? "–"} />
              <SummaryRow label="Kundennummer" value={customer.profile.customerNumber ?? "–"} />
              <SummaryRow label="Firmenname" value={customer.profile.companyName ?? "–"} />
              <SummaryRow label="B2B" value={customer.profile.b2b ? "Ja" : "Nein"} />
              <SummaryRow label="Newsletter" value={customer.profile.newsletter ? "Ja" : "Nein"} />
              <SummaryRow
                label="Rabatt"
                value={customer.profile.discountPercent !== null ? `${customer.profile.discountPercent} %` : "–"}
              />
            </dl>
          </section>

          <section className="rounded-xl border border-zinc-200 bg-white p-4">
            <form ref={noteFormRef} action={noteFormAction} className="space-y-3">
              <label className="space-y-1 text-sm font-semibold text-zinc-900">
                Notiz <span className="text-rose-500">*</span>
                <textarea
                  name="note"
                  rows={4}
                  placeholder="Notiz hinzufügen …"
                  className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  required
                />
              </label>
              {noteState.error ? (
                <p className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-xs text-rose-600">
                  {noteState.error}
                </p>
              ) : null}
              <div className="flex justify-end">
                <NoteSubmitButton />
              </div>
            </form>

            <div className="mt-6 space-y-3">
              <h4 className="text-sm font-semibold text-zinc-900">Notizverlauf</h4>
              {customer.notes.length === 0 ? (
                <p className="text-xs text-zinc-500">Noch keine Notizen vorhanden.</p>
              ) : (
                <ul className="space-y-3">
                  {customer.notes.map((note) => (
                    <li key={note.id} className="rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-2 text-sm">
                      <p className="text-zinc-800">{note.text}</p>
                      <p className="mt-1 text-xs text-zinc-500">
                        {formatAppointmentDate(note.createdAt)}
                      </p>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </section>
        </div>
      )}

      {activeTab === "audits" && (
        <div className="mt-6 space-y-6">
          <form key={customer.id} action={consentFormAction} className="space-y-6">
            {CONSENT_CHANNELS.map((channel) => {
              const consent = consentByScope.get(channel.scope) ?? null;
              const granted = consentToggles[channel.key];
              const audits = auditsByScope.get(channel.scope) ?? [];
              const consentLabel = granted ? "Aktiv" : "Inaktiv";
              return (
                <section key={channel.key} className="rounded-xl border border-zinc-200 bg-white p-4">
                  <header className="flex flex-wrap items-center justify-between gap-3">
                    <div>
                      <h4 className="text-sm font-semibold text-zinc-900">Einwilligung {channel.label}</h4>
                      <p className="text-xs text-zinc-500">Status: {consentLabel}</p>
                    </div>
                    <label className="inline-flex items-center gap-2 text-sm font-semibold text-zinc-700">
                      <input
                        type="checkbox"
                        name={`consent_${channel.key}_granted`}
                        checked={granted}
                        onChange={(event) =>
                          setConsentToggles((prev) => ({ ...prev, [channel.key]: event.target.checked }))
                        }
                      />
                      Einwilligung aktiv
                    </label>
                  </header>

                  <div className="mt-4 grid gap-4 md:grid-cols-2">
                    <label className="space-y-1 text-sm font-medium text-zinc-700">
                      Erteilt am
                      <input
                        type="datetime-local"
                        name={`consent_${channel.key}_grantedAt`}
                        defaultValue={formatDateTimeInput(consent?.grantedAt ?? null)}
                        className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      />
                    </label>
                    <label className="space-y-1 text-sm font-medium text-zinc-700">
                      Widerrufen am
                      <input
                        type="datetime-local"
                        name={`consent_${channel.key}_revokedAt`}
                        defaultValue={formatDateTimeInput(consent?.revokedAt ?? null)}
                        disabled={granted}
                        className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm disabled:cursor-not-allowed disabled:bg-zinc-100 disabled:text-zinc-500 focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      />
                    </label>
                    <label className="space-y-1 text-sm font-medium text-zinc-700">
                      Methode
                      <select
                        name={`consent_${channel.key}_method`}
                        defaultValue={consent?.metadata.method ?? ""}
                        className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      >
                        <option value="">Keine Auswahl</option>
                        {CONSENT_METHOD_OPTIONS.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="space-y-1 text-sm font-medium text-zinc-700">
                      Nachweis / Referenz
                      <input
                        type="text"
                        name={`consent_${channel.key}_reference`}
                        defaultValue={consent?.metadata.reference ?? ""}
                        placeholder="z. B. Formular-ID, Ticket, Datei"
                        className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      />
                    </label>
                    <label className="space-y-1 text-sm font-medium text-zinc-700">
                      Text-Version
                      <input
                        type="text"
                        name={`consent_${channel.key}_textVersion`}
                        defaultValue={consent?.metadata.textVersion ?? ""}
                        placeholder="z. B. v2.1"
                        className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      />
                    </label>
                    <label className="space-y-1 text-sm font-medium text-zinc-700 md:col-span-2">
                      Hinweis
                      <textarea
                        name={`consent_${channel.key}_note`}
                        defaultValue={consent?.metadata.note ?? ""}
                        rows={3}
                        className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                      />
                    </label>
                  </div>

                  <div className="mt-3 text-xs text-zinc-500">
                    {consent ? (
                      <p>
                        Quelle: {consent.source}
                        {consent.recordedBy ? ` · erfasst von ${consent.recordedBy}` : ""}
                      </p>
                    ) : (
                      <p>Noch keine Einwilligung hinterlegt.</p>
                    )}
                  </div>

                  {audits.length > 0 && (
                    <div className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 px-3 py-3">
                      <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Audit-Verlauf</p>
                      <ul className="mt-2 space-y-2">
                        {audits.map((entry) => (
                          <li key={entry.id} className="text-xs text-zinc-600">
                            <span className="font-semibold text-zinc-800">{describeConsentAudit(entry)}</span>{" "}
                            · {formatAppointmentDate(entry.createdAt)} · {describeConsentActor(entry)}
                          </li>
                        ))}
                      </ul>
                    </div>
                  )}
                </section>
              );
            })}

            {consentState.error ? (
              <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                {consentState.error}
              </p>
            ) : null}
            {consentState.success ? (
              <p className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs text-emerald-700">
                Einwilligungen gespeichert.
              </p>
            ) : null}

            <div className="flex items-center justify-between border-t border-zinc-200 pt-4 text-xs text-zinc-500">
              <span>Änderungen werden revisionssicher protokolliert.</span>
              <ConsentSubmitButton />
            </div>
          </form>
        </div>
      )}
    </section>
  );
}

function AnalyticsCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
      <p className="text-xs uppercase tracking-widest text-zinc-400">{label}</p>
      <p className="mt-2 text-sm font-semibold text-zinc-900">{value}</p>
    </div>
  );
}

function SummaryRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <dt className="text-xs font-semibold uppercase tracking-widest text-zinc-400">{label}</dt>
      <dd className="text-sm text-zinc-700">{value}</dd>
    </div>
  );
}

function SubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-300"
      disabled={pending}
    >
      {pending ? "Speichern …" : "Änderungen sichern"}
    </button>
  );
}

function NoteSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="rounded-md bg-emerald-600 px-4 py-2 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-300"
      disabled={pending}
    >
      {pending ? "Speichern …" : "Erstellen"}
    </button>
  );
}

function ConsentSubmitButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="rounded-full bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white shadow-sm transition hover:bg-emerald-500 disabled:cursor-not-allowed disabled:bg-emerald-300"
      disabled={pending}
    >
      {pending ? "Speichern …" : "Einwilligungen sichern"}
    </button>
  );
}

function DeleteCustomerButton() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      className="rounded-full border border-rose-200 bg-rose-50 px-4 py-2 text-xs font-semibold text-rose-700 shadow-sm transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
      disabled={pending}
    >
      {pending ? "Löschen …" : "Kunde löschen"}
    </button>
  );
}
