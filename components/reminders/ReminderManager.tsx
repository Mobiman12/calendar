"use client";

import { useMemo, useState, useTransition } from "react";
import { Plus, Pencil, Trash2, X } from "lucide-react";
import { useRouter } from "next/navigation";

import type { ReminderFormInput, ReminderRule } from "@/lib/reminders";
import { formatReminderOffset, splitOffsetMinutes } from "@/lib/reminders";
import { DEFAULT_WHATSAPP_TEMPLATE, WHATSAPP_TEMPLATE_OPTIONS } from "@/lib/notifications/whatsapp-templates";
import { useToast } from "@/components/ui/ToastProvider";

export type ReminderActionResult = { success: true } | { success: false; error: string };

type ReminderManagerProps = {
  reminders: ReminderRule[];
  onCreate: (input: ReminderFormInput) => Promise<ReminderActionResult>;
  onUpdate: (id: string, input: ReminderFormInput) => Promise<ReminderActionResult>;
  onDelete: (id: string) => Promise<ReminderActionResult>;
  variant?: "page" | "embedded";
};

type EditState = { mode: "create" } | { mode: "edit"; reminderId: string } | null;

const HOURS = Array.from({ length: 24 }, (_, idx) => idx);
const MINUTES = Array.from({ length: 12 }, (_, idx) => idx * 5);

