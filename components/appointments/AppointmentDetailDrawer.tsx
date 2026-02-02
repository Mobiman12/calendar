"use client";

import { format, formatDistanceToNow, min as minDate, max as maxDate } from "date-fns";
import { de } from "date-fns/locale";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { AppointmentDetailPayload } from "@/components/appointments/types";
import type { BookingActor } from "@/components/dashboard/booking-pin-types";
import { useBookingPinSession } from "@/components/dashboard/BookingPinSessionContext";
import { useToast } from "@/components/ui/ToastProvider";
import { extractColorMetadata, isColorPrecheckComplete } from "@/lib/color-consultation";

function isAdminRoleValue(role?: string | null): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  const adminTokens = new Set(["2", "admin", "administrator", "superadmin", "super-admin", "owner"]);
  if (adminTokens.has(normalized)) {
    return true;
  }
  return false;
}

function isRoleOneValue(role?: string | null): boolean {
  if (!role) return false;
  const normalized = role.trim().toLowerCase();
  if (normalized.length === 0) {
    return false;
  }
  const staffTokens = new Set(["1", "mitarbeiter", "employee", "staff", "team"]);
  return staffTokens.has(normalized);
}

interface AppointmentDetailDrawerProps {
  open: boolean;
  onClose: () => void;
  loading: boolean;
  error: string | null;
  detail: AppointmentDetailPayload | null;
  onRetry: () => void;
  locationSlug: string;
  onReload: () => void;
  onDataChanged?: () => void;
  onEdit?: (detail: AppointmentDetailPayload) => void;
  activeItemId?: string | null;
  ensureBookingActor: (contextLabel?: string) => Promise<BookingActor>;
}

type AppointmentStatusValue = AppointmentDetailPayload["appointment"]["status"];
type PaymentStatusValue = AppointmentDetailPayload["appointment"]["paymentStatus"];

export function AppointmentDetailDrawer({
  open,
  onClose,
  loading,
  error,
  detail,
  onRetry,
  locationSlug,
  onReload,
  onDataChanged,
  onEdit,
  activeItemId,
  ensureBookingActor,
}: AppointmentDetailDrawerProps) {
  const { pushToast } = useToast();
  const { actor, registerActivity, secondsRemaining } = useBookingPinSession();
  const isAdminActor = isAdminRoleValue(actor?.role);
  const within24h = useMemo(() => {
    if (!detail) return true;
    const endRef = detail.appointment.endsAt ?? detail.appointment.startsAt ?? null;
    if (!endRef) return true;
    const limit = new Date(endRef).getTime() + 24 * 60 * 60 * 1000;
    return new Date().getTime() <= limit;
  }, [detail]);
  const activityRef = useRef(registerActivity);
  useEffect(() => {
    activityRef.current = registerActivity;
  }, [registerActivity]);
  const handleInteraction = useCallback(() => {
    activityRef.current();
  }, []);
  useEffect(() => {
    if (open) {
      registerActivity();
    }
  }, [open, registerActivity]);

  useEffect(() => {
    if (!open) return;
    const id = window.requestAnimationFrame(() => {
      const active = document.activeElement as HTMLElement | null;
      if (active && typeof active.blur === "function") {
        active.blur();
      }
    });
    return () => window.cancelAnimationFrame(id);
  }, [open]);

  useEffect(() => {
    if (open && (!actor || secondsRemaining <= 0)) {
      onClose();
    }
  }, [actor, secondsRemaining, open, onClose]);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(false);
  const [showCancelForm, setShowCancelForm] = useState(false);
  const [cancelReason, setCancelReason] = useState("");
  const [paymentError, setPaymentError] = useState<string | null>(null);
  const [paymentLoading, setPaymentLoading] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [deleteLoading, setDeleteLoading] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [showPaymentNote, setShowPaymentNote] = useState(false);
  const [paymentNote, setPaymentNote] = useState("");
  const [pendingPaymentStatus, setPendingPaymentStatus] = useState<PaymentStatusValue | null>(null);
  const [paymentAmount, setPaymentAmount] = useState<string>("");
  const [removeError, setRemoveError] = useState<string | null>(null);
  const [removingItemId, setRemovingItemId] = useState<string | null>(null);
  const headerTitle = useMemo(() => {
    if (!detail) return "Termin";
    const { start } = getAppointmentBounds(detail);
    return `Termin ${format(start, "dd.MM.yyyy")}`;
  }, [detail]);
  const assignedStaffCount = detail
    ? Array.from(
        new Set(
          detail.appointment.items
            .map((item) => item.staff?.id?.trim())
            .filter((id): id is string => Boolean(id && id.length)),
        ),
      ).length
    : 0;
  const colorMetadata = detail ? extractColorMetadata(detail.appointment.metadata) : null;
  const isColorRequest = Boolean(colorMetadata?.request);
  const confirmLabel =
    isColorRequest && detail?.appointment.status === "PENDING" ? "Termin bestaetigen" : undefined;

  useEffect(() => {
    setStatusError(null);
    setStatusLoading(false);
    setShowCancelForm(false);
    setCancelReason("");
    setPaymentError(null);
    setPaymentLoading(false);
    setShowPaymentNote(false);
    setPaymentNote("");
    setPendingPaymentStatus(null);
    setPaymentAmount("");
    setDeleteError(null);
    setDeleteLoading(false);
    setShowDeleteConfirm(false);
    setRemoveError(null);
    setRemovingItemId(null);
  }, [detail?.appointment.id, detail?.appointment.status, detail?.appointment.paymentStatus]);

  const handleStatusChange = useMemo(() => {
    if (!detail) return async () => false;
    const appointmentId = detail.appointment.id;
    return async (
      targetStatus: AppointmentDetailPayload["appointment"]["status"],
      options?: { reason?: string },
    ): Promise<boolean> => {
      if (statusLoading) return false;
      let actor: BookingActor;
      try {
        actor = await ensureBookingActor();
      } catch {
        return false;
      }
      const trimmedReason = options?.reason?.trim() ?? "";
      if (targetStatus === "CANCELLED") {
        if (!trimmedReason.length) {
          setStatusError("Bitte gib einen Stornierungsgrund an.");
          setShowCancelForm(true);
          return false;
        }
        if (!isAdminActor && !within24h) {
          setStatusLoading(true);
          setStatusError(null);
          try {
            const response = await fetch(
              `/api/backoffice/${locationSlug}/appointments/${appointmentId}/request`,
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  action: "CANCEL",
                  reason: trimmedReason,
                  performedBy: {
                    staffId: actor.staffId,
                    token: actor.token,
                  },
                }),
              },
            );
            const payload = await response.json().catch(() => ({}));
            if (!response.ok) {
              throw new Error(payload?.error ?? "Anfrage konnte nicht gesendet werden.");
            }
            setShowCancelForm(false);
            setCancelReason("");
            pushToast({
              variant: "success",
              message: "Deine Stornierungsanfrage wird dem Admin weitergeleitet.",
            });
            return true;
          } catch (err) {
            const message = err instanceof Error ? err.message : "Anfrage konnte nicht gesendet werden.";
            setStatusError(message);
            return false;
          } finally {
            setStatusLoading(false);
          }
        }
      }

      setStatusLoading(true);
      setStatusError(null);
      try {
        const response = await fetch(
          `/api/backoffice/${locationSlug}/appointments/${appointmentId}/status`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: targetStatus,
              reason: trimmedReason || undefined,
              performedBy: {
                staffId: actor.staffId,
                token: actor.token,
              },
            }),
          },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error ?? "Status konnte nicht aktualisiert werden.");
        }
        setShowCancelForm(false);
        setCancelReason("");
        onReload();
        onDataChanged?.();
        pushToast({
          variant: "success",
          message: statusSuccessMessage(targetStatus),
        });
        if (targetStatus === "CANCELLED") {
          onClose();
        }
        return true;
      } catch (err) {
        const message = err instanceof Error ? err.message : "Status konnte nicht aktualisiert werden.";
        setStatusError(message);
        return false;
      } finally {
        setStatusLoading(false);
      }
    };
  }, [detail, ensureBookingActor, statusLoading, locationSlug, onReload, onDataChanged, pushToast, onClose, isAdminActor, within24h]);

  const handleRemoveAssignment = useCallback(
    async (itemId: string) => {
      if (!detail || removingItemId) {
        return;
      }
      setRemoveError(null);
      setRemovingItemId(itemId);
      let actorForRemoval: BookingActor;
      try {
        actorForRemoval = await ensureBookingActor("Mitarbeiter-Zuordnung entfernen");
      } catch {
        setRemovingItemId(null);
        return;
      }

      try {
        const response = await fetch(
          `/api/backoffice/${locationSlug}/appointments/${detail.appointment.id}/items/${itemId}`,
          {
            method: "DELETE",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              performedBy: {
                staffId: actorForRemoval.staffId,
                token: actorForRemoval.token,
              },
            }),
          },
        );

        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error ?? "Zuordnung konnte nicht entfernt werden.");
        }

        pushToast({ variant: "success", message: "Mitarbeiter-Zuordnung entfernt." });
        setRemoveError(null);
        setRemovingItemId(null);
        onReload();
        onDataChanged?.();
      } catch (error) {
        const message = error instanceof Error ? error.message : "Zuordnung konnte nicht entfernt werden.";
        setRemoveError(message);
        setRemovingItemId(null);
      }
    },
    [detail, ensureBookingActor, locationSlug, onDataChanged, onReload, pushToast, removingItemId],
  );

  const handlePaymentChange = useMemo(() => {
    if (!detail) return async () => {};
    const appointmentId = detail.appointment.id;
    return async (
      targetStatus: AppointmentDetailPayload["appointment"]["paymentStatus"],
      options?: { note?: string },
    ) => {
      if (paymentLoading) return;
      let actor: BookingActor;
      try {
        actor = await ensureBookingActor();
      } catch {
        return;
      }
      setPaymentLoading(true);
      setPaymentError(null);
      try {
        const response = await fetch(
          `/api/backoffice/${locationSlug}/appointments/${appointmentId}/payment-status`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              status: targetStatus,
              note: options?.note ?? "",
              performedBy: {
                staffId: actor.staffId,
                token: actor.token,
              },
            }),
          },
        );
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) {
          throw new Error(payload?.error ?? "Zahlungsstatus konnte nicht aktualisiert werden.");
        }
        pushToast({
          variant: "success",
          message: paymentSuccessMessage(targetStatus),
        });
        setShowPaymentNote(false);
        setPaymentNote("");
        setPendingPaymentStatus(null);
        setPaymentAmount("");
        onReload();
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Zahlungsstatus konnte nicht aktualisiert werden.";
        setPaymentError(message);
      } finally {
        setPaymentLoading(false);
      }
    };
  }, [detail, ensureBookingActor, paymentLoading, locationSlug, onReload, pushToast]);

  const handleDelete = useCallback(async (): Promise<boolean> => {
    if (!detail || deleteLoading) {
      return false;
    }
    let actorForDelete: BookingActor;
    try {
      actorForDelete = await ensureBookingActor();
    } catch {
      return false;
    }

    if (!isAdminRoleValue(actorForDelete.role)) {
      const message = "Nur Administrator:innen dürfen Termine endgültig löschen.";
      setDeleteError(message);
      pushToast({ variant: "error", message });
      return false;
    }

    setDeleteLoading(true);
    setDeleteError(null);
    try {
      const response = await fetch(
        `/api/backoffice/${locationSlug}/appointments/${detail.appointment.id}`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            performedBy: {
              staffId: actorForDelete.staffId,
              token: actorForDelete.token,
            },
          }),
        },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "Termin konnte nicht gelöscht werden.");
      }
      setShowDeleteConfirm(false);
      pushToast({ variant: "success", message: "Termin wurde gelöscht." });
      onDataChanged?.();
      onClose();
      return true;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Termin konnte nicht gelöscht werden.";
      setDeleteError(message);
      pushToast({ variant: "error", message });
      return false;
    } finally {
      setDeleteLoading(false);
    }
  }, [deleteLoading, detail, ensureBookingActor, locationSlug, onClose, onDataChanged, pushToast]);

  const durationLabel = detail
    ? (() => {
        const { start, end } = getAppointmentBounds(detail);
        const minutes = Math.max(5, Math.round((end.getTime() - start.getTime()) / 60000));
        return `${format(start, "HH:mm")} – ${format(end, "HH:mm")} (${minutes} Min.)`;
      })()
    : null;

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[1150] flex justify-end bg-black/25 backdrop-blur-sm"
      onPointerDownCapture={handleInteraction}
      onKeyDownCapture={handleInteraction}
    >
      <div className="flex h-full w-full max-w-5xl flex-col rounded-l-3xl border border-zinc-200 bg-white shadow-2xl">
        <header className="flex flex-col gap-4 border-b border-zinc-200 px-6 py-4 lg:flex-row lg:items-center lg:justify-between">
          <div>
            <p className="text-xs uppercase tracking-widest text-zinc-400">Termin-Details</p>
            <h2 className="text-2xl font-semibold text-zinc-900">{headerTitle}</h2>
            {durationLabel && <p className="text-xs text-zinc-500">{durationLabel}</p>}
            {detail && (
              <p className="mt-1 text-xs text-zinc-500">
                Bestätigungscode: <span className="font-mono text-zinc-700">{detail.appointment.confirmationCode}</span>
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {detail && canEditAppointment(detail, actor) && onEdit && (
              <button
                type="button"
                onClick={() => onEdit(detail)}
                className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-semibold text-zinc-700 transition hover:bg-zinc-100"
              >
                Bearbeiten
              </button>
            )}
            <button
              type="button"
              onClick={() => handleDownloadIcs(detail)}
              disabled={!detail || !detail.ics || loading}
              className="rounded-full border border-zinc-300 px-4 py-2 text-sm text-zinc-700 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
            >
              ICS herunterladen
            </button>
            <button
              type="button"
              onClick={onClose}
              className="rounded-full bg-zinc-900 px-5 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800"
            >
              Schließen
            </button>
          </div>
        </header>

        <div className="flex flex-1 flex-col overflow-hidden lg:flex-row">
          <div className="flex-1 overflow-y-auto px-6 py-6">
            {loading && (
              <div className="flex h-full items-center justify-center">
                <div className="text-sm text-zinc-500">Termindetails werden geladen…</div>
              </div>
            )}

            {!loading && error && (
              <div className="flex h-full flex-col items-center justify-center gap-3 text-center">
                <p className="text-sm text-red-600">{error}</p>
                <button
                  type="button"
                  onClick={onRetry}
                  className="rounded-full border border-zinc-300 px-4 py-2 text-sm font-medium text-zinc-700 transition hover:bg-zinc-100"
                >
                  Erneut versuchen
                </button>
              </div>
            )}

            {!loading && !error && detail && (
              <div className="space-y-8">
                <OverviewSection detail={detail} />
                <ColorRequestSection detail={detail} />
                <StatusActions
                  status={detail.appointment.status}
                  allowNoShow={new Date(detail.appointment.startsAt) <= new Date()}
                  onStatusChange={handleStatusChange}
                  loading={statusLoading}
                  error={statusError}
                  showCancelForm={showCancelForm}
                  setShowCancelForm={setShowCancelForm}
                  cancelReason={cancelReason}
                  setCancelReason={setCancelReason}
                  confirmLabel={confirmLabel}
                />
                <DeleteAppointmentSection
                  status={detail.appointment.status}
                  canDelete={isAdminActor}
                  showConfirm={showDeleteConfirm}
                  setShowConfirm={(value) => {
                    setDeleteError(null);
                    setShowDeleteConfirm(value);
                  }}
                  onDelete={handleDelete}
                  loading={deleteLoading}
                  error={deleteError}
                />
                <PaymentActions
                  status={detail.appointment.paymentStatus}
                  onStatusChange={handlePaymentChange}
                  loading={paymentLoading}
                  error={paymentError}
                  showNote={showPaymentNote}
                  setShowNote={setShowPaymentNote}
                  note={paymentNote}
                  setNote={setPaymentNote}
                  setError={setPaymentError}
                  amount={paymentAmount}
                  setAmount={setPaymentAmount}
                  pendingStatus={pendingPaymentStatus}
                  setPendingStatus={setPendingPaymentStatus}
                />
                <ServicesSection
                  detail={detail}
                  activeItemId={activeItemId}
                  onRemoveAssignment={assignedStaffCount > 1 ? handleRemoveAssignment : undefined}
                  removingItemId={removingItemId}
                  canRemoveAssignments={assignedStaffCount > 1}
                  removeError={removeError}
                />
                <NotesSection
                  detail={detail}
                  locationSlug={locationSlug}
                  onReload={onReload}
                  ensureBookingActor={ensureBookingActor}
                />
                <NotificationsSection detail={detail} locationSlug={locationSlug} onReload={onReload} />
                <AttachmentsSection detail={detail} locationSlug={locationSlug} />
                <PaymentHistorySection detail={detail} />
                <AuditSection detail={detail} />
              </div>
            )}

            {!loading && !error && !detail && (
              <div className="flex h-full items-center justify-center text-sm text-zinc-500">
                Kein Termin ausgewählt.
              </div>
            )}
          </div>

          <aside className="hidden w-full max-w-xs border-t border-zinc-200 bg-zinc-50 px-6 py-6 lg:block lg:border-t-0 lg:border-l">
            {detail ? (
              <CustomerSidebar
                detail={detail}
                locationSlug={locationSlug}
                ensureBookingActor={ensureBookingActor}
              />
            ) : (
              <SidebarPlaceholder />
            )}
          </aside>
        </div>
      </div>
    </div>
  );
}

