import type { Node } from "@xyflow/react";
import { builderChainProfile, isDexActive } from "@/builder_agent/blocks";
import { readStoredHomeChainId } from "@/lib/chains/homeChains";
import { getSelectedChainId, getRunModeChainLabel } from "./networks";

function preferredDexForRun(): string {
  return builderChainProfile({
    chainId: getSelectedChainId(),
    homeChainId: readStoredHomeChainId(),
  }).preferredDex;
}

/** Prefer the node’s venue when it’s still active; otherwise the chain default. */
function resolveDexForRun(raw: unknown): string {
  const label = raw != null ? String(raw).trim() : "";
  if (label && isDexActive(label)) return label;
  return preferredDexForRun();
}

type NodeData = Record<string, unknown>;

function setIfPresent(target: Record<string, string>, key: string, value: unknown): void {
  if (value == null) return;
  const str = String(value).trim();
  if (str) target[key] = str;
}

/** Seed Pay & Run form fields from builder block data. */
export function buildRunModeValuesFromNodes(nodes: Node[]): Record<string, Record<string, string>> {
  const values: Record<string, Record<string, string>> = {};

  for (const node of nodes) {
    const d = node.data as NodeData;
    const type = String(d.type || "");
    const step: Record<string, string> = {};

    if (type === "deposit") {
      // Follow the dashboard chain toggle, NOT the template's baked-in d.chain — otherwise a
      // template authored on Sepolia forces a Base-selected run to build/arm on Sepolia.
      setIfPresent(step, "chain", getRunModeChainLabel(getSelectedChainId()));
      setIfPresent(step, "tokenA", d.coin);
      setIfPresent(step, "amount", d.amount);
    } else if (type === "swap") {
      setIfPresent(step, "dexType", resolveDexForRun(d.dex));
      setIfPresent(step, "coin", d.coin);
      setIfPresent(step, "coinB", d.toCoin);
      setIfPresent(step, "amount", d.amount);
    } else if (type === "lend") {
      setIfPresent(step, "lendAction", d.lendAction === "exit" ? "exit" : "enter");
      setIfPresent(step, "lendVenue", d.lendVenue === "jito" ? "jito" : "jupiter");
      setIfPresent(step, "coin", d.coin);
      setIfPresent(step, "coinB", d.toCoin);
      setIfPresent(step, "amount", d.amount);
    } else if (type === "strategy") {
      for (const field of [
        "priceGoal",
        "rangeLow",
        "rangeHigh",
        "gridLevels",
        "sliceCount",
        "intervalSeconds",
        "maxSlippageBps",
        "intervals",
        "positionPct",
        "side",
      ]) {
        setIfPresent(step, field, d[field]);
      }
    } else if (type === "withdraw") {
      // Follow the dashboard chain toggle, NOT the template's baked-in d.chain — otherwise a
      // template authored on Sepolia forces a Base-selected run to build/arm on Sepolia.
      setIfPresent(step, "chain", getRunModeChainLabel(getSelectedChainId()));
      setIfPresent(step, "coin", d.coin);
      setIfPresent(step, "amount", d.amount);
      setIfPresent(step, "address", d.wallet);
    } else if (type === "repeatGroup") {
      setIfPresent(step, "repeatMode", d.repeatMode || "until_funds");
      setIfPresent(step, "repeatCount", d.repeatCount);
      setIfPresent(step, "loopIntervalValue", d.loopIntervalValue);
      setIfPresent(step, "loopIntervalUnit", d.loopIntervalUnit || "hours");
    } else if (type === "control") {
      for (const field of ["scheduleValue", "scheduleUnit"]) {
        setIfPresent(step, field, d[field]);
      }
    }

    if (Object.keys(step).length > 0) {
      values[node.id] = step;
    }
  }

  return values;
}

export function getRunStepFieldValue(
  runModeValues: Record<string, Record<string, string>>,
  stepId: string,
  field: string,
  nodeData: NodeData
): string {
  const override = runModeValues[stepId]?.[field];
  if (override != null && String(override).trim() !== "") return override;

  if (field === "tokenA") return String(nodeData.coin || "");
  if (field === "coinB") return String(nodeData.toCoin || "");
  if (field === "address") return String(nodeData.wallet || "");
  if (field === "dexType") return resolveDexForRun(nodeData.dex);
  if (field === "chain") {
    // The dashboard chain toggle is authoritative for run mode. A template's baked-in nodeData.chain
    // (e.g. "Ethereum Sepolia") must NOT override the user's selected chain — that made a
    // Base-selected strategy build + arm on Sepolia. An explicit per-step override (runModeValues)
    // still wins via the `override` check above; otherwise always follow the selected chain.
    return getRunModeChainLabel(getSelectedChainId());
  }

  const raw = nodeData[field];
  return raw != null ? String(raw) : "";
}
