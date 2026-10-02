from flask_sqlalchemy import SQLAlchemy
from sqlalchemy.types import TypeDecorator, LargeBinary
from sqlalchemy import Column, String, Float, Text, DateTime
from datetime import datetime
import uuid
import json
from encryption import db_encryption, data_compression

db = SQLAlchemy()

class CompressedEncryptedText(TypeDecorator):
    """Custom SQLAlchemy type that compresses and encrypts text data"""
    impl = LargeBinary
    cache_ok = True
    
    def process_bind_param(self, value, dialect):
        """Compress and encrypt before storing"""
        if value is None:
            return None
        if isinstance(value, str):
            compressed = data_compression.compress_to_base64(value)
            encrypted = db_encryption.encrypt(compressed)
            return encrypted.encode()
        return value
    
    def process_result_value(self, value, dialect):
        """Decrypt and decompress after retrieving"""
        if value is None:
            return None
        if isinstance(value, bytes):
            try:
                decrypted = db_encryption.decrypt(value.decode())
                return data_compression.decompress_from_base64(decrypted)
            except Exception as e:
                print(f"⚠️  Error processing value: {e}")
                return value.decode() if isinstance(value, bytes) else value
        return value

class CompressedText(TypeDecorator):
    """Custom SQLAlchemy type that compresses text data (for non-sensitive large data)"""
    impl = LargeBinary
    cache_ok = True
    
    def process_bind_param(self, value, dialect):
        """Compress before storing"""
        if value is None:
            return None
        if isinstance(value, str):
            return data_compression.compress_to_base64(value).encode()
        return value
    
    def process_result_value(self, value, dialect):
        """Decompress after retrieving"""
        if value is None:
            return None
        if isinstance(value, bytes):
            try:
                return data_compression.decompress_from_base64(value.decode())
            except:
                return value.decode() if isinstance(value, bytes) else value
        return value

