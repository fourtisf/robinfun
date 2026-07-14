// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {ERC20PermitUpgradeable} from
    "@openzeppelin/contracts-upgradeable/token/ERC20/extensions/ERC20PermitUpgradeable.sol";
import {IRobinfunToken} from "./interfaces/IRobinfun.sol";

/// @title RobinfunToken — fair-launch ERC-20 with a creator levy.
///
/// @notice Every Robinfun token is a minimal-proxy clone of this contract.
/// The full 1B supply is minted to the token's bonding curve at initialization;
/// there is no mint function afterward, no pause, no blacklist, no max-wallet
/// and no transfer gates of any kind. A holder can always transfer and always
/// sell — honeypots are structurally impossible.
///
/// @dev The creator levy is a fee-on-transfer tax that applies ONLY to trades
/// against the canonical AMM pair (set once by the bonding curve at
/// graduation):
///   - transfers FROM the pair are buys  → `buyLevyBps` is skimmed;
///   - transfers TO the pair are sells   → `sellLevyBps` is skimmed.
/// Plain wallet-to-wallet transfers are never taxed. Skimmed tokens are routed
/// to the FeeRouter, which later converts them to ETH and splits the proceeds
/// 90% creator / 10% protocol.
///
/// Pre-graduation trades happen on the bonding curve, which charges the levy
/// in ETH directly; the curve, factory and fee router are levy-exempt here so
/// curve trades and the graduation liquidity-add are not double-taxed.
///
/// Anti-rug guarantees enforced by this contract:
///   - levy rates can only ever be LOWERED, never raised;
///   - `renounceRateControl()` permanently locks the rates;
///   - the optional decay flag halves both rates at graduation;
///   - the exemption set is frozen at initialization — nobody can add to it;
///   - the AMM pair can be set exactly once, and only by the bonding curve.
contract RobinfunToken is ERC20Upgradeable, ERC20PermitUpgradeable {
    // ---------------------------------------------------------------- constants

    /// @notice Fixed total supply: 1,000,000,000 tokens (18 decimals).
    uint256 public constant TOTAL_SUPPLY = 1_000_000_000e18;

    /// @notice Hard cap on either levy: 10% (enforced again by the factory).
    uint16 public constant MAX_LEVY_BPS = 1_000;

    /// @notice Always-on protocol fee (1%) charged on post-graduation DEX
    ///         trades, on top of any creator levy — so Robinfun keeps earning
    ///         forever on every token, even ones launched with a 0/0 levy.
    ///         Matches the bonding curve's flat 1% so the protocol takes a
    ///         uniform 1% on every trade, in both phases, forever. This only
    ///         applies once the token trades on the AMM pair; the skim goes to
    ///         the FeeRouter and is 100% protocol revenue.
    uint16 public constant PROTOCOL_FEE_BPS = 100;

    uint16 private constant BPS = 10_000;

    // ---------------------------------------------------------------- state

    /// @notice Wallet that earns the creator's 90% share of the levy.
    address public creator;

    /// @notice Pending creator in a two-step creator transfer.
    address public pendingCreator;

    /// @notice The token's bonding curve (holds the supply pre-graduation).
    address public curve;

    /// @notice Protocol fee router; receives all skimmed levy tokens.
    address public feeRouter;

    /// @notice Canonical AMM pair, set once by the curve at graduation.
    address public ammPair;

    /// @notice Buy-side levy in basis points (100 = 1%).
    uint16 public buyLevyBps;

    /// @notice Sell-side levy in basis points (100 = 1%).
    uint16 public sellLevyBps;

    /// @notice If true, both levy rates halve at graduation.
    bool public decayAtGraduation;

    /// @notice If true, levy rates are permanently locked.
    bool public rateControlRenounced;

    /// @notice True once the token has graduated to the DEX.
    bool public graduated;

    /// @notice Addresses whose transfers are never levied (frozen at init).
    mapping(address => bool) public levyExempt;

    /// @notice Levy tokens skimmed to the FeeRouter that are the creator-levy
    ///         basis (their ETH proceeds split 90/10 at harvest). Zeroed when
    ///         the FeeRouter reads them via `takeLevyAccounting` at harvest.
    uint256 public levyBasisAccrued;

    /// @notice Levy tokens skimmed that are the always-on protocol fee (their
    ///         ETH proceeds are 100% protocol). Zeroed at harvest.
    uint256 public protocolBasisAccrued;

    // ---------------------------------------------------------------- events

    event LeviesLowered(uint16 buyLevyBps, uint16 sellLevyBps);
    event RateControlRenounced();
    event GraduationDecayApplied(uint16 buyLevyBps, uint16 sellLevyBps);
    event Graduated(address indexed ammPair);
    event CreatorTransferStarted(address indexed previousCreator, address indexed newCreator);
    event CreatorTransferred(address indexed previousCreator, address indexed newCreator);

    // ---------------------------------------------------------------- errors

    error NotCreator();
    error NotCurve();
    error NotFeeRouter();
    error LevyTooHigh();
    error LevyIncreaseForbidden();
    error RateControlIsRenounced();
    error AlreadyGraduated();
    error ZeroAddress();

    constructor() {
        _disableInitializers();
    }

    // ---------------------------------------------------------------- init

    /// @notice Initializes a freshly cloned token and mints the full supply
    ///         to its bonding curve. Callable exactly once, by the factory
    ///         (which enforces the 10% cap and 0.5% steps on the levies).
    function initialize(IRobinfunToken.TokenInit calldata init) external initializer {
        if (init.creator == address(0) || init.curve == address(0) || init.feeRouter == address(0)) {
            revert ZeroAddress();
        }
        if (init.buyLevyBps > MAX_LEVY_BPS || init.sellLevyBps > MAX_LEVY_BPS) revert LevyTooHigh();

        __ERC20_init(init.name, init.symbol);
        __ERC20Permit_init(init.name);

        creator = init.creator;
        curve = init.curve;
        feeRouter = init.feeRouter;
        buyLevyBps = init.buyLevyBps;
        sellLevyBps = init.sellLevyBps;
        decayAtGraduation = init.decayAtGraduation;
        rateControlRenounced = init.renounceAtCreation;

        // Frozen exemption set: curve trades, factory plumbing and fee-router
        // harvests must never be levied (they'd double-tax or tax LP adds).
        levyExempt[init.curve] = true;
        levyExempt[init.feeRouter] = true;
        levyExempt[msg.sender] = true; // factory

        _mint(init.curve, TOTAL_SUPPLY);

        if (init.renounceAtCreation) emit RateControlRenounced();
    }

    // ---------------------------------------------------------------- creator controls

    /// @notice Lowers the levy rates. Rates can NEVER be raised.
    /// @dev Reverts if rate control has been renounced.
    function lowerLevies(uint16 newBuyLevyBps, uint16 newSellLevyBps) external {
        if (msg.sender != creator) revert NotCreator();
        if (rateControlRenounced) revert RateControlIsRenounced();
        if (newBuyLevyBps > buyLevyBps || newSellLevyBps > sellLevyBps) revert LevyIncreaseForbidden();
        buyLevyBps = newBuyLevyBps;
        sellLevyBps = newSellLevyBps;
        emit LeviesLowered(newBuyLevyBps, newSellLevyBps);
    }

    /// @notice Permanently locks the levy rates at their current values.
    function renounceRateControl() external {
        if (msg.sender != creator) revert NotCreator();
        if (rateControlRenounced) revert RateControlIsRenounced();
        rateControlRenounced = true;
        emit RateControlRenounced();
    }

    /// @notice Starts a two-step transfer of the creator role (levy recipient).
    /// @dev The levy destination is money — two-step avoids fat-finger loss.
    function transferCreator(address newCreator) external {
        if (msg.sender != creator) revert NotCreator();
        if (newCreator == address(0)) revert ZeroAddress();
        pendingCreator = newCreator;
        emit CreatorTransferStarted(creator, newCreator);
    }

    /// @notice Completes the creator transfer. Caller must be the pending creator.
    function acceptCreator() external {
        if (msg.sender != pendingCreator) revert NotCreator();
        emit CreatorTransferred(creator, msg.sender);
        creator = msg.sender;
        pendingCreator = address(0);
    }

    // ---------------------------------------------------------------- curve hook

    /// @notice Called by the bonding curve exactly once, at graduation.
    ///         Registers the canonical AMM pair and applies the optional decay.
    function onGraduation(address pair) external {
        if (msg.sender != curve) revert NotCurve();
        if (graduated) revert AlreadyGraduated();
        if (pair == address(0)) revert ZeroAddress();

        graduated = true;
        ammPair = pair;

        if (decayAtGraduation) {
            buyLevyBps /= 2;
            sellLevyBps /= 2;
            emit GraduationDecayApplied(buyLevyBps, sellLevyBps);
        }
        emit Graduated(pair);
    }

    /// @notice Returns and zeroes the accrued levy composition. Only the
    ///         FeeRouter calls this, at harvest, to split proceeds exactly.
    function takeLevyAccounting() external returns (uint256 levyBasis, uint256 protocolBasis) {
        if (msg.sender != feeRouter) revert NotFeeRouter();
        levyBasis = levyBasisAccrued;
        protocolBasis = protocolBasisAccrued;
        levyBasisAccrued = 0;
        protocolBasisAccrued = 0;
    }

    // ---------------------------------------------------------------- fee-on-transfer

    /// @dev Applies the levy on trades against the canonical AMM pair.
    ///      Mints/burns and exempt parties bypass the levy entirely. The levy
    ///      is skimmed to the FeeRouter inside the same transfer, so wallets
    ///      never need a separate approval and no external calls are made.
    function _update(address from, address to, uint256 value) internal override {
        // Mints (from == 0) and burns (to == 0) are never taxed.
        if (from != address(0) && to != address(0) && !levyExempt[from] && !levyExempt[to]) {
            address pair = ammPair;
            if (pair != address(0) && (from == pair || to == pair)) {
                // Post-graduation DEX trade: this side's creator levy plus the
                // always-on 0.5% protocol fee (so 0/0 tokens still pay Robinfun).
                // Both skim to the FeeRouter, which splits after harvest.
                uint256 rate = from == pair ? buyLevyBps : sellLevyBps;
                uint256 levyComp = (value * rate) / BPS; // creator-levy basis (90/10 at harvest)
                uint256 protoComp = (value * PROTOCOL_FEE_BPS) / BPS; // protocol fee (100% protocol)
                uint256 fee = levyComp + protoComp;
                if (fee != 0) {
                    super._update(from, feeRouter, fee);
                    // Record the exact composition so the FeeRouter splits the
                    // harvested ETH by true basis, not an average-rate guess.
                    levyBasisAccrued += levyComp;
                    protocolBasisAccrued += protoComp;
                    unchecked {
                        value -= fee;
                    }
                }
            }
        }
        super._update(from, to, value);
    }
}
