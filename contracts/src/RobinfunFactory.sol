// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {RobinfunToken} from "./RobinfunToken.sol";
import {BondingCurve} from "./BondingCurve.sol";
import {IRobinfunToken, IBondingCurve, IFeeRouter} from "./interfaces/IRobinfun.sol";

/// @title RobinfunFactory — one-transaction fair launches.
///
/// @notice Deploys each new token + bonding curve as EIP-1167 minimal-proxy
/// clones (cheap deploys), enforces the advertised anti-rug guarantees at
/// creation, collects the deploy fee and optionally executes the creator's
/// first "dev buy" atomically in the same transaction.
///
/// Guarantees enforced here (user promises — brief §2):
///   - levy hard cap: at most 10% buy / 10% sell, in 0.5% steps;
///   - full supply on the curve, no presale, no team allocation (the token
///     mints 100% of supply to its curve at initialization);
///   - curve parameters are validated so graduation liquidity always fits
///     within the fixed supply.
///
/// The owner (protocol multisig, §10.5) can only tune parameters for FUTURE
/// launches (curve shape, deploy fee, DEX wiring). Live tokens and curves
/// have no admin surface at all.
contract RobinfunFactory is Ownable2Step {
    // ---------------------------------------------------------------- constants

    /// @notice Hard cap on either levy side: 10%.
    uint16 public constant MAX_LEVY_BPS = 1_000;

    /// @notice Levies are configured in 0.5% steps.
    uint16 public constant LEVY_STEP_BPS = 50;

    /// @dev Mirrors RobinfunToken.TOTAL_SUPPLY (compile-time constant).
    uint256 private constant TOTAL_SUPPLY = 1_000_000_000e18;

    // ---------------------------------------------------------------- immutables

    /// @notice Logic contract every token clone points at.
    address public immutable tokenImplementation;

    /// @notice Logic contract every curve clone points at.
    address public immutable curveImplementation;

    /// @notice Protocol fee router. Fixed for the factory's lifetime.
    address public immutable feeRouter;

    // ---------------------------------------------------------------- config

    /// @notice Curve shape applied to new launches (frozen per token at create).
    IBondingCurve.CurveParams public curveParams;

    /// @notice Uniswap-v2 style factory new curves graduate into.
    address public dexFactory;

    /// @notice Wrapped native token used as the graduation pair's quote asset.
    address public weth;

    /// @notice Flat ETH fee charged per launch (§10.8 — value pending team).
    uint256 public deployFee;

    // ---------------------------------------------------------------- registry

    /// @notice Every token ever launched, in creation order.
    address[] public allTokens;

    /// @notice Token → its bonding curve. Nonzero iff the token is ours.
    mapping(address => address) public curveOf;

    /// @notice True for every bonding curve this factory deployed.
    mapping(address => bool) public isCurve;

    // ---------------------------------------------------------------- types

    struct CreateParams {
        string name;
        string symbol;
        /// @dev Off-chain metadata pointer (description/emoji/socials live in
        ///      the backend DB — brief §6). Emitted so the indexer can bind
        ///      metadata to the deploy transaction (§7).
        string metadataURI;
        uint16 buyLevyBps;
        uint16 sellLevyBps;
        bool decayAtGraduation;
        bool renounceRateControl;
        /// @dev Slippage floor for the optional dev buy.
        uint256 devBuyMinTokensOut;
        /// @dev Vanity salt: the token is deployed with CREATE2 at a
        ///      deterministic address, so an off-chain miner can grind this
        ///      value until the resulting token address ends in a chosen hex
        ///      suffix (Robinfun's signature is `…feed`). Bound to the caller
        ///      (see `_tokenSalt`) so a mined salt cannot be front-run. Pass 0
        ///      to skip vanity — the address is still deterministic and unique.
        bytes32 vanitySalt;
    }

    // ---------------------------------------------------------------- events

    event TokenCreated(
        address indexed token,
        address indexed curve,
        address indexed creator,
        string name,
        string symbol,
        string metadataURI,
        uint16 buyLevyBps,
        uint16 sellLevyBps,
        bool decayAtGraduation,
        bool renounceRateControl,
        uint256 deployFee,
        uint256 devBuyEth
    );
    event CurveParamsSet(uint128 virtualEth, uint128 virtualToken, uint128 graduationEth);
    event DexSet(address indexed dexFactory, address indexed weth);
    event DeployFeeSet(uint256 deployFee);

    // ---------------------------------------------------------------- errors

    error ZeroAddress();
    error LevyTooHigh();
    error LevyNotOnStep();
    error BadName();
    error InsufficientDeployFee();
    error BadCurveParams();
    error EthTransferFailed();
    error UnexpectedEth();

    /// @dev Accepts ETH only from its own curves: a dev buy that overshoots
    ///      the graduation target is capped by the curve, which refunds the
    ///      surplus to its caller (this factory) — forwarded to the creator
    ///      at the end of `createToken`.
    receive() external payable {
        if (!isCurve[msg.sender]) revert UnexpectedEth();
    }

    // ---------------------------------------------------------------- constructor

    constructor(
        address owner_,
        address feeRouter_,
        address dexFactory_,
        address weth_,
        IBondingCurve.CurveParams memory curveParams_,
        uint256 deployFee_
    ) Ownable(owner_) {
        if (feeRouter_ == address(0) || dexFactory_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        feeRouter = feeRouter_;
        dexFactory = dexFactory_;
        weth = weth_;
        _setCurveParams(curveParams_);
        deployFee = deployFee_;

        tokenImplementation = address(new RobinfunToken());
        curveImplementation = address(new BondingCurve());
    }

    // ---------------------------------------------------------------- launch

    /// @notice Launches a new token: clones token + curve, mints the full 1B
    ///         supply onto the curve, pays the deploy fee and (optionally)
    ///         executes the creator's dev buy — all in one transaction.
    /// @dev `msg.value` = deployFee + optional dev-buy ETH. Everything above
    ///      the deploy fee is spent on the dev buy.
    function createToken(CreateParams calldata p) external payable returns (address token, address curve) {
        if (msg.value < deployFee) revert InsufficientDeployFee();
        _validateLevy(p.buyLevyBps);
        _validateLevy(p.sellLevyBps);
        if (bytes(p.name).length == 0 || bytes(p.name).length > 64) revert BadName();
        if (bytes(p.symbol).length == 0 || bytes(p.symbol).length > 16) revert BadName();

        // With a vanity salt, deploy the token at a deterministic CREATE2
        // address (so it can carry the `…feed` suffix a miner ground for);
        // otherwise a plain clone, which is always unique. The curve is always
        // a plain clone — its address is not user-facing.
        token = p.vanitySalt == bytes32(0)
            ? Clones.clone(tokenImplementation)
            : Clones.cloneDeterministic(tokenImplementation, _tokenSalt(msg.sender, p.vanitySalt));
        curve = Clones.clone(curveImplementation);

        RobinfunToken(token).initialize(
            IRobinfunToken.TokenInit({
                name: p.name,
                symbol: p.symbol,
                creator: msg.sender,
                curve: curve,
                feeRouter: feeRouter,
                buyLevyBps: p.buyLevyBps,
                sellLevyBps: p.sellLevyBps,
                decayAtGraduation: p.decayAtGraduation,
                renounceAtCreation: p.renounceRateControl
            })
        );
        BondingCurve(payable(curve)).initialize(token, feeRouter, dexFactory, weth, curveParams);

        // Register before any value-bearing external call.
        allTokens.push(token);
        curveOf[token] = curve;
        isCurve[curve] = true;

        emit TokenCreated(
            token,
            curve,
            msg.sender,
            p.name,
            p.symbol,
            p.metadataURI,
            p.buyLevyBps,
            p.sellLevyBps,
            p.decayAtGraduation,
            p.renounceRateControl,
            deployFee,
            msg.value - deployFee
        );

        if (deployFee != 0) IFeeRouter(feeRouter).collectDeployFee{value: deployFee}(token);

        uint256 devBuy = msg.value - deployFee;
        if (devBuy != 0) {
            // Tokens go to the creator; a capped final buy refunds surplus ETH
            // to the factory, which forwards it back to the creator below.
            BondingCurve(payable(curve)).buyFor{value: devBuy}(msg.sender, p.devBuyMinTokensOut, block.timestamp);
            uint256 refund = address(this).balance;
            if (refund != 0) {
                (bool ok,) = msg.sender.call{value: refund}("");
                if (!ok) revert EthTransferFailed();
            }
        }
    }

    // ---------------------------------------------------------------- views

    /// @notice Number of tokens ever launched.
    function allTokensLength() external view returns (uint256) {
        return allTokens.length;
    }

    /// @notice The address a token WILL have if `creator` launches with
    ///         `vanitySalt`. An off-chain miner grinds `vanitySalt` until this
    ///         ends in the desired hex suffix (e.g. `…feed`), then passes that
    ///         salt to `createToken`.
    function predictTokenAddress(address creator, bytes32 vanitySalt) public view returns (address) {
        return Clones.predictDeterministicAddress(tokenImplementation, _tokenSalt(creator, vanitySalt), address(this));
    }

    /// @dev Binds the user's vanity salt to the creator so a salt observed in
    ///      the mempool cannot be front-run into someone else's address.
    function _tokenSalt(address creator, bytes32 vanitySalt) internal pure returns (bytes32) {
        return keccak256(abi.encode(creator, vanitySalt));
    }

    // ---------------------------------------------------------------- config (owner, future launches only)

    /// @notice Updates the curve shape for FUTURE launches.
    function setCurveParams(IBondingCurve.CurveParams calldata p) external onlyOwner {
        _setCurveParams(p);
    }

    /// @notice Updates the DEX wiring for FUTURE launches (§10.2 pending).
    function setDex(address dexFactory_, address weth_) external onlyOwner {
        if (dexFactory_ == address(0) || weth_ == address(0)) revert ZeroAddress();
        dexFactory = dexFactory_;
        weth = weth_;
        emit DexSet(dexFactory_, weth_);
    }

    /// @notice Updates the deploy fee for FUTURE launches (§10.8 pending).
    function setDeployFee(uint256 fee) external onlyOwner {
        deployFee = fee;
        emit DeployFeeSet(fee);
    }

    // ---------------------------------------------------------------- internals

    function _validateLevy(uint16 bps) private pure {
        if (bps > MAX_LEVY_BPS) revert LevyTooHigh();
        if (bps % LEVY_STEP_BPS != 0) revert LevyNotOnStep();
    }

    /// @dev Validates that the curve shape is solvent end-to-end: the tokens
    ///      sold on the way to graduation plus the price-matched liquidity
    ///      deposit can never exceed the fixed 1B supply (conservative
    ///      integer rounding: sold is over-estimated, LP need is ceil'd).
    function _setCurveParams(IBondingCurve.CurveParams memory p) private {
        if (p.virtualEth == 0 || p.virtualToken == 0 || p.graduationEth == 0) revert BadCurveParams();

        uint256 supply = TOTAL_SUPPLY;
        uint256 k = uint256(p.virtualEth) * uint256(p.virtualToken);
        uint256 xAtGrad = uint256(p.virtualEth) + p.graduationEth;
        uint256 yAtGrad = k / xAtGrad; // floor → over-estimates tokens sold
        uint256 sold = uint256(p.virtualToken) - yAtGrad;
        uint256 lpTokens = Math.ceilDiv(uint256(p.graduationEth) * yAtGrad, xAtGrad);
        if (sold + lpTokens > supply) revert BadCurveParams();

        curveParams = IBondingCurve.CurveParams(p.virtualEth, p.virtualToken, p.graduationEth);
        emit CurveParamsSet(p.virtualEth, p.virtualToken, p.graduationEth);
    }
}