class Strategy(db.Model):
    id = db.Column(db.String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id = db.Column(db.String, nullable=False, index=True)
    strategy_type = db.Column(db.String, nullable=False, index=True)
    asset_in = db.Column(db.String, nullable=False)
    asset_out = db.Column(db.String, nullable=False)
    amount = db.Column(db.Float, nullable=False)
    price_feed_id = db.Column(db.String, nullable=True)
    billing_ref = db.Column(db.String, nullable=True)
    recipient_address = db.Column(db.String, nullable=False)

    
    # FHE keys are no longer stored per-strategy. The client key NEVER leaves the user's
    # browser; the (large) server key is stored once per user in UserFheKey and looked up
    # by user_id at evaluation time.

    # Compressed but not encrypted (FHE ciphertexts - already encrypted by FHE)
    encrypted_upper_bound = db.Column(CompressedText, nullable=True)
    encrypted_lower_bound = db.Column(CompressedText, nullable=True)

    # Latest encrypted evaluation result (hex of a RadixCiphertext, 1=triggered/0=not),
    # refreshed by the scheduler against the current price. The browser polls and decrypts
    # this locally to decide whether to authorize execution.
    encrypted_result = db.Column(CompressedText, nullable=True)
    result_updated_at = db.Column(DateTime, nullable=True)
    
    # Compressed JSON fields
    zkp_data = db.Column(CompressedText, nullable=True)
    
    # Status and Transaction
    status = db.Column(db.String, default='PENDING', nullable=False, index=True)
    tx_hash = db.Column(db.String, nullable=True)
    executed_at = db.Column(DateTime, nullable=True)  # When the trade was executed
    # Structured recovery context when a confirmed withdrawal cannot be delivered.
    execution_error = db.Column(db.Text, nullable=True)

    # ZK Privacy Pool Integration
    utxo_commitments = db.Column(db.Text, nullable=True)
    is_private = db.Column(db.Boolean, default=True, nullable=False, index=True)

    # Custom Strategies + Li.Fi Swaps Integration
    condition_tree = db.Column(db.Text, nullable=True)
    to_chain       = db.Column(db.String(20), nullable=True)
    from_chain     = db.Column(db.String(20), nullable=True)
    # Immutable deployment generation. Rows created before the dual-generation upgrade
    # remain NULL and are rejected by the scheduler until explicitly reconciled.
    vault_generation_id = db.Column(db.String(100), nullable=True, index=True)

    # The id the BROWSER armed this strategy's legs under in the enclave, which is the id
    # /spend/prove must ask for. It cannot be this row's id: the browser has to seal the legs
    # BEFORE createStrategy exists to mint one, so it arms under an id of its own and reports it
    # here. Proving by row id instead found no armed leg, and the strategy sat PENDING until it
    # expired. NULL on every non-attested row, which never touches the enclave.
    arm_strategy_id = db.Column(db.String(120), nullable=True, index=True)

    # Swap output routing: 'address' (default — send to recipient_address) or
    # 'vault' (re-deposit the swap output into the asset_out vault as a private note
    # owned by output_precommitment, so the user stays shielded and withdraws later) or
    # 'bridge' (the armed leg withdraws to this executor, which pays `payout` out through LI.FI).
    output_mode          = db.Column(db.String(20), nullable=False, default='address')
    output_precommitment = db.Column(db.String(80), nullable=True)
    # JSON bridge_payout.parse_payout(): {to_chain_id, to_address, to_token, refund_address,
    # slippage_bps}. Set only with output_mode='bridge'.
    payout = db.Column(db.Text, nullable=True)
    # Devnet (900002) settlement record, JSON (solana_devnet_strategy._record): the resume state
    # of a STAGED settlement, what it is waiting for, or the final record incl. the returned note.
    settlement = db.Column(db.Text, nullable=True)
    # Fire-time prove attempts for an enclave-armed SINGLE-leg strategy; the multi-leg
    # counter lives on StrategyLeg. Both shapes re-prove in the CVM on every tick, so both
    # need the same bound. Nullable: existing rows predate it (migration adds DEFAULT 0).
    prove_attempts = db.Column(db.Integer, nullable=True, default=0)

    # --- Multi-leg strategies (TWAP / RANGE_GRID) ------------------------------------------
    # A TWAP/Grid order is a parent Strategy with N child StrategyLeg rows, each an independent
    # shielded leg (its own slice note, ZK proof, nullifier, and encrypted trigger). The columns
    # below describe the schedule/ladder; per-leg data lives in StrategyLeg.
    #   leg_count        — number of legs (TWAP slices / grid rungs)
    #   interval_sec     — TWAP cadence between slices (seconds)
    #   grid_levels      — grid rung count (mirrors leg_count for RANGE_GRID)
    #   max_slippage_bps — per-leg slippage cap
    #   start_delay_sec  — delay before the first leg becomes eligible
    #   executed_count   — legs that have completed; strategy is EXECUTED when == leg_count
    #   eval_mode        — 'price' (grid rung price triggers) | 'time' (TWAP encrypted fire-time)
    leg_count        = db.Column(db.Integer, nullable=True)
    interval_sec     = db.Column(db.Integer, nullable=True)
    grid_levels      = db.Column(db.Integer, nullable=True)
    max_slippage_bps = db.Column(db.Integer, nullable=True)
    start_delay_sec  = db.Column(db.Integer, nullable=True)
    executed_count   = db.Column(db.Integer, nullable=False, default=0)
    eval_mode        = db.Column(db.String(10), nullable=True)  # 'price' | 'time'
    # Anchor time (unix seconds) the TWAP fire-times were computed against, so the executor can
    # reconstruct/verify schedule offsets. Plaintext is fine: it's just "when the order started",
    # the same instant the creation tx is already publicly timestamped on-chain.
    schedule_anchor  = db.Column(db.Integer, nullable=True)
    execution_window_sec = db.Column(db.Integer, nullable=True)  # expire + return funds after this

    # --- Polymarket (strategy_type='POLYMARKET') -------------------------------------------
    # JSON blob of the prediction-market order params the executor needs at fire time:
    #   {market_id, token_id, outcome, side, entry_odds}. Plaintext (public once the order hits
    #   the CLOB anyway); the PRIVACY is in the shielded funding + FHE trigger, not these fields.
    poly_meta = db.Column(db.Text, nullable=True)

    # --- Hyperliquid (strategy_type='HYPERLIQUID') -----------------------------------------
    # {coin, side: LONG|SHORT, leverage, take_profit_px?, stop_loss_px?, trigger_dir}.
    # Plaintext venue params; privacy is shielded funding + FHE entry trigger.
    hl_meta = db.Column(db.Text, nullable=True)

    # Timestamps
    created_at = db.Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def _payout_order(self):
        """Where a fired payout stands, for the activity log. None until the order fires."""
        if not self.payout:
            return None
        o = (BridgeOrder.query.filter_by(strategy_id=self.id)
             .order_by(BridgeOrder.created_at.desc()).first())
        if o is None:
            return None
        return {k: getattr(o, k) for k in
                ('id', 'status', 'amount_in', 'amount_out', 'bridge_tx', 'dest_tx', 'refund_tx', 'error')}

    def to_dict(self):
        """Convert to dictionary (automatically decrypts/decompresses)"""
        return {
            'id': self.id,
            'user_id': self.user_id,
            'strategy_type': self.strategy_type,
            'asset_in': self.asset_in,
            'asset_out': self.asset_out,
            'amount': self.amount,
            'price_feed_id': self.price_feed_id,
            'billing_ref': self.billing_ref,
            'recipient_address': self.recipient_address,

            'encrypted_upper_bound': self.encrypted_upper_bound,
            'encrypted_lower_bound': self.encrypted_lower_bound,
            'encrypted_result': self.encrypted_result,
            'result_updated_at': self.result_updated_at.isoformat() + 'Z' if self.result_updated_at else None,
            'zkp_data': json.loads(self.zkp_data) if self.zkp_data and isinstance(self.zkp_data, str) else self.zkp_data,
            'status': self.status,
            'tx_hash': self.tx_hash,
            'execution_error': self.execution_error,
            'executed_at': self.executed_at.isoformat() + 'Z' if self.executed_at else None,
            'utxo_commitments': self.utxo_commitments,
            'is_private': self.is_private,
            'condition_tree': json.loads(self.condition_tree) if self.condition_tree else None,
            'to_chain': self.to_chain,
            'from_chain': self.from_chain,
            'vault_generation_id': self.vault_generation_id,
            'arm_strategy_id': self.arm_strategy_id,
            'output_mode': self.output_mode,
            'output_precommitment': self.output_precommitment,
            'payout': json.loads(self.payout) if self.payout else None,
            'settlement': json.loads(self.settlement) if self.settlement else None,
            'payout_order': self._payout_order(),
            'leg_count': self.leg_count,
            'interval_sec': self.interval_sec,
            'grid_levels': self.grid_levels,
            'max_slippage_bps': self.max_slippage_bps,
            'start_delay_sec': self.start_delay_sec,
            'executed_count': self.executed_count,
            'eval_mode': self.eval_mode,
            'schedule_anchor': self.schedule_anchor,
            'execution_window_sec': self.execution_window_sec,
            'poly_meta': json.loads(self.poly_meta) if self.poly_meta else None,
            'hl_meta': json.loads(self.hl_meta) if self.hl_meta else None,
            'created_at': self.created_at.isoformat() + 'Z' if self.created_at else None,
            'updated_at': self.updated_at.isoformat() + 'Z' if self.updated_at else None,
        }


class PolymarketPosition(db.Model):
    """An open Polymarket position held by the executor between entry and resolution/exit.

    A prediction-market position lives days–weeks and the CTF outcome shares (ERC-1155) can't sit in
    the 2-token vault, so the executor's Polygon wallet custodies them during that window (v1 shared
    escrow). This row maps the owning strategy → the on-chain position and the shielded exit note
    (output_precommitment), so the resolution watcher can redeem and re-shield the proceeds back to
    the user's Base vault. Amounts are plaintext here (executor-internal accounting); user privacy
    rests on the shielded entry/exit + FHE trigger, not on this table.
    """
    __tablename__ = 'polymarket_positions'

    id           = db.Column(db.String, primary_key=True, default=lambda: str(uuid.uuid4()))
    strategy_id  = db.Column(db.String, db.ForeignKey('strategy.id'), nullable=False, index=True)
    user_id      = db.Column(db.String, nullable=False, index=True)
    market_id    = db.Column(db.String, nullable=False)
    token_id     = db.Column(db.String, nullable=False, index=True)  # CTF outcome token
    outcome      = db.Column(db.String, nullable=True)               # e.g. "Yes" / "Spain"
    side         = db.Column(db.String(8), nullable=False, default='BUY')
    entry_odds   = db.Column(db.Float, nullable=True)                # odds (0..1) at fill
    shares       = db.Column(db.String, nullable=True)               # CTF shares held (base units, str)
    cost_usdc    = db.Column(db.String, nullable=True)               # USDC spent (base units, str)
    # The shielded note the redeemed proceeds re-enter the Base vault under.
    output_precommitment = db.Column(db.String(80), nullable=True)
    # OPEN → REDEEMING → SETTLED (proceeds shielded) | FAILED | CANCELLED
    status       = db.Column(db.String, default='OPEN', nullable=False, index=True)
    entry_tx     = db.Column(db.String, nullable=True)   # CLOB order / fill reference
    bridge_tx    = db.Column(db.String, nullable=True)   # Base→Polygon LiFi tx
    redeem_tx    = db.Column(db.String, nullable=True)   # CTF redeemPositions tx
    settle_tx    = db.Column(db.String, nullable=True)   # Polygon→Base vault re-deposit tx
    payout_usdc  = db.Column(db.String, nullable=True)   # USDC realized at redemption
    created_at   = db.Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at   = db.Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def to_dict(self):
        return {
            'id': self.id,
            'strategy_id': self.strategy_id,
            'user_id': self.user_id,
            'market_id': self.market_id,
            'token_id': self.token_id,
            'outcome': self.outcome,
            'side': self.side,
            'entry_odds': self.entry_odds,
            'shares': self.shares,
            'cost_usdc': self.cost_usdc,
            'output_precommitment': self.output_precommitment,
            'status': self.status,
            'entry_tx': self.entry_tx,
            'bridge_tx': self.bridge_tx,
            'redeem_tx': self.redeem_tx,
            'settle_tx': self.settle_tx,
            'payout_usdc': self.payout_usdc,
            'created_at': self.created_at.isoformat() + 'Z' if self.created_at else None,
            'updated_at': self.updated_at.isoformat() + 'Z' if self.updated_at else None,
        }


class HyperliquidPosition(db.Model):
    """One user's perp on the executor's Hyperliquid account — see hyperliquid_watcher for the
    lifecycle (FUNDING → OPENING → OPEN → CLOSING → PAYOUT_DUE → PAYING → SETTLED).

    Every user's margin sits in that one account, so this row is the only record of what is whose:
    margin is what THIS strategy's bridge order delivered, and size / entry / PnL / fees come from
    the fills of this position's own orders (found again by deterministic cloids after a restart).
    """
    __tablename__ = 'hyperliquid_positions'

    id              = db.Column(db.String, primary_key=True, default=lambda: str(uuid.uuid4()))
    strategy_id     = db.Column(db.String, db.ForeignKey('strategy.id'), nullable=False, unique=True)
    bridge_order_id = db.Column(db.String, nullable=True)
    user_id         = db.Column(db.String, nullable=False, index=True)
    coin            = db.Column(db.String(32), nullable=False)
    side            = db.Column(db.String(8), nullable=False)         # LONG | SHORT
    leverage        = db.Column(db.Integer, nullable=False, default=1)
    take_profit_px  = db.Column(db.Float, nullable=True)
    stop_loss_px    = db.Column(db.Float, nullable=True)
    margin_usdc     = db.Column(db.String, nullable=True)             # USDC base units delivered
    entry_size      = db.Column(db.Float, nullable=True)              # coin units filled at entry
    size            = db.Column(db.Float, nullable=False, default=0)  # coin units still open
    entry_px        = db.Column(db.Float, nullable=True)
    realized_pnl    = db.Column(db.Float, nullable=False, default=0)  # USD, from exit fills
    fees_usd        = db.Column(db.Float, nullable=False, default=0)  # trading fees, entry + exit
    funding_usd     = db.Column(db.Float, nullable=True)              # paid (+) / received (−)
    close_reason    = db.Column(db.String(16), nullable=True)         # tp | sl | guard | user
    payout_usdc     = db.Column(db.String, nullable=True)             # USDC base units owed
    payout_chain    = db.Column(db.Integer, nullable=False)           # 1337 HyperCore | 42161
    payout_address  = db.Column(db.String(42), nullable=False)
    payout_ref      = db.Column(db.String, nullable=True)
    status          = db.Column(db.String(16), nullable=False, default='FUNDING', index=True)
    attempts        = db.Column(db.Integer, nullable=False, default=0)  # names the next order's cloid
    error           = db.Column(db.Text, nullable=True)
    opened_at       = db.Column(DateTime, nullable=True)
    closed_at       = db.Column(DateTime, nullable=True)
    created_at      = db.Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at      = db.Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def to_dict(self):
        iso = lambda d: d.isoformat() + 'Z' if d else None  # noqa: E731
        return {
            'id': self.id, 'strategy_id': self.strategy_id, 'user_id': self.user_id,
            'coin': self.coin, 'side': self.side, 'leverage': self.leverage,
            'take_profit_px': self.take_profit_px, 'stop_loss_px': self.stop_loss_px,
            'margin_usdc': self.margin_usdc, 'entry_size': self.entry_size, 'size': self.size,
            'entry_px': self.entry_px,
            'realized_pnl': self.realized_pnl, 'fees_usd': self.fees_usd, 'funding_usd': self.funding_usd,
            'close_reason': self.close_reason, 'payout_usdc': self.payout_usdc,
            'payout_chain': self.payout_chain, 'payout_address': self.payout_address,
            'payout_ref': self.payout_ref, 'status': self.status, 'error': self.error,
            'opened_at': iso(self.opened_at), 'closed_at': iso(self.closed_at),
            'created_at': iso(self.created_at), 'updated_at': iso(self.updated_at),
        }


class StrategyLeg(db.Model):
    """One independent leg of a multi-leg strategy (TWAP slice / grid rung).

    Each leg is a fully shielded sub-trade: its own slice note (from Vault.split), its own
    multi-note withdrawal ZK proof + nullifier set, its own encrypted trigger, and its own
    swap. Legs are evaluated and fired independently by the scheduler/executor, so a TWAP of N
    slices produces N withdraw+swap txs with N distinct nullifiers — never reusing one note.

    Privacy: a grid leg triggers on an encrypted PRICE band (FHE GTE/LTE vs the public price);
    a TWAP leg triggers on an encrypted FIRE-TIME (FHE LTE vs the public current unix time), so
    the cadence stays hidden in ciphertext exactly like a price threshold does — never stored
    in plaintext on the server."""
    __tablename__ = 'strategy_legs'
    id          = db.Column(db.String, primary_key=True, default=lambda: str(uuid.uuid4()))
    strategy_id = db.Column(db.String, db.ForeignKey('strategy.id'), nullable=False, index=True)
    leg_index   = db.Column(db.Integer, nullable=False)
    amount      = db.Column(db.Float, nullable=False)               # per-leg amount (asset_in units)
    side        = db.Column(db.String(12), nullable=True)           # LIMIT_BUY | LIMIT_SELL (grid)
    eval_mode   = db.Column(db.String(10), nullable=False, default='price')  # 'price' | 'time'
    # DEPRECATED — never populated anymore, nothing reads it. Storing the plaintext rung price next
    # to its FHE-encrypted band defeated threshold privacy against DB access. Column kept only to
    # avoid a schema migration; new rows are NULL. (Scrub old rows: UPDATE strategy_legs SET
    # target_price = NULL;)
    target_price = db.Column(db.Float, nullable=True)

    # Per-leg encrypted trigger bound (FHE ciphertext, compressed at rest):
    #   grid: rung price band (lower for buy rung / upper for sell rung)
    #   twap: encrypted fire-time (seconds); fires when current_time >= fire_time
    encrypted_upper_bound = db.Column(CompressedText, nullable=True)
    encrypted_lower_bound = db.Column(CompressedText, nullable=True)
    encrypted_result      = db.Column(CompressedText, nullable=True)
    result_updated_at     = db.Column(DateTime, nullable=True)

    # Per-leg multi-note withdrawal proof (JSON). Holds pA/pB/pC, stateRoot, nullifierHashes[],
    # changeCommitment, and swap-binding signals — one note (slice) spent per leg.
    zkp_data       = db.Column(CompressedText, nullable=True)
    nullifier_hash = db.Column(db.String(80), nullable=True, index=True)  # first nullifier (claim/dedup)

    # Vault-output (output_mode='vault'): precommitment of THIS leg's asset_out note. After the
    # leg's swap, the executor re-deposits the output as Poseidon(actualOut, precommitment).
    output_precommitment = db.Column(db.String, nullable=True)
    # Devnet settlement record for this leg (see Strategy.settlement).
    settlement = db.Column(db.Text, nullable=True)

    # Fire-time prove attempts (v3 enclave-armed legs only). A v2 leg carries a finished proof, so
    # it either executes or fails; a v3 leg re-proves in the CVM on every tick until it succeeds,
    # and each attempt is a full ASP sync plus a Groth16 proof on 2 vCPUs. Unbounded, one wedged
    # leg consumes the enclave. Counted here so the retry can be given up on.
    #
    # Belongs on the LEG, not on Strategy: _bump_prove_attempts writes strategy_legs and reads it
    # back off this model, and the app.py migration ALTERs strategy_legs. Declared on Strategy it
    # matched no column in the live table and every Strategy query failed with
    # "no such column: strategy.prove_attempts" — the executor answered /health while its
    # scheduler could not read a single row.
    prove_attempts = db.Column(db.Integer, nullable=True, default=0)

    # 'pipeline' = sequential multi-hop (not TWAP parallel). NULL on TWAP/grid legs.
    leg_kind = db.Column(db.String(20), nullable=True)

    status      = db.Column(db.String, default='PENDING', nullable=False, index=True)
    tx_hash     = db.Column(db.String, nullable=True)
    executed_at = db.Column(DateTime, nullable=True)
    created_at  = db.Column(DateTime, default=datetime.utcnow, nullable=False)

    strategy = db.relationship('Strategy', backref=db.backref('legs', lazy='dynamic', order_by='StrategyLeg.leg_index'))

    def to_dict(self):
        return {
            'id': self.id,
            'strategy_id': self.strategy_id,
            'leg_index': self.leg_index,
            'amount': self.amount,
            'side': self.side,
            'eval_mode': self.eval_mode,
            'encrypted_upper_bound': self.encrypted_upper_bound,
            'encrypted_lower_bound': self.encrypted_lower_bound,
            'encrypted_result': self.encrypted_result,
            'result_updated_at': self.result_updated_at.isoformat() + 'Z' if self.result_updated_at else None,
            'zkp_data': json.loads(self.zkp_data) if self.zkp_data and isinstance(self.zkp_data, str) else self.zkp_data,
            'nullifier_hash': self.nullifier_hash,
            'output_precommitment': self.output_precommitment,
            'settlement': json.loads(self.settlement) if self.settlement else None,
            'leg_kind': self.leg_kind,
            'status': self.status,
            'tx_hash': self.tx_hash,
            'executed_at': self.executed_at.isoformat() + 'Z' if self.executed_at else None,
            'created_at': self.created_at.isoformat() + 'Z' if self.created_at else None,
        }


class WithdrawCredit(db.Model):
    """Prepaid withdrawal-fee balance, and the debits taken against it.

    Why prepaid rather than a payment per withdrawal: a fee transfer sent from the user's PUBLIC
    wallet moments before their shielded withdrawal is relayed correlates the two by timing, which
    links the public identity to a withdrawal that was otherwise unlinkable. That defeats the point
    of the vault. Topping up occasionally and debiting silently keeps the collection point (the
    relayer) without putting an on-chain event next to every exit.

    One row per movement: a `topup` credits, a `debit` consumes. Balance is the signed sum, so a
    debit can never be lost by a concurrent read-modify-write of a running total.

    tx_hash is UNIQUE for topups — arming_fee.py verifies its transfer but never records it, so the
    same transaction can arm any number of strategies. Here that bug would be free money, so the
    uniqueness constraint is the enforcement, not a convention.
    """
    __tablename__ = 'withdraw_credits'
    id         = db.Column(db.String, primary_key=True, default=lambda: str(uuid.uuid4()))
    wallet     = db.Column(db.String(42), nullable=False, index=True)  # lowercase
    chain_id   = db.Column(db.Integer, nullable=False, index=True)
    kind       = db.Column(db.String(8), nullable=False)               # 'topup' | 'debit'
    amount_wei = db.Column(db.String, nullable=False)                  # USDC minor units, positive
    tx_hash    = db.Column(db.String, nullable=True, unique=True)      # set on topup; replay guard
    ref        = db.Column(db.String, nullable=True)                   # debit: spend tx hash
    created_at = db.Column(DateTime, default=datetime.utcnow, nullable=False)


class FeeAccrual(db.Model):
    """A protocol fee retained in the executor wallet (Part A arming / Part B execution)."""
    __tablename__ = 'fee_accruals'
    id          = db.Column(db.String, primary_key=True, default=lambda: str(uuid.uuid4()))
    chain_id    = db.Column(db.Integer, nullable=False, index=True)
    asset       = db.Column(db.String(12), nullable=False)
    amount_wei  = db.Column(db.String, nullable=False)   # string — wei can exceed BIGINT range
    kind        = db.Column(db.String(12), nullable=False)   # 'execution' | 'arming'
    strategy_id = db.Column(db.String, nullable=True, index=True)
    leg_id      = db.Column(db.String, nullable=True)
    tx_hash     = db.Column(db.String, nullable=True)   # the trade tx the fee was deducted from
    swept       = db.Column(db.Boolean, default=False, nullable=False, index=True)
    sweep_tx    = db.Column(db.String, nullable=True)   # legacy field; no automatic sweep runs
    created_at  = db.Column(DateTime, default=datetime.utcnow, nullable=False)

    def to_dict(self):
        return {
            'id': self.id, 'chain_id': self.chain_id, 'asset': self.asset,
            'amount_wei': self.amount_wei, 'kind': self.kind, 'strategy_id': self.strategy_id,
            'leg_id': self.leg_id, 'tx_hash': self.tx_hash, 'swept': self.swept,
            'sweep_tx': self.sweep_tx,
            'created_at': self.created_at.isoformat() + 'Z' if self.created_at else None,
        }

class Note(db.Model):
    __tablename__ = 'notes'
    id             = db.Column(db.String, primary_key=True, default=lambda: str(uuid.uuid4()))
    wallet         = db.Column(db.String(42), nullable=False, index=True)
    ciphertext     = db.Column(db.Text, nullable=False)
    iv             = db.Column(db.String(64), nullable=False)
    commitment     = db.Column(db.String(80), nullable=False)
    nullifier_hash = db.Column(db.String(80), nullable=False)
    chain_id       = db.Column(db.Integer, nullable=False, default=11155111)
    asset          = db.Column(db.String(10), nullable=False, default='ETH')
    spent          = db.Column(db.String(10), nullable=False, default='false')  # 'false' | 'pending' | 'true'
    created_at     = db.Column(DateTime, default=datetime.utcnow, nullable=False)

    def to_dict(self):
        return {
            'id': self.id,
            'wallet': self.wallet,
            'ciphertext': self.ciphertext,
            'iv': self.iv,
            'commitment': self.commitment,
            'nullifier_hash': self.nullifier_hash,
            'chain_id': self.chain_id,
            'asset': self.asset,
            'spent': self.spent,  # 'false' | 'pending' | 'true'
            'created_at': self.created_at.isoformat() + 'Z' if self.created_at else None,
        }


class UserFheKey(db.Model):
    """Per-user FHE public (server) key. Generated in the user's browser and uploaded once.
    The server key is large (~100 MB) and identical across all of a user's strategies, so it
    is stored here once rather than duplicated per strategy.

    An enc-key-wrapped copy of the CLIENT key is also stored so a returning device can restore
    it without re-signing; the server cannot decrypt it. The wrapping key is AES-GCM derived
    from a wallet signature the browser rebuilds on every page load and never uploads, so this
    row is an unopenable blob to anyone holding the database."""
    __tablename__ = 'user_fhe_keys'
    user_id    = db.Column(db.String, primary_key=True)
    server_key = db.Column(CompressedText, nullable=False)  # hex, compressed at rest
    # hex(encrypt(0)) under THIS generation's ClientKey. Uploaded with server_key so the two are
    # provably one generation; the scheduler decrypts it through the engine+decryptor before firing
    # to catch a decryptor ClientKey that drifted after arm-time (see verify_canary). NULL = legacy
    # row (no gate; scheduler falls back to fail-closed decrypt only).
    canary     = db.Column(db.String, nullable=True)
    # Wallet-wrapped ClientKey, so a new device restores instead of re-prompting for the FHE seed
    # signature. Ciphertext only: AES-GCM under the browser's note enc-key, which never leaves the
    # browser. Plain Text, NOT CompressedText — ciphertext does not compress, so the wrapper would
    # add a failure mode and buy nothing. All nullable: existing rows stay valid.
    enc_client_key = db.Column(db.Text, nullable=True)      # base64 AES-GCM ciphertext
    client_key_iv  = db.Column(db.String(32), nullable=True)  # base64 12-byte IV
    client_key_fp  = db.Column(db.String(64), nullable=True)  # sha256(clientKeyHex)[:16], observability only
    client_key_v   = db.Column(db.Integer, nullable=True)     # payload encoding version
    created_at = db.Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)


