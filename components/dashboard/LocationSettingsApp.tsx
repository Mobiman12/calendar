"use client";

import { useCallback, useEffect, useRef, useState } from "react";

import { useToast } from "@/components/ui/ToastProvider";
import {
  BookingLimit,
  BookingLimitUnit,
  BookingPreferencesState,
  bookingPreferencesDefaults,
} from "@/lib/booking-preferences";

const NAV_ITEMS = [
  { id: "bookingFunction", label: "Buchungsfunktion", description: "Steuerung der Online-Buchung" },
  { id: "bookingPreferences", label: "Buchungseinstellungen", description: "Zeitslots, Pufferzeiten & Regeln" },
  { id: "customerNotifications", label: "Kundenbenachrichtigung", description: "E-Mail, SMS und WhatsApp" },
  { id: "paymentSettings", label: "Zahlungseinstellungen", description: "Bezahlarten und Vorkasse" },
  { id: "integrations", label: "Integrationen", description: "Kalender und Tools verbinden" },
  { id: "taxes", label: "Steuern", description: "Steuersätze & Rechnungsangaben" },
] as const;

type NavId = (typeof NAV_ITEMS)[number]["id"];

export function LocationSettingsApp({
  locationSlug,
  tenantSlug,
  bookingBaseUrl,
  initialPreferences = bookingPreferencesDefaults,
}: {
  locationSlug: string;
  tenantSlug?: string;
  bookingBaseUrl?: string;
  initialPreferences?: BookingPreferencesState;
}) {
  const [active, setActive] = useState<NavId>(NAV_ITEMS[0].id);
  const [bookingPrefs, setBookingPrefs] = useState<BookingPreferencesState>(initialPreferences);
  const { pushToast } = useToast();
  const normalizedBookingBaseUrl = bookingBaseUrl?.replace(/\/$/, "");
  const tenantSlugValue = tenantSlug ?? "DEIN_TENANT";
  const locationSlugValue = locationSlug || "DEIN_STANDORT";
  const tenantBookingUrl = normalizedBookingBaseUrl
    ? `${normalizedBookingBaseUrl}/book/${tenantSlugValue}`
    : `/book/${tenantSlugValue}`;
  const locationBookingUrl = normalizedBookingBaseUrl
    ? `${normalizedBookingBaseUrl}/book/${tenantSlugValue}/${locationSlugValue}`
    : `/book/${tenantSlugValue}/${locationSlugValue}`;
  const bookingUrl = bookingPrefs.bookingButtonUseLocation ? locationBookingUrl : tenantBookingUrl;
  const persistPatch = useCallback(
    async (patch: Partial<BookingPreferencesState>, successMessage = "Einstellung gespeichert.") => {
      const previous = bookingPrefs;
      const next = { ...bookingPrefs, ...patch };
      setBookingPrefs(next);
      try {
        await persistBookingPreferences(locationSlug, patch);
        pushToast({ variant: "success", message: successMessage });
      } catch (error) {
        setBookingPrefs(previous);
        pushToast({
          variant: "error",
          message: error instanceof Error ? error.message : "Einstellung konnte nicht gespeichert werden.",
        });
      }
    },
    [bookingPrefs, locationSlug, pushToast],
  );

  const renderContent = () => {
    switch (active) {
      case "bookingFunction":
        return (
          <div className="space-y-10">
            <SettingsCard title="Buchungsfunktion">
              <p className="text-sm text-zinc-600">
                Aktiviere oder deaktiviere die Online-Buchung für diesen Standort, lege Sichtbarkeiten fest und bestimme, ob nur
                Stammkunden buchen dürfen.
              </p>
              <div className="mt-4 rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3 text-sm">
                <div className="flex items-center gap-3">
                  <label className="text-sm font-semibold text-zinc-900">Online-Buchung</label>
                  <input
                    type="checkbox"
                    checked={bookingPrefs.onlineBookingEnabled}
                    onChange={(event) => {
                      void persistPatch(
                        { onlineBookingEnabled: event.target.checked },
                        event.target.checked
                          ? "Online-Buchung aktiviert."
                          : "Online-Buchung deaktiviert.",
                      );
                    }}
                    className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                  />
                </div>
                <p className="mt-2 text-xs text-zinc-500">
                  Deaktiviert die Buchungsmaske für Kunden. Bestehende Termine bleiben erhalten.
                </p>
              </div>
            </SettingsCard>

            <SettingsCard title="Buchungsbutton">
              <p className="text-sm text-zinc-600">
                Passe deinen Buchungsbutton an und kopiere den HTML-Code, um ihn auf einer externen Website einzubauen.
              </p>
              <BookingButtonSettings
                prefs={bookingPrefs}
                bookingUrl={bookingUrl}
                tenantBookingUrl={tenantBookingUrl}
                locationBookingUrl={locationBookingUrl}
                tenantSlug={tenantSlug}
                onChange={(patch, message) => void persistPatch(patch, message)}
              />
            </SettingsCard>

            <SettingsCard title="Bannerbild">
              <p className="text-sm text-zinc-600">
                Lade ein Bannerbild für die Online-Buchungsseite hoch. Empfohlen: 1600 × 480 px, max. 6 MB.
              </p>
              <BookingBannerSettings
                locationSlug={locationSlug}
                bannerUrl={bookingPrefs.bookingBannerImageUrl}
                bannerHeight={bookingPrefs.bookingBannerHeight}
                bannerFit={bookingPrefs.bookingBannerFit}
                onBannerChange={(url) =>
                  setBookingPrefs((current) => ({ ...current, bookingBannerImageUrl: url }))
                }
                onSettingsChange={(patch, message) => void persistPatch(patch, message)}
              />
            </SettingsCard>
          </div>
        );
      case "bookingPreferences":
        return (
          <BookingPreferencesSettings
            prefs={bookingPrefs}
            onChange={(patch) => {
              void persistPatch(patch);
            }}
            onShiftPlanToggle={async (value) => {
              try {
                await persistPatch({ shiftPlan: value }, value ? "Schichtplan aktiviert." : "Schichtplan deaktiviert.");
              } catch {
                // persistPatch macht selbst Toast/Revert
              }
            }}
          />
        );
      case "customerNotifications":
        return (
          <SettingsCard title="Kundenbenachrichtigung">
            <p className="text-sm text-zinc-600">Lege fest, wie deine E-Mails und SMS für Kund:innen aussehen.</p>
            <div className="mt-6 space-y-6">
              <CustomerNotificationSettings
                prefs={bookingPrefs}
                onChange={(patch, message) => void persistPatch(patch, message)}
              />
            </div>
          </SettingsCard>
        );
      case "paymentSettings":
        return (
          <SettingsCard title="Zahlungseinstellungen">
            <p className="text-sm text-zinc-600">Verwalte Vorkasse, Anzahlungen und unterstützte Zahlungsarten.</p>
            <div className="mt-4 rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm shadow-sm">
              <label className="flex items-center gap-3">
                <input type="checkbox" className="h-4 w-4 rounded border-zinc-300 text-emerald-600" />
                Anzahlungen bei Online-Buchung verlangen
              </label>
              <label className="mt-3 flex items-center gap-3">
                <input type="checkbox" className="h-4 w-4 rounded border-zinc-300 text-emerald-600" />
                Barzahlung zulassen
              </label>
            </div>
          </SettingsCard>
        );
      case "integrations":
        return (
          <SettingsCard title="Integrationen">
            <p className="text-sm text-zinc-600">Verbinde externe Tools wie Google Calendar, Stripe oder DATEV.</p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              {["Google Calendar", "Stripe", "Mailchimp", "DATEV"].map((integration) => (
                <div key={integration} className="rounded-xl border border-zinc-200 bg-white px-4 py-3 text-sm shadow-sm">
                  <p className="font-semibold text-zinc-900">{integration}</p>
                  <p className="text-xs text-zinc-500">Noch nicht verbunden.</p>
                  <button className="mt-2 rounded-full border border-zinc-200 px-3 py-1 text-xs font-semibold text-zinc-700 transition hover:border-zinc-300">
                    Verbinden
                  </button>
                </div>
              ))}
            </div>
          </SettingsCard>
        );
      case "taxes":
      default:
        return (
          <SettingsCard title="Steuern">
            <p className="text-sm text-zinc-600">Hinterlege Steuersätze, Rechnungsangaben und USt-ID.</p>
            <div className="mt-4 grid gap-4 md:grid-cols-2">
              <label className="text-sm text-zinc-600">
                Standard-Steuersatz (%):
                <input
                  type="number"
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                  placeholder="z. B. 19"
                />
              </label>
              <label className="text-sm text-zinc-600">
                USt-ID:
                <input
                  type="text"
                  className="mt-1 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
                  placeholder="DE000000000"
                />
              </label>
            </div>
          </SettingsCard>
        );
    }
  };

  return (
    <div className="flex flex-col gap-6 lg:flex-row">
      <nav className="rounded-2xl border border-zinc-200 bg-white p-3 text-sm font-medium text-zinc-700 lg:w-64 lg:shrink-0">
        <p className="mb-2 px-2 text-xs font-semibold uppercase tracking-widest text-zinc-500">Einstellungen</p>
        <div className="flex flex-col">
          {NAV_ITEMS.map((item) => (
            <button
              key={item.id}
              type="button"
              onClick={() => setActive(item.id)}
              className={`w-full rounded-xl px-4 py-3 text-left transition ${
                active === item.id ? "bg-emerald-50 text-emerald-700 shadow-inner" : "hover:bg-zinc-50"
              }`}
            >
              <span className="block text-sm font-semibold">{item.label}</span>
              <span className="text-xs font-normal text-zinc-500">{item.description}</span>
            </button>
          ))}
        </div>
      </nav>
      <div className="flex-1 rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">{renderContent()}</div>
    </div>
  );
}