function OverviewSection({ detail }: { detail: AppointmentDetailPayload }) {
  const appointment = detail.appointment;
  const bounds = getAppointmentBounds(detail);
  const badges = [
    { label: statusLabel(appointment.status), className: statusBadgeClass(appointment.status) },
    { label: paymentStatusLabel(appointment.paymentStatus), className: paymentBadgeClass(appointment.paymentStatus) },
  ];

  const auditTrail = Array.isArray(detail.auditTrail) ? detail.auditTrail : [];
  const bookedAt = format(new Date(appointment.createdAt), "dd.MM.yyyy HH:mm", { locale: de });
  const startsAt = format(bounds.start, "dd.MM.yyyy HH:mm", { locale: de });
  const endsAt = format(bounds.end, "dd.MM.yyyy HH:mm", { locale: de });
  const totalAmount = formatCurrency(appointment.totalAmount, appointment.currency);
  const depositAmount = appointment.depositAmount ? formatCurrency(appointment.depositAmount, appointment.currency) : "–";
  const durationMinutes = Math.max(5, Math.round((bounds.end.getTime() - bounds.start.getTime()) / 60000));
  const metadataInfo = extractAppointmentMetadata(appointment.metadata);
  const staffNames = Array.from(
    new Set(
      detail.appointment.items
        .map((item) => item.staff?.name?.trim())
        .filter((name): name is string => Boolean(name && name.length)),
    ),
  );
  const staffDescription = staffNames.length ? staffNames.join(", ") : "Nicht zugewiesen";
  const createdAuditEntry = auditTrail.find((entry) => entry.action === "CREATE");
  const createdByFallback = createdAuditEntry ? formatAuditActor(createdAuditEntry) : null;
  const createdByLabel = metadataInfo.createdByStaff ?? createdByFallback ?? "Unbekannt";
  let lastUpdatedDescription: string | null = null;
  if (metadataInfo.lastUpdatedByStaff || metadataInfo.lastUpdatedAt) {
    const timestamp =
      metadataInfo.lastUpdatedAt && !Number.isNaN(new Date(metadataInfo.lastUpdatedAt).getTime())
        ? format(new Date(metadataInfo.lastUpdatedAt), "dd.MM.yyyy HH:mm", { locale: de })
        : null;
    if (metadataInfo.lastUpdatedByStaff && timestamp) {
      lastUpdatedDescription = `${metadataInfo.lastUpdatedByStaff} · ${timestamp}`;
    } else {
      lastUpdatedDescription = metadataInfo.lastUpdatedByStaff ?? timestamp;
    }
  }
  if (!lastUpdatedDescription) {
    const latestUpdateEntry = auditTrail
      .filter((entry) => entry.action === "UPDATE")
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    if (latestUpdateEntry) {
      const actorLabel = formatAuditActor(latestUpdateEntry);
      const timestamp = format(new Date(latestUpdateEntry.createdAt), "dd.MM.yyyy HH:mm", { locale: de });
      lastUpdatedDescription = actorLabel ? `${actorLabel} · ${timestamp}` : timestamp;
    }
  }

  return (
    <section className="space-y-4">
      <header>
        <h3 className="text-sm font-semibold text-zinc-900">Terminübersicht</h3>
        <p className="text-xs text-zinc-500">Status, Zahlungsstand und zentrale Eckdaten.</p>
      </header>

      <div className="flex flex-wrap gap-2">
        {badges.map((badge) => (
          <span key={badge.label} className={`inline-flex rounded-full border px-3 py-1 text-[11px] font-semibold uppercase tracking-widest ${badge.className}`}>
            {badge.label}
          </span>
        ))}
      </div>

      <dl className="grid gap-3 text-sm md:grid-cols-2">
        <InfoRow term="Erstellt am" description={bookedAt} />
        <InfoRow term="Erstellt durch" description={createdByLabel} />
        {lastUpdatedDescription && (
          <InfoRow term="Zuletzt bearbeitet" description={lastUpdatedDescription} />
        )}
        <InfoRow term="Start" description={startsAt} />
        <InfoRow term="Ende" description={endsAt} />
        <InfoRow term="Quelle" description={sourceLabel(appointment.source)} />
        <InfoRow term="Team" description={staffDescription} />
        <InfoRow term="Gesamtbetrag" description={totalAmount} />
        <InfoRow term="Anzahlung" description={depositAmount} />
        <InfoRow term="Dauer" description={`${durationMinutes} Minuten`} />
      </dl>
    </section>
  );
}