class AdminWallet(db.Model):
    """Allow-listed wallet for gated chains (e.g. ETH Sepolia testing).

    When a chain is admin-gated, only wallets present here (or in the env seed) may create /
    execute strategies on it. Rows are added at runtime via the admin API, and/or seeded from
    an env var at boot. Addresses are stored lowercased for case-insensitive matching."""
    __tablename__ = 'admin_wallets'
    address    = db.Column(db.String(42), primary_key=True)   # lowercased EVM address
    chain_id   = db.Column(db.Integer, primary_key=True)       # which chain this allows
    label      = db.Column(db.String(120), nullable=True)
    created_at = db.Column(DateTime, default=datetime.utcnow, nullable=False)

    def to_dict(self):
        return {
            'address': self.address,
            'chain_id': self.chain_id,
            'label': self.label,
            'created_at': self.created_at.isoformat() + 'Z' if self.created_at else None,
        }


class Receipt(db.Model):
    """A compliant, selectively-disclosable receipt for a shielded deposit or withdrawal.

    Three layers, per the 'compliant by disclosure' design:
      • PUBLIC   — only what the chain already exposes (tx hash, amount, token, chain, date).
                   Safe to show anyone; reveals no deposit↔withdraw linkage.
      • IDENTITY — merchant/payer + payee fields the user entered (name, email, address, tax id).
                   Stored ENCRYPTED at rest; printed only on the owner's own copy / an L3 disclosure.
      • ATTESTATION — the enclave (order-signer) signs the canonical digest and stamps its DCAP
                   quote, so a verifier can confirm the receipt is genuine without trusting Siphon.

    Privacy is unchanged: nothing here is on-chain, and the shielded reference is stored only as a
    hash (`shielded_ref_hash`) so the row can't relink a withdrawal to its funding deposit."""
    __tablename__ = 'receipts'

    id            = db.Column(db.String, primary_key=True, default=lambda: str(uuid.uuid4()))
    user_id       = db.Column(db.String, nullable=False, index=True)   # owning wallet (lowercased)
    kind          = db.Column(db.String(12), nullable=False, index=True)  # 'deposit' | 'withdraw'

    # ── PUBLIC layer (safe to disclose) ─────────────────────────────────────────────────────────
    tx_hash       = db.Column(db.String, nullable=True)
    chain_id      = db.Column(db.Integer, nullable=True)
    token         = db.Column(db.String(16), nullable=True)
    amount        = db.Column(db.String, nullable=True)   # human units, str (avoid float drift)
    counterparty  = db.Column(db.String, nullable=True)   # public on-chain address (payer→vault / vault→recipient)
    occurred_at   = db.Column(DateTime, nullable=True)

    # ── IDENTITY layer (encrypted at rest) ──────────────────────────────────────────────────────
    identity      = db.Column(CompressedEncryptedText, nullable=True)  # JSON: merchant/payee fields
    # Commitment to the identity block — SAFE to expose publicly (reveals nothing), lets a public
    # verifier recompute the digest without seeing the identity.
    identity_hash = db.Column(db.String(66), nullable=True)

    # ── Private shielded reference (HASH only — never the note secret / linkage) ─────────────────
    shielded_ref_hash = db.Column(db.String(66), nullable=True)  # sha256 hex of the note ref
    strategy_id   = db.Column(db.String, db.ForeignKey('strategy.id'), nullable=True, index=True)

    # ── ATTESTATION layer (the compliance teeth) ────────────────────────────────────────────────
    digest        = db.Column(db.String(66), nullable=True)   # canonical receipt digest (sha256 hex)
    tee_signature = db.Column(db.String, nullable=True)       # enclave signature over digest
    tee_address   = db.Column(db.String(42), nullable=True)   # signer address (bind to attestation)
    attestation_ref = db.Column(db.String, nullable=True)     # quote/report ref for verification

    status        = db.Column(db.String(12), default='SIGNED', nullable=False)  # DRAFT|SIGNED
    created_at    = db.Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at    = db.Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def identity_dict(self):
        try:
            return json.loads(self.identity) if self.identity else {}
        except Exception:
            return {}

    def to_dict(self, include_identity=False):
        """Public view by default. `include_identity=True` only for the authenticated owner."""
        out = {
            'id': self.id,
            'kind': self.kind,
            'tx_hash': self.tx_hash,
            'chain_id': self.chain_id,
            'token': self.token,
            'amount': self.amount,
            'counterparty': self.counterparty,
            'occurred_at': self.occurred_at.isoformat() + 'Z' if self.occurred_at else None,
            'identity_hash': self.identity_hash,
            'shielded_ref_hash': self.shielded_ref_hash,
            'digest': self.digest,
            'tee_signature': self.tee_signature,
            'tee_address': self.tee_address,
            'attestation_ref': self.attestation_ref,
            'status': self.status,
            'created_at': self.created_at.isoformat() + 'Z' if self.created_at else None,
        }
        if include_identity:
            out['identity'] = self.identity_dict()
        return out