function persistBookingPreferences(locationSlug: string, payload: Partial<BookingPreferencesState>) {
  return fetch(`/api/backoffice/${locationSlug}/settings/booking-preferences`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  }).then((response) => {
    if (!response.ok) {
      return response
        .json()
        .catch(() => null)
        .then((data) => {
          throw new Error(data?.error ?? "Einstellung konnte nicht gespeichert werden.");
        });
    }
  });
}

function SettingsCard({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="space-y-4">
      <h2 className="text-2xl font-semibold text-zinc-900">{title}</h2>
      {children}
    </section>
  );
}

function InfoPopover({ label, children }: { label: string; children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const handleClick = (event: MouseEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClick);
    document.addEventListener("keydown", handleKey);
    return () => {
      document.removeEventListener("mousedown", handleClick);
      document.removeEventListener("keydown", handleKey);
    };
  }, [open]);

  return (
    <div ref={containerRef} className="relative inline-flex">
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        aria-label={label}
        aria-expanded={open}
        className="inline-flex h-6 w-6 items-center justify-center rounded-full border border-zinc-300 text-[11px] font-semibold text-zinc-600 hover:border-zinc-400 hover:text-zinc-700"
      >
        i
      </button>
      {open ? (
        <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-xl border border-zinc-200 bg-white p-4 text-sm text-zinc-700 shadow-xl">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function BookingButtonSettings({
  prefs,
  bookingUrl,
  tenantBookingUrl,
  locationBookingUrl,
  tenantSlug,
  onChange,
}: {
  prefs: BookingPreferencesState;
  bookingUrl: string;
  tenantBookingUrl: string;
  locationBookingUrl: string;
  tenantSlug?: string;
  onChange: (patch: Partial<BookingPreferencesState>, message: string) => void;
}) {
  const { pushToast } = useToast();
  const [buttonTextDraft, setButtonTextDraft] = useState(prefs.bookingButtonText);
  const buttonColors = [
    "#111827",
    "#475569",
    "#64748b",
    "#ef4444",
    "#f97316",
    "#f59e0b",
    "#16a34a",
    "#0ea5e9",
    "#1f6feb",
    "#8b5cf6",
  ];
  const textColors = ["#ffffff", "#111827", "#0f172a"];
  const snippet = buildBookingButtonSnippet(prefs, bookingUrl);

  useEffect(() => {
    setButtonTextDraft(prefs.bookingButtonText);
  }, [prefs.bookingButtonText]);

  const copyText = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      pushToast({ variant: "success", message: `${label} kopiert.` });
    } catch (error) {
      pushToast({
        variant: "error",
        message: error instanceof Error ? error.message : "Kopieren fehlgeschlagen.",
      });
    }
  };

  const handleCopy = async () => {
    await copyText(snippet, "HTML-Code");
  };

  return (
    <div className="mt-4 grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
      <div className="space-y-6">
        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">1 · Button-Stil</p>
          <ToggleField
            label={prefs.bookingButtonFloating ? "Schwebenden Button verwenden" : "Schwebenden Button deaktiviert"}
            checked={prefs.bookingButtonFloating}
            onChange={(value) => onChange({ bookingButtonFloating: value }, "Button-Stil gespeichert.")}
          />
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">2 · Zielseite</p>
          <div className="mt-3 flex flex-col gap-3 text-sm text-zinc-700">
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="booking-button-target"
                value="tenant"
                checked={!prefs.bookingButtonUseLocation}
                onChange={() =>
                  onChange({ bookingButtonUseLocation: false }, "Zielseite gespeichert.")
                }
                className="h-4 w-4 border-zinc-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span>Hauptbuchungsseite</span>
            </label>
            <label className="flex items-center gap-2">
              <input
                type="radio"
                name="booking-button-target"
                value="location"
                checked={prefs.bookingButtonUseLocation}
                onChange={() =>
                  onChange({ bookingButtonUseLocation: true }, "Zielseite gespeichert.")
                }
                className="h-4 w-4 border-zinc-300 text-emerald-600 focus:ring-emerald-500"
              />
              <span>Diesen Standort verlinken</span>
            </label>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">3 · Button-Position</p>
          <div className="mt-3 flex items-center gap-6 text-sm text-zinc-700">
            {(["left", "right"] as const).map((side) => (
              <label key={side} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="booking-button-position"
                  value={side}
                  checked={prefs.bookingButtonPosition === side}
                  onChange={() =>
                    onChange({ bookingButtonPosition: side }, "Button-Position gespeichert.")
                  }
                  className="h-4 w-4 border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span>{side === "left" ? "Links" : "Rechts"}</span>
              </label>
            ))}
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">4 · Buttontext</p>
          <input
            type="text"
            value={buttonTextDraft}
            onChange={(event) => setButtonTextDraft(event.target.value)}
            onBlur={() => {
              if (buttonTextDraft !== prefs.bookingButtonText) {
                onChange({ bookingButtonText: buttonTextDraft }, "Buttontext gespeichert.");
              }
            }}
            className="mt-3 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            placeholder="Termin online buchen"
          />
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">5 · Buttonfarbe</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {buttonColors.map((color) => (
              <ColorSwatch
                key={color}
                color={color}
                selected={prefs.bookingButtonColor.toLowerCase() === color.toLowerCase()}
                onSelect={() => onChange({ bookingButtonColor: color }, "Buttonfarbe gespeichert.")}
              />
            ))}
            <label className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-dashed border-zinc-300 text-xs text-zinc-500">
              <input
                type="color"
                value={prefs.bookingButtonColor}
                onChange={(event) =>
                  onChange({ bookingButtonColor: event.target.value }, "Buttonfarbe gespeichert.")
                }
                className="h-0 w-0 opacity-0"
              />
              +
            </label>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">6 · Textfarbe</p>
          <div className="mt-3 flex flex-wrap gap-2">
            {textColors.map((color) => (
              <ColorSwatch
                key={color}
                color={color}
                selected={prefs.bookingButtonTextColor.toLowerCase() === color.toLowerCase()}
                onSelect={() => onChange({ bookingButtonTextColor: color }, "Textfarbe gespeichert.")}
              />
            ))}
            <label className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-md border border-dashed border-zinc-300 text-xs text-zinc-500">
              <input
                type="color"
                value={prefs.bookingButtonTextColor}
                onChange={(event) =>
                  onChange({ bookingButtonTextColor: event.target.value }, "Textfarbe gespeichert.")
                }
                className="h-0 w-0 opacity-0"
              />
              +
            </label>
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4 text-xs text-zinc-600">
          {bookingUrl !== tenantBookingUrl && bookingUrl !== locationBookingUrl ? (
            <>
              <div className="flex items-center justify-between">
                <p className="font-semibold text-zinc-900">Buchungslink</p>
                <button
                  type="button"
                  onClick={() => void copyText(bookingUrl, "Buchungslink")}
                  className="rounded-full border border-zinc-200 px-3 py-1 text-[11px] font-semibold text-zinc-700 transition hover:border-zinc-300"
                >
                  In Zwischenablage kopieren
                </button>
              </div>
              <p className="mt-2 break-all font-mono text-[11px]">{bookingUrl}</p>
            </>
          ) : null}
          {!tenantSlug && (
            <p className="mt-2 text-amber-700">
              Hinweis: Der Tenant-Slug konnte nicht automatisch ermittelt werden. Bitte den Link anpassen.
            </p>
          )}
          <div className="mt-3 space-y-2 text-[11px] text-zinc-500">
            <div className="flex items-center justify-between gap-3">
              <p className="break-all">
                Hauptbuchung: <span className="font-mono">{tenantBookingUrl}</span>
              </p>
              <button
                type="button"
                onClick={() => void copyText(tenantBookingUrl, "Hauptbuchungslink")}
                className="shrink-0 rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 transition hover:border-zinc-300"
              >
                Kopieren
              </button>
            </div>
            <div className="flex items-center justify-between gap-3">
              <p className="break-all">
                Standort: <span className="font-mono">{locationBookingUrl}</span>
              </p>
              <button
                type="button"
                onClick={() => void copyText(locationBookingUrl, "Standortlink")}
                className="shrink-0 rounded-full border border-zinc-200 px-2 py-0.5 text-[10px] font-semibold text-zinc-600 transition hover:border-zinc-300"
              >
                Kopieren
              </button>
            </div>
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-4">
          <p className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Vorschau Buchungsbutton</p>
          <div className="relative mt-4 h-40 rounded-lg border border-dashed border-zinc-200 bg-white">
            <BookingButtonPreview prefs={prefs} />
          </div>
        </div>

        <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
          <div className="flex items-center justify-between text-xs font-semibold uppercase tracking-widest text-zinc-500">
            <span>HTML-Code</span>
            <button
              type="button"
              onClick={handleCopy}
              className="rounded-full border border-zinc-200 px-3 py-1 text-[11px] font-semibold text-zinc-700 transition hover:border-zinc-300"
            >
              In Zwischenablage kopieren
            </button>
          </div>
          <p className="mt-2 text-xs text-zinc-500">
            Kopiere den Code in deine Website, damit der Buchungsbutton angezeigt wird.
          </p>
          <pre className="mt-3 max-h-56 overflow-auto rounded-lg border border-zinc-200 bg-zinc-50 p-3 text-[11px] text-zinc-700">
            {snippet}
          </pre>
        </div>
      </div>
    </div>
  );
}

