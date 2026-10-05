"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  CONFIRM_EVENT,
  TOAST_EVENT,
  type AppConfirmDetail,
  type AppToastDetail,
} from "@/lib/appToast";
import "./AppToast.css";

type ToastState = AppToastDetail & { id: number };
type ConfirmState = AppConfirmDetail & { id: number; resolve: (ok: boolean) => void };

function IconForType({ type }: { type?: AppToastDetail["type"] }) {
  if (type === "error") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
        <circle cx="12" cy="12" r="10" />
        <line x1="12" y1="8" x2="12" y2="12" />
        <line x1="12" y1="16" x2="12.01" y2="16" />
      </svg>
    );
  }
  if (type === "success") {
    return (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
        <polyline points="20 6 9 17 4 12" />
      </svg>
    );
  }
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
      <circle cx="12" cy="12" r="10" />
      <line x1="12" y1="16" x2="12" y2="12" />
      <line x1="12" y1="8" x2="12.01" y2="8" />
    </svg>
  );
}

function IconDoor() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
      <path d="M10 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h5" />
      <path d="M10 3v18" />
      <path d="M15 8l5 4-5 4" />
      <path d="M20 12H10" />
    </svg>
  );
}

export default function AppToastHost() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const [confirm, setConfirm] = useState<ConfirmState | null>(null);
  const [exiting, setExiting] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const idRef = useRef(0);
  const confirmRef = useRef<ConfirmState | null>(null);
  confirmRef.current = confirm;

  const clearTimer = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  const dismissToast = useCallback(() => {
    clearTimer();
    setExiting(true);
    timerRef.current = setTimeout(() => {
      setToast(null);
      setExiting(false);
    }, 350);
  }, [clearTimer]);

  const settleConfirm = useCallback((ok: boolean) => {
    const current = confirmRef.current;
    if (!current) return;
    current.resolve(ok);
    confirmRef.current = null;
    setConfirm(null);
    setExiting(false);
  }, []);

  useEffect(() => {
    const onToast = (event: Event) => {
      if (confirmRef.current) return;
      const detail = (event as CustomEvent<AppToastDetail>).detail;
      if (!detail?.message) return;

      clearTimer();
      setExiting(false);
      idRef.current += 1;
      setToast({ ...detail, id: idRef.current });

      const duration = detail.durationMs ?? 3200;
      if (duration > 0) {
        timerRef.current = setTimeout(dismissToast, duration);
      }
    };

    const onConfirm = (event: Event) => {
      const detail = (event as CustomEvent<AppConfirmDetail & { resolve: (ok: boolean) => void }>).detail;
      if (!detail?.title || typeof detail.resolve !== "function") return;

      confirmRef.current?.resolve(false);
      clearTimer();
      setToast(null);
      setExiting(false);
      idRef.current += 1;
      const next = { ...detail, id: idRef.current };
      confirmRef.current = next;
      setConfirm(next);
    };

    window.addEventListener(TOAST_EVENT, onToast);
    window.addEventListener(CONFIRM_EVENT, onConfirm);
    return () => {
      window.removeEventListener(TOAST_EVENT, onToast);
      window.removeEventListener(CONFIRM_EVENT, onConfirm);
      confirmRef.current?.resolve(false);
      confirmRef.current = null;
      clearTimer();
    };
  }, [clearTimer, dismissToast]);

  useEffect(() => {
    if (!confirm) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        settleConfirm(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, settleConfirm]);

  if (confirm) {
    const tone = confirm.tone ?? "danger";
    return (
      <div
        key={confirm.id}
        className={`app-toast app-toast--confirm app-toast--${tone}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`app-toast-title-${confirm.id}`}
        aria-describedby={`app-toast-body-${confirm.id}`}
      >
        {tone === "danger" ? <IconDoor /> : <IconForType type="info" />}
        <div className="app-toast-confirm-body">
          <strong id={`app-toast-title-${confirm.id}`}>{confirm.title}</strong>
          <p id={`app-toast-body-${confirm.id}`}>{confirm.message}</p>
          <div className="app-toast-confirm-actions">
            <button
              type="button"
              className="app-toast-btn app-toast-btn--ghost"
              autoFocus
              onClick={() => settleConfirm(false)}
            >
              {confirm.cancelLabel ?? "Cancel"}
            </button>
            <button
              type="button"
              className="app-toast-btn app-toast-btn--danger"
              onClick={() => settleConfirm(true)}
            >
              {confirm.confirmLabel ?? "Confirm"}
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (!toast) return null;

  return (
    <div
      key={toast.id}
      className={`app-toast app-toast--${toast.type ?? "info"}${exiting ? " app-toast--exiting" : ""}`}
      role="alert"
      onClick={dismissToast}
    >
      <IconForType type={toast.type} />
      <span>{toast.message}</span>
    </div>
  );
}