function ColorRequestSection({ detail }: { detail: AppointmentDetailPayload }) {
  const { request, precheck } = extractColorMetadata(detail.appointment.metadata);
  if (!request && !precheck) return null;

  const requestMode = typeof request?.mode === "string" ? request.mode : null;
  const requestedServiceName =
    typeof request?.requestedServiceName === "string" ? request.requestedServiceName : null;
  const consultationServiceName =
    typeof request?.consultationServiceName === "string" ? request.consultationServiceName : null;
  const modeLabel =
    requestMode === "consultation" ? "Farbberatung" : requestMode === "direct" ? "Direkter Farbtermin" : null;

  const precheckLabels = {
    hairLength: { short: "Kurz", medium: "Mittel", long: "Lang" },
    hairDensity: { fine: "Fein", normal: "Normal", thick: "Kraeftig" },
    hairState: { natural: "Natur", colored: "Gefaerbt", blonded: "Blondiert" },
    desiredResult: { refresh: "Auffrischen", change: "Veraenderung" },
    yesNo: { yes: "Ja", no: "Nein" },
  } as const;

  const precheckEntries: Array<{ term: string; description: string }> = [];
  if (precheck?.hairLength) {
    precheckEntries.push({
      term: "Haarlaenge",
      description: precheckLabels.hairLength[precheck.hairLength] ?? precheck.hairLength,
    });
  }
  if (precheck?.hairDensity) {
    precheckEntries.push({
      term: "Haardichte",
      description: precheckLabels.hairDensity[precheck.hairDensity] ?? precheck.hairDensity,
    });
  }
  if (precheck?.hairState) {
    precheckEntries.push({
      term: "Aktueller Zustand",
      description: precheckLabels.hairState[precheck.hairState] ?? precheck.hairState,
    });
  }
  if (precheck?.desiredResult) {
    precheckEntries.push({
      term: "Gewuenschtes Ergebnis",
      description: precheckLabels.desiredResult[precheck.desiredResult] ?? precheck.desiredResult,
    });
  }
  if (precheck?.allergies) {
    precheckEntries.push({
      term: "Allergien",
      description: precheckLabels.yesNo[precheck.allergies] ?? precheck.allergies,
    });
  }
  if (precheck?.returning) {
    precheckEntries.push({
      term: "Bereits Kund:in",
      description: precheckLabels.yesNo[precheck.returning] ?? precheck.returning,
    });
  }

  const precheckStatus = precheckEntries.length
    ? isColorPrecheckComplete(precheck)
      ? "Vollstaendig"
      : "Unvollstaendig"
    : "Noch nicht ausgefuellt";

  const entries: Array<{ term: string; description: string }> = [];
  if (modeLabel) {
    entries.push({ term: "Modus", description: modeLabel });
  }
  if (consultationServiceName) {
    entries.push({ term: "Beratungstermin", description: consultationServiceName });
  }
  if (requestedServiceName) {
    entries.push({ term: "Gewuenschte Farbe", description: requestedServiceName });
  }
  entries.push({ term: "Vorerfassung", description: precheckStatus });
  entries.push(...precheckEntries);

  return (
    <section className="space-y-4">
      <header>
        <h3 className="text-sm font-semibold text-zinc-900">Farbberatung & Planung</h3>
        <p className="text-xs text-zinc-500">Details zur Farbanfrage und Vorerfassung.</p>
      </header>
      <dl className="grid gap-3 text-sm md:grid-cols-2">
        {entries.map((entry) => (
          <InfoRow key={`${entry.term}-${entry.description}`} term={entry.term} description={entry.description} />
        ))}
      </dl>
    </section>
  );
}

