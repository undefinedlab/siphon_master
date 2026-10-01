//! Siphon Solana ZK vault (plan 1B+2A) — Poseidon depth-32 tree + Groth16 alt_bn128.
//!
//! Default features have **no** scaffold-verify path. Spend fails closed when the VK
//! is missing or pairing verification fails.

use anchor_lang::prelude::*;
use anchor_lang::system_program::{self, CreateAccount};
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

pub mod poseidon;
pub mod verify;

use poseidon::{
    be_field_from_bytes, deposit_commitment, deposit_label, hash2_le, le_to_be,
    spend_payee_id_compat, vault_scope_id,
};
use verify::{verify_proof, NR_PUBLIC_INPUTS, VK_ACCOUNT_BYTES};

declare_id!("BktHHQ8KJpfnwLNMEqnh9uANEyuFa1qYtbhzHwCKMEDe");

/// Native wrapped SOL mint (solana-v1 assetId for “SOL” notes).
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");
/// Jupiter Earn jlUSDC on Devnet — PDA `[b"f_token_mint", Circle USDC 4zMMC9…]`
/// under Lending `7tjE28izRUjzmxC1QNXnNwcc4N82CNYCexf3k8mw67s3`.
pub const JL_USDC_MINT: Pubkey = pubkey!("2Wx1tTo8PkTP95NyKoFNPTtcLnYaSowDkExwbHDKAZQu");
/// JitoSOL on Devnet — pool mint of stake pool `JitoY5pcAxWX6iyP2QdFwTznGb8A99PRCUCVVxB46WZ`.
pub const JITO_SOL_MINT: Pubkey = pubkey!("J1tos8mqbhdGcF3pgj4PCKyVjzWSURcpLZU7pPGHxSYi");

pub const VAULT_SEED: &[u8] = b"siphon-vault-v1";
pub const COMPLIANCE_SEED: &[u8] = b"siphon-compliance-v1";
pub const PENDING_SEED: &[u8] = b"siphon-pending-inputs-v1";
pub const TREE_SEED: &[u8] = b"siphon-tree-v1";
pub const NULLIFIER_SEED: &[u8] = b"siphon-nf-v1";
pub const LEAF_SEED: &[u8] = b"siphon-leaf-v1";
pub const VK_SEED: &[u8] = b"siphon-vk-v1";
pub const POSTMAN_SEED: &[u8] = b"siphon-postman-v1";

pub const NOTE_TREE_DEPTH: usize = 32;
/// State roots a proof may still cite. An armed order carries a proof built at arming, so every
/// later insert (deposits, change notes, returned swap outputs) ages it by one. 250 keeps the tree
/// account under the 10 KiB a CPI `init` may allocate, and `recent_len`/`recent_head` in a u8.
pub const RECENT_ROOTS_CAP: usize = 250;
/// Published admitted roots a proof may still cite. Admission only ever adds labels, so an older
/// admitted root is a subset of the current one and still sound; revocation is enforced by
/// requiring the CURRENT revoked root (ComplianceHub on EVM does the same). Without this every
/// admission — anyone's deposit — invalidated every armed order's proof.
pub const ADMITTED_RING_CAP: usize = 128;
pub const VK_SLOT_COUNT: usize = 14;
pub const MAX_INPUTS: usize = 6;
pub const NULLIFIER_START: usize = 9;
pub const PROGRAM_VERSION_LIMB: usize = 16;
pub const ACTION_WITHDRAW: u8 = 0;
pub const ACTION_MERGE: u8 = 1;
pub const ACTION_SPLIT: u8 = 3;
/// Split always proves 8 output slots (inactive ones are zero) — MerkleRoot8 in limb 17.
pub const SPLIT_OUTPUTS: usize = 8;
/// VK slot of the split circuit (withdraw1–6 = 0–5, merge2–6 = 6–10, swap = 11, split = 12).
pub const SPLIT_CIRCUIT_INDEX: u8 = 12;

#[program]
pub mod siphon_vault_zk {
    use super::*;

    pub fn initialize_vault(
        ctx: Context<InitializeVault>,
        program_version: [u8; 32],
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        vault.bump = ctx.bumps.vault;
        vault.authority = ctx.accounts.authority.key();
        vault.program_version = program_version;
        vault.deposit_nonce = 0;
        vault.deposits_paused = false;
        vault.allowed_mint = ctx.accounts.allowed_mint.key();
        vault.vk_accounts = [Pubkey::default(); VK_SLOT_COUNT];

        let program_id_bytes = crate::ID.to_bytes();
        let vault_key_bytes = vault.key().to_bytes();
        let scope = vault_scope_id(&program_id_bytes, &vault_key_bytes)
            .map_err(|_| VaultError::PoseidonFailed)?;
        vault.vault_scope_id = scope;

        // Empty depth-32 Poseidon tree: zeros + root + recent ring.
        let mut zero_le = [0u8; 32];
        let mut zeros = [[0u8; 32]; NOTE_TREE_DEPTH];
        for level in 0..NOTE_TREE_DEPTH {
            zeros[level] = zero_le;
            zero_le = hash2_le(&zero_le, &zero_le).map_err(|_| VaultError::PoseidonFailed)?;
        }
        let empty_root = zero_le;

        {
            let tree = &mut ctx.accounts.tree.load_init()?;
            tree.bump = ctx.bumps.tree;
            tree.next_index = 0;
            tree.root = empty_root;
            for i in 0..NOTE_TREE_DEPTH {
                tree.zero_hashes[i] = zeros[i];
                tree.filled_subtrees[i] = zeros[i];
            }
            tree.recent_roots = [[0u8; 32]; RECENT_ROOTS_CAP];
            tree.recent_roots[0] = empty_root;
            tree.recent_len = 1;
            tree.recent_head = 1;
        }

        vault.state_root = empty_root;
        Ok(())
    }