export function ReminderManager({
  reminders,
  onCreate,
  onUpdate,
  onDelete,
  variant = "page",
}: ReminderManagerProps) {
  const router = useRouter();
  const { pushToast } = useToast();
  const [isPending, startTransition] = useTransition();
  const [editState, setEditState] = useState<EditState>(null);
  const isEmbedded = variant === "embedded";

  const [message, setMessage] = useState("");
  const [days, setDays] = useState(1);
  const [hours, setHours] = useState(0);
  const [minutes, setMinutes] = useState(0);
  const [timing, setTiming] = useState<"BEFORE" | "AFTER">("BEFORE");
  const [sendEmail, setSendEmail] = useState(true);
  const [sendSms, setSendSms] = useState(false);
  const [sendWhatsapp, setSendWhatsapp] = useState(false);
  const [whatsappTemplateKey, setWhatsappTemplateKey] = useState(DEFAULT_WHATSAPP_TEMPLATE);

  const reminderMap = useMemo(() => new Map(reminders.map((reminder) => [reminder.id, reminder])), [reminders]);
  const whatsappTemplateLabels = useMemo(
    () => new Map(WHATSAPP_TEMPLATE_OPTIONS.map((option) => [option.key, option.label])),
    [],
  );

  const resetForm = () => {
    setMessage("");
    setDays(1);
    setHours(0);
    setMinutes(0);
    setTiming("BEFORE");
    setSendEmail(true);
    setSendSms(false);
    setSendWhatsapp(false);
    setWhatsappTemplateKey(DEFAULT_WHATSAPP_TEMPLATE);
  };

  const openCreate = () => {
    if (isPending) return;
    resetForm();
    setEditState({ mode: "create" });
  };

  const openEdit = (reminderId: string) => {
    if (isPending) return;
    const reminder = reminderMap.get(reminderId);
    if (!reminder) {
      pushToast({ variant: "error", message: "Erinnerung nicht gefunden." });
      return;
    }
    const parts = splitOffsetMinutes(reminder.offsetMinutes);
    setMessage(reminder.message);
    setDays(parts.days);
    setHours(parts.hours);
    setMinutes(parts.minutes);
    setTiming(reminder.timing);
    setSendEmail(reminder.channels.includes("EMAIL"));
    setSendSms(reminder.channels.includes("SMS"));
    setSendWhatsapp(reminder.channels.includes("WHATSAPP"));
    setWhatsappTemplateKey(reminder.whatsappTemplateKey ?? DEFAULT_WHATSAPP_TEMPLATE);
    setEditState({ mode: "edit", reminderId });
  };

  const closeDrawer = () => {
    if (isPending) return;
    setEditState(null);
    resetForm();
  };

  const validateForm = () => {
    const trimmed = message.trim();
    const offset = days * 24 * 60 + hours * 60 + minutes;
    const requiresMessage = sendEmail || sendSms;
    if (requiresMessage && !trimmed) {
      pushToast({ variant: "error", message: "Bitte eine Nachricht für E-Mail oder SMS eingeben." });
      return false;
    }
    if (!sendEmail && !sendSms && !sendWhatsapp) {
      pushToast({ variant: "error", message: "Bitte mindestens einen Versandkanal auswählen." });
      return false;
    }
    if (sendWhatsapp && !whatsappTemplateKey) {
      pushToast({ variant: "error", message: "Bitte eine WhatsApp-Vorlage auswählen." });
      return false;
    }
    if (offset <= 0) {
      pushToast({ variant: "error", message: "Bitte einen Zeitabstand größer als 0 wählen." });
      return false;
    }
    return true;
  };

  const submitReminder = () => {
    if (!editState || !validateForm()) return;
    const payload: ReminderFormInput = {
      message,
      days,
      hours,
      minutes,
      timing,
      sendEmail,
      sendSms,
      sendWhatsapp,
      whatsappTemplateKey,
    };
    startTransition(async () => {
      const result =
        editState.mode === "create"
          ? await onCreate(payload)
          : await onUpdate(editState.reminderId, payload);
      if (!result.success) {
        pushToast({ variant: "error", message: result.error });
        return;
      }
      pushToast({
        variant: "success",
        message: editState.mode === "create" ? "Erinnerung gespeichert." : "Erinnerung aktualisiert.",
      });
      router.refresh();
      closeDrawer();
    });
  };

  const handleDelete = (reminderId: string) => {
    if (isPending) return;
    if (!confirm("Erinnerung wirklich löschen?")) return;
    startTransition(async () => {
      const result = await onDelete(reminderId);
      if (!result.success) {
        pushToast({ variant: "error", message: result.error });
        return;
      }
      pushToast({ variant: "success", message: "Erinnerung gelöscht." });
      router.refresh();
    });
  };

  return (
    <section className={isEmbedded ? "space-y-4" : "space-y-6"}>
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <p className="text-xs uppercase tracking-widest text-zinc-500">Erinnerungen</p>
          <h1 className={`${isEmbedded ? "text-xl" : "text-3xl"} font-semibold text-zinc-900`}>
            Terminerinnerungen
          </h1>
        </div>
        <button
          type="button"
          onClick={openCreate}
          className="inline-flex items-center gap-2 rounded-full bg-emerald-500 px-4 py-2 text-sm font-semibold text-white transition hover:bg-emerald-600"
        >
          <Plus className="h-4 w-4" />
          Neue Erinnerung
        </button>
      </header>

      <div className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <div className="overflow-hidden rounded-xl border border-zinc-100">
          <table className="w-full text-sm">
            <thead className="bg-zinc-50 text-xs uppercase tracking-wide text-zinc-500">
              <tr>
                <th className="px-4 py-3 text-left">Nachricht</th>
                <th className="px-4 py-3 text-left">Zeit</th>
                <th className="px-4 py-3 text-left">Versand per</th>
                <th className="px-4 py-3 text-right">Aktion</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-100">
              {reminders.length === 0 ? (
                <tr>
                  <td colSpan={4} className="px-4 py-6 text-center text-sm text-zinc-500">
                    Noch keine Erinnerungen angelegt.
                  </td>
                </tr>
              ) : (
                reminders.map((reminder) => (
                  <tr key={reminder.id} className="hover:bg-zinc-50/50">
                    <td className="px-4 py-4">
                      <p className="max-w-[420px] truncate text-zinc-900">
                        {reminder.message
                          ? reminder.message
                          : `WhatsApp-Vorlage: ${
                              whatsappTemplateLabels.get(reminder.whatsappTemplateKey) ?? "Termin-Erinnerung"
                            }`}
                      </p>
                    </td>
                    <td className="px-4 py-4 text-zinc-700">{formatReminderOffset(reminder)}</td>
                    <td className="px-4 py-4">
                      <div className="flex flex-wrap gap-2">
                        {reminder.channels.includes("EMAIL") ? (
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                            E-Mail
                          </span>
                        ) : null}
                        {reminder.channels.includes("SMS") ? (
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                            SMS
                          </span>
                        ) : null}
                        {reminder.channels.includes("WHATSAPP") ? (
                          <span className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-xs font-semibold text-emerald-700">
                            WhatsApp
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-4 py-4">
                      <div className="flex justify-end gap-2">
                        <button
                          type="button"
                          onClick={() => openEdit(reminder.id)}
                          className="rounded-full border border-zinc-200 p-2 text-zinc-600 hover:border-zinc-300 hover:text-zinc-800"
                          aria-label="Erinnerung bearbeiten"
                        >
                          <Pencil className="h-4 w-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(reminder.id)}
                          className="rounded-full border border-zinc-200 p-2 text-zinc-600 hover:border-rose-200 hover:text-rose-600"
                          aria-label="Erinnerung löschen"
                        >
                          <Trash2 className="h-4 w-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>
      </div>

      {editState ? (
        <div
          className="fixed inset-0 z-50 flex justify-end bg-black/40"
          onClick={(event) => {
            if (event.target === event.currentTarget) {
              closeDrawer();
            }
          }}
        >
          <div className="flex h-full w-full max-w-md flex-col rounded-l-3xl border border-zinc-200 bg-white shadow-2xl">
            <header className="flex items-center justify-between border-b border-zinc-200 px-6 py-4">
              <div>
                <p className="text-xs uppercase tracking-widest text-zinc-400">
                  {editState.mode === "create" ? "Neue Erinnerung" : "Erinnerung bearbeiten"}
                </p>
                <h2 className="text-2xl font-semibold text-zinc-900">Terminerinnerung</h2>
              </div>
              <button
                type="button"
                onClick={closeDrawer}
                className="rounded-full border border-zinc-300 p-2 text-zinc-500 transition hover:bg-zinc-100"
              >
                <X className="h-4 w-4" />
              </button>
            </header>

            <div className="flex-1 overflow-y-auto px-6 py-6">
              <div className="space-y-6">
                <label className="block text-sm font-semibold text-zinc-900">
                  Nachricht (E-Mail/SMS)
                  <textarea
                    value={message}
                    onChange={(event) => setMessage(event.target.value)}
                    rows={4}
                    className="mt-2 w-full rounded-xl border border-zinc-200 px-4 py-3 text-sm text-zinc-700 focus:border-emerald-400 focus:outline-none"
                    placeholder="Denk dran: Dein Termin ist bald."
                  />
                  <p className="mt-2 text-xs text-zinc-500">
                    WhatsApp nutzt die ausgewählte Vorlage aus dem WhatsApp-Manager.
                  </p>
                </label>

                <div className="grid gap-4 md:grid-cols-3">
                  <label className="block text-sm font-semibold text-zinc-900">
                    Tage *
                    <input
                      type="number"
                      min={0}
                      max={365}
                      value={days}
                      onChange={(event) => setDays(Number(event.target.value))}
                      className="mt-2 w-full rounded-xl border border-zinc-200 px-4 py-3 text-sm text-zinc-700 focus:border-emerald-400 focus:outline-none"
                    />
                  </label>
                  <label className="block text-sm font-semibold text-zinc-900">
                    Stunden *
                    <select
                      value={hours}
                      onChange={(event) => setHours(Number(event.target.value))}
                      className="mt-2 w-full rounded-xl border border-zinc-200 px-4 py-3 text-sm text-zinc-700 focus:border-emerald-400 focus:outline-none"
                    >
                      {HOURS.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                  <label className="block text-sm font-semibold text-zinc-900">
                    Minuten *
                    <select
                      value={minutes}
                      onChange={(event) => setMinutes(Number(event.target.value))}
                      className="mt-2 w-full rounded-xl border border-zinc-200 px-4 py-3 text-sm text-zinc-700 focus:border-emerald-400 focus:outline-none"
                    >
                      {MINUTES.map((value) => (
                        <option key={value} value={value}>
                          {value}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <label className="block text-sm font-semibold text-zinc-900">
                  Versand *
                  <select
                    value={timing}
                    onChange={(event) => setTiming(event.target.value === "AFTER" ? "AFTER" : "BEFORE")}
                    className="mt-2 w-full rounded-xl border border-zinc-200 px-4 py-3 text-sm text-zinc-700 focus:border-emerald-400 focus:outline-none"
                  >
                    <option value="BEFORE">vor dem Termin</option>
                    <option value="AFTER">nach dem Termin</option>
                  </select>
                </label>

                <div className="space-y-2 text-sm">
                  <p className="font-semibold text-zinc-900">Versand per</p>
                  <label className="inline-flex items-center gap-2 text-zinc-700">
                    <input
                      type="checkbox"
                      checked={sendEmail}
                      onChange={(event) => setSendEmail(event.target.checked)}
                      className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    E-Mail
                  </label>
                  <label className="ml-4 inline-flex items-center gap-2 text-zinc-700">
                    <input
                      type="checkbox"
                      checked={sendSms}
                      onChange={(event) => setSendSms(event.target.checked)}
                      className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    SMS
                  </label>
                  <label className="ml-4 inline-flex items-center gap-2 text-zinc-700">
                    <input
                      type="checkbox"
                      checked={sendWhatsapp}
                      onChange={(event) => setSendWhatsapp(event.target.checked)}
                      className="h-4 w-4 rounded border-zinc-300 text-emerald-600 focus:ring-emerald-500"
                    />
                    WhatsApp
                  </label>
                  {sendWhatsapp ? (
                    <label className="mt-3 block text-sm font-semibold text-zinc-900">
                      WhatsApp-Vorlage
                      <select
                        value={whatsappTemplateKey}
                        onChange={(event) =>
                          setWhatsappTemplateKey(
                            (event.target.value as typeof WHATSAPP_TEMPLATE_OPTIONS[number]["key"]) ??
                              DEFAULT_WHATSAPP_TEMPLATE,
                          )
                        }
                        className="mt-2 w-full rounded-xl border border-zinc-200 px-4 py-3 text-sm text-zinc-700 focus:border-emerald-400 focus:outline-none"
                      >
                        {WHATSAPP_TEMPLATE_OPTIONS.map((option) => (
                          <option key={option.key} value={option.key}>
                            {option.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  ) : null}
                </div>
              </div>
            </div>

            <footer className="flex items-center justify-between border-t border-zinc-200 px-6 py-4">
              <button
                type="button"
                onClick={closeDrawer}
                className="rounded-full border border-zinc-200 px-4 py-2 text-sm font-semibold text-zinc-600 hover:border-zinc-300"
              >
                Abbrechen
              </button>
              <button
                type="button"
                onClick={submitReminder}
                disabled={isPending}
                className="rounded-full bg-emerald-500 px-5 py-2 text-sm font-semibold text-white shadow-sm hover:bg-emerald-600 disabled:cursor-not-allowed disabled:opacity-70"
              >
                Speichern
              </button>
            </footer>
          </div>
        </div>
      ) : null}
    </section>
  );
}
