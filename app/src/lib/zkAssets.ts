/**
 * Where ZK artifacts are fetched from.
 *
 * The proving artifacts under `public/zk` are ~732 MB for the dev-beacon set alone, and the
 * per-chain ceremony set added for Base roughly doubles that. Amplify's Gen-1 SSR deployment
 * artifact cap is 200 MB compressed, and zkeys are high-entropy so they barely compress — shipping
 * them through the app bundle cannot work. `amplify.yml` has documented the escape hatch
 * (`NEXT_PUBLIC_ZK_BASE_URL` → S3/CloudFront) since before the ceremony tree existed, but nothing
 * read the variable, so setting it did nothing and the only observable symptom was a build that
 * exceeded the cap or a 404 at proving time.
 *
 * Contract: the base URL points at whatever now serves the CONTENTS of `public/zk`. So the `/zk`
 * prefix is REPLACED, not appended — upload `public/zk/*` to the bucket root and set the variable
 * to the bucket's public origin. Unset (the default) keeps everything same-origin, which is what
 * local dev and any host that can serve the directory should use.
 *
 * Every artifact goes through {@link zkUrl}: the wasm, the zkey, the verification key and
 * CEREMONY.json. Routing only some of them is worse than routing none — the bundle stays over the
 * cap because of the ones left behind, and the failure shows up as a 404 mid-proof.
 */

/** Configured artifact origin with any trailing slash removed, or "" for same-origin. */
export function zkBase(): string {
  // Must be a literal member expression: Next inlines NEXT_PUBLIC_* at build time only where it
  // sees `process.env.NEXT_PUBLIC_X` verbatim (see the ENV note in v3/configV3.ts).
  return (process.env.NEXT_PUBLIC_ZK_BASE_URL || "").trim().replace(/\/+$/, "");
}

/**
 * Resolve a `/zk/...` path to the URL it should actually be fetched from.
 * Paths are passed in their canonical same-origin form so call sites read the same either way.
 */
export function zkUrl(path: string): string {
  const p = path.startsWith("/") ? path : `/${path}`;
  const base = zkBase();
  if (!base) return p;
  // Replace the `/zk` prefix — the bucket holds the CONTENTS of public/zk, not a `zk/` folder.
  // Note the bare "/zk" case: zkProvingBase() returns exactly that for a dev-beacon chain, and a
  // prefix test written only for "/zk/" leaves it appended, so Sepolia would fetch
  // `<base>/zk/withdraw2/...` with a duplicated segment while Base resolved correctly.
  const rest = p === "/zk" ? "" : p.startsWith("/zk/") ? p.slice(3) : p;
  return `${base}${rest}`;
}