    pub fn set_compliance(
        ctx: Context<SetCompliance>,
        admitted_root: [u8; 32],
        revoked_root: [u8; 32],
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.vault.authority,
            VaultError::Unauthorized
        );
        let mut c = ctx.accounts.compliance.load_init()?;
        c.bump = ctx.bumps.compliance;
        c.set_roots(admitted_root, revoked_root);
        Ok(())
    }

    /// Authority names the ASP postman allowed to publish compliance roots. The vault
    /// authority is also the upgrade authority, so it must not sit on the ASP host; the
    /// postman key can, and rotating it is one call here.
    pub fn set_postman(ctx: Context<SetPostman>, postman: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.vault.authority,
            VaultError::Unauthorized
        );
        let p = &mut ctx.accounts.postman_config;
        p.bump = ctx.bumps.postman_config;
        p.postman = postman;
        Ok(())
    }

    /// Postman-signed compliance root publish (the ASP's on-chain write).
    pub fn publish_roots(
        ctx: Context<PublishRoots>,
        admitted_root: [u8; 32],
        revoked_root: [u8; 32],
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.postman.key(),
            ctx.accounts.postman_config.postman,
            VaultError::Unauthorized
        );
        ctx.accounts.compliance.load_mut()?.set_roots(admitted_root, revoked_root);
        emit!(RootsPublished {
            admitted_root,
            revoked_root,
        });
        Ok(())
    }

    /// Authority registers an off-chain-created packed VK account pubkey into a circuit slot.
    pub fn register_vk(ctx: Context<RegisterVk>, circuit_index: u8) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.vault.authority,
            VaultError::Unauthorized
        );
        require!(
            (circuit_index as usize) < VK_SLOT_COUNT,
            VaultError::InvalidCircuitIndex
        );

        let vk_info = &ctx.accounts.vk_account;
        require!(vk_info.owner == &crate::ID, VaultError::BadVkAccount);
        let data = vk_info.try_borrow_data()?;
        require!(data.len() >= VK_ACCOUNT_BYTES, VaultError::BadVkAccount);
        let nr = u64::from_le_bytes(data[0..8].try_into().unwrap());
        require!(nr as usize == NR_PUBLIC_INPUTS, VaultError::BadVkAccount);
        drop(data);

        ctx.accounts.vault.vk_accounts[circuit_index as usize] = vk_info.key();
        Ok(())
    }

    /// Create a program-owned VK PDA (2120 bytes) and bind it to a circuit slot (Devnet bootstrap).
    pub fn init_vk_pda(ctx: Context<InitVkPda>, circuit_index: u8) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.vault.authority,
            VaultError::Unauthorized
        );
        require!(
            (circuit_index as usize) < VK_SLOT_COUNT,
            VaultError::InvalidCircuitIndex
        );
        ctx.accounts.vault.vk_accounts[circuit_index as usize] = ctx.accounts.vk.key();
        Ok(())
    }

    /// Upload packed VK bytes in chunks (tx size limit); authority-only.
    pub fn write_vk_chunk(
        ctx: Context<WriteVkChunk>,
        offset: u16,
        chunk: Vec<u8>,
    ) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.vault.authority,
            VaultError::Unauthorized
        );
        let end = offset as usize + chunk.len();
        require!(ctx.accounts.vk.owner == &crate::ID, VaultError::BadVkAccount);
        require!(
            ctx.accounts.vault
                .vk_accounts
                .iter()
                .any(|k| *k == ctx.accounts.vk.key()),
            VaultError::VkMismatch
        );
        require!(end <= VK_ACCOUNT_BYTES, VaultError::BadVkAccount);
        let mut data = ctx.accounts.vk.try_borrow_mut_data()?;
        require!(data.len() >= VK_ACCOUNT_BYTES, VaultError::BadVkAccount);
        data[offset as usize..end].copy_from_slice(&chunk);
        Ok(())
    }

    /// SPL pull + Poseidon commitment insert. Emits commitment + leaf_index only (no amount PDA).
    pub fn deposit(
        ctx: Context<Deposit>,
        amount: u64,
        user_salt: [u8; 32],
        precommitment: [u8; 32],
        note_commitment: [u8; 32],
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.deposits_paused, VaultError::DepositsPaused);
        require!(amount > 0, VaultError::ZeroAmount);
        require!(user_salt != [0u8; 32], VaultError::InvalidSalt);
        require!(
            mint_allowed(ctx.accounts.mint.key(), vault.allowed_mint),
            VaultError::MintNotAllowed
        );

        let nonce = vault.deposit_nonce;
        let label = deposit_label(&vault.vault_scope_id, nonce, &user_salt)
            .map_err(|_| VaultError::PoseidonFailed)?;
        let mint_bytes = ctx.accounts.mint.key().to_bytes();
        let commitment = deposit_commitment(amount, &label, &mint_bytes, &precommitment)
            .map_err(|_| VaultError::PoseidonFailed)?;
        require!(commitment == note_commitment, VaultError::InvalidCommitment);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.depositor_token.to_account_info(),
                    to: ctx.accounts.vault_token.to_account_info(),
                    authority: ctx.accounts.depositor.to_account_info(),
                },
            ),
            amount,
        )?;

        let leaf_index = tree_insert(&ctx.accounts.tree, commitment)?;
        vault.state_root = ctx.accounts.tree.load()?.root;
        vault.deposit_nonce = nonce
            .checked_add(1)
            .ok_or(VaultError::NonceOverflow)?;

        let leaf = &mut ctx.accounts.leaf_index;
        leaf.bump = ctx.bumps.leaf_index;
        leaf.leaf_index = leaf_index;

        emit!(DepositEvent {
            depositor: ctx.accounts.depositor.key(),
            mint: ctx.accounts.mint.key(),
            commitment,
            leaf_index,
            deposit_nonce: nonce,
        });
        Ok(())
    }

    pub fn commit_public_inputs(
        ctx: Context<CommitPublicInputs>,
        binder: [u8; 32],
        publics: [[u8; 32]; 25],
    ) -> Result<()> {
        let pending = &mut ctx.accounts.pending.load_init()?;
        pending.bump = ctx.bumps.pending;
        pending.consumed = 0;
        pending.owner = ctx.accounts.payer.key();
        pending.binder = binder;
        pending.publics = publics;
        Ok(())
    }

    /// Verify Groth16 proof against pending publics, burn nullifiers, settle Withdraw.
    pub fn spend(
        ctx: Context<Spend>,
        _binder: [u8; 32],
        proof: [u8; 256],
        raw_payee: [u8; 32],
        circuit_index: u8,
    ) -> Result<()> {
        let (binder_key, publics, action, input_count) = admit_spend(
            &ctx.accounts.pending,
            &ctx.accounts.spender,
            &ctx.accounts.vault,
            &ctx.accounts.vk_account,
            &ctx.accounts.tree,
            &ctx.accounts.compliance,
            &proof,
            circuit_index,
        )?;
        let publics = &*publics;
        {
            let a = &ctx.accounts;
            burn_nullifiers(
                publics,
                input_count,
                &[&a.nullifier0, &a.nullifier1, &a.nullifier2, &a.nullifier3, &a.nullifier4, &a.nullifier5],
                &a.spender,
                &a.system_program,
            )?;
        }

        // Withdraw: push SPL amount (limb 5) to payee ATA.
        if action == ACTION_WITHDRAW {
            let expected_payee =
                spend_payee_id_compat(&raw_payee).map_err(|_| VaultError::PoseidonFailed)?;
            require!(publics[15] == expected_payee, VaultError::PayeeMismatch);
            let amount = limb_u64(&publics[5])?;
            require!(amount > 0, VaultError::ZeroAmount);

            let vault_bump = ctx.accounts.vault.bump;
            let payout_mint = payout_mint(&publics[17], ctx.accounts.vault.allowed_mint)?;
            require_keys_eq!(
                ctx.accounts.payee_token.owner,
                Pubkey::new_from_array(raw_payee),
                VaultError::PayeeMismatch
            );
            require_keys_eq!(
                ctx.accounts.payee_token.mint,
                payout_mint,
                VaultError::MintNotAllowed
            );
            require_keys_eq!(
                ctx.accounts.vault_token.mint,
                payout_mint,
                VaultError::MintNotAllowed
            );

            let seeds: &[&[u8]] = &[VAULT_SEED, &[vault_bump]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault_token.to_account_info(),
                        to: ctx.accounts.payee_token.to_account_info(),
                        authority: ctx.accounts.vault.to_account_info(),
                    },
                    &[seeds],
                ),
                amount,
            )?;

            // Optional change note (limb 7).
            if publics[7] != [0u8; 32] {
                let leaf_index = tree_insert(&ctx.accounts.tree, publics[7])?;
                ctx.accounts.vault.state_root = ctx.accounts.tree.load()?.root;
                emit!(LeafInserted {
                    commitment: publics[7],
                    leaf_index,
                });
            }
        } else if action == ACTION_MERGE {
            require!(publics[7] != [0u8; 32], VaultError::InvalidCommitment);
            let leaf_index = tree_insert(&ctx.accounts.tree, publics[7])?;
            ctx.accounts.vault.state_root = ctx.accounts.tree.load()?.root;
            emit!(LeafInserted {
                commitment: publics[7],
                leaf_index,
            });
        } else {
            // Swap, split, and ragequit are not settled here. Returning success would
            // burn the nullifiers and destroy the note with no payout.
            return err!(VaultError::InvalidAction);
        }

        emit!(SpendEvent {
            spender: ctx.accounts.spender.key(),
            binder: binder_key,
            action,
            circuit_index,
        });
        Ok(())
    }

    /// Re-point the vault at another SPL mint (devnet: a mint we can supply liquidity for).
    /// Only while the vault holds none of the current one, so no outstanding note loses its
    /// backing. WSOL stays allowed regardless.
    pub fn set_allowed_mint(ctx: Context<SetAllowedMint>) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.vault.authority,
            VaultError::Unauthorized
        );
        let current = &ctx.accounts.current_vault_token;
        require_keys_eq!(
            current.key(),
            anchor_spl::associated_token::get_associated_token_address(
                &ctx.accounts.vault.key(),
                &ctx.accounts.vault.allowed_mint,
            ),
            VaultError::MintNotAllowed
        );
        // Never created = never held any.
        if !current.data_is_empty() {
            let data = current.try_borrow_data()?;
            let held = TokenAccount::try_deserialize(&mut &data[..])?.amount;
            require!(held == 0, VaultError::VaultNotEmpty);
        }
        ctx.accounts.vault.allowed_mint = ctx.accounts.new_mint.key();
        Ok(())
    }

    /// SPLIT one note into up to 8 slices under the same label (a multi-leg order's per-leg
    /// notes). The circuit binds the outputs only through their MerkleRoot8 (limb 17), so the
    /// commitments passed here are re-hashed to that root before any is inserted. Its own
    /// instruction: `spend`'s token accounts plus 8 commitments do not fit one transaction.
    pub fn spend_split(
        ctx: Context<SpendSplit>,
        _binder: [u8; 32],
        proof: [u8; 256],
        split_commitments: [[u8; 32]; SPLIT_OUTPUTS],
        circuit_index: u8,
    ) -> Result<()> {
        require!(circuit_index == SPLIT_CIRCUIT_INDEX, VaultError::InvalidCircuitIndex);
        let (binder_key, publics, action, input_count) = admit_spend(
            &ctx.accounts.pending,
            &ctx.accounts.spender,
            &ctx.accounts.vault,
            &ctx.accounts.vk_account,
            &ctx.accounts.tree,
            &ctx.accounts.compliance,
            &proof,
            circuit_index,
        )?;
        let publics = &*publics;
        require!(action == ACTION_SPLIT, VaultError::InvalidAction);
        require!(input_count == 1, VaultError::InvalidInputCount);
        require!(
            split_root8(&split_commitments)? == publics[17],
            VaultError::InvalidCommitment
        );
        burn_nullifiers(
            publics,
            1,
            &[&ctx.accounts.nullifier0],
            &ctx.accounts.spender,
            &ctx.accounts.system_program,
        )?;
        for c in split_commitments.iter().filter(|c| **c != [0u8; 32]) {
            let leaf_index = tree_insert(&ctx.accounts.tree, *c)?;
            emit!(LeafInserted { commitment: *c, leaf_index });
        }
        ctx.accounts.vault.state_root = ctx.accounts.tree.load()?.root;
        emit!(SpendEvent {
            spender: ctx.accounts.spender.key(),
            binder: binder_key,
            action,
            circuit_index,
        });
        Ok(())
    }
}

