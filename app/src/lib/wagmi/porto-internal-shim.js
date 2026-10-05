/**
 * @wagmi/connectors imports `{ z }` from `porto/internal` even when Porto is unused.
 * Webpack also cannot follow porto's `export * as z from 'zod/mini'` re-export.
 */
import * as z from "./zod-mini-shim.js";

export { z };
export const encode = z.encode;
export const decode = z.decode;
