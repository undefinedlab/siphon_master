/**
 * Webpack/Next often fails to resolve Zod 4's `zod/mini` export conditions.
 * Re-export the concrete ESM file so named `encode`/`decode` and namespace `z` exist.
 */
import * as z from "../../../node_modules/zod/v4/mini/external.js";

export * from "../../../node_modules/zod/v4/mini/external.js";
export { z };
export default z;
export const encode = z.encode;
export const decode = z.decode;