// ─── Spend helpers (shared by spend and spend_split) ─────────────────────────

/// Everything that admits a spend: the spender's unconsumed pending publics (consumed here — a
/// later failure reverts the tx), program version, the registered VK verifying the proof, a
/// known state root, accepted compliance roots, and zero padding in the unused nullifier slots.
#[allow(clippy::too_many_arguments)]
fn admit_spend<'info>(
    pending: &AccountLoader<'info, PendingInputsAccount>,
    spender: &Signer<'info>,
    vault: &VaultAccount,
    vk_account: &UncheckedAccount<'info>,
    tree: &AccountLoader<'info, TreeAccount>,
    compliance: &AccountLoader<'info, ComplianceAccount>,
    proof: &[u8; 256],
    circuit_index: u8,
) -> Result<([u8; 32], Box<[[u8; 32]; NR_PUBLIC_INPUTS]>, u8, u8)> {
    require!(
        (circuit_index as usize) < VK_SLOT_COUNT,
        VaultError::InvalidCircuitIndex
    );
    // Copy the publics out: holding the zero-copy Ref across the handler made the closing
    // load_mut() fail with AccountBorrowFailed on every spend.
    let (binder_key, publics) = {
        let mut p = pending.load_mut()?;
        require!(p.consumed == 0, VaultError::PendingConsumed);
        require_keys_eq!(p.owner, spender.key(), VaultError::Unauthorized);
        p.consumed = 1;
        (p.binder, Box::new(p.publics))
    };

    require!(
        publics[PROGRAM_VERSION_LIMB] == vault.program_version,
        VaultError::ProgramVersionMismatch
    );

    // VK must be registered; fail closed.
    let vk_key = vault.vk_accounts[circuit_index as usize];
    require!(vk_key != Pubkey::default(), VaultError::VerifyNotConfigured);
    require_keys_eq!(vk_account.key(), vk_key, VaultError::VkMismatch);
    {
        let vk_data = vk_account.try_borrow_data()?;
        verify_proof(vk_data.as_ref(), proof, &publics).map_err(|e| match e {
            verify::VerifyError::BadVkLayout => error!(VaultError::BadVkAccount),
            verify::VerifyError::VerifierInitFailed
            | verify::VerifyError::PrepareFailed
            | verify::VerifyError::PairingFailed
            | verify::VerifyError::VerifyFailed => error!(VaultError::VerifyFailed),
        })?;
    }

    // State root in recent_roots (limb 2).
    require!(
        recent_roots_contains(&*tree.load()?, &publics[2]),
        VaultError::UnknownStateRoot
    );
    // Compliance roots (limbs 3 / 4): any recently published admitted root, the CURRENT
    // revoked root.
    require!(
        {
            let c = compliance.load()?;
            c.admits(&publics[3]) && publics[4] == c.revoked_root
        },
        VaultError::ComplianceRootMismatch
    );

    let action = small_u8(&publics[0]).ok_or(VaultError::InvalidAction)?;
    let input_count = small_u8(&publics[1]).ok_or(VaultError::InvalidInputCount)?;
    require!(
        input_count >= 1 && (input_count as usize) <= MAX_INPUTS,
        VaultError::InvalidInputCount
    );
    for i in input_count as usize..MAX_INPUTS {
        require!(
            publics[NULLIFIER_START + i] == [0u8; 32],
            VaultError::InvalidInputCount
        );
    }
    Ok((binder_key, publics, action, input_count))
}