# Cross-cycle server-key cache. CompressedText gunzips the ~24MB hex on EVERY row read,
# which used to happen once per user per scheduler tick. Steady state now costs one tiny
# updated_at query; the hex is re-read only when the browser re-uploads the key.
_server_key_cache = {}  # user_id -> (updated_at, server_key_hex)


def get_server_key(user_id):
    """Look up a user's stored FHE server key (hex), or None if not uploaded yet."""
    stamp = db.session.query(UserFheKey.updated_at).filter_by(user_id=user_id).scalar()
    if stamp is None:
        _server_key_cache.pop(user_id, None)
        return None
    cached = _server_key_cache.get(user_id)
    if cached and cached[0] == stamp:
        return cached[1]
    row = UserFheKey.query.get(user_id)
    key = row.server_key if row else None
    if key:
        _server_key_cache[user_id] = (stamp, key)
    return key


def get_user_canary(user_id):
    """Look up a user's stored key-consistency canary (hex encrypt(0)), or None."""
    row = UserFheKey.query.get(user_id)
    return row.canary if row else None


class ExecutionEvent(db.Model):
    __tablename__ = 'execution_events'
    id          = db.Column(db.String, primary_key=True, default=lambda: str(uuid.uuid4()))
    strategy_id = db.Column(db.String, nullable=True)
    tx_hash     = db.Column(db.String, nullable=False, unique=True)
    billing_ref = db.Column(db.String, nullable=True)
    created_at  = db.Column(DateTime, default=datetime.utcnow, nullable=False)