function BookingCustomerNoticeSettings({
  prefs,
  onChange,
}: {
  prefs: BookingPreferencesState;
  onChange: (patch: Partial<BookingPreferencesState>, message: string) => void;
}) {
  const maxLength = 280;
  const [draft, setDraft] = useState(prefs.customerNoticeText);

  useEffect(() => {
    setDraft(prefs.customerNoticeText);
  }, [prefs.customerNoticeText]);

  const remaining = Math.max(0, maxLength - draft.length);

  return (
    <div className="mt-4 space-y-4 rounded-xl border border-zinc-200 bg-white px-4 py-4">
      <ToggleField
        label={prefs.customerNoticeEnabled ? "Kundenhinweise anzeigen" : "Kundenhinweise ausblenden"}
        checked={prefs.customerNoticeEnabled}
        onChange={(value) =>
          onChange(
            { customerNoticeEnabled: value },
            value ? "Kundenhinweise aktiviert." : "Kundenhinweise deaktiviert.",
          )
        }
      />
      <div className="space-y-2">
        <textarea
          value={draft ?? ""}
          onChange={(event) => setDraft(event.target.value.slice(0, maxLength))}
          onBlur={() => {
            if (draft !== prefs.customerNoticeText) {
              onChange({ customerNoticeText: draft }, "Kundenhinweis gespeichert.");
            }
          }}
          rows={4}
          maxLength={maxLength}
          disabled={!prefs.customerNoticeEnabled}
          className="w-full resize-none rounded-lg border border-zinc-300 px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100"
        />
        <p className="text-right text-xs text-zinc-500">Noch {remaining} Zeichen</p>
      </div>
    </div>
  );
}

