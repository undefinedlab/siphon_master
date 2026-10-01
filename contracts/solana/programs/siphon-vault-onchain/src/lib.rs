//! Retired Devnet scaffold. Not the product vault.
//!
//! Deposits still record a plaintext note PDA. `spend` and `strategy_swap`
//! always fail closed: a structural accept could freeze any note, and the
//! pool swap could pay an arbitrary recipient. The product path is
//! `siphon-vault-zk`.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::hash::hashv;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("Eip1D6GPh5hc3qrJVBcghd3W3KSPszqyRYbn6XPi9MWj");

pub const VAULT_SEED: &[u8] = b"siphon-vault-v1";
pub const COMPLIANCE_SEED: &[u8] = b"siphon-compliance-v1";
pub const NOTE_SEED: &[u8] = b"siphon-note-v1";
pub const PENDING_SEED: &[u8] = b"siphon-pending-inputs-v1";
pub const POOL_SEED: &[u8] = b"siphon-pool-v1";

/// Domain tag for Devnet MVP commitment hashing (client must match).
pub const COMMIT_DOMAIN: &[u8] = b"siphon-solana-devnet-deposit-v1";

/// Native wrapped SOL mint.
pub const WSOL_MINT: Pubkey = pubkey!("So11111111111111111111111111111111111111112");

#[program]
pub mod siphon_vault {
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
        vault.state_root = [0u8; 32];
        vault.deposits_paused = false;
        vault.allowed_mint = ctx.accounts.allowed_mint.key();
        vault.vault_scope_id = hashv(&[
            b"siphon-scope-v1",
            crate::ID.as_ref(),
            vault.key().as_ref(),
        ])
        .to_bytes();
        Ok(())
    }

    /// Devnet-only: rotate allowed mint (e.g. to a faucet-mintable test USDC).
    pub fn set_allowed_mint(ctx: Context<AdminVaultMint>, new_mint: Pubkey) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.vault.authority,
            VaultError::Unauthorized
        );
        ctx.accounts.vault.allowed_mint = new_mint;
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
        let c = &mut ctx.accounts.compliance;
        c.bump = ctx.bumps.compliance;
        c.admitted_root = admitted_root;
        c.revoked_root = revoked_root;
        Ok(())
    }

    pub fn pause_deposits(ctx: Context<AdminVault>, paused: bool) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.vault.authority,
            VaultError::Unauthorized
        );
        ctx.accounts.vault.deposits_paused = paused;
        Ok(())
    }

    /// Create Devnet CPMM pool (USDC ↔ WSOL). Jupiter has no Devnet liquidity.
    pub fn initialize_pool(ctx: Context<InitializePool>, fee_bps: u16) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.vault.authority,
            VaultError::Unauthorized
        );
        require!(fee_bps <= 1_000, VaultError::InvalidFee);
        require_keys_eq!(
            ctx.accounts.usdc_mint.key(),
            ctx.accounts.vault.allowed_mint,
            VaultError::MintNotAllowed
        );
        require_keys_eq!(ctx.accounts.wsol_mint.key(), WSOL_MINT, VaultError::MintNotAllowed);

        let pool = &mut ctx.accounts.pool;
        pool.bump = ctx.bumps.pool;
        pool.vault = ctx.accounts.vault.key();
        pool.usdc_mint = ctx.accounts.usdc_mint.key();
        pool.wsol_mint = ctx.accounts.wsol_mint.key();
        pool.fee_bps = fee_bps;
        pool.reserve_usdc = 0;
        pool.reserve_wsol = 0;
        Ok(())
    }

    /// Seed / top-up pool liquidity (authority).
    pub fn fund_pool(ctx: Context<FundPool>, usdc_amount: u64, wsol_amount: u64) -> Result<()> {
        require_keys_eq!(
            ctx.accounts.authority.key(),
            ctx.accounts.vault.authority,
            VaultError::Unauthorized
        );
        require!(
            usdc_amount > 0 || wsol_amount > 0,
            VaultError::ZeroAmount
        );

        if usdc_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.authority_usdc.to_account_info(),
                        to: ctx.accounts.pool_usdc.to_account_info(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                ),
                usdc_amount,
            )?;
            ctx.accounts.pool.reserve_usdc = ctx
                .accounts
                .pool
                .reserve_usdc
                .checked_add(usdc_amount)
                .ok_or(VaultError::MathOverflow)?;
        }
        if wsol_amount > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.authority_wsol.to_account_info(),
                        to: ctx.accounts.pool_wsol.to_account_info(),
                        authority: ctx.accounts.authority.to_account_info(),
                    },
                ),
                wsol_amount,
            )?;
            ctx.accounts.pool.reserve_wsol = ctx
                .accounts
                .pool
                .reserve_wsol
                .checked_add(wsol_amount)
                .ok_or(VaultError::MathOverflow)?;
        }
        Ok(())
    }

    /// Pull SPL USDC into the vault ATA and open a note PDA.
    pub fn deposit(
        ctx: Context<Deposit>,
        amount: u64,
        user_salt: [u8; 32],
        precommitment: [u8; 32],
    ) -> Result<()> {
        let vault = &mut ctx.accounts.vault;
        require!(!vault.deposits_paused, VaultError::DepositsPaused);
        require!(amount > 0, VaultError::ZeroAmount);
        require!(user_salt != [0u8; 32], VaultError::InvalidSalt);
        // Devnet bidirectional notes: allowed USDC mint or native WSOL.
        require!(
            ctx.accounts.mint.key() == vault.allowed_mint
                || ctx.accounts.mint.key() == WSOL_MINT,
            VaultError::MintNotAllowed
        );

        let note_commitment = commitment_hash(
            amount,
            ctx.accounts.mint.key().as_ref(),
            &user_salt,
            &precommitment,
        );

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

        let nonce = vault.deposit_nonce;
        let label = hashv(&[
            b"siphon-label-v1",
            &vault.vault_scope_id,
            &nonce.to_le_bytes(),
            &user_salt,
        ])
        .to_bytes();

        let note = &mut ctx.accounts.note;
        note.bump = ctx.bumps.note;
        note.depositor = ctx.accounts.depositor.key();
        note.mint = ctx.accounts.mint.key();
        note.amount = amount;
        note.user_salt = user_salt;
        note.precommitment = precommitment;
        note.commitment = note_commitment;
        note.label = label;
        note.deposit_nonce = nonce;
        note.spent = false;

        vault.state_root = hashv(&[&vault.state_root, &note_commitment]).to_bytes();
        vault.deposit_nonce = nonce
            .checked_add(1)
            .ok_or(VaultError::NonceOverflow)?;

        emit!(DepositEvent {
            depositor: note.depositor,
            mint: note.mint,
            amount,
            commitment: note_commitment,
            label,
            deposit_nonce: nonce,
            leaf_index: nonce,
        });
        Ok(())
    }

    pub fn commit_public_inputs(
        ctx: Context<CommitPublicInputs>,
        binder: [u8; 32],
        publics: [[u8; 32]; 25],
    ) -> Result<()> {
        let pending = &mut ctx.accounts.pending;
        pending.bump = ctx.bumps.pending;
        pending.owner = ctx.accounts.payer.key();
        pending.binder = binder;
        pending.publics = publics;
        pending.consumed = false;
        Ok(())
    }

    /// Retired. A structural accept marked whatever note account the caller passed.
    pub fn spend(ctx: Context<Spend>, _proof: [u8; 256]) -> Result<()> {
        let _ = ctx;
        err!(VaultError::VerifyNotConfigured)
    }

    /// Retired. The authority could pay pool output to any recipient.
    pub fn strategy_swap(ctx: Context<StrategySwap>, min_out: u64) -> Result<()> {
        let _ = (ctx, min_out);
        err!(VaultError::VerifyNotConfigured)
    }
}

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
    pub allowed_mint: Account<'info, Mint>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct AdminVault<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
}

