export type AppToastType = "success" | "error" | "info";

export type AppToastDetail = {
  message: string;
  type?: AppToastType;
  durationMs?: number;
};

export type AppConfirmTone = "danger" | "warn" | "info";

export type AppConfirmDetail = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: AppConfirmTone;
};

const TOAST_EVENT = "siphon:app-toast";
const CONFIRM_EVENT = "siphon:app-confirm";

export function showAppToast(
  message: string,
  type: AppToastType = "info",
  durationMs = 3200,
) {
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent<AppToastDetail>(TOAST_EVENT, {
      detail: { message, type, durationMs },
    }),
  );
}

/** Styled confirm in the same toast host — never `window.confirm`. */
export function showAppConfirm(opts: AppConfirmDetail): Promise<boolean> {
  if (typeof window === "undefined") return Promise.resolve(false);
  return new Promise((resolve) => {
    window.dispatchEvent(
      new CustomEvent<AppConfirmDetail & { resolve: (ok: boolean) => void }>(CONFIRM_EVENT, {
        detail: { ...opts, resolve },
      }),
    );
  });
}

export { TOAST_EVENT, CONFIRM_EVENT };