function CustomerNotificationSettings({
  prefs,
  onChange,
}: {
  prefs: BookingPreferencesState;
  onChange: (patch: Partial<BookingPreferencesState>, message: string) => void;
}) {
  const [replyToDraft, setReplyToDraft] = useState(prefs.emailReplyTo);
  const [emailSenderDraft, setEmailSenderDraft] = useState(prefs.emailSenderName);
  const [smsBrandDraft, setSmsBrandDraft] = useState(prefs.smsBrandName);
  const [smsSenderDraft, setSmsSenderDraft] = useState(prefs.smsSenderName);
  const emailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  const replyToTrimmed = replyToDraft.trim();
  const replyToMissing = prefs.emailReplyToEnabled && !replyToTrimmed;
  const replyToInvalid = Boolean(replyToTrimmed) && !emailPattern.test(replyToTrimmed);
  const replyToError = replyToMissing
    ? "Dieses Feld ist ein Pflichtfeld."
    : replyToInvalid
      ? "Bitte eine gültige E-Mail-Adresse eingeben."
      : null;
  const smsBrandRemaining = Math.max(0, 20 - smsBrandDraft.length);
  const smsSenderRemaining = Math.max(0, 11 - smsSenderDraft.length);

  useEffect(() => {
    setReplyToDraft(prefs.emailReplyTo);
  }, [prefs.emailReplyTo]);

  useEffect(() => {
    setEmailSenderDraft(prefs.emailSenderName);
  }, [prefs.emailSenderName]);

  useEffect(() => {
    setSmsBrandDraft(prefs.smsBrandName);
  }, [prefs.smsBrandName]);

  useEffect(() => {
    setSmsSenderDraft(prefs.smsSenderName);
  }, [prefs.smsSenderName]);

  return (
    <div className="space-y-6">
      <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-zinc-900">Email Reply-To</p>
          <p className="text-xs text-zinc-500">
            Kundenantworten auf Terminbestätigungen, Erinnerungen und Newsletter werden an diese Adresse weitergeleitet.
          </p>
        </div>
        <div className="mt-4 space-y-3">
          <ToggleField
            label="Email Reply-To aktivieren"
            checked={prefs.emailReplyToEnabled}
            onChange={(value) =>
              onChange({ emailReplyToEnabled: value }, value ? "Reply-To aktiviert." : "Reply-To deaktiviert.")
            }
          />
          <div className="space-y-2">
            <input
              type="email"
              value={replyToDraft ?? ""}
              onChange={(event) => setReplyToDraft(event.target.value.slice(0, 120))}
              onBlur={() => {
                if (replyToDraft !== prefs.emailReplyTo && !replyToInvalid) {
                  onChange({ emailReplyTo: replyToTrimmed }, "Reply-To gespeichert.");
                }
              }}
              disabled={!prefs.emailReplyToEnabled}
              className={`w-full rounded-lg border px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none disabled:cursor-not-allowed disabled:bg-zinc-100 ${
                replyToError ? "border-red-400" : "border-zinc-300"
              }`}
            />
            <p className={`text-xs ${replyToError ? "text-red-600" : "text-zinc-500"}`}>
              {replyToError ?? "Füge hier die E-Mail ein."}
            </p>
          </div>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-zinc-900">E-Mail-Absender</p>
          <p className="text-xs text-zinc-500">In E-Mails an deine Kund:innen wird dieser Name als Absender angezeigt.</p>
        </div>
        <input
          type="text"
          value={emailSenderDraft ?? ""}
          onChange={(event) => setEmailSenderDraft(event.target.value.slice(0, 80))}
          onBlur={() => {
            if (emailSenderDraft !== prefs.emailSenderName) {
              onChange({ emailSenderName: emailSenderDraft.trim() }, "E-Mail-Absender gespeichert.");
            }
          }}
          className="mt-3 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none"
        />
      </div>

      <div className="space-y-2">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-zinc-900">Kundenhinweis</p>
          <p className="text-xs text-zinc-500">
            Über den Kundenhinweis kannst du zusätzliche Informationen bei der Buchungsbestätigung übermitteln.
          </p>
        </div>
        <BookingCustomerNoticeSettings prefs={prefs} onChange={onChange} />
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-zinc-900">Firmenname in Textnachrichten</p>
          <p className="text-xs text-zinc-500">Dieser Name wird im Fließtext von SMS-Erinnerungen angezeigt.</p>
        </div>
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={smsBrandDraft ?? ""}
            onChange={(event) => setSmsBrandDraft(event.target.value.slice(0, 20))}
            onBlur={() => {
              if (smsBrandDraft !== prefs.smsBrandName) {
                onChange({ smsBrandName: smsBrandDraft.trim() }, "Firmenname gespeichert.");
              }
            }}
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none"
        />
          <p className="text-right text-xs text-zinc-500">Noch {smsBrandRemaining} Zeichen</p>
        </div>
      </div>

      <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
        <div className="space-y-1">
          <p className="text-sm font-semibold text-zinc-900">SMS-Absender</p>
          <p className="text-xs text-zinc-500">Kund:innen sehen diesen Namen als Absender von SMS-Nachrichten.</p>
        </div>
        <div className="mt-3 space-y-2">
          <input
            type="text"
            value={smsSenderDraft ?? ""}
            onChange={(event) => setSmsSenderDraft(event.target.value.slice(0, 11))}
            onBlur={() => {
              if (smsSenderDraft !== prefs.smsSenderName) {
                onChange({ smsSenderName: smsSenderDraft.trim() }, "SMS-Absender gespeichert.");
              }
            }}
          className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm placeholder:text-zinc-400 focus:border-emerald-500 focus:outline-none"
        />
          <p className="text-right text-xs text-zinc-500">Noch {smsSenderRemaining} Zeichen</p>
        </div>
      </div>
    </div>
  );
}