/// Create the nullifier PDA for each spent input (limbs 9..); an existing one means spent.
fn burn_nullifiers<'info>(
    publics: &[[u8; 32]; NR_PUBLIC_INPUTS],
    input_count: u8,
    slots: &[&UncheckedAccount<'info>],
    spender: &Signer<'info>,
    system_program: &Program<'info, System>,
) -> Result<()> {
    require!((input_count as usize) <= slots.len(), VaultError::InvalidInputCount);
    for i in 0..input_count as usize {
        let nf = publics[NULLIFIER_START + i];
        require!(nf != [0u8; 32], VaultError::InvalidNullifier);
        let nf_ai = slots[i];
        require!(nf_ai.data_is_empty(), VaultError::NullifierSpent);
        let (expected, bump) =
            Pubkey::find_program_address(&[NULLIFIER_SEED, nf.as_ref()], &crate::ID);
        require_keys_eq!(nf_ai.key(), expected, VaultError::InvalidNullifierPda);

        let space = 8 + NullifierAccount::INIT_SPACE;
        let lamports = Rent::get()?.minimum_balance(space);
        let bump_seed = [bump];
        let seeds: &[&[u8]] = &[NULLIFIER_SEED, nf.as_ref(), &bump_seed];
        system_program::create_account(
            CpiContext::new_with_signer(
                system_program.to_account_info(),
                CreateAccount {
                    from: spender.to_account_info(),
                    to: nf_ai.to_account_info(),
                },
                &[seeds],
            ),
            lamports,
            space as u64,
            &crate::ID,
        )?;

        let mut data = nf_ai.try_borrow_mut_data()?;
        let mut cursor: &mut [u8] = &mut data;
        NullifierAccount {
            bump,
            nullifier: nf,
        }
        .try_serialize(&mut cursor)?;
    }
    Ok(())
}