class RelaySubmission(db.Model):
    """Durable pre-broadcast journal for relayed withdrawals.

    The signed raw transaction and deterministic hash are committed before broadcast, allowing an
    ambiguous timeout or process crash to be reconciled without constructing a second transaction.
    """
    __tablename__ = 'relay_submissions'
    id = db.Column(db.String(64), primary_key=True)
    request_hash = db.Column(db.String(64), nullable=False)
    wallet = db.Column(db.String(42), nullable=False)
    chain_id = db.Column(db.Integer, nullable=False)
    status = db.Column(db.String(20), nullable=False, default='preparing')
    tx_hash = db.Column(db.String(66), nullable=True, index=True)
    raw_transaction = db.Column(CompressedEncryptedText, nullable=True)
    error = db.Column(db.Text, nullable=True)
    created_at = db.Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at = db.Column(
        DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False
    )


class BridgeOrder(db.Model):
    """Withdraw-to-any-chain: one relayed vault payout and the LI.FI hop that forwards it.

    The payout's payee is the executor, so between the spend landing and the bridge leaving these
    funds sit in the executor wallet. This row is the only record of whose they are: it is written
    BEFORE the spend is broadcast, and every later tx hash (spend, bridge, refund) is stored before
    its own broadcast, so a crash at any point leaves enough to finish or refund without guessing.

    Amounts are strings (base units can exceed BIGINT). to_chain_id is a string because LI.FI's
    non-EVM ids (Solana 1151111081099710) do not fit a 32-bit column.
    """
    __tablename__ = 'bridge_orders'
    id             = db.Column(db.String, primary_key=True, default=lambda: str(uuid.uuid4()))
    wallet         = db.Column(db.String(64), nullable=True, index=True)
    # The strategy whose fired leg paid this order; NULL for a /bridgeWithdraw order.
    strategy_id    = db.Column(db.String, nullable=True, index=True)
    chain_id       = db.Column(db.Integer, nullable=False)
    token          = db.Column(db.String(42), nullable=False)
    spend_tx       = db.Column(db.String(66), nullable=True, unique=True)
    amount_in      = db.Column(db.String, nullable=True)   # what the spend actually paid the executor
    to_chain_id    = db.Column(db.String(24), nullable=False)
    to_token       = db.Column(db.String(64), nullable=False)
    to_address     = db.Column(db.Text, nullable=False)   # Zcash unified addresses run ~213 chars
    min_out        = db.Column(db.String, nullable=False)
    refund_address = db.Column(db.String(42), nullable=False)
    status         = db.Column(db.String(16), nullable=False, default='RELAYING', index=True)
    attempts       = db.Column(db.Integer, nullable=False, default=0)
    bridge_tx      = db.Column(db.String(66), nullable=True)
    sent_at        = db.Column(DateTime, nullable=True)
    tool           = db.Column(db.String(64), nullable=True)
    dest_tx        = db.Column(db.String(128), nullable=True)
    amount_out     = db.Column(db.String, nullable=True)
    refund_tx      = db.Column(db.String(66), nullable=True)
    error          = db.Column(db.Text, nullable=True)
    created_at     = db.Column(DateTime, default=datetime.utcnow, nullable=False)
    updated_at     = db.Column(DateTime, default=datetime.utcnow, onupdate=datetime.utcnow, nullable=False)

    def to_dict(self):
        return {
            'id': self.id, 'status': self.status, 'chain_id': self.chain_id, 'strategy_id': self.strategy_id,
            'spend_tx': self.spend_tx, 'amount_in': self.amount_in,
            'to_chain_id': self.to_chain_id, 'to_token': self.to_token,
            'to_address': self.to_address, 'min_out': self.min_out,
            'refund_address': self.refund_address, 'bridge_tx': self.bridge_tx,
            'tool': self.tool, 'dest_tx': self.dest_tx, 'amount_out': self.amount_out,
            'refund_tx': self.refund_tx, 'error': self.error,
            'created_at': self.created_at.isoformat() + 'Z' if self.created_at else None,
            'updated_at': self.updated_at.isoformat() + 'Z' if self.updated_at else None,
        }