function ServicesSection({
  detail,
  activeItemId,
  onRemoveAssignment,
  removingItemId,
  canRemoveAssignments,
  removeError,
}: {
  detail: AppointmentDetailPayload;
  activeItemId?: string | null;
  onRemoveAssignment?: (itemId: string) => void;
  removingItemId?: string | null;
  canRemoveAssignments?: boolean;
  removeError?: string | null;
}) {
  const { items } = detail.appointment;
  if (!items.length) {
    return null;
  }

  const selectedItemId = activeItemId && items.some((item) => item.id === activeItemId)
    ? activeItemId
    : items[0]?.id ?? null;

  return (
    <section className="space-y-4">
      <header>
        <h3 className="text-sm font-semibold text-zinc-900">Leistungen & Ressourcen</h3>
        <p className="text-xs text-zinc-500">Chronologische Auflistung der gebuchten Leistungen.</p>
      </header>
      <ul className="space-y-4">
        {items.map((item, index) => {
          const start = format(new Date(item.startsAt), "HH:mm", { locale: de });
          const end = format(new Date(item.endsAt), "HH:mm", { locale: de });
          const highlighted = item.id === selectedItemId || (!selectedItemId && index === 0);
          const showRemoveButton = Boolean(canRemoveAssignments && onRemoveAssignment && item.staff?.id);
          const isRemoving = removingItemId === item.id;
          return (
            <li
              key={item.id}
              data-selected={highlighted ? true : undefined}
              className={`rounded-xl border px-4 py-3 transition ${
                highlighted
                  ? "border-emerald-400 ring-2 ring-emerald-200/70 bg-emerald-50/70"
                  : "border-zinc-200 bg-zinc-50/60 text-zinc-500"
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className={highlighted ? "" : "text-zinc-500"}>
                  <p className={`text-sm font-semibold ${highlighted ? "text-zinc-900" : "text-zinc-600"}`}>
                    {item.service?.name ?? "Leistung"}
                  </p>
                  <p className="text-xs">
                    {start} – {end} · {formatCurrency(item.price, item.currency)}
                  </p>
                </div>
                <span
                  className={`inline-flex rounded-full border px-3 py-0.5 text-[11px] font-semibold uppercase tracking-widest ${
                    statusBadgeClass(item.status)
                  }`}
                >
                  {statusLabel(item.status)}
                </span>
              </div>
              <dl className={`mt-3 grid gap-2 text-xs sm:grid-cols-3 ${highlighted ? "text-zinc-600" : "text-zinc-500"}`}>
                <InfoRow term="Mitarbeiter:in" description={item.staff?.name ?? "Nicht zugewiesen"} />
                <InfoRow term="Ressource" description={item.resource?.name ?? "Keine"} />
                <InfoRow term="Dauer" description={`${item.service?.duration ?? detail.appointment.durationMinutes} Min.`} />
              </dl>
              {item.notes && (
                <p
                  className={`mt-3 rounded-lg px-3 py-2 text-xs ${
                    highlighted ? "bg-emerald-50/80 text-zinc-600" : "bg-white/60 text-zinc-500"
                  }`}
                >
                  {item.notes}
                </p>
              )}
              {showRemoveButton && (
                <div className="mt-3 flex justify-end">
                  <button
                    type="button"
                    onClick={() => onRemoveAssignment?.(item.id)}
                    disabled={isRemoving}
                    className="rounded-full border border-rose-300 px-3 py-1 text-xs font-semibold text-rose-600 transition hover:bg-rose-50 disabled:cursor-not-allowed disabled:border-rose-200 disabled:text-rose-300"
                  >
                    {isRemoving ? "Entferne…" : "Zuordnung entfernen"}
                  </button>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      {removeError && <p className="text-xs text-rose-600">{removeError}</p>}
    </section>
  );
}

function NotesSection({
  detail,
  locationSlug,
  onReload,
  ensureBookingActor,
}: {
  detail: AppointmentDetailPayload;
  locationSlug: string;
  onReload: () => void;
  ensureBookingActor: (contextLabel?: string) => Promise<BookingActor>;
}) {
  const { pushToast } = useToast();
  const [editing, setEditing] = useState(false);
  const [noteDraft, setNoteDraft] = useState(detail.appointment.note ?? "");
  const [internalNoteDraft, setInternalNoteDraft] = useState(detail.appointment.internalNote ?? "");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const customerNotes = detail.appointment.customer?.notes ?? null;

  useEffect(() => {
    setEditing(false);
    setNoteDraft(detail.appointment.note ?? "");
    setInternalNoteDraft(detail.appointment.internalNote ?? "");
    setError(null);
  }, [detail.appointment.id, detail.appointment.note, detail.appointment.internalNote]);

    const handleSave = async () => {
      if (saving) return;
      let actor: BookingActor;
      try {
        actor = await ensureBookingActor();
      } catch {
        return;
      }
      setSaving(true);
      setError(null);
      try {
        const response = await fetch(
          `/api/backoffice/${locationSlug}/appointments/${detail.appointment.id}/note`,
          {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              note: noteDraft,
              internalNote: internalNoteDraft,
              performedBy: {
                staffId: actor.staffId,
                token: actor.token,
              },
            }),
          },
        );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "Notiz konnte nicht gespeichert werden.");
      }
      pushToast({ variant: "success", message: "Notiz gespeichert." });
      setEditing(false);
      onReload();
    } catch (err) {
      const message = err instanceof Error ? err.message : "Notiz konnte nicht gespeichert werden.";
      setError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="space-y-4">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-zinc-900">Notizen</h3>
          <p className="text-xs text-zinc-500">Kundenhinweis sowie interne Informationen bearbeiten.</p>
        </div>
        {!editing && (
          <button
            type="button"
            onClick={() => setEditing(true)}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100"
          >
            Bearbeiten
          </button>
        )}
      </header>

      <div className="space-y-3 text-sm text-zinc-700">
        <div className="rounded-xl border border-zinc-200 bg-zinc-50 px-4 py-3">
          <h4 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Hinweis für Kunden</h4>
          {editing ? (
            <textarea
              value={noteDraft}
              onChange={(event) => setNoteDraft(event.target.value)}
              placeholder="Diese Nachricht wird mit der Terminbestätigung gesendet"
              className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              rows={4}
              maxLength={4000}
            />
          ) : (
            <p className="mt-1 text-sm text-zinc-700">
              {detail.appointment.note?.length ? detail.appointment.note : "Keine Notiz hinterlegt."}
            </p>
          )}
        </div>

        <div className="rounded-xl border border-zinc-200 px-4 py-3">
          <h4 className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Interne Notiz</h4>
          {editing ? (
            <textarea
              value={internalNoteDraft}
              onChange={(event) => setInternalNoteDraft(event.target.value)}
              placeholder="Nur intern sichtbar"
              className="mt-2 w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
              rows={3}
              maxLength={4000}
            />
          ) : (
            <p className="mt-1 text-sm text-zinc-700">
              {internalNoteDraft?.length ? internalNoteDraft : "Keine interne Notiz hinterlegt."}
            </p>
          )}
          {customerNotes && !editing && (
            <p className="mt-2 text-xs text-zinc-500">Kundenkartei: {customerNotes}</p>
          )}
        </div>
      </div>

      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      {editing && (
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-500"
          >
            {saving ? "Speichern…" : "Speichern"}
          </button>
          <button
            type="button"
            onClick={() => {
              setEditing(false);
              setNoteDraft(detail.appointment.note ?? "");
              setError(null);
            }}
            disabled={saving}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
          >
            Abbrechen
          </button>
        </div>
      )}
    </section>
  );
}

function DeleteAppointmentSection({
  status,
  canDelete,
  showConfirm,
  setShowConfirm,
  onDelete,
  loading,
  error,
}: {
  status: AppointmentStatusValue;
  canDelete: boolean;
  showConfirm: boolean;
  setShowConfirm: (value: boolean) => void;
  onDelete: () => Promise<boolean>;
  loading: boolean;
  error: string | null;
}) {
  if (status !== "CANCELLED" || !canDelete) {
    return null;
  }

  return (
    <section className="space-y-4">
      <header>
        <h3 className="text-sm font-semibold text-zinc-900">Termin löschen</h3>
        <p className="text-xs text-zinc-500">
          Entfernt den Termin dauerhaft aus dem Kalender. Anhänge und Historie werden ebenfalls gelöscht.
        </p>
      </header>
      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
      {showConfirm ? (
        <div className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-3">
          <p className="text-xs text-red-700">
            Wirklich löschen? Diese Aktion kann nicht rückgängig gemacht werden.
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={async () => {
                const success = await onDelete();
                if (!success) {
                  return;
                }
              }}
              disabled={loading}
              className="rounded-full bg-red-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-400"
            >
              {loading ? "Löschen…" : "Unwiderruflich löschen"}
            </button>
            <button
              type="button"
              onClick={() => setShowConfirm(false)}
              disabled={loading}
              className="rounded-full border border-red-200 px-3 py-1 text-xs font-semibold text-red-600 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:text-red-300"
            >
              Abbrechen
            </button>
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setShowConfirm(true)}
          disabled={loading}
          className="rounded-full border border-red-300 px-3 py-1 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:text-red-300"
        >
          Termin endgültig löschen
        </button>
      )}
    </section>
  );
}

function NotificationsSection({
  detail,
  locationSlug,
  onReload,
}: {
  detail: AppointmentDetailPayload;
  locationSlug: string;
  onReload: () => void;
}) {
  const { pushToast } = useToast();
  const notifications = detail.appointment.notifications;
  const [resendLoadingId, setResendLoadingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!notifications.length) {
    return null;
  }

  const handleResend = async (notificationId: string) => {
    if (resendLoadingId) return;
    setResendLoadingId(notificationId);
    setError(null);
    try {
      const response = await fetch(
        `/api/backoffice/${locationSlug}/appointments/${detail.appointment.id}/notifications/${notificationId}/resend`,
        { method: "POST" },
      );
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.error ?? "Benachrichtigung konnte nicht erneut versendet werden.");
      }
      pushToast({ variant: "success", message: "Benachrichtigung wird erneut versendet." });
      onReload();
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Benachrichtigung konnte nicht erneut versendet werden.";
      setError(message);
    } finally {
      setResendLoadingId(null);
    }
  };

  return (
    <section className="space-y-4">
      <header>
        <h3 className="text-sm font-semibold text-zinc-900">Benachrichtigungen</h3>
        <p className="text-xs text-zinc-500">
          Geplante und versandte Erinnerungen. Erinnerungs- und Follow-up-Mails lassen sich erneut senden.
        </p>
      </header>
      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}
      <ul className="space-y-3 text-sm text-zinc-700">
        {notifications.map((notification) => {
          const scheduled = notification.scheduledAt
            ? format(new Date(notification.scheduledAt), "dd.MM.yyyy HH:mm", { locale: de })
            : "Nicht geplant";
          const sent = notification.sentAt
            ? format(new Date(notification.sentAt), "dd.MM.yyyy HH:mm", { locale: de })
            : null;
          const canResend = RESENDABLE_TRIGGERS.has(notification.trigger);
          const isLoading = resendLoadingId === notification.id;
          const attempts = extractAttemptCount(notification.metadata);
          const lastError = notification.error;
          return (
            <li key={notification.id} className="rounded-xl border border-zinc-200 px-4 py-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-zinc-900">
                    {notificationLabel(notification.type)} · {channelLabel(notification.channel)}
                  </p>
                  <p className="text-xs text-zinc-500">Trigger: {triggerLabel(notification.trigger)}</p>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex rounded-full border px-3 py-0.5 text-[11px] font-semibold uppercase tracking-widest ${notificationBadgeClass(notification.status)}`}>
                    {notificationStatusLabel(notification.status)}
                  </span>
                  {canResend && (
                    <button
                      type="button"
                      onClick={() => handleResend(notification.id)}
                      disabled={isLoading}
                      className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
                    >
                      {isLoading ? "Versand…" : "Erneut senden"}
                    </button>
                  )}
                </div>
              </div>
              <div className="mt-2 grid gap-2 text-xs text-zinc-600 sm:grid-cols-3">
                <InfoRow term="Geplant" description={scheduled} />
                <InfoRow term="Versendet" description={sent ?? "Noch nicht versendet"} />
                <InfoRow term="Versuche" description={attempts ? `${attempts}` : "–"} />
              </div>
              {lastError && (
                <p className="mt-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">
                  Fehler: {lastError}
                </p>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

function AttachmentsSection({ detail, locationSlug }: { detail: AppointmentDetailPayload; locationSlug: string }) {
  const attachments = detail.appointment.attachments;
  const [previewId, setPreviewId] = useState<string | null>(null);

  useEffect(() => {
    setPreviewId(null);
  }, [detail.appointment.id, attachments.length]);

  if (!attachments.length) {
    return null;
  }

  const previewAttachment = attachments.find((attachment) => attachment.id === previewId);
  const previewUrl = previewAttachment
    ? `/api/backoffice/${locationSlug}/appointments/${detail.appointment.id}/attachments/${previewAttachment.id}?inline=1`
    : null;
  const canPreview = previewAttachment ? isPreviewable(previewAttachment.mimeType) : false;

  return (
    <section className="space-y-4">
      <header>
        <h3 className="text-sm font-semibold text-zinc-900">Anhänge</h3>
        <p className="text-xs text-zinc-500">Dateien, die dem Termin zugeordnet wurden.</p>
      </header>
      <ul className="space-y-2 text-sm text-zinc-700">
        {attachments.map((attachment) => {
          const previewable = isPreviewable(attachment.mimeType);
          const isActive = previewId === attachment.id;
          return (
            <li
              key={attachment.id}
              className={`flex flex-col gap-3 rounded-lg border px-4 py-3 transition ${
                isActive ? "border-zinc-400 bg-zinc-50" : "border-zinc-200"
              } md:flex-row md:items-center md:justify-between`}
            >
              <div>
                <p className="font-medium text-zinc-900">{attachment.fileName}</p>
                <p className="text-xs text-zinc-500">
                  {attachment.mimeType} · {formatFileSize(attachment.size)} ·{" "}
                  {format(new Date(attachment.createdAt), "dd.MM.yyyy HH:mm", { locale: de })}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs">
                {previewable && (
                  <button
                    type="button"
                    onClick={() => setPreviewId(isActive ? null : attachment.id)}
                    className={`rounded-full border px-3 py-1 font-semibold transition ${
                      isActive
                        ? "border-zinc-900 bg-zinc-900 text-white"
                        : "border-zinc-300 text-zinc-600 hover:bg-zinc-100"
                    }`}
                  >
                    {isActive ? "Vorschau schließen" : "Anzeigen"}
                  </button>
                )}
                <a
                  href={`/api/backoffice/${locationSlug}/appointments/${detail.appointment.id}/attachments/${attachment.id}`}
                  className="rounded-full border border-zinc-300 px-3 py-1 font-semibold text-zinc-600 transition hover:bg-zinc-100"
                  download
                >
                  Herunterladen
                </a>
              </div>
            </li>
          );
        })}
      </ul>

      {previewAttachment && canPreview && previewUrl && (
        <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
            <div>
              <p className="text-sm font-semibold text-zinc-900">{previewAttachment.fileName}</p>
              <p className="text-xs text-zinc-500">{previewAttachment.mimeType}</p>
            </div>
            <button
              type="button"
              onClick={() => setPreviewId(null)}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100"
            >
              Schließen
            </button>
          </div>
          <div className="max-h-[480px] overflow-auto bg-zinc-50 p-4">
            {previewAttachment.mimeType === "application/pdf" ? (
              <iframe
                src={`${previewUrl}#toolbar=0`}
                title={previewAttachment.fileName}
                className="h-[420px] w-full rounded-lg border border-zinc-200 bg-white"
              />
            ) : (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={previewUrl}
                alt={previewAttachment.fileName}
                className="mx-auto max-h-[420px] max-w-full rounded-lg border border-zinc-200 bg-white object-contain"
                loading="lazy"
              />
            )}
          </div>
        </div>
      )}

      {previewAttachment && !canPreview && (
        <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-700">
          Dieser Dateityp kann nicht im Browser angezeigt werden. Bitte lade die Datei herunter.
        </p>
      )}
    </section>
  );
}

function PaymentHistorySection({ detail }: { detail: AppointmentDetailPayload }) {
  const history = detail.appointment.paymentHistory ?? [];
  if (!history.length) {
    return null;
  }

  return (
    <section className="space-y-4">
      <header>
        <h3 className="text-sm font-semibold text-zinc-900">Zahlungsvorgänge</h3>
        <p className="text-xs text-zinc-500">Chronologische Historie von Zahlungen und Rückerstattungen.</p>
      </header>
      <div className="space-y-3">
        {history
          .slice()
          .reverse()
          .map((entry, index) => {
            const amountLabel =
              entry.amount != null
                ? formatCurrency(entry.amount, entry.currency ?? detail.appointment.currency)
                : null;
            const timestamp = format(new Date(entry.at), "dd.MM.yyyy HH:mm", { locale: de });
            return (
              <div key={`${entry.at}-${index}`} className="rounded-lg border border-zinc-200 bg-white px-4 py-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-sm font-semibold text-zinc-900">{paymentStatusLabel(entry.status)}</p>
                  <p className="text-xs text-zinc-500">{timestamp}</p>
                </div>
                <div className="mt-2 text-xs text-zinc-600">
                  <p>Betrag: {amountLabel ?? "–"}</p>
                  <p>Notiz: {entry.note?.length ? entry.note : "–"}</p>
                </div>
              </div>
            );
          })}
      </div>
    </section>
  );
}

function AuditSection({ detail }: { detail: AppointmentDetailPayload }) {
  if (!detail.auditTrail.length) {
    return null;
  }

  return (
    <section className="space-y-4">
      <header>
        <h3 className="text-sm font-semibold text-zinc-900">Audit-Verlauf</h3>
        <p className="text-xs text-zinc-500">Wichtige Aktionen und Änderungen an diesem Termin.</p>
      </header>
      <ol className="space-y-3">
        {detail.auditTrail.map((entry) => {
          const timestamp = formatDistanceToNow(new Date(entry.createdAt), { addSuffix: true, locale: de });
          const actorLabel = formatAuditActor(entry);
          const diffLines = summarizeDiff(entry.diff, detail);
          const contextLines = summarizeContext(entry.context);
          const lines = [...diffLines, ...contextLines];
          return (
            <li key={entry.id} className="rounded-xl border border-zinc-200 bg-white px-4 py-3">
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <div>
                  <p className="text-sm font-semibold text-zinc-900">{auditActionLabel(entry.action)}</p>
                  <p className="text-xs text-zinc-500">{actorLabel}</p>
                </div>
                <p className="text-xs text-zinc-500">{timestamp}</p>
              </div>
              {lines.length > 0 ? (
                <ul className="mt-3 space-y-2 text-xs text-zinc-600">
                  {lines.map((line, index) =>
                    line.type === "text" ? (
                      <li key={index} className="flex gap-2">
                        <span className="mt-1 h-1.5 w-1.5 flex-none rounded-full bg-zinc-400" />
                        <span>{line.value}</span>
                      </li>
                    ) : (
                      <li key={index}>
                        <pre className="whitespace-pre-wrap rounded-lg bg-zinc-100 px-3 py-2 text-[11px] leading-snug text-zinc-600">
                          {line.value}
                        </pre>
                      </li>
                    ),
                  )}
                </ul>
              ) : (
                <p className="mt-3 text-xs text-zinc-500">Aktion protokolliert.</p>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}

type AuditDetailLine = { type: "text"; value: string } | { type: "code"; value: string };

function formatAuditActor(entry: AppointmentDetailPayload["auditTrail"][number]): string {
  const typeLabel = formatActorType(entry.actorType);
  const name = entry.actor?.name ?? entry.actor?.email ?? null;
  if (name) {
    return typeLabel && typeLabel !== "Mitarbeiter:in" ? `${name} · ${typeLabel}` : name;
  }
  return typeLabel;
}

function formatActorType(type: string | null | undefined): string {
  switch (type) {
    case "USER":
      return "Mitarbeiter:in";
    case "CUSTOMER":
      return "Kund:in";
    case "SYSTEM":
      return "System";
    case "INTEGRATION":
      return "Integration";
    default:
      return type ? humanizeKey(type) : "Unbekannt";
  }
}

function summarizeDiff(diff: unknown, detail: AppointmentDetailPayload): AuditDetailLine[] {
  const lines: AuditDetailLine[] = [];
  if (diff === null || diff === undefined) {
    return lines;
  }
  if (typeof diff === "string") {
    return [{ type: "text", value: diff }];
  }
  if (Array.isArray(diff)) {
    for (const entry of diff) {
      if (typeof entry === "string") {
        lines.push({ type: "text", value: entry });
      } else if (isPlainObject(entry)) {
        lines.push({ type: "code", value: JSON.stringify(entry, null, 2) });
      }
    }
    return lines;
  }
  if (!isPlainObject(diff)) {
    return [{ type: "text", value: String(diff) }];
  }

  const record = diff as Record<string, unknown>;
  const handled = new Set<string>();
  const staffById = new Map<string, string>();
  const serviceById = new Map<string, string>();
  const itemById = new Map<string, AppointmentDetailPayload["appointment"]["items"][number]>();
  for (const item of detail.appointment.items) {
    if (item.staff?.id && item.staff.name) {
      staffById.set(item.staff.id, item.staff.name);
    }
    if (item.service?.id && item.service.name) {
      serviceById.set(item.service.id, item.service.name);
    }
    itemById.set(item.id, item);
  }

  const resolveStaffLabel = (value: unknown) => {
    if (value === null || value === undefined) {
      return "Nicht zugewiesen";
    }
    if (typeof value === "string") {
      return staffById.get(value) ?? `ID ${value}`;
    }
    if (isPlainObject(value)) {
      const candidate = value as Record<string, unknown>;
      if (typeof candidate.staffName === "string") {
        return candidate.staffName;
      }
      if (typeof candidate.name === "string") {
        return candidate.name;
      }
    }
    return formatDiffValue(value);
  };

  const resolveServiceLabel = (value: unknown) => {
    if (value === null || value === undefined) {
      return "Keine Auswahl";
    }
    if (typeof value === "string") {
      return serviceById.get(value) ?? `ID ${value}`;
    }
    if (isPlainObject(value) && typeof value.name === "string") {
      return value.name;
    }
    return formatDiffValue(value);
  };

  const formatRange = (start: unknown, end: unknown) => {
    const startLabel =
      typeof start === "string" ? formatDateTimeValue(start) : formatDiffValue(start);
    const endLabel =
      typeof end === "string" ? formatDateTimeValue(end) : formatDiffValue(end);
    return `${startLabel} – ${endLabel}`;
  };

  if ("itemId" in record) {
    const rawId = record.itemId;
    let label = formatDiffValue(rawId);
    if (typeof rawId === "string") {
      const item = itemById.get(rawId);
      if (item) {
        const start = format(new Date(item.startsAt), "HH:mm", { locale: de });
        const end = format(new Date(item.endsAt), "HH:mm", { locale: de });
        label = `${item.service?.name ?? "Leistung"} (${start} – ${end})`;
        if (item.staff?.name) {
          label += ` · ${item.staff.name}`;
        }
      }
    }
    lines.push({ type: "text", value: `Bearbeitetes Element: ${label}` });
    handled.add("itemId");
  }

  if ("itemLabel" in record && isPlainObject(record.itemLabel)) {
    const itemLabel = record.itemLabel as Record<string, unknown>;
    if (typeof itemLabel.id === "string") {
      const item = itemById.get(itemLabel.id);
      if (item && item.staff?.name) {
        staffById.set(item.staff.id, item.staff.name);
      }
      if (item && item.service?.name) {
        serviceById.set(item.service.id, item.service.name);
      }
    }
    handled.add("itemLabel");
  }

  if ("performedByStaff" in record) {
    const performer = record.performedByStaff;
    if (isPlainObject(performer) && typeof performer.staffName === "string") {
      lines.push({ type: "text", value: `Aktion durch ${performer.staffName}` });
    }
    handled.add("performedByStaff");
  }

  if ("previousStatus" in record || "newStatus" in record) {
    const previousStatus = typeof record.previousStatus === "string" ? statusLabel(record.previousStatus) : formatDiffValue(record.previousStatus);
    const newStatus = typeof record.newStatus === "string" ? statusLabel(record.newStatus) : formatDiffValue(record.newStatus);
    lines.push({ type: "text", value: `Status geändert: ${previousStatus} → ${newStatus}` });
    handled.add("previousStatus");
    handled.add("newStatus");
  }

  if ("reason" in record && record.reason) {
    lines.push({ type: "text", value: `Grund: ${formatDiffValue(record.reason)}` });
    handled.add("reason");
  }

  if ("previousNote" in record || "newNote" in record) {
    const prev = formatNoteValue(record.previousNote);
    const next = formatNoteValue(record.newNote);
    lines.push({ type: "text", value: `Notiz angepasst: ${prev} → ${next}` });
    handled.add("previousNote");
    handled.add("newNote");
  }

  if ("note" in record && isPlainObject(record.note)) {
    const noteRecord = record.note as Record<string, unknown>;
    const prev = formatNoteValue(noteRecord.previous);
    const next = formatNoteValue(noteRecord.next);
    lines.push({ type: "text", value: `Notiz geändert: ${prev} → ${next}` });
    handled.add("note");
  }

  if ("staff" in record && isPlainObject(record.staff)) {
    const staffRecord = record.staff as Record<string, unknown>;
    if (typeof staffRecord.previousStaffId === "string" && typeof staffRecord.previousStaffName === "string") {
      staffById.set(staffRecord.previousStaffId, staffRecord.previousStaffName);
    }
    if (typeof staffRecord.newStaffId === "string" && typeof staffRecord.newStaffName === "string") {
      staffById.set(staffRecord.newStaffId, staffRecord.newStaffName);
    }
    const prev = resolveStaffLabel(staffRecord.previousStaffId ?? staffRecord.previous);
    const next = resolveStaffLabel(staffRecord.newStaffId ?? staffRecord.next);
    lines.push({ type: "text", value: `Mitarbeiter geändert: ${prev} → ${next}` });
    handled.add("staff");
  }

  if ("service" in record && isPlainObject(record.service)) {
    const serviceRecord = record.service as Record<string, unknown>;
    if (typeof serviceRecord.previousServiceId === "string" && typeof serviceRecord.previousServiceName === "string") {
      serviceById.set(serviceRecord.previousServiceId, serviceRecord.previousServiceName);
    }
    if (typeof serviceRecord.newServiceId === "string" && typeof serviceRecord.newServiceName === "string") {
      serviceById.set(serviceRecord.newServiceId, serviceRecord.newServiceName);
    }
    const prev = resolveServiceLabel(serviceRecord.previousServiceId ?? serviceRecord.previous);
    const next = resolveServiceLabel(serviceRecord.newServiceId ?? serviceRecord.next);
    lines.push({ type: "text", value: `Leistung geändert: ${prev} → ${next}` });
    handled.add("service");
  }

  if ("itemTiming" in record && isPlainObject(record.itemTiming)) {
    const timing = record.itemTiming as Record<string, unknown>;
    lines.push({
      type: "text",
      value: `Zeitfenster angepasst: ${formatRange(timing.previousStartsAt, timing.previousEndsAt)} → ${formatRange(timing.newStartsAt, timing.newEndsAt)}`,
    });
    handled.add("itemTiming");
  }

  if ("appointmentStartsAt" in record && isPlainObject(record.appointmentStartsAt)) {
    const change = record.appointmentStartsAt as Record<string, unknown>;
    const prev =
      typeof change.previous === "string" ? formatDateTimeValue(change.previous) : formatDiffValue(change.previous);
    const next =
      typeof change.next === "string" ? formatDateTimeValue(change.next) : formatDiffValue(change.next);
    lines.push({
      type: "text",
      value: `Terminstart neu: ${prev} → ${next}`,
    });
    handled.add("appointmentStartsAt");
  }

  if ("appointmentEndsAt" in record && isPlainObject(record.appointmentEndsAt)) {
    const change = record.appointmentEndsAt as Record<string, unknown>;
    const prev =
      typeof change.previous === "string" ? formatDateTimeValue(change.previous) : formatDiffValue(change.previous);
    const next =
      typeof change.next === "string" ? formatDateTimeValue(change.next) : formatDiffValue(change.next);
    lines.push({
      type: "text",
      value: `Terminende neu: ${prev} → ${next}`,
    });
    handled.add("appointmentEndsAt");
  }

  if ("resultingItem" in record) {
    const resulting = record.resultingItem;
    if (isPlainObject(resulting)) {
      const summary = resulting as Record<string, unknown>;
      if (typeof summary.staffId === "string" && typeof summary.staffName === "string") {
        staffById.set(summary.staffId, summary.staffName);
      }
      if (typeof summary.serviceId === "string" && typeof summary.serviceName === "string") {
        serviceById.set(summary.serviceId, summary.serviceName);
      }
      const serviceLabel = typeof summary.serviceName === "string" ? summary.serviceName : resolveServiceLabel(summary.serviceId);
      const staffLabel = typeof summary.staffName === "string" ? summary.staffName : resolveStaffLabel(summary.staffId ?? null);
      const timeLabel =
        typeof summary.startsAt === "string" && typeof summary.endsAt === "string"
          ? formatRange(summary.startsAt, summary.endsAt)
          : null;
      const parts = [serviceLabel, staffLabel !== "Nicht zugewiesen" ? staffLabel : null, timeLabel]
        .filter(Boolean)
        .join(" · ");
      if (parts) {
        lines.push({ type: "text", value: `Aktueller Stand: ${parts}` });
      }
    }
    handled.add("resultingItem");
  }

  if ("deltaMinutes" in record) {
    const delta = Number(record.deltaMinutes);
    if (Number.isFinite(delta)) {
      if (delta > 0) {
        lines.push({ type: "text", value: `Termin um ${delta} Minuten nach hinten verschoben.` });
      } else if (delta < 0) {
        lines.push({ type: "text", value: `Termin um ${Math.abs(delta)} Minuten vorgezogen.` });
      } else {
        lines.push({ type: "text", value: "Startzeit beibehalten." });
      }
    }
    handled.add("deltaMinutes");
  }

  if ("newStartsAt" in record && typeof record.newStartsAt === "string") {
    lines.push({ type: "text", value: `Neue Startzeit: ${formatDateTimeValue(record.newStartsAt)}` });
    handled.add("newStartsAt");
  }

  if ("staffId" in record) {
    if (record.staffId === null) {
      lines.push({ type: "text", value: "Mitarbeiterzuordnung entfernt." });
    } else if (typeof record.staffId === "string") {
      const staffName = staffById.get(record.staffId);
      lines.push({
        type: "text",
        value: staffName ? `Mitarbeiter neu zugewiesen: ${staffName}` : `Mitarbeiter aktualisiert (ID ${record.staffId})`,
      });
    } else {
      lines.push({ type: "text", value: "Mitarbeiter aktualisiert." });
    }
    handled.add("staffId");
  }

  if ("amount" in record) {
    const amountValue = record.amount;
    if (amountValue === null) {
      lines.push({ type: "text", value: "Betrag entfernt." });
    } else {
      lines.push({ type: "text", value: `Betrag: ${formatDiffValue(amountValue)}` });
    }
    handled.add("amount");
  }

  if ("note" in record && !handled.has("note") && record.note !== undefined) {
    lines.push({ type: "text", value: `Notiz: ${formatDiffValue(record.note)}` });
    handled.add("note");
  }

  for (const [key, value] of Object.entries(record)) {
    if (handled.has(key)) continue;
    const formatted = formatDiffValue(value);
    lines.push({ type: "text", value: `${humanizeKey(key)}: ${formatted}` });
  }

  if (lines.length === 0) {
    const fallback = JSON.stringify(record, null, 2);
    if (fallback && fallback !== "{}") {
      lines.push({ type: "code", value: fallback });
    }
  }

  return lines;
}

function summarizeContext(context: unknown): AuditDetailLine[] {
  if (!isPlainObject(context)) {
    if (context === null || context === undefined) {
      return [];
    }
    if (typeof context === "string" && context.trim().length) {
      return [{ type: "text", value: context.trim() }];
    }
    return [{ type: "code", value: JSON.stringify(context, null, 2) }];
  }

  const record = context as Record<string, unknown>;
  const lines: AuditDetailLine[] = [];

  if (typeof record.source === "string" && record.source.trim().length) {
    lines.push({ type: "text", value: `Quelle: ${humanizeKey(record.source)}` });
  }

  for (const [key, value] of Object.entries(record)) {
    if (key === "source") continue;
    lines.push({ type: "text", value: `${humanizeKey(key)}: ${formatDiffValue(value)}` });
  }

  return lines;
}

function formatNoteValue(value: unknown): string {
  if (typeof value === "string" && value.trim().length) {
    return `„${value.trim()}“`;
  }
  return "leer";
}

function formatDiffValue(value: unknown): string {
  if (value === null || value === undefined) {
    return "—";
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.length) return "—";
    if (isIsoDateString(trimmed)) {
      return formatDateTimeValue(trimmed);
    }
    return trimmed;
  }
  if (typeof value === "number") {
    return new Intl.NumberFormat("de-DE", {
      minimumFractionDigits: Number.isInteger(value) ? 0 : 2,
      maximumFractionDigits: 2,
    }).format(value);
  }
  if (typeof value === "boolean") {
    return value ? "Ja" : "Nein";
  }
  if (Array.isArray(value)) {
    return value.map((item) => formatDiffValue(item)).join(", ");
  }
  if (isPlainObject(value)) {
    const record = value as Record<string, unknown>;
    if (typeof record.staffName === "string") {
      return record.staffName;
    }
    if (typeof record.name === "string") {
      return record.name;
    }
    if (typeof record.serviceName === "string") {
      return record.serviceName;
    }
    if (typeof record.label === "string") {
      return record.label;
    }
    return JSON.stringify(record);
  }
  return String(value);
}

function formatDateTimeValue(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }
  return format(date, "dd.MM.yyyy HH:mm", { locale: de });
}

function humanizeKey(value: string): string {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^./, (char) => char.toUpperCase());
}

function isIsoDateString(value: string): boolean {
  if (value.length < 10) return false;
  const date = new Date(value);
  return !Number.isNaN(date.getTime());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function CustomerSidebar({
  detail,
  locationSlug,
  ensureBookingActor,
}: {
  detail: AppointmentDetailPayload;
  locationSlug: string;
  ensureBookingActor: (contextLabel?: string) => Promise<BookingActor>;
}) {
  const { pushToast } = useToast();
  const [smsOpen, setSmsOpen] = useState(false);
  const [smsMessage, setSmsMessage] = useState("");
  const [smsSending, setSmsSending] = useState(false);
  const [smsError, setSmsError] = useState<string | null>(null);
  const customer = detail.appointment.customer;
  if (!customer) {
    return (
      <div className="text-sm text-zinc-500">
        Kein Kunde verknüpft.
      </div>
    );
  }

  const lastAction = detail.auditTrail.find((entry) => entry.action === "CREATE");
  const bookedAgo = lastAction ? formatDistanceToNow(new Date(lastAction.createdAt), { addSuffix: true, locale: de }) : null;

  return (
    <div className="space-y-4">
      <header>
        <p className="text-xs uppercase tracking-widest text-zinc-500">Kunde</p>
        <h3 className="text-lg font-semibold text-zinc-900">{customer.name}</h3>
        {bookedAgo && <p className="text-xs text-zinc-500">Termin angelegt {bookedAgo}</p>}
      </header>
      <dl className="space-y-2 text-sm text-zinc-700">
        <InfoRow term="E-Mail" description={customer.email ?? "–"} />
        <InfoRow term="Telefon" description={customer.phone ?? "–"} />
      </dl>
      <div className="flex flex-col gap-2 text-xs">
        {customer.email && (
          <a href={`mailto:${customer.email}`} className="rounded-full border border-zinc-300 px-3 py-1 text-center text-zinc-600 transition hover:bg-zinc-100">
            E-Mail senden
          </a>
        )}
        {customer.phone && (
          <a href={`tel:${customer.phone}`} className="rounded-full border border-zinc-300 px-3 py-1 text-center text-zinc-600 transition hover:bg-zinc-100">
            Anrufen
          </a>
        )}
        {customer.phone && (
          <button
            type="button"
            onClick={() => {
              setSmsOpen((open) => !open);
              setSmsError(null);
            }}
            className="rounded-full border border-zinc-300 px-3 py-1 text-center text-zinc-600 transition hover:bg-zinc-100"
          >
            SMS schreiben
          </button>
        )}
      </div>
      {customer.phone && smsOpen && (
        <div className="space-y-2 rounded-lg border border-zinc-200 bg-white/70 p-3 text-xs text-zinc-600">
          <label className="text-xs font-semibold text-zinc-700">SMS Nachricht</label>
          <textarea
            value={smsMessage}
            onChange={(event) => setSmsMessage(event.target.value)}
            rows={4}
            className="w-full rounded-lg border border-zinc-300 px-3 py-2 text-xs text-zinc-700 placeholder:text-zinc-400"
            placeholder="Nachricht eingeben..."
          />
          {smsError && <p className="text-xs text-red-600">{smsError}</p>}
          <div className="flex gap-2">
            <button
              type="button"
              onClick={async () => {
                const message = smsMessage.trim();
                if (!message) {
                  setSmsError("Bitte eine Nachricht eingeben.");
                  return;
                }
                setSmsSending(true);
                setSmsError(null);
                let actor: BookingActor;
                try {
                  actor = await ensureBookingActor("SMS senden");
                } catch {
                  setSmsSending(false);
                  setSmsError("Buchungsfreigabe fehlt.");
                  return;
                }
                try {
                  const response = await fetch(
                    `/api/backoffice/${locationSlug}/appointments/${detail.appointment.id}/sms`,
                    {
                      method: "POST",
                      headers: { "Content-Type": "application/json" },
                      body: JSON.stringify({
                        message,
                        performedBy: { staffId: actor.staffId, token: actor.token },
                      }),
                    },
                  );
                  const payload = await response.json().catch(() => ({}));
                  if (!response.ok || payload?.ok === false || payload?.error) {
                    throw new Error(payload?.error ?? "SMS konnte nicht gesendet werden.");
                  }
                  pushToast({ variant: "success", message: "SMS gesendet." });
                  setSmsMessage("");
                  setSmsOpen(false);
                } catch (error) {
                  const message = error instanceof Error ? error.message : "SMS konnte nicht gesendet werden.";
                  setSmsError(message);
                  pushToast({ variant: "error", message });
                } finally {
                  setSmsSending(false);
                }
              }}
              disabled={smsSending}
              className="rounded-full bg-zinc-900 px-3 py-1 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed"
            >
              SMS senden
            </button>
            <button
              type="button"
              onClick={() => {
                setSmsOpen(false);
                setSmsError(null);
              }}
              disabled={smsSending}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}
      <p className="rounded-lg bg-zinc-100 px-3 py-2 text-xs text-zinc-600">
        Stammdaten & weitere Historie folgen im Kundenprofil.
      </p>
    </div>
  );
}

function SidebarPlaceholder() {
  return (
    <div className="flex h-full items-center justify-center text-xs text-zinc-500">
      Wähle einen Termin für Details.
    </div>
  );
}

function extractAppointmentMetadata(metadata: unknown): {
  createdByStaff: string | null;
  lastUpdatedByStaff: string | null;
  lastUpdatedAt: string | null;
} {
  if (!isPlainObject(metadata)) {
    return { createdByStaff: null, lastUpdatedByStaff: null, lastUpdatedAt: null };
  }
  const record = metadata as Record<string, unknown>;
  return {
    createdByStaff: extractStaffMetadata(record.createdByStaff),
    lastUpdatedByStaff: extractStaffMetadata(record.lastUpdatedByStaff),
    lastUpdatedAt: typeof record.lastUpdatedAt === "string" ? record.lastUpdatedAt : null,
  };
}

function extractStaffMetadata(value: unknown): string | null {
  if (!isPlainObject(value)) return null;
  const name = typeof value.staffName === "string" ? value.staffName.trim() : "";
  const id = typeof value.staffId === "string" ? value.staffId.trim() : "";
  if (name.length) return name;
  if (id.length) return `ID ${id}`;
  return null;
}

function InfoRow({ term, description }: { term: string; description: string }) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-widest text-zinc-400">{term}</dt>
      <dd className="text-sm text-zinc-700">{description}</dd>
    </div>
  );
}

function handleDownloadIcs(detail: AppointmentDetailPayload | null) {
  if (!detail?.ics) return;
  const blob = new Blob([detail.ics], { type: "text/calendar;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `termin-${detail.appointment.confirmationCode}.ics`;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function statusBadgeClass(status: string) {
  switch (status) {
    case "CONFIRMED":
      return "bg-emerald-100 text-emerald-700 border-emerald-200";
    case "COMPLETED":
      return "bg-blue-100 text-blue-700 border-blue-200";
    case "CANCELLED":
      return "bg-zinc-100 text-zinc-600 border-zinc-200";
    case "NO_SHOW":
      return "bg-red-100 text-red-700 border-red-200";
    default:
      return "bg-amber-100 text-amber-700 border-amber-200";
  }
}

function statusLabel(status: string) {
  switch (status) {
    case "CONFIRMED":
      return "Bestätigt";
    case "PENDING":
      return "Offen";
    case "COMPLETED":
      return "Abgeschlossen";
    case "CANCELLED":
      return "Storniert";
    case "NO_SHOW":
      return "Nicht erschienen";
    default:
      return status;
  }
}

function paymentBadgeClass(status: string) {
  switch (status) {
    case "PAID":
      return "bg-emerald-100 text-emerald-700 border-emerald-200";
    case "PARTIALLY_PAID":
      return "bg-blue-100 text-blue-700 border-blue-200";
    case "REFUNDED":
      return "bg-zinc-100 text-zinc-600 border-zinc-200";
    case "FAILED":
      return "bg-red-100 text-red-700 border-red-200";
    default:
      return "bg-amber-100 text-amber-700 border-amber-200";
  }
}

function paymentStatusLabel(status: string) {
  switch (status) {
    case "PAID":
      return "Bezahlt";
    case "UNPAID":
      return "Offen";
    case "PARTIALLY_PAID":
      return "Teilweise bezahlt";
    case "REFUNDED":
      return "Erstattet";
    case "FAILED":
      return "Fehlgeschlagen";
    default:
      return status;
  }
}

function notificationBadgeClass(status: string) {
  switch (status) {
    case "SENT":
      return "bg-emerald-100 text-emerald-700 border-emerald-200";
    case "FAILED":
      return "bg-red-100 text-red-700 border-red-200";
    case "CANCELLED":
      return "bg-zinc-100 text-zinc-600 border-zinc-200";
    default:
      return "bg-amber-100 text-amber-700 border-amber-200";
  }
}

function notificationStatusLabel(status: string) {
  switch (status) {
    case "SENT":
      return "Versendet";
    case "FAILED":
      return "Fehlgeschlagen";
    case "CANCELLED":
      return "Abgebrochen";
    case "PENDING":
      return "Geplant";
    default:
      return status;
  }
}

function notificationLabel(type: string) {
  switch (type) {
    case "REMINDER_24H":
      return "Erinnerung 24h";
    case "REMINDER_2H":
      return "Erinnerung 2h";
    case "FOLLOW_UP":
      return "Follow-up";
    default:
      return type;
  }
}

function channelLabel(channel: string) {
  switch (channel) {
    case "EMAIL":
      return "E-Mail";
    case "SMS":
      return "SMS";
    case "WHATSAPP":
      return "WhatsApp";
    case "PUSH":
      return "Push";
    default:
      return channel;
  }
}

function triggerLabel(trigger: string) {
  switch (trigger) {
    case "BOOKING_CONFIRMED":
      return "Nach Buchung";
    case "REMINDER":
      return "Reminder";
    case "FOLLOW_UP":
      return "Follow-up";
    default:
      return trigger;
  }
}

function sourceLabel(source: string) {
  switch (source) {
    case "WEB":
      return "Online-Buchung";
    case "ADMIN":
      return "Backoffice";
    case "POS":
      return "Point of Sale";
    default:
      return source;
  }
}

function auditActionLabel(action: string) {
  switch (action) {
    case "CREATE":
      return "Angelegt";
    case "UPDATE":
      return "Aktualisiert";
    case "DELETE":
      return "Gelöscht";
    case "EXPORT":
      return "Exportiert";
    default:
      return action;
  }
}

function formatCurrency(value: number, currency: string) {
  return new Intl.NumberFormat("de-DE", { style: "currency", currency }).format(value);
}

function formatFileSize(bytes: number) {
  if (bytes >= 1024 * 1024) {
    return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
  }
  if (bytes >= 1024) {
    return `${(bytes / 1024).toFixed(1)} kB`;
  }
  return `${bytes} B`;
}

const PREVIEWABLE_MIME_TYPES = new Set(["image/jpeg", "image/png", "image/gif", "image/webp", "application/pdf"]);

function isPreviewable(mimeType?: string | null) {
  if (!mimeType) return false;
  return PREVIEWABLE_MIME_TYPES.has(mimeType.toLowerCase());
}

const RESENDABLE_TRIGGERS = new Set(["APPOINTMENT_REMINDER", "NO_SHOW_FOLLOW_UP"]);

function statusSuccessMessage(status: AppointmentStatusValue) {
  switch (status) {
    case "CONFIRMED":
      return "Termin als bestätigt markiert.";
    case "COMPLETED":
      return "Termin als abgeschlossen markiert.";
    case "CANCELLED":
      return "Termin wurde storniert.";
    case "NO_SHOW":
      return "Termin als nicht erschienen markiert.";
    case "PENDING":
      return "Termin zurück auf offen gesetzt.";
    default:
      return "Status aktualisiert.";
  }
}

function extractAttemptCount(metadata: Record<string, unknown> | null | undefined) {
  if (!metadata || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>).attempts ?? (metadata as Record<string, unknown>).retryCount;
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.max(0, Math.floor(value));
  }
  if (typeof value === "string") {
    const parsed = Number.parseInt(value, 10);
    if (Number.isFinite(parsed)) {
      return Math.max(0, parsed);
    }
  }
  return null;
}

const noteRequiredPaymentStatuses = new Set<PaymentStatusValue>([
  "REFUNDED",
  "PARTIALLY_REFUNDED",
]);

const amountRequiredPaymentStatuses = new Set<PaymentStatusValue>([
  "PARTIALLY_REFUNDED",
  "REFUNDED",
]);

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

function canEditAppointment(detail: AppointmentDetailPayload, actor: BookingActor | null): boolean {
  if (detail.appointment.status === "CANCELLED") {
    return false;
  }

  if (detail.appointment.status !== "COMPLETED") {
    return true;
  }

  if (!actor) {
    return false;
  }

  const { end } = getAppointmentBounds(detail);
  const now = new Date();
  const elapsedMs = now.getTime() - end.getTime();

  if (elapsedMs <= 0) {
    return true;
  }

  if (elapsedMs <= TWENTY_FOUR_HOURS_MS) {
    return isRoleOneValue(actor.role) || isAdminRoleValue(actor.role);
  }

  return isAdminRoleValue(actor.role);
}

function getAppointmentBounds(detail: AppointmentDetailPayload): { start: Date; end: Date } {
  if (!detail.appointment.items.length) {
    return {
      start: new Date(detail.appointment.startsAt),
      end: new Date(detail.appointment.endsAt),
    };
  }
  const starts = detail.appointment.items.map((item) => new Date(item.startsAt));
  const ends = detail.appointment.items.map((item) => new Date(item.endsAt));
  return {
    start: minDate(starts),
    end: maxDate(ends),
  };
}

function paymentSuccessMessage(status: PaymentStatusValue) {
  switch (status) {
    case "AUTHORIZED":
      return "Zahlung als autorisiert vermerkt.";
    case "PAID":
      return "Zahlung als abgeschlossen vermerkt.";
    case "PARTIALLY_REFUNDED":
      return "Teilrückzahlung dokumentiert.";
    case "REFUNDED":
      return "Vollständige Rückzahlung dokumentiert.";
    case "UNPAID":
      return "Zahlungsstatus auf offen gesetzt.";
    default:
      return "Zahlungsstatus aktualisiert.";
  }
}

function PaymentActions({
  status,
  onStatusChange,
  loading,
  error,
  showNote,
  setShowNote,
  note,
  setNote,
  setError,
  amount,
  setAmount,
  pendingStatus,
  setPendingStatus,
}: {
  status: PaymentStatusValue;
  onStatusChange: (status: PaymentStatusValue, options?: { note?: string; amount?: number }) => Promise<void>;
  loading: boolean;
  error: string | null;
  showNote: boolean;
  setShowNote: (value: boolean) => void;
  note: string;
  setNote: (value: string) => void;
  setError: (value: string | null) => void;
  amount: string;
  setAmount: (value: string) => void;
  pendingStatus: PaymentStatusValue | null;
  setPendingStatus: (value: PaymentStatusValue | null) => void;
}) {
  const actions: Array<{ status: PaymentStatusValue; label: string }> = [];

  switch (status) {
    case "UNPAID":
      actions.push({ status: "AUTHORIZED", label: "Zahlung autorisiert" });
      actions.push({ status: "PAID", label: "Als bezahlt markieren" });
      break;
    case "AUTHORIZED":
      actions.push({ status: "PAID", label: "Zahlung buchen" });
      actions.push({ status: "PARTIALLY_REFUNDED", label: "Teilrückzahlung verbuchen" });
      actions.push({ status: "REFUNDED", label: "Vollständig erstatten" });
      break;
    case "PAID":
      actions.push({ status: "PARTIALLY_REFUNDED", label: "Teilrückzahlung verbuchen" });
      actions.push({ status: "REFUNDED", label: "Vollständig erstatten" });
      break;
    case "PARTIALLY_REFUNDED":
      actions.push({ status: "PAID", label: "Als vollständig bezahlt markieren" });
      actions.push({ status: "REFUNDED", label: "Restbetrag erstatten" });
      break;
    case "REFUNDED":
    default:
      break;
  }

  return (
    <section className="space-y-4">
      <header>
        <h3 className="text-sm font-semibold text-zinc-900">Zahlungsstatus</h3>
        <p className="text-xs text-zinc-500">Dokumentiere den Zahlungsfortschritt oder Rückerstattungen.</p>
      </header>

      <div className="flex flex-wrap gap-2">
        {actions.map((action) => {
          const needsNote = noteRequiredPaymentStatuses.has(action.status);
          const needsAmount = amountRequiredPaymentStatuses.has(action.status);
          return (
            <button
              key={action.status}
              type="button"
              onClick={() => {
                setError(null);
                if (needsNote && !note.trim().length) {
                  setPendingStatus(action.status);
                  setShowNote(true);
                  setError("Bitte gib eine Notiz zur Rückerstattung an.");
                  return;
                }
                if (needsAmount && (!amount.trim().length || Number.isNaN(Number.parseFloat(amount)))) {
                  setPendingStatus(action.status);
                  setShowNote(true);
                  setError("Bitte gib den Rückerstattungsbetrag an.");
                  return;
                }
                setPendingStatus(null);
                onStatusChange(action.status, {
                  note: note.trim() || undefined,
                  amount: needsAmount ? Number.parseFloat(amount) : undefined,
                });
              }}
              disabled={loading}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
            >
              {action.label}
            </button>
          );
        })}
        {status === "REFUNDED" && actions.length === 0 && (
          <span className="text-xs text-zinc-500">Keine weiteren Aktionen verfügbar.</span>
        )}
      </div>

      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      {showNote && (
        <div className="space-y-3 rounded-lg border border-zinc-200 bg-zinc-50 p-3">
          <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Notiz zur Zahlung</label>
          <textarea
            value={note}
            onChange={(event) => {
              setError(null);
              setNote(event.target.value);
            }}
            placeholder="Rückerstattungsgrund oder Transaktionshinweis"
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
            rows={3}
            maxLength={500}
          />
          {amountRequiredPaymentStatuses.has(pendingStatus ?? status) && (
            <div className="space-y-1">
              <label className="text-xs font-semibold uppercase tracking-widest text-zinc-500">Betrag</label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={amount}
                onChange={(event) => {
                  setError(null);
                  setAmount(event.target.value);
                }}
                className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm focus:border-zinc-900 focus:outline-none focus:ring-2 focus:ring-zinc-900/10"
                placeholder="z. B. 25,00"
              />
            </div>
          )}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                if (!pendingStatus) {
                  setShowNote(false);
                  setNote("");
                  setAmount("");
                  return;
                }
                if (!note.trim().length) {
                  setError("Bitte gib eine Notiz zur Rückerstattung an.");
                  return;
                }
                if (amountRequiredPaymentStatuses.has(pendingStatus) && (!amount.trim().length || Number.isNaN(Number.parseFloat(amount)))) {
                  setError("Bitte gib den Rückerstattungsbetrag an.");
                  return;
                }
                onStatusChange(pendingStatus, {
                  note: note.trim(),
                  amount: amountRequiredPaymentStatuses.has(pendingStatus)
                    ? Number.parseFloat(amount)
                    : undefined,
                });
              }}
              disabled={
                loading ||
                !pendingStatus ||
                !note.trim().length ||
                (amountRequiredPaymentStatuses.has(pendingStatus) && (!amount.trim().length || Number.isNaN(Number.parseFloat(amount))))
              }
              className="rounded-full bg-zinc-900 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-500"
            >
              {pendingStatus ? "Aktion ausführen" : "Schließen"}
            </button>
            <button
              type="button"
              onClick={() => {
                setShowNote(false);
                setNote("");
                setAmount("");
                setPendingStatus(null);
                setError(null);
              }}
              disabled={loading}
              className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

function StatusActions({
  status,
  allowNoShow,
  onStatusChange,
  loading,
  error,
  showCancelForm,
  setShowCancelForm,
  cancelReason,
  setCancelReason,
  confirmLabel,
}: {
  status: AppointmentStatusValue;
  allowNoShow: boolean;
  onStatusChange: (status: AppointmentStatusValue, options?: { reason?: string }) => Promise<boolean>;
  loading: boolean;
  error: string | null;
  showCancelForm: boolean;
  setShowCancelForm: (value: boolean) => void;
  cancelReason: string;
  setCancelReason: (value: string) => void;
  confirmLabel?: string;
}) {
  const actions: Array<{ status: AppointmentStatusValue; label: string }> = [];

  switch (status) {
    case "PENDING":
      actions.push({ status: "CONFIRMED", label: confirmLabel ?? "Als bestätigt markieren" });
      break;
    case "CONFIRMED":
      actions.push({ status: "COMPLETED", label: "Als abgeschlossen markieren" });
      if (allowNoShow) {
        actions.push({ status: "NO_SHOW", label: "Als nicht erschienen markieren" });
      }
      break;
    case "COMPLETED":
      actions.push({ status: "CONFIRMED", label: "Zurück zu bestätigt" });
      if (allowNoShow) {
        actions.push({ status: "NO_SHOW", label: "Als nicht erschienen markieren" });
      }
      break;
    case "NO_SHOW":
      actions.push({ status: "CONFIRMED", label: "Zurück zu bestätigt" });
      actions.push({ status: "COMPLETED", label: "Als abgeschlossen markieren" });
      break;
    case "CANCELLED":
      actions.push({ status: "CONFIRMED", label: "Zurück zu bestätigt" });
      break;
    default:
      break;
  }

  const canCancel = status !== "CANCELLED";

  return (
    <section className="space-y-4">
      <header>
        <h3 className="text-sm font-semibold text-zinc-900">Status & Aktionen</h3>
        <p className="text-xs text-zinc-500">Passe den Terminstatus an oder storniere den Termin mit Grund.</p>
      </header>

      <div className="flex flex-wrap gap-2">
        {actions.map((action) => (
          <button
            key={action.status}
            type="button"
            onClick={() => {
              void onStatusChange(action.status);
            }}
            disabled={loading}
            className="rounded-full border border-zinc-300 px-3 py-1 text-xs font-semibold text-zinc-600 transition hover:bg-zinc-100 disabled:cursor-not-allowed disabled:text-zinc-400"
          >
            {action.label}
          </button>
        ))}
        {canCancel && (
          <button
            type="button"
            onClick={() => setShowCancelForm(!showCancelForm)}
            className="rounded-full border border-red-200 px-3 py-1 text-xs font-semibold text-red-600 transition hover:bg-red-50 disabled:cursor-not-allowed disabled:text-red-300"
            disabled={loading}
          >
            {showCancelForm ? "Storno abbrechen" : "Termin stornieren"}
          </button>
        )}
      </div>

      {error && <p className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>}

      {showCancelForm && canCancel && (
        <div className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-3">
          <label className="text-xs font-semibold uppercase tracking-widest text-red-600">
            Stornierungsgrund
          </label>
          <textarea
            value={cancelReason}
            onChange={(event) => setCancelReason(event.target.value)}
            className="w-full rounded-md border border-red-200 px-3 py-2 text-sm text-red-900 focus:border-red-500 focus:outline-none focus:ring-2 focus:ring-red-500/20"
            placeholder="Kurze Begründung für die Stornierung"
            rows={3}
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                void onStatusChange("CANCELLED", { reason: cancelReason });
              }}
              disabled={loading}
              className="rounded-full bg-red-600 px-4 py-1.5 text-xs font-semibold text-white transition hover:bg-red-700 disabled:cursor-not-allowed disabled:bg-red-400"
            >
              Stornierung bestätigen
            </button>
            <button
              type="button"
              onClick={() => {
                setCancelReason("");
                setShowCancelForm(false);
              }}
              disabled={loading}
              className="rounded-full border border-red-200 px-3 py-1 text-xs font-semibold text-red-600 transition hover:bg-red-100 disabled:cursor-not-allowed disabled:text-red-300"
            >
              Abbrechen
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