/// PROTOCOL §4.4 MerkleRoot8: depth-3 Poseidon over the 8 slots in order (LE limbs).
fn split_root8(leaves: &[[u8; 32]; SPLIT_OUTPUTS]) -> Result<[u8; 32]> {
    let mut level: Vec<[u8; 32]> = leaves.to_vec();
    while level.len() > 1 {
        let mut next = Vec::with_capacity(level.len() / 2);
        for pair in level.chunks(2) {
            next.push(hash2_le(&pair[0], &pair[1]).map_err(|_| VaultError::PoseidonFailed)?);
        }
        level = next;
    }
    Ok(level[0])
}

// ─── Tree helpers ────────────────────────────────────────────────────────────

fn tree_insert(tree: &AccountLoader<TreeAccount>, commitment: [u8; 32]) -> Result<u64> {
    let mut tree = tree.load_mut()?;
    let idx = tree.next_index;
    require!(
        idx < (1u64 << NOTE_TREE_DEPTH),
        VaultError::TreeFull
    );

    let mut current_index = idx;
    let mut current = commitment;
    for level in 0..NOTE_TREE_DEPTH {
        if current_index & 1 == 0 {
            tree.filled_subtrees[level] = current;
            current = hash2_le(&current, &tree.zero_hashes[level])
                .map_err(|_| VaultError::PoseidonFailed)?;
        } else {
            current = hash2_le(&tree.filled_subtrees[level], &current)
                .map_err(|_| VaultError::PoseidonFailed)?;
        }
        current_index >>= 1;
    }

    tree.next_index = idx + 1;
    let new_root = current;
    tree.root = new_root;
    push_recent_root(&mut tree, new_root);
    Ok(idx)
}

fn push_recent_root(tree: &mut TreeAccount, root: [u8; 32]) {
    let head = tree.recent_head as usize % RECENT_ROOTS_CAP;
    tree.recent_roots[head] = root;
    tree.recent_head = ((head + 1) % RECENT_ROOTS_CAP) as u8;
    if (tree.recent_len as usize) < RECENT_ROOTS_CAP {
        tree.recent_len = tree.recent_len.saturating_add(1);
    }
}

fn recent_roots_contains(tree: &TreeAccount, root: &[u8; 32]) -> bool {
    let len = tree.recent_len as usize;
    if len == 0 {
        return false;
    }
    if len < RECENT_ROOTS_CAP {
        tree.recent_roots[..len].iter().any(|r| r == root)
    } else {
        tree.recent_roots.iter().any(|r| r == root)
    }
}

fn small_u8(limb: &[u8; 32]) -> Option<u8> {
    if limb[1..].iter().any(|&b| b != 0) {
        return None;
    }
    Some(limb[0])
}

fn limb_u64(limb: &[u8; 32]) -> Result<u64> {
    require!(limb[8..].iter().all(|&b| b == 0), VaultError::InvalidAmount);
    let mut bytes = [0u8; 8];
    bytes.copy_from_slice(&limb[..8]);
    Ok(u64::from_le_bytes(bytes))
}

