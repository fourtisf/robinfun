// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IRobinfunToken, IFeeRouter, IBondingCurve} from "./interfaces/IRobinfun.sol";
import {IUniswapV2Factory, IUniswapV2Pair, IWETH} from "./interfaces/IUniswapV2.sol";

/// @title BondingCurve — deterministic fair-launch market for one Robinfun token.
///
/// @notice Each token gets its own minimal-proxy clone of this contract. The
/// curve holds the token's entire 1B supply at birth and prices trades with a
/// virtual-reserve constant product (the pump.fun model):
///
///     (virtualEth + Δeth) * (virtualToken - Δtoken) = k
///
/// Buys push the price up deterministically, sells push it down. The virtual
/// token reserve is strictly larger than the real supply, which guarantees the
/// curve can ALWAYS pay out every sell (see `_quoteSellGross` notes) — there is
/// no path where a holder cannot exit.
///
/// Fees on every curve trade, both charged in ETH on the gross amount:
///   - a flat 1% curve fee → protocol (via the FeeRouter);
///   - the creator levy (token's current buy/sell rate) → 90% creator /
///     10% protocol, split by the FeeRouter.
///
/// When `graduationEth` of real ETH has been collected, the final buy is
/// capped to land exactly on the target (excess refunded) and `_graduate()`
/// runs atomically in the same transaction:
///   1. the token is told its canonical AMM pair (levy decay applies here);
///   2. all collected ETH + tokens matching the graduation spot price are
///      deposited into a Uniswap-v2 pair whose LP is minted straight to the
///      dead address — 100% of liquidity is burned, the pool can never be
///      pulled;
///   3. leftover curve tokens are burned to the dead address;
///   4. curve trading is permanently closed.
///
/// No admin functions, no upgrade hooks, no pause: once initialized, the only
/// state transitions are trades and the one-way graduation.
/// @dev Uses the plain (non-upgradeable) ReentrancyGuard: in a minimal-proxy
///      clone its storage starts at 0, which the OZ v5 guard treats as
///      NOT_ENTERED — the constructor write is only a gas optimization.
contract BondingCurve is Initializable, ReentrancyGuard, IBondingCurve {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    /// @notice Flat protocol fee on every curve trade: 1% of gross ETH.
    uint16 public constant CURVE_FEE_BPS = 100;

    uint16 private constant BPS = 10_000;

    /// @notice LP tokens and leftover inventory are burned here.
    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;

    // ---------------------------------------------------------------- state

    /// @notice The token this curve trades.
    IRobinfunToken public token;

    /// @notice Protocol fee router (receives curve fees + levies).
    IFeeRouter public feeRouter;

    /// @notice Uniswap-v2 style factory used at graduation.
    IUniswapV2Factory public dexFactory;

    /// @notice Wrapped native token used as the pair's quote asset.
    IWETH public weth;

    /// @notice Immutable-per-token curve parameters, frozen at initialization.
    CurveParams public params;

    /// @notice Current virtual ETH reserve (starts at `params.virtualEth`).
    uint256 public virtualEthReserve;

    /// @notice Current virtual token reserve (starts at `params.virtualToken`).
    uint256 public virtualTokenReserve;

    /// @notice Real ETH held for the curve (== virtualEthReserve - params.virtualEth).
    /// @dev Tracked explicitly so force-sent ETH cannot poison accounting.
    uint256 public reserveEth;

    /// @notice True once the token has graduated; trading is then closed forever.
    bool public graduated;

    // ---------------------------------------------------------------- events

    /// @dev `virtualEthReserve`/`virtualTokenReserve` after the trade let the
    ///      indexer reconstruct price and market cap without extra calls.
    event Buy(
        address indexed trader,
        address indexed recipient,
        uint256 grossEth,
        uint256 curveFeeEth,
        uint256 levyEth,
        uint256 netEth,
        uint256 tokensOut,
        uint256 virtualEthReserve,
        uint256 virtualTokenReserve
    );
    event Sell(
        address indexed trader,
        uint256 tokensIn,
        uint256 grossEth,
        uint256 curveFeeEth,
        uint256 levyEth,
        uint256 netEth,
        uint256 virtualEthReserve,
        uint256 virtualTokenReserve
    );
    event Graduated(
        address indexed token, address indexed pair, uint256 ethToLp, uint256 tokensToLp, uint256 tokensBurned
    );

    // ---------------------------------------------------------------- errors

    error AlreadyGraduatedErr();
    error DeadlineExpired();
    error ZeroAmount();
    error ZeroAddress();
    error SlippageExceeded();
    error EthTransferFailed();

    constructor() {
        _disableInitializers();
    }

    // ---------------------------------------------------------------- init

    /// @notice Initializes a freshly cloned curve. Callable exactly once, by
    ///         the factory, which validates `params_` before deploying.
    function initialize(
        address token_,
        address feeRouter_,
        address dexFactory_,
        address weth_,
        CurveParams calldata params_
    ) external initializer {
        if (token_ == address(0) || feeRouter_ == address(0) || dexFactory_ == address(0) || weth_ == address(0)) {
            revert ZeroAddress();
        }
        token = IRobinfunToken(token_);
        feeRouter = IFeeRouter(feeRouter_);
        dexFactory = IUniswapV2Factory(dexFactory_);
        weth = IWETH(weth_);
        params = params_;
        virtualEthReserve = params_.virtualEth;
        virtualTokenReserve = params_.virtualToken;
    }

    // ---------------------------------------------------------------- trading

    /// @notice Buys tokens with ETH for `msg.sender`.
    function buy(uint256 minTokensOut, uint256 deadline) external payable returns (uint256 tokensOut) {
        return buyFor(msg.sender, minTokensOut, deadline);
    }

    /// @notice Buys tokens with ETH for `recipient`. Used directly by the
    ///         factory for the atomic creator dev-buy.
    /// @dev The buy that crosses the graduation target is capped so the curve
    ///      collects exactly `params.graduationEth`; surplus ETH is refunded.
    ///      Graduation then runs inside the same transaction.
    /// @param recipient    Receiver of the tokens.
    /// @param minTokensOut Slippage floor on tokens received.
    /// @param deadline     Unix timestamp after which the trade reverts.
    function buyFor(address recipient, uint256 minTokensOut, uint256 deadline)
        public
        payable
        nonReentrant
        returns (uint256 tokensOut)
    {
        if (graduated) revert AlreadyGraduatedErr();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (msg.value == 0) revert ZeroAmount();
        if (recipient == address(0)) revert ZeroAddress();

        uint16 levyBps = token.buyLevyBps();
        (uint256 gross, uint256 fee, uint256 levy, uint256 net, uint256 refund) =
            _splitBuy(msg.value, levyBps, params.graduationEth - reserveEth);

        tokensOut = (virtualTokenReserve * net) / (virtualEthReserve + net);
        if (tokensOut == 0) revert ZeroAmount();
        if (tokensOut < minTokensOut) revert SlippageExceeded();

        // Effects.
        virtualEthReserve += net;
        virtualTokenReserve -= tokensOut;
        reserveEth += net;

        emit Buy(msg.sender, recipient, gross, fee, levy, net, tokensOut, virtualEthReserve, virtualTokenReserve);

        // Interactions. The fee router is a trusted protocol contract; the
        // token transfer is our own non-reentrant ERC-20 (curve is levy-exempt).
        if (fee != 0) feeRouter.collectCurveFee{value: fee}(address(token));
        if (levy != 0) feeRouter.collectLevy{value: levy}(address(token));
        IERC20(address(token)).safeTransfer(recipient, tokensOut);

        if (reserveEth >= params.graduationEth) _graduate();

        if (refund != 0) {
            (bool ok,) = msg.sender.call{value: refund}("");
            if (!ok) revert EthTransferFailed();
        }
    }

    /// @notice Sells tokens back to the curve for ETH.
    /// @dev Caller must have approved the curve (or use `sellWithPermit`).
    /// @param tokensIn  Tokens to sell.
    /// @param minEthOut Slippage floor on net ETH received.
    /// @param deadline  Unix timestamp after which the trade reverts.
    function sell(uint256 tokensIn, uint256 minEthOut, uint256 deadline)
        public
        nonReentrant
        returns (uint256 ethOut)
    {
        if (graduated) revert AlreadyGraduatedErr();
        if (block.timestamp > deadline) revert DeadlineExpired();
        if (tokensIn == 0) revert ZeroAmount();

        uint256 gross = (virtualEthReserve * tokensIn) / (virtualTokenReserve + tokensIn);
        if (gross == 0) revert ZeroAmount();

        uint16 levyBps = token.sellLevyBps();
        uint256 fee = (gross * CURVE_FEE_BPS) / BPS;
        uint256 levy = (gross * levyBps) / BPS;
        ethOut = gross - fee - levy;
        if (ethOut < minEthOut) revert SlippageExceeded();

        // Effects. `gross <= reserveEth` always holds: the virtual token
        // buffer means x*y >= k keeps virtualEthReserve >= params.virtualEth
        // for any tokensIn up to the full circulating supply.
        virtualEthReserve -= gross;
        virtualTokenReserve += tokensIn;
        reserveEth -= gross;

        emit Sell(msg.sender, tokensIn, gross, fee, levy, ethOut, virtualEthReserve, virtualTokenReserve);

        // Interactions.
        IERC20(address(token)).safeTransferFrom(msg.sender, address(this), tokensIn);
        if (fee != 0) feeRouter.collectCurveFee{value: fee}(address(token));
        if (levy != 0) feeRouter.collectLevy{value: levy}(address(token));
        (bool ok,) = msg.sender.call{value: ethOut}("");
        if (!ok) revert EthTransferFailed();
    }

    /// @notice `sell` with an EIP-2612 permit so no separate approval tx is needed.
    function sellWithPermit(
        uint256 tokensIn,
        uint256 minEthOut,
        uint256 deadline,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external returns (uint256 ethOut) {
        // A front-run of the permit must not brick the sell (griefing vector),
        // so a failed permit is ignored — transferFrom then settles allowance.
        try IERC20Permit(address(token)).permit(msg.sender, address(this), tokensIn, deadline, v, r, s) {} catch {}
        return sell(tokensIn, minEthOut, deadline);
    }

    // ---------------------------------------------------------------- views

    /// @notice Current spot price in ETH-wei per whole token (1e18 units).
    function currentPrice() external view returns (uint256) {
        return (virtualEthReserve * 1e18) / virtualTokenReserve;
    }

    /// @notice Market cap in ETH-wei at the current spot price (USD conversion
    ///         is a frontend concern — brief §4).
    function marketCapEth() external view returns (uint256) {
        return (virtualEthReserve * token.totalSupply()) / virtualTokenReserve;
    }

    /// @notice Progress toward graduation: (collected, target).
    function graduationProgress() external view returns (uint256 collected, uint256 target) {
        return (reserveEth, params.graduationEth);
    }

    /// @notice Quotes a buy of `ethIn` gross ETH, mirroring `buyFor` exactly
    ///         (including the graduation cap + refund).
    function quoteBuy(uint256 ethIn)
        external
        view
        returns (uint256 fee, uint256 levy, uint256 net, uint256 tokensOut, uint256 refund)
    {
        if (graduated || ethIn == 0) return (0, 0, 0, 0, ethIn);
        uint256 gross;
        (gross, fee, levy, net, refund) = _splitBuy(ethIn, token.buyLevyBps(), params.graduationEth - reserveEth);
        tokensOut = (virtualTokenReserve * net) / (virtualEthReserve + net);
    }

    /// @notice Quotes a sell of `tokensIn`, mirroring `sell` exactly.
    function quoteSell(uint256 tokensIn)
        external
        view
        returns (uint256 gross, uint256 fee, uint256 levy, uint256 net)
    {
        if (graduated || tokensIn == 0) return (0, 0, 0, 0);
        gross = (virtualEthReserve * tokensIn) / (virtualTokenReserve + tokensIn);
        fee = (gross * CURVE_FEE_BPS) / BPS;
        levy = (gross * token.sellLevyBps()) / BPS;
        net = gross - fee - levy;
    }

    // ---------------------------------------------------------------- internals

    /// @dev Splits a gross buy into (fee, levy, net) and caps the net amount at
    ///      `room`, the ETH still needed to graduate. When capping, the gross
    ///      is recomputed with ceiling division so `net` lands EXACTLY on
    ///      `room` (any 1-wei rounding excess is refunded), guaranteeing the
    ///      graduation trigger fires.
    function _splitBuy(uint256 amount, uint16 levyBps, uint256 room)
        private
        pure
        returns (uint256 gross, uint256 fee, uint256 levy, uint256 net, uint256 refund)
    {
        uint256 cutBps = uint256(CURVE_FEE_BPS) + levyBps;
        gross = amount;
        fee = (gross * CURVE_FEE_BPS) / BPS;
        levy = (gross * levyBps) / BPS;
        net = gross - fee - levy;

        if (net > room) {
            gross = Math.ceilDiv(room * BPS, BPS - cutBps);
            fee = (gross * CURVE_FEE_BPS) / BPS;
            levy = (gross * levyBps) / BPS;
            net = gross - fee - levy;
            refund = amount - gross;
            if (net > room) {
                // ceil rounding overshoot is at most a few wei — refund it.
                refund += net - room;
                net = room;
            }
        }
    }

    /// @dev One-way graduation. Runs inside the buy that hits the target:
    ///      registers the pair on the token, deposits all collected ETH plus
    ///      price-matched tokens as liquidity, mints the LP directly to the
    ///      dead address (100% burn) and burns leftover curve inventory.
    function _graduate() private {
        graduated = true;

        address tokenAddr = address(token);
        address wethAddr = address(weth);

        address pair = dexFactory.getPair(tokenAddr, wethAddr);
        if (pair == address(0)) pair = dexFactory.createPair(tokenAddr, wethAddr);

        // Neutralize donation griefing: with zero LP supply, skim clears any
        // pre-seeded balances so the pool opens exactly at graduation price.
        if (IUniswapV2Pair(pair).totalSupply() == 0) IUniswapV2Pair(pair).skim(DEAD);

        // Tell the token first so the decay flag applies from the first DEX
        // trade. The curve stays levy-exempt, so funding the pair is untaxed.
        token.onGraduation(pair);

        uint256 ethToLp = reserveEth;
        // Price-matched token amount: tokens = eth / spot = eth * y / x.
        uint256 tokensToLp = (ethToLp * virtualTokenReserve) / virtualEthReserve;
        uint256 inventory = token.balanceOf(address(this));
        // Factory-validated params guarantee tokensToLp <= inventory; assert
        // defensively rather than deploying a mispriced pool.
        assert(tokensToLp <= inventory);

        reserveEth = 0;

        weth.deposit{value: ethToLp}();
        IERC20(address(weth)).safeTransfer(pair, ethToLp);
        IERC20(address(token)).safeTransfer(pair, tokensToLp);
        IUniswapV2Pair(pair).mint(DEAD);

        uint256 leftover = inventory - tokensToLp;
        if (leftover != 0) IERC20(address(token)).safeTransfer(DEAD, leftover);

        emit Graduated(tokenAddr, pair, ethToLp, tokensToLp, leftover);
    }
}

interface IERC20Permit {
    function permit(address owner, address spender, uint256 value, uint256 deadline, uint8 v, bytes32 r, bytes32 s)
        external;
}
