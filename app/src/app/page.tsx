import DappPage from "@/components/dapp/DappPage";

// Same caching rationale as /dapp/layout: avoid CDN serving a stale prerendered shell.
export const dynamic = "force-dynamic";
export const revalidate = 0;

export default function Home() {
  return <DappPage />;
}