/// Mints the vault may custody: primary `allowed_mint` (USDC), WSOL, jlUSDC, and JitoSOL.
fn mint_allowed(mint: Pubkey, allowed_mint: Pubkey) -> bool {
    mint == allowed_mint
        || mint == WSOL_MINT
        || mint == JL_USDC_MINT
        || mint == JITO_SOL_MINT
}

/// The mint a withdraw pays out, from public limb 17.
///
/// A note's asset is the mint REDUCED mod p (`deposit_commitment` hashes `be_field_from_bytes`),
/// so a mint above the modulus never reads back as itself — devnet USDC `DteUan…` is ~3p and came
/// back as `47wdgm…`, failing MintNotAllowed on every USDC withdraw. Match the reduced forms of
/// the mints the vault accepts and pay out the real one.
fn payout_mint(limb: &[u8; 32], allowed_mint: Pubkey) -> Result<Pubkey> {
    let asset = le_to_be(limb);
    [allowed_mint, WSOL_MINT, JL_USDC_MINT, JITO_SOL_MINT]
        .into_iter()
        .find(|m| be_field_from_bytes(&m.to_bytes()) == asset)
        .ok_or_else(|| error!(VaultError::MintNotAllowed))
}

// ─── Accounts ────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct InitializeVault<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        init,
        payer = authority,
        space = 8 + VaultAccount::INIT_SPACE,
        seeds = [VAULT_SEED],
        bump
    )]
    pub vault: Account<'info, VaultAccount>,
    #[account(
        init,
        payer = authority,
        space = TreeAccount::SPACE,
        seeds = [TREE_SEED],
        bump
    )]
    pub tree: AccountLoader<'info, TreeAccount>,
    pub allowed_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetCompliance<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    // `init`, once at bootstrap: later roots come from the postman (publish_roots).
    #[account(
        init,
        payer = authority,
        space = 8 + std::mem::size_of::<ComplianceAccount>(),
        seeds = [COMPLIANCE_SEED],
        bump
    )]
    pub compliance: AccountLoader<'info, ComplianceAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct SetPostman<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + PostmanAccount::INIT_SPACE,
        seeds = [POSTMAN_SEED],
        bump
    )]
    pub postman_config: Account<'info, PostmanAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct PublishRoots<'info> {
    pub postman: Signer<'info>,
    #[account(seeds = [POSTMAN_SEED], bump = postman_config.bump)]
    pub postman_config: Account<'info, PostmanAccount>,
    #[account(mut, seeds = [COMPLIANCE_SEED], bump)]
    pub compliance: AccountLoader<'info, ComplianceAccount>,
}

#[derive(Accounts)]
#[instruction(circuit_index: u8)]
pub struct RegisterVk<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    /// CHECK: packed VK bytes (2120); created off-chain / via create_account.
    pub vk_account: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(circuit_index: u8)]
pub struct InitVkPda<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    /// CHECK: raw VK blob (2120 bytes), program-owned PDA.
    #[account(
        init,
        payer = authority,
        space = VK_ACCOUNT_BYTES,
        seeds = [VK_SEED, &[circuit_index][..]],
        bump,
        owner = crate::ID
    )]
    pub vk: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct WriteVkChunk<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    /// CHECK: VK PDA being filled.
    #[account(mut)]
    pub vk: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(amount: u64, user_salt: [u8; 32], precommitment: [u8; 32], note_commitment: [u8; 32])]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    #[account(mut, seeds = [TREE_SEED], bump)]
    pub tree: AccountLoader<'info, TreeAccount>,
    pub mint: Account<'info, Mint>,
    #[account(
        mut,
        constraint = depositor_token.owner == depositor.key(),
        constraint = depositor_token.mint == mint.key()
    )]
    pub depositor_token: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = depositor,
        associated_token::mint = mint,
        associated_token::authority = vault,
    )]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = depositor,
        space = 8 + LeafIndexAccount::INIT_SPACE,
        seeds = [LEAF_SEED, note_commitment.as_ref()],
        bump
    )]
    pub leaf_index: Account<'info, LeafIndexAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(binder: [u8; 32])]
pub struct CommitPublicInputs<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    #[account(
        init,
        payer = payer,
        space = PendingInputsAccount::SPACE,
        seeds = [PENDING_SEED, binder.as_ref()],
        bump
    )]
    pub pending: AccountLoader<'info, PendingInputsAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(binder: [u8; 32])]
pub struct Spend<'info> {
    #[account(mut)]
    pub spender: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    #[account(mut, seeds = [TREE_SEED], bump)]
    pub tree: AccountLoader<'info, TreeAccount>,
    #[account(seeds = [COMPLIANCE_SEED], bump)]
    pub compliance: AccountLoader<'info, ComplianceAccount>,
    #[account(
        mut,
        seeds = [PENDING_SEED, binder.as_ref()],
        bump
    )]
    pub pending: AccountLoader<'info, PendingInputsAccount>,
    /// CHECK: must match vault.vk_accounts[circuit_index]; data = packed VK.
    pub vk_account: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = vault_token.owner == vault.key()
    )]
    pub vault_token: Account<'info, TokenAccount>,
    #[account(mut)]
    pub payee_token: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
    /// CHECK: nullifier PDA slots (only 0..input_count are used).
    #[account(mut)]
    pub nullifier0: UncheckedAccount<'info>,
    #[account(mut)]
    pub nullifier1: UncheckedAccount<'info>,
    #[account(mut)]
    pub nullifier2: UncheckedAccount<'info>,
    #[account(mut)]
    pub nullifier3: UncheckedAccount<'info>,
    #[account(mut)]
    pub nullifier4: UncheckedAccount<'info>,
    #[account(mut)]
    pub nullifier5: UncheckedAccount<'info>,
}

