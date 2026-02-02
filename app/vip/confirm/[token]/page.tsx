"use client";

import { useCallback, useMemo, useState } from "react";
import { useParams } from "next/navigation";

const COOKIE_NAME = "booking_device_id";
const ONE_YEAR_SECONDS = 60 * 60 * 24 * 365;

type ConfirmStatus = "idle" | "loading" | "success" | "expired" | "error";

function readDeviceCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(/(?:^|; )booking_device_id=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : null;
}

function writeDeviceCookie(deviceId: string) {
  if (typeof document === "undefined") return;
  const secure = typeof window !== "undefined" && window.location.protocol === "https:";
  const parts = [
    `${COOKIE_NAME}=${encodeURIComponent(deviceId)}`,
    "Path=/",
    `Max-Age=${ONE_YEAR_SECONDS}`,
    "SameSite=Lax",
  ];
  if (secure) {
    parts.push("Secure");
  }
  document.cookie = parts.join("; ");
}

function ensureDeviceId(): string | null {
  const existing = readDeviceCookie();
  if (existing) return existing;
  if (typeof crypto?.randomUUID !== "function") return null;
  const next = crypto.randomUUID();
  writeDeviceCookie(next);
  return next;
}

export default function VipConfirmPage() {
  const params = useParams<{ token?: string | string[] }>();
  const rawToken = Array.isArray(params?.token) ? params?.token[0] : params?.token;
  const token = useMemo(() => decodeURIComponent(rawToken ?? ""), [rawToken]);
  const [status, setStatus] = useState<ConfirmStatus>("idle");
  const [message, setMessage] = useState<string | null>(null);

  const handleConfirm = useCallback(async () => {
    const deviceId = ensureDeviceId();
    if (!deviceId) {
      setStatus("error");
      setMessage("Gerät konnte nicht erkannt werden.");
      return;
    }
    setStatus("loading");
    setMessage(null);
    try {
      const response = await fetch("/api/vip/confirm", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, deviceId }),
      });
      if (response.ok) {
        setStatus("success");
        return;
      }
      const payload = await response.json().catch(() => ({}));
      if (response.status === 410) {
        setStatus("expired");
        setMessage("Der Link ist abgelaufen. Bitte fordere einen neuen Bestätigungslink an.");
        return;
      }
      const errorMessage =
        typeof payload?.error === "string" && payload.error.length
          ? payload.error
          : "Bestätigung fehlgeschlagen.";
      setStatus("error");
      setMessage(errorMessage);
    } catch (error) {
      setStatus("error");
      setMessage("Bestätigung fehlgeschlagen.");
    }
  }, [token]);

  return (
    <main className="mx-auto flex min-h-screen max-w-xl items-center px-6 py-16">
      <div className="w-full rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm">
        <h1 className="text-xl font-semibold text-zinc-900">Freischaltung bestätigen</h1>
        <p className="mt-2 text-sm text-zinc-600">
          Bestätige die Freigabe, damit du bestimmte Mitarbeitende online buchen kannst.
        </p>

        {status === "success" ? (
          <div className="mt-6 rounded-lg border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800">
            Freigabe erfolgreich bestätigt.
          </div>
        ) : null}

        {status === "expired" || status === "error" ? (
          <div className="mt-6 rounded-lg border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">
            {message ?? "Bestätigung fehlgeschlagen."}
          </div>
        ) : null}

        {status !== "success" && (
          <button
            type="button"
            onClick={handleConfirm}
            className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-md bg-zinc-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-zinc-800 disabled:cursor-not-allowed disabled:bg-zinc-400"
            disabled={status === "loading"}
          >
            {status === "loading" ? "Bestätige..." : "Bestätigen"}
          </button>
        )}
      </div>
    </main>
  );
}
