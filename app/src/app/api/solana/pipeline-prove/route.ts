/**
 * Internal TEE/mock prove for pipeline hop N≥1.
 *
 * The executor unseals hop secrets in the decryptor, then posts them here (shared token) so we
 * reuse the Solana witness + snarkjs path. MPC later replaces this with an in-enclave prover;
 * the outer provePipelineHop API stays the same.
 */
import { NextRequest, NextResponse } from "next/server";
import { NATIVE_MINT } from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import {
  assetIdFromSolanaMint,
  hashCommitmentWithPre,
  mintLabelSalted,
} from "@/lib/v3/noteCryptoV3";
import {
  bytesToHex,
  fetchZkVaultState,
  fieldToLe32,
  getZkProgramId,
  leToField,
  proveSolanaPipelineHop,
} from "@/lib/chains/solanaVaultZk";
import { getDevnetConnection } from "@/lib/chains/solanaVaultOnchain";
import {
  earnPackageFromProof,
  jitoPackageFromProof,
  meteoraPackageFromProof,
  type MeteoraPair,
  type MeteoraSide,
} from "@/lib/chains/solanaDevnetStrategy";
import type { SolanaStoredNote } from "@/lib/chains/solanaNoteStore";
import { solanaSymbolForMint } from "@/lib/chains/solanaNoteStore";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 300;

function authorized(req: NextRequest): boolean {
  const expected = (process.env.PIPELINE_PROVE_TOKEN || process.env.SOLANA_PIPELINE_PROVE_TOKEN || "").trim();
  if (!expected) {
    return process.env.NEXT_PUBLIC_ALLOW_MOCK_TEE === "true";
  }
  const got = (req.headers.get("x-pipeline-prove-token") || "").trim();
  return got === expected;
}

type HopSecrets = { nullifier: string; secret: string; userSalt: string; precommitment: string };

type Body = {
  input_hop: HopSecrets;
  return_hop: HopSecrets;
  returned_note: {
    commitment: string;
    amount: string;
    mint: string;
    leaf_index: string | number;
    deposit_nonce: string;
    deposit_sig?: string | null;
  };
  settlement: string;
  venue: Record<string, unknown>;
};

export async function POST(req: NextRequest) {
  if (!authorized(req)) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  let body: Body;
  try {
    body = (await req.json()) as Body;
  } catch {
    return NextResponse.json({ ok: false, error: "invalid JSON" }, { status: 400 });
  }
  try {
    const mint = new PublicKey(body.returned_note.mint);
    const connection = getDevnetConnection();
    const vault = await fetchZkVaultState(connection, getZkProgramId());
    const label = await mintLabelSalted(
      leToField(vault.vaultScopeId),
      BigInt(body.returned_note.deposit_nonce),
      BigInt(body.input_hop.userSalt),
    );
    const assetId = assetIdFromSolanaMint(mint.toBytes());
    const commitment = await hashCommitmentWithPre(
      BigInt(body.returned_note.amount),
      label,
      assetId,
      BigInt(body.input_hop.precommitment),
    );
    if (commitment.toString() !== String(body.returned_note.commitment)) {
      return NextResponse.json(
        { ok: false, error: "returned note does not match sealed hop secrets" },
        { status: 400 },
      );
    }
    const note: SolanaStoredNote = {
      nullifier: body.input_hop.nullifier,
      secret: body.input_hop.secret,
      label: label.toString(),
      assetId: assetId.toString(),
      mint: mint.toBase58(),
      symbol: solanaSymbolForMint(mint.toBase58()),
      commitment: commitment.toString(),
      commitmentHex: bytesToHex(fieldToLe32(commitment)),
      value: String(body.returned_note.amount),
      precommitment: body.input_hop.precommitment,
      userSalt: body.input_hop.userSalt,
      depositSig: body.returned_note.deposit_sig || "pipeline-return",
      leafIndex: Number(body.returned_note.leaf_index),
      spent: false,
    };

    const proof = await proveSolanaPipelineHop({
      note,
      amountBaseUnits: BigInt(body.returned_note.amount),
      recipient: body.settlement,
    });

    const pairHint = String(body.venue.meteora_pair || "") as MeteoraPair | "";
    const venuePool = String(body.venue.meteora_pool || "").trim();
    const settle = {
      pubkey: body.settlement,
      meteoraPool: String(
        (pairHint === "usdc_sol" && venuePool) || process.env.NEXT_PUBLIC_METEORA_POOL || venuePool || "",
      ),
      meteoraJlUsdcSolPool: String(
        (pairHint === "jlusdc_sol" && venuePool) ||
          process.env.NEXT_PUBLIC_METEORA_JLUSDC_SOL_POOL ||
          "",
      ),
      meteoraJitoSolPool: String(
        (pairHint === "jitosol_sol" && venuePool) ||
          process.env.NEXT_PUBLIC_METEORA_JITOSOL_SOL_POOL ||
          "",
      ),
      usdcMint: String(body.venue.solana_usdc_mint || process.env.NEXT_PUBLIC_SOLANA_USDC_MINT || ""),
      jlUsdcMint: String(body.venue.jl_token_mint || process.env.NEXT_PUBLIC_JUPITER_JL_USDC_MINT || ""),
      jitoSolMint: String(body.venue.jito_sol_mint || process.env.NEXT_PUBLIC_JITO_SOL_MINT || ""),
      jitoStakePool: String(body.venue.stake_pool || process.env.NEXT_PUBLIC_JITO_STAKE_POOL || ""),
      lendingProgram: String(body.venue.lending_program || ""),
    };

    const venue = String(body.venue.venue || "meteora-dlmm");
    let pkg: Record<string, unknown>;
    if (venue === "jupiter-earn") {
      pkg = earnPackageFromProof(proof, settle, (body.venue.action as "enter" | "exit") || "enter");
    } else if (venue === "jito-stake") {
      pkg = jitoPackageFromProof(proof, settle, (body.venue.action as "enter" | "exit") || "enter");
    } else {
      const side =
        (body.venue.solana_side as MeteoraSide) ||
        (mint.equals(NATIVE_MINT) ? "sell_wsol" : "sell_jlusdc");
      const pair = (body.venue.meteora_pair as MeteoraPair) || "jlusdc_sol";
      pkg = meteoraPackageFromProof(proof, settle, side, pair);
    }
    pkg = {
      ...pkg,
      return_precommitment: body.return_hop.precommitment,
      return_user_salt: body.return_hop.userSalt,
    };
    return NextResponse.json({ ok: true, package: pkg });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const needsReproof = /stale|leaves|root|ASP|admitted|resync|not in the live/i.test(msg);
    return NextResponse.json(
      { ok: false, error: msg, code: needsReproof ? "NEEDS_REPROOF" : "FAILED" },
      { status: 500 },
    );
  }
}