#[derive(Accounts)]
pub struct SetAllowedMint<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    pub new_mint: Account<'info, Mint>,
    /// CHECK: the vault's ATA for the CURRENT mint (address checked in the handler); it must be
    /// empty or never created.
    pub current_vault_token: UncheckedAccount<'info>,
}

#[derive(Accounts)]
#[instruction(binder: [u8; 32])]
pub struct SpendSplit<'info> {
    #[account(mut)]
    pub spender: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    #[account(mut, seeds = [TREE_SEED], bump)]
    pub tree: AccountLoader<'info, TreeAccount>,
    #[account(seeds = [COMPLIANCE_SEED], bump)]
    pub compliance: AccountLoader<'info, ComplianceAccount>,
    #[account(
        mut,
        seeds = [PENDING_SEED, binder.as_ref()],
        bump
    )]
    pub pending: AccountLoader<'info, PendingInputsAccount>,
    /// CHECK: matched against vault.vk_accounts[circuit_index] in admit_spend.
    pub vk_account: UncheckedAccount<'info>,
    pub system_program: Program<'info, System>,
    /// CHECK: the input note's nullifier PDA, created by burn_nullifiers.
    #[account(mut)]
    pub nullifier0: UncheckedAccount<'info>,
}

// ─── State ───────────────────────────────────────────────────────────────────

#[account]
#[derive(InitSpace)]
pub struct VaultAccount {
    pub bump: u8,
    pub authority: Pubkey,
    pub program_version: [u8; 32],
    pub deposit_nonce: u64,
    pub state_root: [u8; 32],
    pub deposits_paused: bool,
    pub allowed_mint: Pubkey,
    pub vault_scope_id: [u8; 32],
    pub vk_accounts: [Pubkey; VK_SLOT_COUNT],
}

#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct TreeAccount {
    pub bump: u8,
    pub recent_len: u8,
    pub recent_head: u8,
    pub _pad0: [u8; 5],
    pub next_index: u64,
    pub root: [u8; 32],
    pub filled_subtrees: [[u8; 32]; NOTE_TREE_DEPTH],
    pub zero_hashes: [[u8; 32]; NOTE_TREE_DEPTH],
    pub recent_roots: [[u8; 32]; RECENT_ROOTS_CAP],
}

impl TreeAccount {
    pub const SPACE: usize = 8 + std::mem::size_of::<Self>();
}

/// Zero-copy: the 4 KiB ring would overflow the 4 KiB SBF stack frame if Borsh-deserialized.
/// Every field is byte-aligned, so the layout is the borsh one — bump @8, admitted @9, revoked
/// @41 — and readers of the first two roots (solasp postman, the app) are unaffected.
#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct ComplianceAccount {
    pub bump: u8,
    pub admitted_root: [u8; 32],
    pub revoked_root: [u8; 32],
    pub ring_head: u8,
    pub ring_len: u8,
    pub admitted_ring: [[u8; 32]; ADMITTED_RING_CAP],
}

impl ComplianceAccount {
    fn set_roots(&mut self, admitted_root: [u8; 32], revoked_root: [u8; 32]) {
        // A republish of an unchanged admitted root (only the revoked root moved) must not push
        // a duplicate and crowd real history out of the ring.
        if self.ring_len == 0 || self.admitted_root != admitted_root {
            let head = self.ring_head as usize % ADMITTED_RING_CAP;
            self.admitted_ring[head] = admitted_root;
            self.ring_head = ((head + 1) % ADMITTED_RING_CAP) as u8;
            if (self.ring_len as usize) < ADMITTED_RING_CAP {
                self.ring_len += 1;
            }
        }
        self.admitted_root = admitted_root;
        self.revoked_root = revoked_root;
    }

    fn admits(&self, root: &[u8; 32]) -> bool {
        *root == self.admitted_root
            || self.admitted_ring[..self.ring_len as usize].iter().any(|r| r == root)
    }
}

#[account(zero_copy(unsafe))]
#[repr(C)]
pub struct PendingInputsAccount {
    pub bump: u8,
    pub consumed: u8,
    pub _pad: [u8; 6],
    pub owner: Pubkey,
    pub binder: [u8; 32],
    pub publics: [[u8; 32]; NR_PUBLIC_INPUTS],
}

impl PendingInputsAccount {
    pub const SPACE: usize = 8 + std::mem::size_of::<Self>();
}

#[account]
#[derive(InitSpace)]
pub struct PostmanAccount {
    pub bump: u8,
    pub postman: Pubkey,
}

/// Tiny leaf-index lookup by commitment (no plaintext amount).
#[account]
#[derive(InitSpace)]
pub struct LeafIndexAccount {
    pub bump: u8,
    pub leaf_index: u64,
}

#[account]
#[derive(InitSpace)]
pub struct NullifierAccount {
    pub bump: u8,
    pub nullifier: [u8; 32],
}

#[event]
pub struct DepositEvent {
    pub depositor: Pubkey,
    pub mint: Pubkey,
    pub commitment: [u8; 32],
    pub leaf_index: u64,
    pub deposit_nonce: u64,
}