function BookingBannerSettings({
  locationSlug,
  bannerUrl,
  bannerHeight,
  bannerFit,
  onBannerChange,
  onSettingsChange,
}: {
  locationSlug: string;
  bannerUrl: string | null;
  bannerHeight: number;
  bannerFit: BookingPreferencesState["bookingBannerFit"];
  onBannerChange: (url: string | null) => void;
  onSettingsChange: (patch: Partial<BookingPreferencesState>, message: string) => void;
}) {
  const { pushToast } = useToast();
  const [uploading, setUploading] = useState(false);
  const [heightDraft, setHeightDraft] = useState(bannerHeight);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const bannerImageClass =
    bannerFit === "contain" ? "h-full w-full object-contain" : "h-full w-full object-cover";

  useEffect(() => {
    setHeightDraft(bannerHeight);
  }, [bannerHeight]);

  const handleUpload = async (file: File | null) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) {
      pushToast({ variant: "error", message: "Bitte ein gültiges Bild auswählen." });
      return;
    }
    if (file.size > 6 * 1024 * 1024) {
      pushToast({ variant: "error", message: "Das Bild ist zu groß (max. 6 MB)." });
      return;
    }

    setUploading(true);
    const formData = new FormData();
    formData.set("file", file);
    try {
      const response = await fetch(`/api/backoffice/${locationSlug}/settings/booking-banner`, {
        method: "POST",
        body: formData,
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "Banner konnte nicht gespeichert werden.");
      }
      const nextUrl = payload?.data?.bookingBannerImageUrl ?? null;
      onBannerChange(nextUrl);
      pushToast({ variant: "success", message: "Bannerbild gespeichert." });
    } catch (error) {
      pushToast({
        variant: "error",
        message: error instanceof Error ? error.message : "Banner konnte nicht gespeichert werden.",
      });
    } finally {
      setUploading(false);
      if (inputRef.current) inputRef.current.value = "";
    }
  };

  const handleRemove = async () => {
    setUploading(true);
    try {
      const response = await fetch(`/api/backoffice/${locationSlug}/settings/booking-banner`, {
        method: "DELETE",
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "Banner konnte nicht entfernt werden.");
      }
      onBannerChange(null);
      pushToast({ variant: "success", message: "Bannerbild entfernt." });
    } catch (error) {
      pushToast({
        variant: "error",
        message: error instanceof Error ? error.message : "Banner konnte nicht entfernt werden.",
      });
    } finally {
      setUploading(false);
    }
  };

  const applyHeight = () => {
    if (heightDraft === bannerHeight) return;
    onSettingsChange({ bookingBannerHeight: heightDraft }, "Bannerhöhe gespeichert.");
  };

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_240px]">
      <div className="rounded-xl border border-zinc-200 bg-white px-4 py-4">
        <div
          className="overflow-hidden rounded-lg border border-dashed border-zinc-200 bg-zinc-50"
          style={{ height: `${heightDraft}px` }}
        >
          {bannerUrl ? (
            <img src={bannerUrl} alt="Buchungsbanner" className={bannerImageClass} />
          ) : (
            <div className="flex h-full items-center justify-center text-xs text-zinc-500">
              Kein Bannerbild hinterlegt.
            </div>
          )}
        </div>
        <div className="mt-4 space-y-3 text-xs text-zinc-600">
          <div>
            <p className="font-semibold text-zinc-900">Bannergröße</p>
            <div className="mt-2 flex items-center gap-3">
              <input
                type="range"
                min={120}
                max={360}
                step={10}
                value={heightDraft}
                onChange={(event) => setHeightDraft(Number(event.target.value))}
                onPointerUp={applyHeight}
                onBlur={applyHeight}
                className="w-full"
              />
              <span className="w-12 text-right">{heightDraft}px</span>
            </div>
          </div>
          <div>
            <p className="font-semibold text-zinc-900">Anpassung</p>
            <div className="mt-2 flex flex-col gap-2 text-[12px] text-zinc-700">
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="banner-fit"
                  value="cover"
                  checked={bannerFit === "cover"}
                  onChange={() =>
                    onSettingsChange({ bookingBannerFit: "cover" }, "Banner-Anpassung gespeichert.")
                  }
                  className="h-4 w-4 border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span>Füllend (zugeschnitten)</span>
              </label>
              <label className="flex items-center gap-2">
                <input
                  type="radio"
                  name="banner-fit"
                  value="contain"
                  checked={bannerFit === "contain"}
                  onChange={() =>
                    onSettingsChange({ bookingBannerFit: "contain" }, "Banner-Anpassung gespeichert.")
                  }
                  className="h-4 w-4 border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                />
                <span>Einpassen (komplettes Bild sichtbar)</span>
              </label>
            </div>
          </div>
        </div>
      </div>
      <div className="flex flex-col gap-2">
        <input
          ref={inputRef}
          type="file"
          accept="image/*"
          className="hidden"
          onChange={(event) => handleUpload(event.target.files?.[0] ?? null)}
        />
        <button
          type="button"
          onClick={() => inputRef.current?.click()}
          disabled={uploading}
          className="rounded-full border border-zinc-200 px-4 py-2 text-xs font-semibold text-zinc-700 transition hover:border-zinc-300 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {uploading ? "Lade hoch …" : bannerUrl ? "Banner ändern" : "Banner hochladen"}
        </button>
        {bannerUrl && (
          <button
            type="button"
            onClick={() => void handleRemove()}
            disabled={uploading}
            className="rounded-full border border-red-200 px-4 py-2 text-xs font-semibold text-red-600 transition hover:border-red-300 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Banner entfernen
          </button>
        )}
      </div>
    </div>
  );
}

