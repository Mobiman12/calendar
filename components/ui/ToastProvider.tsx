"use client";

import { createContext, useCallback, useContext, useMemo, useState } from "react";

export type ToastVariant = "success" | "error" | "info";

export interface ToastMessage {
  id: string;
  title?: string;
  message: string;
  variant?: ToastVariant;
  duration?: number;
}

interface ToastContextValue {
  toasts: ToastMessage[];
  pushToast: (toast: Omit<ToastMessage, "id">) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | undefined>(undefined);

export function useToast() {
  const context = useContext(ToastContext);
  if (!context) {
    throw new Error("useToast must be used within ToastProvider");
  }
  return context;
}

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<ToastMessage[]>([]);

  const pushToast = useCallback<ToastContextValue["pushToast"]>((toast) => {
    const id = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`;
    const duration = toast.duration ?? 4000;
    setToasts((current) => [...current, { id, variant: "info", ...toast }]);
    if (duration > 0) {
      setTimeout(() => {
        setToasts((current) => current.filter((entry) => entry.id !== id));
      }, duration);
    }
  }, []);

  const dismissToast = useCallback<ToastContextValue["dismissToast"]>((id) => {
    setToasts((current) => current.filter((entry) => entry.id !== id));
  }, []);

  const value = useMemo<ToastContextValue>(() => ({ toasts, pushToast, dismissToast }), [toasts, pushToast, dismissToast]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer toasts={toasts} onDismiss={value.dismissToast} />
    </ToastContext.Provider>
  );
}

function ToastContainer({ toasts, onDismiss }: { toasts: ToastMessage[]; onDismiss: (id: string) => void }) {
  if (!toasts.length) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 top-6 z-[9999] flex flex-col items-center gap-3 px-4">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-toast="true"
          data-variant={toast.variant ?? "info"}
          className={`pointer-events-auto w-full max-w-sm rounded-lg border px-4 py-3 text-sm shadow-lg backdrop-blur transition ${
            toast.variant === "success"
              ? "border-emerald-200 bg-emerald-50 text-emerald-900"
              : toast.variant === "error"
                ? "border-red-200 bg-red-50 text-red-700"
                : "border-zinc-200 bg-white text-zinc-800"
          }`}
        >
          <div className="flex items-start justify-between gap-3">
            <div>
              {toast.title && <p className="text-sm font-semibold">{toast.title}</p>}
              <p className="text-sm">{toast.message}</p>
            </div>
            <button
              type="button"
              onClick={() => onDismiss(toast.id)}
              className="text-xs text-zinc-400 transition hover:text-zinc-600"
            >
              ×
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