#[derive(Accounts)]
pub struct AdminVaultMint<'info> {
    pub authority: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
}

#[derive(Accounts)]
pub struct SetCompliance<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    #[account(
        init_if_needed,
        payer = authority,
        space = 8 + ComplianceAccount::INIT_SPACE,
        seeds = [COMPLIANCE_SEED],
        bump
    )]
    pub compliance: Account<'info, ComplianceAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    pub usdc_mint: Account<'info, Mint>,
    pub wsol_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = authority,
        space = 8 + PoolAccount::INIT_SPACE,
        seeds = [POOL_SEED],
        bump
    )]
    pub pool: Account<'info, PoolAccount>,
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = usdc_mint,
        associated_token::authority = pool,
    )]
    pub pool_usdc: Account<'info, TokenAccount>,
    #[account(
        init_if_needed,
        payer = authority,
        associated_token::mint = wsol_mint,
        associated_token::authority = pool,
    )]
    pub pool_wsol: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct FundPool<'info> {
    pub authority: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, PoolAccount>,
    #[account(mut, constraint = authority_usdc.owner == authority.key())]
    pub authority_usdc: Account<'info, TokenAccount>,
    #[account(mut, constraint = authority_wsol.owner == authority.key())]
    pub authority_wsol: Account<'info, TokenAccount>,
    #[account(mut, constraint = pool_usdc.owner == pool.key())]
    pub pool_usdc: Account<'info, TokenAccount>,
    #[account(mut, constraint = pool_wsol.owner == pool.key())]
    pub pool_wsol: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