function BookingButtonPreview({ prefs }: { prefs: BookingPreferencesState }) {
  const buttonStyle: React.CSSProperties = {
    backgroundColor: prefs.bookingButtonColor,
    color: prefs.bookingButtonTextColor,
  };
  const baseClasses =
    "inline-flex items-center gap-2 rounded-full px-5 py-2 text-sm font-semibold shadow-lg transition";

  if (prefs.bookingButtonFloating) {
    const positionClass = prefs.bookingButtonPosition === "right" ? "right-4" : "left-4";
    return (
      <div className="absolute inset-0">
        <div className={`absolute bottom-4 ${positionClass}`}>
          <span className={baseClasses} style={buttonStyle}>
            {prefs.bookingButtonText || "Termin online buchen"}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="flex h-full items-center justify-center">
      <span className={baseClasses} style={buttonStyle}>
        {prefs.bookingButtonText || "Termin online buchen"}
      </span>
    </div>
  );
}

function buildBookingButtonSnippet(prefs: BookingPreferencesState, bookingUrl: string) {
  const safeText = escapeHtml(prefs.bookingButtonText || "Termin online buchen");
  const safeUrl = escapeHtml(bookingUrl);
  const styles = [
    `background:${prefs.bookingButtonColor}`,
    `color:${prefs.bookingButtonTextColor}`,
    "padding:12px 18px",
    "border-radius:999px",
    "font-family:Arial, sans-serif",
    "font-weight:600",
    "text-decoration:none",
    "display:inline-flex",
    "align-items:center",
    "gap:8px",
    "box-shadow:0 12px 30px rgba(15, 23, 42, 0.15)",
  ];

  if (prefs.bookingButtonFloating) {
    styles.push(
      "position:fixed",
      "bottom:24px",
      `${prefs.bookingButtonPosition}:24px`,
      "z-index:9999",
    );
  }

  return [
    "<!-- Booking Button Start -->",
    `<a href="${safeUrl}" style="${styles.join("; ")}" target="_blank" rel="noreferrer">${safeText}</a>`,
    "<!-- Booking Button End -->",
  ].join("\n");
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function ColorSwatch({
  color,
  selected,
  onSelect,
}: {
  color: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      className={`h-8 w-8 rounded-md border ${selected ? "border-emerald-500 ring-2 ring-emerald-200" : "border-transparent"}`}
      style={{ backgroundColor: color }}
      aria-label={`Farbe ${color}`}
    />
  );
}

function BookingPreferencesSettings({
  prefs,
  onChange,
  onShiftPlanToggle,
}: {
  prefs: BookingPreferencesState;
  onChange: (patch: Partial<BookingPreferencesState>) => void;
  onShiftPlanToggle: (value: boolean) => void;
}) {
  const intervalOptions = ["5", "10", "15", "20", "30", "45", "60", "90", "120"].map((value) => ({
    label: `${value} Minuten`,
    value,
  }));
  const manualConfirmationOptions = [
    { value: "single", label: "SMS oder WhatsApp" },
    { value: "both", label: "SMS und WhatsApp" },
  ] as const;
  const manualConfirmationHint =
    "Bei der Auswahl von SMS oder WhatsApp, kann nur SMS oder WhatsApp ausgewählt werden. " +
    "Bei Auswahl SMS und WhatsApp, können bei Buchungen beide Benachrichtigungen ausgewählt werden. " +
    "Achtung! Es entstehen Kosten pro Versand. (Der Versand per E-Mail ist immer aktiv und kann nicht deaktiviert werden).";
  const popularWindowOptions = [
    { value: 30, label: "Letzte 30 Tage" },
    { value: 90, label: "Letzte 90 Tage" },
  ];
  const popularLimitOptions = [
    { value: 4, label: "Top 4" },
    { value: 5, label: "Top 5" },
    { value: 6, label: "Top 6" },
  ];
  const units: { label: string; value: BookingLimitUnit }[] = [
    { label: "Minute(n)", value: "minutes" },
    { label: "Stunde(n)", value: "hours" },
    { label: "Tag(e)", value: "days" },
    { label: "Woche(n)", value: "weeks" },
  ];
  type LimitKey = "minAdvance" | "maxAdvance" | "cancelLimit";
  const stepUiMin = Number.parseInt(prefs.interval ?? "", 10) || 30;
  const maxOffGridLimit = Math.max(0, Math.floor(stepUiMin / 2));

  const clampInt = (value: string, fallback: number, min: number, max: number) => {
    const raw = Number(value);
    if (!Number.isFinite(raw)) return fallback;
    const rounded = Math.round(raw);
    return Math.min(max, Math.max(min, rounded));
  };

  const clampEngineStep = (value: string, fallback: number) => {
    const raw = Number(value);
    if (!Number.isFinite(raw)) return fallback;
    let candidate = Math.min(stepUiMin, Math.max(1, Math.round(raw)));
    if (stepUiMin % candidate === 0) return candidate;
    for (let next = candidate; next >= 1; next -= 1) {
      if (stepUiMin % next === 0) return next;
    }
    return stepUiMin;
  };

  const updateLimit = (key: LimitKey, patch: Partial<BookingLimit>) => {
    onChange({
      [key]: {
        ...prefs[key],
        ...patch,
      },
    } as Partial<BookingPreferencesState>);
  };

  const renderLimitField = (
    key: LimitKey,
    label: string,
    description: string,
  ) => {
    const isCancelLimit = key === "cancelLimit";
    return (
    <div key={key} className="space-y-2 rounded-2xl border border-zinc-200 p-4">
      <div>
        <p className="text-sm font-semibold text-zinc-900">{label}</p>
        <p className="text-xs text-zinc-500">{description}</p>
        {key === "minAdvance" ? (
          <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
            Hinweis: Ist der Wert hoch eingestellt, erscheinen freie Zeiten für heute nicht mehr in der
            Online-Buchung. Kund:innen sehen dann erst Termine ab dem frühesten erlaubten Zeitpunkt.
          </div>
        ) : null}
      </div>
      <div className="flex flex-wrap gap-3">
        {isCancelLimit ? <span className="self-center text-xs text-zinc-500">Spätestens</span> : null}
        <div className="flex items-center gap-2 rounded-xl border border-zinc-300 px-3 py-2">
          <input
            type="number"
            min={0}
            value={prefs[key].value}
            onChange={(event) => {
              const raw = Number(event.target.value);
              updateLimit(key, { value: Number.isFinite(raw) ? Math.max(0, raw) : 0 });
            }}
            className="w-20 border-none bg-transparent text-right text-sm font-semibold focus:outline-none"
          />
          <span className="text-xs text-zinc-500">Einheit</span>
        </div>
        <select
          value={prefs[key].unit}
          onChange={(event) => updateLimit(key, { unit: event.target.value as BookingLimitUnit })}
          className="rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
        >
          {units.map((unit) => (
            <option key={unit.value} value={unit.value}>
              {unit.label}
            </option>
          ))}
        </select>
        {isCancelLimit ? <span className="self-center text-xs text-zinc-500">vor dem Termin</span> : null}
      </div>
    </div>
    );
  };

  return (
    <div className="space-y-10">
      <SettingsCard title="Automatische Buchungsbestätigung">
        <p className="text-sm text-zinc-600">
          Entscheide, ob neue Online-Buchungen ohne manuelle Freigabe bestätigt werden sollen.
        </p>
        <ToggleField
          label={prefs.autoConfirm ? "Automatische Bestätigung aktiv" : "Automatische Bestätigung deaktiviert"}
          checked={prefs.autoConfirm}
          onChange={(value) => onChange({ autoConfirm: value })}
        />
        <div className="mt-4 space-y-2">
          <div className="flex items-center gap-2">
            <span className="text-sm font-medium text-zinc-700">
              Senden von Buchungsbestätigung für manuell erstellte Termine
            </span>
            <span
              title={manualConfirmationHint}
              aria-label={manualConfirmationHint}
              className="inline-flex h-5 w-5 items-center justify-center rounded-full border border-zinc-300 text-[10px] font-semibold text-zinc-600"
            >
              i
            </span>
          </div>
          <select
            value={prefs.manualConfirmationMode}
            onChange={(event) => onChange({ manualConfirmationMode: event.target.value as BookingPreferencesState["manualConfirmationMode"] })}
            className="w-full max-w-xs rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
          >
            {manualConfirmationOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </SettingsCard>

      <SettingsCard title="Termintaktung">
        <p className="text-sm text-zinc-600">
          Bestimmt in welchen Abständen freie Slots in der Online-Buchungsmaske erscheinen.
        </p>
        <select
          value={prefs.interval}
          onChange={(event) => {
            const nextInterval = event.target.value;
            const nextStepUi = Number.parseInt(nextInterval, 10) || stepUiMin;
            const nextEngine = (() => {
              if (nextStepUi % prefs.stepEngineMin === 0 && prefs.stepEngineMin <= nextStepUi) {
                return prefs.stepEngineMin;
              }
              for (let candidate = Math.min(nextStepUi, prefs.stepEngineMin); candidate >= 1; candidate -= 1) {
                if (nextStepUi % candidate === 0) return candidate;
              }
              return nextStepUi;
            })();
            const nextMaxOffset = Math.min(
              prefs.maxOffGridOffsetMin,
              Math.max(0, Math.floor(nextStepUi / 2)),
            );
            onChange({
              interval: nextInterval,
              stepEngineMin: nextEngine,
              maxOffGridOffsetMin: nextMaxOffset,
            });
          }}
          className="mt-4 w-48 rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
        >
          {intervalOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      </SettingsCard>

      <SettingsCard
        title={
          <span className="flex items-center gap-3">
            <span>Smart-Slots</span>
            <InfoPopover label="Info zu Smart-Slots">
              <div className="space-y-2">
                <p className="text-sm font-semibold text-zinc-900">Kurz erklärt</p>
                <p className="text-sm text-zinc-700">
                  Die Termintaktung bleibt das Raster im Kalender. Smart-Slots zeigen nur dann zusätzliche Startzeiten,
                  wenn dadurch echte Leerlaufzeit reduziert wird.
                </p>
                <ul className="list-disc space-y-1 pl-5 text-xs text-zinc-600">
                  <li>Beispiel: 20 Minuten Service bei 30 Minuten Raster - statt 10 Minuten Leerlauf erscheint 09:20.</li>
                  <li>Die Abweichung vom Raster ist begrenzt und es gibt eine Maximalanzahl pro Stunde.</li>
                  <li>Wenn kein Vorteil entsteht, bleibt es bei den normalen Rasterzeiten.</li>
                </ul>
                <p className="text-xs text-zinc-500">Du kannst die Funktion jederzeit deaktivieren.</p>
              </div>
            </InfoPopover>
          </span>
        }
      >
        <p className="text-sm text-zinc-600">
          Fügt zusätzliche Startzeiten ein, wenn dadurch Leerlauf vermieden wird. Die Termintaktung bleibt die normale
          Anzeige im Kalender.
        </p>
        <div className="mt-4 space-y-4">
          <ToggleField
            label={prefs.smartSlotsEnabled ? "Smart-Slots aktiv" : "Smart-Slots deaktiviert"}
            checked={prefs.smartSlotsEnabled}
            onChange={(value) => onChange({ smartSlotsEnabled: value })}
          />
          <div className="grid gap-4 md:grid-cols-2">
            <div className="rounded-2xl border border-zinc-200 p-4">
              <p className="text-sm font-semibold text-zinc-900">Fein-Taktung für Vorschläge (Min.)</p>
              <p className="text-xs text-zinc-500">
                Legt fest, in welchen Minuten-Schritten nach besseren Startzeiten gesucht wird. Kleinere Werte prüfen
                mehr Möglichkeiten, zeigen aber nur Vorteile an. Muss zur Termintaktung passen (z.B. bei {stepUiMin}:
                passende Teiler).
              </p>
              <input
                type="number"
                min={1}
                max={stepUiMin}
                disabled={!prefs.smartSlotsEnabled}
                value={prefs.stepEngineMin}
                onChange={(event) =>
                  onChange({
                    stepEngineMin: clampEngineStep(event.target.value, prefs.stepEngineMin),
                  })
                }
                className="mt-3 w-28 rounded-xl border border-zinc-300 px-3 py-2 text-center text-sm font-semibold focus:border-emerald-500 focus:outline-none disabled:bg-zinc-100"
              />
            </div>
            <div className="rounded-2xl border border-zinc-200 p-4">
              <p className="text-sm font-semibold text-zinc-900">Pufferzeit zwischen Terminen</p>
              <p className="text-xs text-zinc-500">
                Diese Minuten werden bei der Vorschlags-Suche mitgedacht, damit genug Zeit fürs Aufräumen oder
                Umrüsten bleibt. Beispiel: 5 Minuten heißt, dass danach noch 5 Minuten Luft bleiben müssen.
              </p>
              <input
                type="number"
                min={0}
                max={15}
                disabled={!prefs.smartSlotsEnabled}
                value={prefs.bufferMin}
                onChange={(event) =>
                  onChange({
                    bufferMin: clampInt(event.target.value, prefs.bufferMin, 0, 15),
                  })
                }
                className="mt-3 w-28 rounded-xl border border-zinc-300 px-3 py-2 text-center text-sm font-semibold focus:border-emerald-500 focus:outline-none disabled:bg-zinc-100"
              />
            </div>
            <div className="rounded-2xl border border-zinc-200 p-4">
              <p className="text-sm font-semibold text-zinc-900">Minimale Restlücke (Min.)</p>
              <p className="text-xs text-zinc-500">
                Legt fest, ab wann eine freie Restzeit im Tagesplan noch sinnvoll ist. Kleinere Lücken gelten als
                unpraktisch und werden nach Möglichkeit vermieden. Höherer Wert = weniger Mini-Lücken.
              </p>
              <input
                type="number"
                min={5}
                max={30}
                disabled={!prefs.smartSlotsEnabled}
                value={prefs.minGapMin}
                onChange={(event) =>
                  onChange({
                    minGapMin: clampInt(event.target.value, prefs.minGapMin, 5, 30),
                  })
                }
                className="mt-3 w-28 rounded-xl border border-zinc-300 px-3 py-2 text-center text-sm font-semibold focus:border-emerald-500 focus:outline-none disabled:bg-zinc-100"
              />
            </div>
            <div className="rounded-2xl border border-zinc-200 p-4">
              <p className="text-sm font-semibold text-zinc-900">Zusätzliche Vorschläge pro Stunde</p>
              <p className="text-xs text-zinc-500">
                Begrenzt, wie viele zusätzliche Zeiten neben der normalen Termintaktung pro Stunde angezeigt werden.
                0 = nur normale Zeiten, 1–2 = sanfte Ergänzung für bessere Auslastung.
              </p>
              <select
                value={prefs.maxSmartSlotsPerHour}
                disabled={!prefs.smartSlotsEnabled}
                onChange={(event) =>
                  onChange({
                    maxSmartSlotsPerHour: clampInt(event.target.value, prefs.maxSmartSlotsPerHour, 0, 2),
                  })
                }
                className="mt-3 w-28 rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none disabled:bg-zinc-100"
              >
                {[0, 1, 2].map((value) => (
                  <option key={value} value={value}>
                    {value}
                  </option>
                ))}
              </select>
            </div>
            <div className="rounded-2xl border border-zinc-200 p-4">
              <p className="text-sm font-semibold text-zinc-900">Mindest-Vorteil (Min.)</p>
              <p className="text-xs text-zinc-500">
                Ein Smart-Slot erscheint nur, wenn dadurch mindestens diese Minuten Leerlauf eingespart werden.
                Höherer Wert = weniger, dafür nur wirklich sinnvolle Zusatzzeiten.
              </p>
              <input
                type="number"
                min={0}
                max={60}
                disabled={!prefs.smartSlotsEnabled}
                value={prefs.minWasteReductionMin}
                onChange={(event) =>
                  onChange({
                    minWasteReductionMin: clampInt(event.target.value, prefs.minWasteReductionMin, 0, 60),
                  })
                }
                className="mt-3 w-28 rounded-xl border border-zinc-300 px-3 py-2 text-center text-sm font-semibold focus:border-emerald-500 focus:outline-none disabled:bg-zinc-100"
              />
            </div>
            <div className="rounded-2xl border border-zinc-200 p-4">
              <p className="text-sm font-semibold text-zinc-900">Maximale Abweichung vom Raster (Min.)</p>
              <p className="text-xs text-zinc-500">
                Wie weit eine Zusatzzeit neben der normalen Termintaktung liegen darf. Beispiel: Taktung 30 Minuten und
                Wert 10 erlaubt 09:20 statt 09:30. Kleinere Werte halten die Zeiten näher am Raster.
              </p>
              <input
                type="number"
                min={0}
                max={maxOffGridLimit}
                disabled={!prefs.smartSlotsEnabled}
                value={prefs.maxOffGridOffsetMin}
                onChange={(event) =>
                  onChange({
                    maxOffGridOffsetMin: clampInt(event.target.value, prefs.maxOffGridOffsetMin, 0, maxOffGridLimit),
                  })
                }
                className="mt-3 w-28 rounded-xl border border-zinc-300 px-3 py-2 text-center text-sm font-semibold focus:border-emerald-500 focus:outline-none disabled:bg-zinc-100"
              />
            </div>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Buchungslimits">
        <div className="grid gap-4 md:grid-cols-2">
          {renderLimitField(
            "minAdvance",
            "Frühestens buchbar",
            "Wie viele Stunden/Tage im Voraus die erste Buchung möglich ist. Wenn der Wert auf 0 gesetzt ist, gilt „kein Limit“.",
          )}
          {renderLimitField(
            "maxAdvance",
            "Spätestens buchbar",
            "Begrenzt wie weit in der Zukunft Kund:innen Termine buchen können. Wenn der Wert auf 0 gesetzt ist, gilt „kein Limit“.",
          )}
        </div>
      </SettingsCard>

      <SettingsCard title="Stornierungslimit">
        {renderLimitField(
          "cancelLimit",
          "Stornierung erlaubt bis",
          "Nach Ablauf dieser Frist können Kund:innen Termine nicht mehr Online stornieren.",
        )}
      </SettingsCard>

      <SettingsCard title="Leistungen pro Termin">
        <p className="text-sm text-zinc-600">Definiert, wie viele Leistungen pro Buchung kombiniert werden dürfen.</p>
        <div className="mt-4 flex items-center gap-3">
          <input
            type="number"
            min={1}
            max={10}
            value={prefs.servicesPerBooking}
            onChange={(event) => {
              const raw = Number(event.target.value);
              const normalized = Number.isFinite(raw) ? Math.min(10, Math.max(1, raw)) : 1;
              onChange({ servicesPerBooking: normalized });
            }}
            className="w-24 rounded-xl border border-zinc-300 px-3 py-2 text-center text-sm font-semibold focus:border-emerald-500 focus:outline-none"
          />
          <span className="text-sm text-zinc-600">Leistungen pro Termin</span>
        </div>
      </SettingsCard>

      <SettingsCard title="Service-Anzeige">
        <p className="text-sm text-zinc-600">
          Lege fest, wie viele Services initial in der Online-Buchung sichtbar sind.
        </p>
        <div className="mt-4 flex items-center gap-3">
          <input
            type="number"
            min={4}
            max={12}
            value={prefs.serviceListLimit}
            onChange={(event) => {
              const raw = Number(event.target.value);
              const normalized = Number.isFinite(raw) ? Math.min(12, Math.max(4, raw)) : 8;
              onChange({ serviceListLimit: normalized });
            }}
            className="w-24 rounded-xl border border-zinc-300 px-3 py-2 text-center text-sm font-semibold focus:border-emerald-500 focus:outline-none"
          />
          <span className="text-sm text-zinc-600">Services anzeigen</span>
        </div>
      </SettingsCard>

      <SettingsCard title="Beliebte Services">
        <p className="text-sm text-zinc-600">
          Lege fest, wie viele Services als Schnellwahl angezeigt werden und aus welchem Zeitraum die Beliebtheit
          berechnet wird.
        </p>
        <div className="mt-4 grid gap-4 md:grid-cols-2">
          <div className="space-y-2 rounded-2xl border border-zinc-200 p-4">
            <p className="text-sm font-semibold text-zinc-900">Zeitfenster</p>
            <select
              value={prefs.popularServicesWindowDays}
              onChange={(event) => {
                const value = Number(event.target.value);
                onChange({ popularServicesWindowDays: Number.isFinite(value) ? value : 90 });
              }}
              className="w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            >
              {popularWindowOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-2 rounded-2xl border border-zinc-200 p-4">
            <p className="text-sm font-semibold text-zinc-900">Anzahl Schnellwahl</p>
            <select
              value={prefs.popularServicesLimit}
              onChange={(event) => {
                const value = Number(event.target.value);
                onChange({ popularServicesLimit: Number.isFinite(value) ? value : 6 });
              }}
              className="w-full rounded-xl border border-zinc-300 px-3 py-2 text-sm focus:border-emerald-500 focus:outline-none"
            >
              {popularLimitOptions.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
        </div>
      </SettingsCard>

      <SettingsCard title="Mitarbeiter:innen & Darstellung">
        <ToggleField
          label={'Auswahl "Beliebige Mitarbeiterperson" anbieten'}
          checked={prefs.showAnyStaffOption}
          onChange={(value) => onChange({ showAnyStaffOption: value })}
        />
        <ToggleField
          label="Mitarbeiter und Ressourcen kombinieren"
          checked={prefs.combineStaffResources}
          onChange={(value) => onChange({ combineStaffResources: value })}
        />
        <ToggleField
          label="Nachnamen von Mitarbeiter:innen verbergen"
          checked={prefs.hideLastNames}
          onChange={(value) => onChange({ hideLastNames: value })}
        />
      </SettingsCard>

      <SettingsCard title="Schichtplan">
        <p className="text-sm text-zinc-600">
          Wenn du den Schichtplan aktivierst, wird die Verfügbarkeit deiner Mitarbeiter auf Basis des Schichtplans berechnet.
          Ist er deaktiviert, basiert die Verfügbarkeit auf Öffnungszeiten oder individuellen Buchungszeiten.
        </p>
        <ToggleField label="Schichtplan aktivieren" checked={prefs.shiftPlan} onChange={onShiftPlanToggle} />
        {prefs.shiftPlan && (
          <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
            Der Schichtplan wurde aktiviert. Trage Schichten ein, damit deine Mitarbeiter für Buchungen verfügbar sind.
          </div>
        )}
      </SettingsCard>
    </div>
  );
}
function ToggleField({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (value: boolean) => void;
  disabled?: boolean;
}) {
  return (
    <div className="mt-3 flex items-center gap-3">
      <button
        type="button"
        onClick={() => {
          if (disabled) return;
          onChange(!checked);
        }}
        aria-pressed={checked}
        aria-disabled={disabled}
        disabled={disabled}
        className={`relative inline-flex h-7 w-12 flex-shrink-0 items-center rounded-full transition ${
          disabled ? "bg-zinc-200" : checked ? "bg-emerald-500" : "bg-zinc-300"
        }`}
      >
        <span
          className={`inline-block h-5 w-5 transform rounded-full shadow transition ${
            disabled ? "bg-zinc-100" : "bg-white"
          } ${checked ? "translate-x-[1.6rem]" : "translate-x-1"}`}
        />
      </button>
      <span className={`text-sm font-medium ${disabled ? "text-zinc-400" : "text-zinc-700"}`}>
        {label}
      </span>
    </div>
  );
}
