"use client";

import { useEffect, useMemo, useState, type FormEvent } from "react";
import { CheckCircle2, Link as LinkIcon, Shield, BellRing, HelpCircle } from "lucide-react";
import useSWR from "swr";

import {
  SLOT_INTERVAL_OPTIONS,
  loadUserPreferences,
  saveUserPreferences,
  type UserPreferences,
} from "@/lib/user-preferences";

async function fetcherJson(url: string) {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) {
    throw new Error("Session konnte nicht geladen werden.");
  }
  return res.json();
}

type MenuItem = {
  id: string;
  label: string;
  description: string;
};

const MENU_ITEMS: MenuItem[] = [
  { id: "account", label: "Account & Login", description: "Zugangsdaten und Sprache verwalten" },
  { id: "calendar", label: "Kalendereinstellungen", description: "Genauigkeit von Tages- & Wochenansicht" },
  { id: "sync", label: "Kalendersynchronisation", description: "Anbindung an externe Kalender" },
  { id: "notifications", label: "Benachrichtigung & Support", description: "Kontaktwege & Hilfekanäle" },
];

const intervalLabels: Record<number, string> = {
  5: "5 Minuten",
  10: "10 Minuten",
  15: "15 Minuten",
  30: "30 Minuten",
};

export default function UserProfilePage() {
  const [activeSection, setActiveSection] = useState<MenuItem["id"]>("account");
  const { data: session } = useSWR<{ email: string } | null>("/api/session", fetcherJson);
  const [userEmail, setUserEmail] = useState("");
  const [language, setLanguage] = useState("de");
  const [slotInterval, setSlotInterval] = useState(30);
  const [accountStatus, setAccountStatus] = useState<string | null>(null);
  const [passwordStatus, setPasswordStatus] = useState<string | null>(null);
  const [notificationPrefs, setNotificationPrefs] = useState({
    email: true,
    sms: true,
    productUpdates: false,
  });

  useEffect(() => {
    const prefs = loadUserPreferences();
    setSlotInterval(prefs.calendarSlotIntervalMinutes);
  }, []);

  useEffect(() => {
    if (session?.email) {
      setUserEmail(session.email);
    }
  }, [session]);

  const slotsPerHour = useMemo(() => (slotInterval ? Math.round(60 / slotInterval) : 2), [slotInterval]);

  const handleAccountSave = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAccountStatus(null);
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ email: userEmail }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setAccountStatus(json.error ?? "Konnte nicht speichern.");
      } else {
        setAccountStatus("E-Mail gespeichert.");
      }
    } catch (error) {
      setAccountStatus("Speichern fehlgeschlagen.");
    }
  };

  const handlePasswordChange = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPasswordStatus(null);
    const formData = new FormData(event.currentTarget as HTMLFormElement);
    const currentPassword = formData.get("currentPassword");
    const newPassword = formData.get("newPassword");
    const confirm = formData.get("confirmPassword");
    if (newPassword !== confirm) {
      setPasswordStatus("Passwörter stimmen nicht überein.");
      return;
    }
    try {
      const res = await fetch("/api/profile", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ currentPassword, newPassword }),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) {
        setPasswordStatus(json.error ?? "Konnte nicht speichern.");
      } else {
        setPasswordStatus("Passwort aktualisiert. Bitte neu einloggen.");
      }
    } catch (error) {
      setPasswordStatus("Speichern fehlgeschlagen.");
    }
  };

  const handleIntervalChange = (value: number) => {
    setSlotInterval(value);
    const next: UserPreferences = saveUserPreferences({ calendarSlotIntervalMinutes: value });
    setAccountStatus(`Kalendergenauigkeit auf ${intervalLabels[next.calendarSlotIntervalMinutes]} gesetzt.`);
  };

  return (
    <div className="flex flex-col gap-8 lg:flex-row">
      <aside className="w-full max-w-xs rounded-2xl border border-zinc-200 bg-white p-4 shadow-sm lg:sticky lg:top-6">
        <h2 className="px-3 text-xs font-semibold uppercase tracking-widest text-zinc-500">Benutzerprofil</h2>
        <nav className="mt-4 flex flex-col gap-1">
          {MENU_ITEMS.map((item) => {
            const isActive = activeSection === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveSection(item.id)}
                className={`rounded-xl px-3 py-3 text-left transition ${
                  isActive ? "bg-zinc-900 text-white shadow" : "text-zinc-600 hover:bg-zinc-100"
                }`}
              >
                <p className="text-sm font-semibold">{item.label}</p>
                <p className={`text-xs ${isActive ? "text-zinc-200" : "text-zinc-500"}`}>{item.description}</p>
              </button>
            );
          })}
        </nav>
      </aside>

      <div className="flex min-w-0 flex-1 flex-col gap-6">
        {activeSection === "account" && (
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold text-zinc-900">Account & Login</h3>
            <p className="text-sm text-zinc-500">Verwalte E-Mail-Adresse, Passwort und Sprache.</p>
            <form onSubmit={handleAccountSave} className="mt-6 space-y-4">
              <div>
                <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">E-Mail-Adresse</label>
                <input
                  type="email"
                  value={userEmail}
                  onChange={(event) => setUserEmail(event.target.value)}
                  className="mt-2 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                />
              </div>
              <div>
                <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Sprache</label>
                <select
                  value={language}
                  onChange={(event) => setLanguage(event.target.value)}
                  className="mt-2 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  disabled
                >
                  <option value="de">Deutsch (bald mehr Auswahl)</option>
                </select>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  className="rounded-full bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800"
                >
                  Änderungen speichern
                </button>
                {accountStatus && <p className="text-xs text-zinc-500">{accountStatus}</p>}
              </div>
            </form>

            <hr className="my-6 border-zinc-200" />

            <form onSubmit={handlePasswordChange} className="space-y-4">
              <h4 className="text-sm font-semibold text-zinc-900">Passwort ändern</h4>
              <div className="grid gap-4 md:grid-cols-2">
                <div className="md:col-span-2">
                  <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Aktuelles Passwort</label>
                  <input
                    type="password"
                    placeholder="••••••••"
                    name="currentPassword"
                    className="mt-2 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Neues Passwort</label>
                  <input
                    type="password"
                    placeholder="Neues Passwort"
                    name="newPassword"
                    className="mt-2 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Passwort wiederholen</label>
                  <input
                    type="password"
                    placeholder="Passwort bestätigen"
                    name="confirmPassword"
                    className="mt-2 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                  />
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="submit"
                  className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100"
                >
                  Passwort aktualisieren
                </button>
                {passwordStatus && <p className="text-xs text-zinc-500">{passwordStatus}</p>}
              </div>
            </form>
          </section>
        )}

        {activeSection === "calendar" && (
          <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h3 className="text-xl font-semibold text-zinc-900">Kalendereinstellungen</h3>
            <p className="text-sm text-zinc-500">Bestimme, wie fein die Tages- und Wochenansicht unterteilt ist.</p>
            <div className="mt-6 space-y-4">
              <div>
                <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Kalenderintervalle</label>
                <select
                  value={slotInterval}
                  onChange={(event) => handleIntervalChange(Number(event.target.value))}
                  className="mt-2 w-full rounded-lg border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                >
                  {SLOT_INTERVAL_OPTIONS.map((option) => (
                    <option key={option} value={option}>
                      {intervalLabels[option]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 px-4 py-3 text-sm text-zinc-700">
                Bei {intervalLabels[slotInterval]} entstehen <strong>{slotsPerHour} Slots</strong> pro Stunde. Kleinere Intervalle
                vergrößern automatisch die Kalenderhöhe in der Tages- und Wochenansicht.
              </div>
            </div>
          </section>
        )}

        {activeSection === "sync" && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
              <h3 className="text-xl font-semibold text-zinc-900">Kalendersynchronisation</h3>
              <p className="text-sm text-zinc-500">Verbinde externe Kalender, um Termine automatisch abzugleichen.</p>
              <div className="mt-6 grid gap-4 md:grid-cols-2">
                {[
                  { name: "Google Calendar", status: "In Vorbereitung", icon: <LinkIcon className="h-4 w-4 text-zinc-400" /> },
                  { name: "Outlook / Office 365", status: "In Vorbereitung", icon: <LinkIcon className="h-4 w-4 text-zinc-400" /> },
                  { name: "Apple Calendar (ICS)", status: "Bald verfügbar", icon: <LinkIcon className="h-4 w-4 text-zinc-400" /> },
                  { name: "Stundenliste Sync", status: "Aktiv", icon: <CheckCircle2 className="h-4 w-4 text-emerald-500" /> },
                ].map((provider) => (
                  <div key={provider.name} className="rounded-xl border border-zinc-200 p-4">
                    <div className="flex items-center justify-between">
                      <p className="font-semibold text-zinc-900">{provider.name}</p>
                      {provider.icon}
                    </div>
                    <p className="text-sm text-zinc-500">{provider.status}</p>
                    <button className="mt-3 rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100">
                      {provider.status === "Aktiv" ? "Verwalten" : "Benachrichtigen"}
                    </button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        )}

        {activeSection === "notifications" && (
          <section className="space-y-4">
            <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
              <h3 className="text-xl font-semibold text-zinc-900">Benachrichtigung & Support</h3>
              <p className="text-sm text-zinc-500">
                Lege fest, wie das Team über Systemereignisse informiert wird und wie du Support erhältst.
              </p>
              <div className="mt-6 space-y-4">
                <div className="rounded-xl border border-zinc-200 p-4">
                  <div className="flex items-center gap-2">
                    <BellRing className="h-4 w-4 text-zinc-400" />
                    <p className="font-semibold text-zinc-900">System-Benachrichtigungen</p>
                  </div>
                  <div className="mt-3 space-y-2 text-sm text-zinc-700">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={notificationPrefs.email}
                        onChange={(event) => setNotificationPrefs((prev) => ({ ...prev, email: event.target.checked }))}
                        className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                      />
                      E-Mails bei wichtigen Ereignissen (Empfohlen)
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={notificationPrefs.sms}
                        onChange={(event) => setNotificationPrefs((prev) => ({ ...prev, sms: event.target.checked }))}
                        className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                      />
                      SMS für kritische Ausfälle
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={notificationPrefs.productUpdates}
                        onChange={(event) =>
                          setNotificationPrefs((prev) => ({ ...prev, productUpdates: event.target.checked }))
                        }
                        className="h-4 w-4 rounded border-zinc-300 text-zinc-900 focus:ring-zinc-900"
                      />
                      Produkt-Updates und Beta-Features
                    </label>
                  </div>
                </div>
                <div className="rounded-xl border border-dashed border-zinc-300 bg-zinc-50 p-4 text-sm text-zinc-700">
                  <div className="flex items-center gap-2">
                    <HelpCircle className="h-4 w-4 text-zinc-400" />
                    <p className="font-semibold">Support-Kanal</p>
                  </div>
                  <p className="mt-2">Schreibe uns jederzeit an support@codex-calendar.local oder starte den Chat im Kalender.</p>
                  <button className="mt-3 rounded-full bg-zinc-900 px-4 py-2 text-xs font-semibold text-white transition hover:bg-zinc-800">
                    Support kontaktieren
                  </button>
                </div>
              </div>
            </div>
          </section>
        )}

        <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
          <div className="flex flex-wrap items-center gap-3">
            <Shield className="h-6 w-6 text-zinc-400" />
            <div>
              <p className="font-semibold text-zinc-900">Datensicherheit</p>
              <p className="text-sm text-zinc-500">Alle Änderungen werden lokal gespeichert und später serverseitig synchronisiert.</p>
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}
