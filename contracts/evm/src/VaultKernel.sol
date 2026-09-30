// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IVaultKernel} from "./interfaces/IVaultKernel.sol";
import {IVerifierRegistry} from "./interfaces/IVerifierRegistry.sol";
import {IComplianceHub} from "./interfaces/IComplianceHub.sol";
import {IAssetAdapter} from "./interfaces/IAssetAdapter.sol";
import {ISettlementAdapter} from "./interfaces/ISettlementAdapter.sol";
import {IPayeeCodec} from "./interfaces/IPayeeCodec.sol";
import {IHasher2} from "./interfaces/IHasher2.sol";
import {PublicInputs} from "./libraries/PublicInputs.sol";
import {CommitmentLib} from "./libraries/CommitmentLib.sol";
import {SimpleErc20} from "./tokens/SimpleErc20.sol";
import {NoteTree} from "./NoteTree.sol";
import {NullifierSet} from "./NullifierSet.sol";

/// @title VaultKernel
/// @notice Proof-first spend entry — PROTOCOL v3.5.0 §8 / D1 (multi-token).
contract VaultKernel is IVaultKernel {
    uint256 public constant PUBLIC_WIDTH = 25;

    uint256 public immutable override programVersion;
    address public immutable governance;

    IVerifierRegistry public immutable registry;
    IComplianceHub public immutable hub;
    IAssetAdapter public immutable assets;
    IPayeeCodec public immutable payees;
    IHasher2 public immutable hasher;
    ISettlementAdapter public immutable settlement;

    NoteTree public immutable notes;
    NullifierSet public immutable nullifiers;

    uint256 public immutable chainId;
    uint256 public immutable override vaultScopeId;
    uint256 public depositNonce;
    bool public override depositsPaused;
    bool public historicalSeedingLocked;
    /// @dev GF-M2 kill switch — bit `action` set ⇒ that spend action is paused.
    uint256 public actionPausedBitmap;
    uint256 private constant ALL_ACTIONS_MASK = 31; // actions 0–4

    mapping(address => bool) public allowedToken;

    /// @dev PROTOCOL surplus: SWAP accrues `protocolClaimable`; gov mints notes via queue (OVERLORD F-2).
    /// @dev OVERLORD F-1: each minted note consumes one unique pre; duplicates rejected via `_protocolPreSeen`.
    uint256 public protocolLabel;
    uint256 private _protocolPreHead;
    uint256 private _protocolPreTail;
    mapping(uint256 => uint256) private _protocolPres;
    mapping(uint256 => bool) private _protocolPreSeen;
    mapping(address => uint256) public protocolClaimable;

    bool private _locked;

    error Reentrancy();
    error ProofFailed();
    error UnknownStateRoot();
    error StaleAdmittedRoot();
    error StaleRevokedRoot();
    error PayeeMismatch();
    error BadRawPayee();
    error ZeroPayee();
    error SplitRootMismatch();
    error NotGovernance();
    error ZeroDepositAmount();
    error ZeroUserSalt();
    error ZeroAddress();
    error DepositsArePaused();
    error ActionPaused(uint256 action);
    error BadAction();
    error SeedingLocked();
    error SettlementNotSet();
    error SwapMinOutZero();
    error SwapDestZero();
    error SwapSlippage();
    error TokenNotAllowed();
    error BadAssetId();
    error SwapPayeeMustBeZero();
    error ProtocolNoteNotConfigured();
    error ProtocolPreExhausted();
    error ProtocolPreDuplicate();
    error ProtocolClaimableInsufficient();
    error SwapSameAsset();
    error SwapAmountInZero();
    error SwapBadFee();
    error ZeroPrimaryValue();

    event Spent(uint256 indexed action, uint256 inputCount, uint256 stateRootAfter);
    event HistoricalRootSeeded(uint256 root);
    event DepositsPausedSet(bool paused);
    event ActionPausedSet(uint256 indexed action, bool paused);
    event AllActionsPausedSet(bool paused);
    event TokenAllowedSet(address indexed token, bool allowed);
    event ProtocolNoteConfigSet(uint256 protocolLabel, uint256 protocolPrecommitment);
    event ProtocolNotePresEnqueued(uint256 count, uint256 remaining);
    /// @dev OVERLORD F-2: depositor is NOT indexed (PROTOCOL §2.7 — no depositor topic).
    event Deposited(
        address depositor,
        address indexed token,
        uint256 amount,
        uint256 commitment,
        uint256 depositNonce,
        uint256 stateRootAfter
    );
    /// @dev SWAP surplus accrued (not yet a note) — OVERLORD F-2 queue-grief fix.
    event ProtocolSurplusAccrued(address indexed token, uint256 amount, uint256 claimableAfter);
    /// @dev Gov-minted protocol surplus note (OVERLORD F-5: includes queueIndex).
    event ProtocolSurplusNote(
        address indexed token,
        uint256 amount,
        uint256 commitment,
        uint256 stateRootAfter,
        uint256 queueIndex
    );
    /// @dev User dest note inserted at minOut (indexer solvency + UI).
    event SwapUserDestNote(address indexed token, uint256 amount, uint256 commitment);
    /// @dev WITHDRAW / RAGEQUIT token out (indexer solvency).
    event AssetsUnshielded(address indexed token, uint256 amount, uint256 indexed action);
    /// @dev SWAP src consumed from note liabilities (indexer solvency).
    event SwapSrcConsumed(address indexed token, uint256 amountIn);

    modifier nonReentrant() {
        if (_locked) revert Reentrancy();
        _locked = true;
        _;
        _locked = false;
    }

    constructor(
        uint256 programVersion_,
        address governance_,
        IVerifierRegistry registry_,
        IComplianceHub hub_,
        IAssetAdapter assets_,
        IPayeeCodec payees_,
        IHasher2 hasher_,
        ISettlementAdapter settlement_
    ) {
        if (governance_ == address(0)) revert ZeroAddress();
        if (address(registry_) == address(0)) revert ZeroAddress();
        if (address(hub_) == address(0)) revert ZeroAddress();
        if (address(assets_) == address(0)) revert ZeroAddress();
        if (address(payees_) == address(0)) revert ZeroAddress();
        if (address(hasher_) == address(0)) revert ZeroAddress();
        programVersion = programVersion_;
        governance = governance_;
        chainId = block.chainid;
        registry = registry_;
        hub = hub_;
        assets = assets_;
        payees = payees_;
        hasher = hasher_;
        settlement = settlement_;
        notes = new NoteTree(hasher_, address(this));
        nullifiers = new NullifierSet(address(this));
        vaultScopeId = CommitmentLib.vaultScopeIdEvm(
            block.chainid, uint256(uint160(address(this)))
        );
    }

    function stateRoot() external view override returns (uint256) {
        return notes.currentRoot();
    }

    function isTokenAllowed(address token) external view override returns (bool) {
        return allowedToken[token];
    }

    function setDepositsPaused(bool paused) external {
        if (msg.sender != governance) revert NotGovernance();
        depositsPaused = paused;
        emit DepositsPausedSet(paused);
    }

    function setTokenAllowed(address token, bool allowed) external {
        if (msg.sender != governance) revert NotGovernance();
        if (token == address(0)) revert ZeroAddress();
        allowedToken[token] = allowed;
        emit TokenAllowedSet(token, allowed);
    }

    /// @notice Set protocol surplus label and enqueue one unique note precommitment.
    /// @dev OVERLORD F-1: do not reuse a single pre — each mint needs its own (nf, secret) pre.
    function setProtocolNoteConfig(uint256 label_, uint256 precommitment_) external {
        if (msg.sender != governance) revert NotGovernance();
        if (label_ == 0 || precommitment_ == 0) revert ProtocolNoteNotConfigured();
        protocolLabel = label_;
        _enqueueProtocolPre(precommitment_);
        emit ProtocolNoteConfigSet(label_, precommitment_);
    }

    /// @notice Enqueue additional unique surplus precommitments (one consumed per gov mint).
    function enqueueProtocolNotePres(uint256[] calldata pres) external {
        if (msg.sender != governance) revert NotGovernance();
        if (protocolLabel == 0) revert ProtocolNoteNotConfigured();
        uint256 n = pres.length;
        for (uint256 i = 0; i < n; i++) {
            if (pres[i] == 0) revert ProtocolNoteNotConfigured();
            _enqueueProtocolPre(pres[i]);
        }
        emit ProtocolNotePresEnqueued(n, protocolPresRemaining());
    }

    /// @notice Remaining surplus precommitments available for `mintProtocolSurplusNote`.
    function protocolPresRemaining() public view returns (uint256) {
        return _protocolPreTail - _protocolPreHead;
    }

    /// @notice Mint a protocol-owned note from accrued SWAP surplus (OVERLORD F-2: not on swap path).
    function mintProtocolSurplusNote(address token, uint256 amount)
        external
        nonReentrant
        returns (uint256 commitment, uint256 queueIndex)
    {
        if (msg.sender != governance) revert NotGovernance();
        if (token == address(0)) revert ZeroAddress();
        if (amount == 0) revert ZeroDepositAmount();
        if (protocolLabel == 0) revert ProtocolNoteNotConfigured();
        if (!allowedToken[token]) revert TokenNotAllowed();
        uint256 claimable = protocolClaimable[token];
        if (claimable < amount) revert ProtocolClaimableInsufficient();
        unchecked {
            protocolClaimable[token] = claimable - amount;
        }
        queueIndex = _protocolPreHead;
        uint256 childPre = _consumeProtocolPre();
        uint256 assetId = CommitmentLib.assetIdFromToken(token);
        commitment = CommitmentLib.commitmentHash(amount, protocolLabel, assetId, childPre);
        notes.insert(commitment);
        emit ProtocolSurplusNote(token, amount, commitment, notes.currentRoot(), queueIndex);
    }

    function _enqueueProtocolPre(uint256 pre) private {
        // OVERLORD F-1: reject duplicate / reused openings (shared nullifier class).
        if (_protocolPreSeen[pre]) revert ProtocolPreDuplicate();
        _protocolPreSeen[pre] = true;
        _protocolPres[_protocolPreTail] = pre;
        unchecked {
            _protocolPreTail += 1;
        }
    }

    function _consumeProtocolPre() private returns (uint256 pre) {
        if (_protocolPreHead >= _protocolPreTail) revert ProtocolPreExhausted();
        pre = _protocolPres[_protocolPreHead];
        delete _protocolPres[_protocolPreHead];
        unchecked {
            _protocolPreHead += 1;
        }
    }

    /// @notice ERC-20 allowance so adapters can move vault custody (governance bootstrap).
    function approveAssetOutbound(address erc20, address spender, uint256 amount) external {
        if (msg.sender != governance) revert NotGovernance();
        require(SimpleErc20(erc20).approve(spender, amount), "approve");
    }

    /// @inheritdoc IVaultKernel
    function actionPaused(uint256 action) external view override returns (bool) {
        return (actionPausedBitmap >> action) & 1 == 1;
    }

    /// @notice GF-M2: governance kill switch per spend action (0–4).
    function setActionPaused(uint256 action, bool paused) external {
        if (msg.sender != governance) revert NotGovernance();
        if (action > PublicInputs.ACTION_RAGEQUIT) revert BadAction();
        if (paused) {
            actionPausedBitmap |= (1 << action);
        } else {
            actionPausedBitmap &= ~(1 << action);
        }
        emit ActionPausedSet(action, paused);
    }

    /// @notice GF-M2 / OMEGA F-6: pause or unpause all spend actions (0–4) in one tx.
    function setAllActionsPaused(bool paused) external {
        if (msg.sender != governance) revert NotGovernance();
        actionPausedBitmap = paused ? ALL_ACTIONS_MASK : 0;
        emit AllActionsPausedSet(paused);
    }

    /// @dev Seed a fixture / migrated state root into the known-root set (governance).
    function seedHistoricalRoot(uint256 root) external {
        if (msg.sender != governance) revert NotGovernance();
        if (historicalSeedingLocked || notes.leafCount() != 0) revert SeedingLocked();
        notes.recognizeRoot(root);
        historicalSeedingLocked = true;
        emit HistoricalRootSeeded(root);
    }

    /// @inheritdoc IVaultKernel
    function deposit(address token, uint256 amount, uint256 userSalt, uint256 precommitment)
        external
        override
        nonReentrant
        returns (uint256 noteCommitment)
    {
        if (depositsPaused) revert DepositsArePaused();
        if (amount == 0) revert ZeroDepositAmount();
        if (userSalt == 0) revert ZeroUserSalt();
        if (token == address(0)) revert ZeroAddress();
        if (!allowedToken[token]) revert TokenNotAllowed();

        uint256 received = assets.pull(token, msg.sender, amount);
        if (received == 0) revert ZeroDepositAmount();

        unchecked {
            depositNonce += 1;
        }
        uint256 label =
            CommitmentLib.mintLabelSalted(vaultScopeId, depositNonce, userSalt);
        uint256 assetId = CommitmentLib.assetIdFromToken(token);
        noteCommitment = CommitmentLib.commitmentHash(received, label, assetId, precommitment);
        notes.insert(noteCommitment);

        emit Deposited(
            msg.sender, token, received, noteCommitment, depositNonce, notes.currentRoot()
        );
    }

    function spend(
        uint256[PUBLIC_WIDTH] calldata publicInputs,
        uint256[8] calldata proof,
        SpendExtra calldata extra
    ) external override nonReentrant {
        uint256 action = PublicInputs.action(publicInputs);
        if ((actionPausedBitmap >> action) & 1 == 1) {
            revert ActionPaused(action);
        }

        PublicInputs.checkKernelPre(publicInputs, programVersion);

        if (!registry.verifySpend(programVersion, publicInputs, proof)) {
            revert ProofFailed();
        }

        if (!notes.rootExists(PublicInputs.stateRoot(publicInputs))) {
            revert UnknownStateRoot();
        }

        _checkCompliance(publicInputs, action);
        _burnNullifiers(publicInputs);

        if (action == PublicInputs.ACTION_WITHDRAW) {
            _finalizeWithdraw(publicInputs, extra);
        } else if (action == PublicInputs.ACTION_MERGE) {
            _finalizeMerge(publicInputs);
        } else if (action == PublicInputs.ACTION_SWAP) {
            _finalizeSwap(publicInputs, extra);
        } else if (action == PublicInputs.ACTION_SPLIT) {
            _finalizeSplit(publicInputs, extra);
        } else if (action == PublicInputs.ACTION_RAGEQUIT) {
            _finalizeRagequit(publicInputs, extra);
        }

        emit Spent(action, PublicInputs.inputCount(publicInputs), notes.currentRoot());
    }

    function _checkCompliance(uint256[PUBLIC_WIDTH] calldata pi, uint256 action) internal view {
        if (!hub.admittedRootIsCurrent(PublicInputs.admittedRoot(pi))) {
            revert StaleAdmittedRoot();
        }
        if (!hub.revokedRootIsCurrent(PublicInputs.revokedRoot(pi))) {
            revert StaleRevokedRoot();
        }
        if (action == PublicInputs.ACTION_RAGEQUIT) {
            if (PublicInputs.payeeId(pi) != 0) {
                revert PayeeMismatch();
            }
        }
    }

    function _burnNullifiers(uint256[PUBLIC_WIDTH] calldata pi) internal {
        uint256 n = PublicInputs.inputCount(pi);
        for (uint256 i = 0; i < n; i++) {
            nullifiers.burn(pi[9 + i]);
        }
    }

    function _requireAllowedAsset(uint256 assetId) internal view returns (address token) {
        if (assetId == 0 || assetId > type(uint160).max) revert BadAssetId();
        token = CommitmentLib.tokenFromAssetId(assetId);
        if (!allowedToken[token]) revert TokenNotAllowed();
    }

    function _finalizeWithdraw(uint256[PUBLIC_WIDTH] calldata pi, SpendExtra calldata extra)
        internal
    {
        address to = _requirePayee(extra.rawPayee, PublicInputs.payeeId(pi));
        address token = _requireAllowedAsset(pi[17]);
        uint256 amt = PublicInputs.primaryValue(pi);
        // OVERLORD F-4: fail-closed zero payout.
        if (amt == 0) revert ZeroPrimaryValue();
        assets.push(token, to, amt);
        emit AssetsUnshielded(token, amt, PublicInputs.ACTION_WITHDRAW);
        _maybeInsertChange(pi);
    }

    function _finalizeMerge(uint256[PUBLIC_WIDTH] calldata pi) internal {
        uint256 c = PublicInputs.outCommitment(pi);
        require(c != 0, "merge-out");
        notes.insert(c);
    }

    function _finalizeSwap(uint256[PUBLIC_WIDTH] calldata pi, SpendExtra calldata /* extra */)
        internal
    {
        if (address(settlement) == address(0)) revert SettlementNotSet();
        uint256 minOut = pi[20];
        if (minOut == 0) revert SwapMinOutZero();
        uint256 dest = pi[22];
        if (dest == 0) revert SwapDestZero();
        // OVERLORD F-1 (D1 payee): D1 pool SWAP — public[15] MUST be 0 (align with zk-v2).
        if (PublicInputs.payeeId(pi) != 0) revert SwapPayeeMustBeZero();
        address srcToken = _requireAllowedAsset(pi[23]);
        address dstToken = _requireAllowedAsset(pi[18]);
        // OVERLORD F-2 (same-asset): same-asset swap can inflate note liabilities with zero net custody.
        if (srcToken == dstToken) revert SwapSameAsset();
        uint256 amountIn = PublicInputs.primaryValue(pi);
        // OVERLORD F-4 (swap amount): defense-in-depth (Circom also rejects primary==0).
        if (amountIn == 0) revert SwapAmountInZero();
        uint256 fee = pi[19];
        // OVERLORD F-3: Uniswap V3 fee is uint24 (align with zk-v2 Num2Bits(24) / adapter BadFee).
        if (fee == 0 || fee > type(uint24).max) revert SwapBadFee();
        uint256 measured = settlement.fill(
            pi[17], srcToken, dstToken, fee, amountIn, minOut
        );
        if (measured < minOut) revert SwapSlippage();
        emit SwapSrcConsumed(srcToken, amountIn);
        _maybeInsertChange(pi);
        notes.insert(dest);
        emit SwapUserDestNote(dstToken, minOut, dest);

        // OVERLORD F-2: accrue surplus — do not consume protocol pre queue on the permissionless path.
        uint256 surplus = measured - minOut;
        if (surplus > 0) {
            uint256 claimableAfter = protocolClaimable[dstToken] + surplus;
            protocolClaimable[dstToken] = claimableAfter;
            emit ProtocolSurplusAccrued(dstToken, surplus, claimableAfter);
        }
    }

    function _finalizeSplit(uint256[PUBLIC_WIDTH] calldata pi, SpendExtra calldata extra)
        internal
    {
        require(PublicInputs.outCommitment(pi) == 0, "split-out");
        uint256 root = _merkleRoot8(extra.splitCommitments);
        if (root != pi[17]) revert SplitRootMismatch();
        for (uint256 i = 0; i < 8; i++) {
            uint256 c = extra.splitCommitments[i];
            if (c != 0) {
                notes.insert(c);
            }
        }
    }

    function _finalizeRagequit(uint256[PUBLIC_WIDTH] calldata pi, SpendExtra calldata extra)
        internal
    {
        require(PublicInputs.outCommitment(pi) != 0, "rq-c");
        address to = _requirePayee(extra.rawPayee, pi[17]);
        address token = _requireAllowedAsset(pi[18]);
        uint256 amt = PublicInputs.primaryValue(pi);
        // OVERLORD F-4: fail-closed zero payout.
        if (amt == 0) revert ZeroPrimaryValue();
        assets.push(token, to, amt);
        emit AssetsUnshielded(token, amt, PublicInputs.ACTION_RAGEQUIT);
    }

    function _maybeInsertChange(uint256[PUBLIC_WIDTH] calldata pi) internal {
        if (PublicInputs.secondaryValue(pi) == 0) {
            require(PublicInputs.outCommitment(pi) == 0, "change");
            return;
        }
        uint256 c = PublicInputs.outCommitment(pi);
        require(c != 0, "change-c");
        notes.insert(c);
    }

    function _requirePayee(bytes calldata rawPayee, uint256 expectedId)
        internal
        view
        returns (address to)
    {
        if (rawPayee.length != 20) revert BadRawPayee();
        to = address(bytes20(rawPayee));
        if (to == address(0)) revert ZeroPayee();
        if (payees.payeeId(rawPayee) != expectedId) revert PayeeMismatch();
    }

    function _merkleRoot8(uint256[8] memory leaves) internal view returns (uint256) {
        uint256[4] memory l1;
        for (uint256 i = 0; i < 4; i++) {
            l1[i] = hasher.hash2(leaves[2 * i], leaves[2 * i + 1]);
        }
        uint256[2] memory l2;
        l2[0] = hasher.hash2(l1[0], l1[1]);
        l2[1] = hasher.hash2(l1[2], l1[3]);
        return hasher.hash2(l2[0], l2[1]);
    }
}