#[instruction(amount: u64, user_salt: [u8; 32], precommitment: [u8; 32])]
pub struct Deposit<'info> {
    #[account(mut)]
    pub depositor: Signer<'info>,
    #[account(mut, seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
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
        space = 8 + NoteAccount::INIT_SPACE,
        seeds = [NOTE_SEED, &commitment_hash(amount, mint.key().as_ref(), &user_salt, &precommitment)],
        bump
    )]
    pub note: Account<'info, NoteAccount>,
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
        space = 8 + PendingInputsAccount::INIT_SPACE,
        seeds = [PENDING_SEED, binder.as_ref()],
        bump
    )]
    pub pending: Account<'info, PendingInputsAccount>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Spend<'info> {
    pub spender: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    #[account(
        mut,
        seeds = [PENDING_SEED, pending.binder.as_ref()],
        bump = pending.bump
    )]
    pub pending: Account<'info, PendingInputsAccount>,
    #[account(mut)]
    pub note: Account<'info, NoteAccount>,
}

#[derive(Accounts)]
pub struct StrategySwap<'info> {
    pub executor: Signer<'info>,
    #[account(seeds = [VAULT_SEED], bump = vault.bump)]
    pub vault: Account<'info, VaultAccount>,
    #[account(mut, seeds = [POOL_SEED], bump = pool.bump)]
    pub pool: Account<'info, PoolAccount>,
    #[account(mut)]
    pub note: Account<'info, NoteAccount>,
    /// Vault ATA for the note mint (USDC or WSOL).
    #[account(mut)]
    pub vault_in: Account<'info, TokenAccount>,
    /// Pool ATA for the note mint (receives note amount).
    #[account(mut)]
    pub pool_in: Account<'info, TokenAccount>,
    /// Pool ATA for the output mint.
    #[account(mut)]
    pub pool_out: Account<'info, TokenAccount>,
    /// Recipient ATA for the output mint.
    #[account(mut)]
    pub recipient_out: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct VaultAccount {
    pub bump: u8,
    pub authority: Pubkey,
    pub allowed_mint: Pubkey,
    pub program_version: [u8; 32],
    pub vault_scope_id: [u8; 32],
    pub deposit_nonce: u64,
    pub state_root: [u8; 32],
    pub deposits_paused: bool,
}

#[account]
#[derive(InitSpace)]
pub struct ComplianceAccount {
    pub bump: u8,
    pub admitted_root: [u8; 32],
    pub revoked_root: [u8; 32],
}

#[account]
#[derive(InitSpace)]
pub struct PoolAccount {
    pub bump: u8,
    pub vault: Pubkey,
    pub usdc_mint: Pubkey,
    pub wsol_mint: Pubkey,
    pub fee_bps: u16,
    pub reserve_usdc: u64,
    pub reserve_wsol: u64,
}

#[account]
#[derive(InitSpace)]
pub struct NoteAccount {
    pub bump: u8,
    pub depositor: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub user_salt: [u8; 32],
    pub precommitment: [u8; 32],
    pub commitment: [u8; 32],
    pub label: [u8; 32],
    pub deposit_nonce: u64,
    pub spent: bool,
}

#[account]
#[derive(InitSpace)]
pub struct PendingInputsAccount {
    pub bump: u8,
    pub owner: Pubkey,
    pub binder: [u8; 32],
    pub publics: [[u8; 32]; 25],
    pub consumed: bool,
}

#[event]
pub struct DepositEvent {
    pub depositor: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub commitment: [u8; 32],
    pub label: [u8; 32],
    pub deposit_nonce: u64,
    pub leaf_index: u64,
}

#[event]
pub struct SpendEvent {
    pub spender: Pubkey,
    pub binder: [u8; 32],
    pub scaffold: bool,
}

#[event]
pub struct StrategySwapEvent {
    pub executor: Pubkey,
    pub depositor: Pubkey,
    pub recipient: Pubkey,
    pub amount_in: u64,
    pub amount_out: u64,
    pub sell_usdc: bool,
    pub commitment: [u8; 32],
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
    #[msg("Commitment mismatch")]
    CommitmentMismatch,
    #[msg("Deposit nonce overflow")]
    NonceOverflow,
    #[msg("Pending inputs already consumed")]
    PendingConsumed,
    #[msg("Note already spent")]
    NoteSpent,
    #[msg("Verifier not configured (scaffold-verify off)")]
    VerifyNotConfigured,
    #[msg("Invalid fee bps")]
    InvalidFee,
    #[msg("Pool has no liquidity")]
    PoolEmpty,
    #[msg("Insufficient pool liquidity")]
    InsufficientLiquidity,
    #[msg("Slippage / min out not met")]
    Slippage,
    #[msg("Math overflow")]
    MathOverflow,
}

pub fn commitment_hash(
    amount: u64,
    mint: &[u8],
    user_salt: &[u8; 32],
    precommitment: &[u8; 32],
) -> [u8; 32] {
    hashv(&[
        COMMIT_DOMAIN,
        &amount.to_le_bytes(),
        mint,
        user_salt.as_ref(),
        precommitment.as_ref(),
    ])
    .to_bytes()
}
