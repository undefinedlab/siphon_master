import { ethers } from 'ethers';
import { generateZKData } from './zkHandler'; // Removed encodeProof as it's not needed
import entrypointArtifact from "./abi/Entrypoint.json";
import { getNetwork, getSelectedChainId, getTokens, NATIVE_TOKEN } from './networks';
import { getEvmProvider } from '@/components/extensions/walletManager';

const FEE = 3000;
const MIN_AMOUNT_OUT = 0n;
const SWAP_DEADLINE_SECS = 1800; // 30 min

const ENTRYPOINT_ABI = entrypointArtifact.abi as ethers.InterfaceAbi;

export async function instantSwap(
    _pool: string, // New parameter
    _srcToken: string,
    _dstToken: string,
    _amount: string,
    _recipient: string,
    provider: ethers.Provider,
    signer: ethers.Signer
) {
    try {
        const srcTokenUpper = _srcToken.toUpperCase();
        const dstTokenUpper = _dstToken.toUpperCase();

        if (!['ETH', 'USDC'].includes(srcTokenUpper) || !['ETH', 'USDC'].includes(dstTokenUpper)) {
            return { success: false, error: "Only ETH and USDC are supported for now" };
        }
        if (srcTokenUpper === dstTokenUpper) {
            return { success: false, error: "source and destination tokens must be different" };
        }

        const net = getNetwork();
        const TOKENS = getTokens();
        const srcToken = TOKENS[srcTokenUpper];
        const dstToken = TOKENS[dstTokenUpper];
        const srcAmount = ethers.parseUnits(_amount, srcToken.decimals);

        // The dstToken the contract actually routes to (and binds in the proof) is WETH when the
        // user asked for native out. Both the Entrypoint arg and the proof signal must use this.
        const dstTokenForSwap = dstToken.address === NATIVE_TOKEN ? net.weth : dstToken.address;
        const minAmountOut = MIN_AMOUNT_OUT;
        const deadline = BigInt(Math.floor(Date.now() / 1000) + SWAP_DEADLINE_SECS);

        console.log(`Swap - Chain: ${net.chainId} (${net.name}), ${srcAmount.toString()} ${srcToken.symbol} → ${dstToken.symbol}`);

        // Generate ZK data with swap-binding signals (pool/dstToken/fee/minAmountOut) so the
        // 9-signal proof matches Entrypoint.swap (else Vault.swap reverts InvalidSwapParams).
        const zkData = await generateZKData(
            net.chainId,
            { symbol: srcToken.symbol, decimals: srcToken.decimals, address: srcToken.address },
            _amount,
            _recipient,
            { pool: _pool, dstToken: dstTokenForSwap, fee: FEE, minAmountOut }
        );

        if ('error' in zkData) {
            return { success: false, error: zkData.error };
        }

        const withdrawalTxData = zkData.withdrawalTxData;

        const zkProofStruct = {
            stateRoot:     withdrawalTxData.stateRoot,
            nullifier:     withdrawalTxData.nullifierHash,
            newCommitment: withdrawalTxData.newCommitment,
            recipient:     _recipient,
            pool:          _pool,
            dstToken:      dstTokenForSwap,
            fee:           FEE,
            minAmountOut:  minAmountOut,
            pA: withdrawalTxData.pA,
            pB: withdrawalTxData.pB,
            pC: withdrawalTxData.pC,
        };

        const contract = new ethers.Contract(net.entrypoint, ENTRYPOINT_ABI, signer);
        // New Entrypoint.swap signature: (...,_fee, _deadline, _zkProof)
        const txParams = [
            _pool,
            srcToken.address,
            dstTokenForSwap,
            _recipient,
            srcAmount,
            minAmountOut,
            FEE,
            deadline,
            zkProofStruct,
        ];

        // swap transaction
        const tx = await contract.swap(...txParams, {
            ...(srcTokenUpper === 'ETH' ? { value: srcAmount } : {})
        });
        console.log("Transaction submitted:", tx.hash);

        // Wait for transaction confirmation
        const receipt = await tx.wait();

        if (receipt && receipt.status === 1) {
            // Store new commitment if remaining balance > 0
            if (zkData.changeValue > 0n && zkData.newDeposit) {
                try {
                    const { writeNote } = await import('./localNoteStore');
                    await writeNote(zkData.newDepositKey, {
                        nullifier:     zkData.newDeposit.nullifier,
                        secret:        zkData.newDeposit.secret,
                        commitment:    zkData.newDeposit.commitment!,
                        precommitment: zkData.newDeposit.precommitment,
                        nullifierHash: zkData.newDeposit.nullifierHash ?? '',
                        amount:        zkData.newDeposit.amount,
                        spent:         false,
                    }, signer);
                } catch (e) { console.warn('[swap] change note write failed:', e); }
            }
            if (zkData.spentDepositKey) {
                const { markNoteSpentByKey } = await import('./localNoteStore');
                markNoteSpentByKey(zkData.spentDepositKey);
            }
            return {
                success: true,
                data: receipt.hash,
                transactionHash: receipt.hash,
                blockNumber: receipt.blockNumber
            };
        }
        return { success: false, error: "Transaction failed" };
    } catch (error: unknown) {
        console.error("Error during swap:", error);
        const errorMessage = error instanceof Error ? error.message : "Unknown error occurred";
        return { success: false, error: errorMessage };
    }
}

// Helper to get provider and signer
export async function getEthersProviderAndSigner() {
    const injected = getEvmProvider();
    if (!injected) {
        throw new Error("No wallet connected");
    }
    const provider = new ethers.BrowserProvider(injected);
    const signer = await provider.getSigner();

    // Ensure the wallet is on the selected network (Eth Sepolia / Base Sepolia)
    const selected = getSelectedChainId();
    const network = await provider.getNetwork();
    if (network.chainId !== BigInt(selected)) {
        throw new Error(`Please switch your wallet to ${getNetwork(selected).name} (chainId ${selected}). Current: ${network.chainId}`);
    }

    return { provider, signer };
}

export async function executeSwap(
    _pool: string, // New parameter
    srcToken: string,
    dstToken: string,
    amount: string,
    recipient: string
) {
    try {
        const { provider, signer } = await getEthersProviderAndSigner();
        // Pass _pool to instantSwap
        const result = await instantSwap(_pool, srcToken, dstToken, amount, recipient, provider, signer);
        return result;
    } catch (error) {
        console.error("Error executing swap:", error);
        return { success: false, error: error instanceof Error ? error.message : "Unknown error" };
    }
}