/// Spend-side tree insert (change / merge note). Deposits emit `DepositEvent` instead; together
/// they give an indexer every leaf, so the state tree can be rebuilt after any spend.
#[event]
pub struct LeafInserted {
    pub commitment: [u8; 32],
    pub leaf_index: u64,
}

#[event]
pub struct RootsPublished {
    pub admitted_root: [u8; 32],
    pub revoked_root: [u8; 32],
}

#[event]
pub struct SpendEvent {
    pub spender: Pubkey,
    pub binder: [u8; 32],
    pub action: u8,
    pub circuit_index: u8,
}

#[error_code]
pub enum VaultError {
    #[msg("Deposits are paused")]
    DepositsPaused,
    #[msg("Amount must be > 0")]
    ZeroAmount,
    #[msg("user_salt must be non-zero")]
    InvalidSalt,
    #[msg("Mint is not allowed for this vault")]
    MintNotAllowed,
    #[msg("Unauthorized")]
    Unauthorized,
    #[msg("Deposit nonce overflow")]
    NonceOverflow,
    #[msg("Pending inputs already consumed")]
    PendingConsumed,
    #[msg("Verifier not configured (VK missing)")]
    VerifyNotConfigured,
    #[msg("Groth16 verification failed")]
    VerifyFailed,
    #[msg("Bad verifying-key account layout")]
    BadVkAccount,
    #[msg("VK account does not match vault registry")]
    VkMismatch,
    #[msg("Invalid circuit index")]
    InvalidCircuitIndex,
    #[msg("Program version mismatch")]
    ProgramVersionMismatch,
    #[msg("Unknown state root")]
    UnknownStateRoot,
    #[msg("Compliance root mismatch")]
    ComplianceRootMismatch,
    #[msg("Invalid action limb")]
    InvalidAction,
    #[msg("Invalid input count")]
    InvalidInputCount,
    #[msg("Invalid nullifier")]
    InvalidNullifier,
    #[msg("Nullifier already spent")]
    NullifierSpent,
    #[msg("Nullifier PDA mismatch")]
    InvalidNullifierPda,
    #[msg("Payee mismatch")]
    PayeeMismatch,
    #[msg("Invalid amount limb")]
    InvalidAmount,
    #[msg("Invalid commitment")]
    InvalidCommitment,
    #[msg("Poseidon hash failed")]
    PoseidonFailed,
    #[msg("Note tree is full")]
    TreeFull,
    #[msg("The vault still holds the current mint")]
    VaultNotEmpty,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn limb_of(mint: Pubkey) -> [u8; 32] {
        let mut le = be_field_from_bytes(&mint.to_bytes());
        le.reverse();
        le
    }

    #[test]
    fn split_root_matches_the_client_merkle_root8() {
        // splitRoot8([1, 2, 3, 0, 0, 0, 0, 0]) from the app (actionPublicsV3.splitRoot8).
        let mut leaves = [[0u8; 32]; SPLIT_OUTPUTS];
        for (i, v) in [1u8, 2, 3].iter().enumerate() {
            leaves[i][0] = *v; // LE limb
        }
        let mut root = split_root8(&leaves).unwrap();
        root.reverse(); // LE -> BE hex
        let want = hex::decode("05c1e52b41a571293b30efacd2afdb7173b20cfaf1f646c4ac9f96eb75848270").unwrap();
        assert_eq!(root.as_slice(), want.as_slice());
    }

    #[test]
    fn payout_mint_resolves_a_mint_above_the_field_modulus() {
        let usdc = pubkey!("DteUanphWnAmksJGq1uQFCRmY6ZwTV7cEib8CqGa5Bie");
        assert_ne!(be_field_from_bytes(&usdc.to_bytes()), usdc.to_bytes(), "test needs a mint > p");
        assert_eq!(payout_mint(&limb_of(usdc), usdc).unwrap(), usdc);
        assert_eq!(payout_mint(&limb_of(WSOL_MINT), usdc).unwrap(), WSOL_MINT);
        assert_eq!(payout_mint(&limb_of(JL_USDC_MINT), usdc).unwrap(), JL_USDC_MINT);
        assert_eq!(payout_mint(&limb_of(JITO_SOL_MINT), usdc).unwrap(), JITO_SOL_MINT);
        let other = pubkey!("8xueCcQRMhKo5CtppfmxXar2LuVaHfiiN3VzhxepqNEg");
        assert!(payout_mint(&limb_of(other), usdc).is_err());
    }

    #[test]
    fn compliance_keeps_recent_admitted_roots_but_only_the_current_revoked_root() {
        let mut c = ComplianceAccount {
            bump: 0,
            admitted_root: [0; 32],
            revoked_root: [0; 32],
            ring_head: 0,
            ring_len: 0,
            admitted_ring: [[0; 32]; ADMITTED_RING_CAP],
        };
        let r = |b: u8| [b; 32];
        c.set_roots(r(1), r(100));
        c.set_roots(r(1), r(101)); // revoked-only republish: no duplicate
        assert_eq!(c.ring_len, 1);
        c.set_roots(r(2), r(101));
        assert!(c.admits(&r(1)) && c.admits(&r(2)) && !c.admits(&r(3)));
        assert_eq!(c.revoked_root, r(101));
        for b in 3..=(ADMITTED_RING_CAP as u8 + 2) {
            c.set_roots(r(b), r(101));
        }
        assert!(!c.admits(&r(1)), "the oldest root ages out of the ring");
        assert!(c.admits(&r(ADMITTED_RING_CAP as u8 + 2)));
    }
}
