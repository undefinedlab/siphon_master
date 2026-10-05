"use client";

import "./BuildSimToast.css";

interface BuildSimToastProps {
  message: string;
  type: "error" | "success";
  exiting?: boolean;
  onDismiss?: () => void;
}

export default function BuildSimToast({ message, type, exiting, onDismiss }: BuildSimToastProps) {
  return (
    <div
      className={`build-sim-toast build-sim-toast--${type}${exiting ? " build-sim-toast--exiting" : ""}`}
      role="alert"
      onClick={onDismiss}
    >
      {type === "error" ? (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <circle cx="12" cy="12" r="10" />
          <line x1="12" y1="8" x2="12" y2="12" />
          <line x1="12" y1="16" x2="12.01" y2="16" />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
      <span className="build-sim-toast__msg">{message}</span>
      {onDismiss && (
        <button
          type="button"
          className="build-sim-toast__close"
          aria-label="Dismiss"
          onClick={(e) => { e.stopPropagation(); onDismiss(); }}
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" aria-hidden>
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      )}
    </div>
  );
}
