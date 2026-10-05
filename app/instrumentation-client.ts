/**
 * Next 15 browser instrumentation hook.
 *
 * The client Sentry config is NOT loaded by instrumentation.ts — that file only runs for the
 * nodejs and edge runtimes. Without this file sentry.client.config.ts is never imported, so
 * browser errors are silently never reported: the SDK is installed, the DSN is set, the
 * dashboard stays empty and nothing indicates why.
 */
import "./sentry.client.config";

export { captureRouterTransitionStart as onRouterTransitionStart } from "@sentry/nextjs";
