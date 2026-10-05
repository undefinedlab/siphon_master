import { getSelectedChainId } from "./networks";
import {
  defaultSideForKind,
  normalizeStrategyKind,
  triggerComparator,
  type StrategySide,
} from "./strategySpec";

export interface ConditionNode {
  op: "LEAF" | "AND" | "OR" | "NOT";
  asset?: string;
  condition?: "GTE" | "LTE";
  bound?: number | string; // raw string while typing (preserves "0.", "0.0001"); consumers coerce via Number()
  price_feed_id?: string;
  conditions?: ConditionNode[];
}

export const PYTH_PRICE_FEED_IDS: Record<string, string> = {
  SOL: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
  ETH: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
  BTC: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  USDC: "0xeaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
};

export function createDefaultPriceConditionTree(): ConditionNode {
  // Solana Devnet trades SOL; a new condition starts on the asset that chain can actually swap.
  const sol = getSelectedChainId() === 900_002;
  return {
    op: "LEAF",
    asset: sol ? "SOL" : "ETH",
    condition: "LTE",
    bound: sol ? 150 : 1500,
    price_feed_id: sol ? PYTH_PRICE_FEED_IDS.SOL : PYTH_PRICE_FEED_IDS.ETH,
  };
}

export function createDefaultLimitOrderTree(): ConditionNode {
  return { op: "AND", conditions: [createDefaultPriceConditionTree()] };
}

export function parseConditionTree(raw: unknown): ConditionNode {
  if (typeof raw === "string") {
    try {
      return parseConditionTree(JSON.parse(raw));
    } catch {
      return createDefaultPriceConditionTree();
    }
  }
  if (raw && typeof raw === "object" && "op" in raw) {
    return raw as ConditionNode;
  }
  return createDefaultPriceConditionTree();
}

function extractPriceLeaves(node: ConditionNode): ConditionNode[] {
  return (node.conditions ?? []).filter((c) => c.op === "LEAF");
}

export function validatePriceConditionTree(
  tree: ConditionNode
): { valid: boolean; error?: string } {
  if (tree.op === "LEAF") {
    const bound = Number(tree.bound);
    if (!tree.asset) {
      return { valid: false, error: "Limit Order needs an asset for each price condition." };
    }
    if (!Number.isFinite(bound) || bound <= 0) {
      return { valid: false, error: "Limit Order needs a valid price on each condition." };
    }
    return { valid: true };
  }

  if (tree.op === "AND" || tree.op === "OR") {
    const children = tree.conditions ?? [];
    if (children.length === 0) {
      return {
        valid: false,
        error: `Limit Order ${tree.op} group needs at least one price condition.`,
      };
    }
    for (const child of children) {
      if (tree.op === "OR" && child.op === "AND") {
        const leaves = extractPriceLeaves(child);
        if (!leaves.length) {
          return { valid: false, error: "Limit Order AND group needs at least one price condition." };
        }
        for (const leaf of leaves) {
          const leafResult = validatePriceConditionTree(leaf);
          if (!leafResult.valid) return leafResult;
        }
        continue;
      }
      if (child.op !== "LEAF") {
        return { valid: false, error: "Limit Order has an unsupported condition type." };
      }
      const childResult = validatePriceConditionTree(child);
      if (!childResult.valid) return childResult;
    }
    return { valid: true };
  }

  return { valid: false, error: "Limit Order has an unsupported condition type." };
}

export function validatePriceConditionTreeRaw(
  raw: string | null | undefined
): { valid: boolean; error?: string } {
  if (!raw?.trim()) {
    return { valid: false, error: "Limit Order needs at least one price condition." };
  }
  return validatePriceConditionTree(parseConditionTree(raw));
}

export function buildLimitOrderConditionTreeJson(opts: {
  priceGoal: string | number;
  side?: StrategySide | string | null;
  asset?: string;
}): string {
  const bound = parseFloat(String(opts.priceGoal));
  const side: StrategySide =
    opts.side === "sell" ? "sell" : opts.side === "buy" ? "buy" : defaultSideForKind("Limit Order");
  const asset = (opts.asset || "ETH").toUpperCase();
  const cmp = triggerComparator("Limit Order", side);
  const tree: ConditionNode = {
    op: "AND",
    conditions: [
      {
        op: "LEAF",
        asset,
        condition: cmp === "lte" ? "LTE" : "GTE",
        bound,
        price_feed_id: PYTH_PRICE_FEED_IDS[asset] ?? PYTH_PRICE_FEED_IDS.ETH,
      },
    ],
  };
  return JSON.stringify(tree);
}

/** Use conditionTree when valid; otherwise derive from priceGoal (AI builder path). */
export function resolveLimitOrderConditionTree(
  conditionTree: string | null | undefined,
  priceGoal: string | null | undefined,
  side: string | null | undefined,
  asset = "ETH"
): string | null {
  if (conditionTree?.trim()) {
    const check = validatePriceConditionTreeRaw(conditionTree);
    if (check.valid) return conditionTree;
  }

  const price = parseFloat(String(priceGoal ?? ""));
  if (Number.isFinite(price) && price > 0) {
    return buildLimitOrderConditionTreeJson({ priceGoal: price, side, asset });
  }

  return conditionTree?.trim() ? conditionTree : null;
}

export function applyLimitOrderTreeFields(
  data: Record<string, unknown>
): Record<string, unknown> {
  if (normalizeStrategyKind(String(data.strategy ?? "")) !== "Limit Order") {
    return data;
  }

  const side = (data.side as string | null) ?? defaultSideForKind("Limit Order");
  const priceGoal = data.priceGoal as string | null | undefined;
  const resolved = resolveLimitOrderConditionTree(
    data.conditionTree as string | undefined,
    priceGoal,
    side
  );

  return {
    ...data,
    useTree: "true",
    side,
    conditionTree: resolved ?? data.conditionTree ?? JSON.stringify(createDefaultLimitOrderTree()),
  };
}
