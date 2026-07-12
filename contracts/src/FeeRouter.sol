// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IRobinfunToken, IRobinStaking} from "./interfaces/IRobinfun.sol";
import {IUniswapV2Router02} from "./interfaces/IUniswapV2.sol";

interface IRobinfunFactoryView {
    function curveOf(address token) external view returns (address);
}

/// @title FeeRouter — all Robinfun revenue flows through here.
///
/// @notice Receives, in ETH:
///   - the flat 1% curve fee on every bonding-curve trade  → 100% protocol;
///   - the creator levy charged in ETH on curve trades      → 90% creator / 10% protocol;
///   - the token-deploy fee                                 → 100% protocol;
/// and, in tokens, the fee-on-transfer levy skimmed from post-graduation DEX
/// trades. Anyone may call `harvest()` to swap an accumulated token levy to
/// ETH (the "~$500 auto-harvest" from the product copy is simply a keeper
/// calling this), after which it is split 90% creator / 10% protocol like any
/// other levy.
///
/// Creator earnings are PULL-based: they accrue per token and the token's
/// current `creator()` claims them (`claim` / `claimMany` — the Treasury
/// page's "claim" and "sweep all"). The protocol share accrues in
/// `protocolPending` until anyone calls `flushProtocol()`, which streams it to
/// the $ROBIN staking vault (or to the treasury before staking launches).
contract FeeRouter is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    /// @notice Creator's share of every levy: 90%. The remaining 10% is
    ///         protocol revenue streamed to $ROBIN stakers.
    uint16 public constant CREATOR_SHARE_BPS = 9_000;

    uint16 private constant BPS = 10_000;

    // ---------------------------------------------------------------- config

    /// @notice The Robinfun factory; used to recognize legitimate tokens.
    ///         Set exactly once (factory and router reference each other).
    IRobinfunFactoryView public factory;

    /// @notice Uniswap-v2 style router used to swap harvested levies to ETH.
    IUniswapV2Router02 public dexRouter;

    /// @notice WETH, cached from the router (swap path hop).
    address public weth;

    /// @notice $ROBIN staking vault. While unset, protocol revenue flushes to
    ///         `treasury` (staking launch is blocked on $ROBIN tokenomics).
    address public stakingVault;

    /// @notice Protocol treasury multisig (brief §10.5 — placeholder until decided).
    address public treasury;

    // ---------------------------------------------------------------- accounting

    /// @notice Unclaimed creator ETH per token.
    mapping(address => uint256) public creatorOwed;

    /// @notice Lifetime creator ETH accrued per token (claimed + unclaimed).
    mapping(address => uint256) public creatorEarnedLifetime;

    /// @notice Sum of all `creatorOwed` — used to detect unaccounted ETH.
    uint256 public totalCreatorOwed;

    /// @notice Protocol ETH awaiting `flushProtocol()`.
    uint256 public protocolPending;

    /// @notice Lifetime protocol ETH accrued (flushed + pending).
    uint256 public protocolEarnedLifetime;

    // ---------------------------------------------------------------- events

    event FactorySet(address indexed factory);
    event DexRouterSet(address indexed router, address indexed weth);
    event StakingVaultSet(address indexed vault);
    event TreasurySet(address indexed treasury);
    event CurveFeeCollected(address indexed token, uint256 amount);
    event DeployFeeCollected(address indexed token, uint256 amount);
    event LevyCollected(address indexed token, uint256 amount, uint256 creatorShare, uint256 protocolShare);
    event LevyHarvested(address indexed token, uint256 tokensIn, uint256 ethOut);
    event CreatorClaimed(address indexed token, address indexed creator, uint256 amount);
    event ProtocolFlushed(address indexed sink, uint256 amount);
    event UnaccountedSwept(address indexed to, uint256 amount);

    // ---------------------------------------------------------------- errors

    error AlreadySet();
    error ZeroAddress();
    error UnknownToken();
    error NotCreator();
    error NothingToDo();
    error NoSink();
    error EthTransferFailed();
    error CannotRescueRobinfunToken();

    constructor(address owner_) Ownable(owner_) {}

    /// @dev Receives ETH from the DEX router during harvests (and nothing
    ///      else by design — stray ETH becomes sweepable as unaccounted).
    receive() external payable {}

    // ---------------------------------------------------------------- config (owner)

    /// @notice Wires the factory. One-shot: the pair is deployed router-first.
    function setFactory(address factory_) external onlyOwner {
        if (factory_ == address(0)) revert ZeroAddress();
        if (address(factory) != address(0)) revert AlreadySet();
        factory = IRobinfunFactoryView(factory_);
        emit FactorySet(factory_);
    }

    /// @notice Sets the DEX router used for levy harvests (§10.2 — the
    ///         canonical Robinhood Chain DEX is still an open question).
    function setDexRouter(address router_) external onlyOwner {
        if (router_ == address(0)) revert ZeroAddress();
        dexRouter = IUniswapV2Router02(router_);
        weth = dexRouter.WETH();
        emit DexRouterSet(router_, weth);
    }

    /// @notice Points the protocol revenue stream at the $ROBIN staking vault.
    function setStakingVault(address vault_) external onlyOwner {
        stakingVault = vault_;
        emit StakingVaultSet(vault_);
    }

    /// @notice Sets the protocol treasury (pre-staking sink + sweep target).
    function setTreasury(address treasury_) external onlyOwner {
        treasury = treasury_;
        emit TreasurySet(treasury_);
    }

    // ---------------------------------------------------------------- collection (curves + factory)

    /// @notice Receives the 1% curve fee. 100% protocol revenue.
    function collectCurveFee(address token) external payable {
        _requireKnown(token);
        protocolPending += msg.value;
        protocolEarnedLifetime += msg.value;
        emit CurveFeeCollected(token, msg.value);
    }

    /// @notice Receives the token-deploy fee. 100% protocol revenue.
    function collectDeployFee(address token) external payable {
        _requireKnown(token);
        protocolPending += msg.value;
        protocolEarnedLifetime += msg.value;
        emit DeployFeeCollected(token, msg.value);
    }

    /// @notice Receives a creator levy in ETH; splits it 90/10 on the spot.
    function collectLevy(address token) external payable {
        _requireKnown(token);
        _splitLevy(token, msg.value);
    }

    // ---------------------------------------------------------------- harvest (permissionless)

    /// @notice Swaps this router's accumulated fee-on-transfer levy of `token`
    ///         to ETH and splits the proceeds 90% creator / 10% protocol.
    /// @dev Permissionless keeper entry point. The caller chooses `minEthOut`,
    ///      so keepers should quote off-chain to avoid sandwiching; a zero
    ///      `minEthOut` from a random caller can only reduce THIS harvest's
    ///      output, never touch principal.
    /// @param token     A graduated Robinfun token with levy inventory here.
    /// @param minEthOut Slippage floor for the swap.
    /// @param deadline  Swap deadline.
    function harvest(address token, uint256 minEthOut, uint256 deadline) external nonReentrant {
        _requireKnown(token);
        if (address(dexRouter) == address(0)) revert NoSink();

        uint256 tokensIn = IERC20(token).balanceOf(address(this));
        if (tokensIn == 0) revert NothingToDo();

        address[] memory path = new address[](2);
        path[0] = token;
        path[1] = weth;

        uint256 balanceBefore = address(this).balance;
        IERC20(token).forceApprove(address(dexRouter), tokensIn);
        dexRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(
            tokensIn, minEthOut, path, address(this), deadline
        );
        uint256 ethOut = address(this).balance - balanceBefore;

        emit LevyHarvested(token, tokensIn, ethOut);
        _splitLevy(token, ethOut);
    }

    // ---------------------------------------------------------------- claims

    /// @notice Claims the caller's accrued creator earnings for one token.
    function claim(address token) external nonReentrant {
        uint256 amount = _accrueClaim(token);
        if (amount == 0) revert NothingToDo();
        _sendEth(msg.sender, amount);
    }

    /// @notice "Sweep all": claims accrued earnings across many tokens in one
    ///         transaction (single ETH transfer).
    function claimMany(address[] calldata tokens) external nonReentrant {
        uint256 total;
        for (uint256 i; i < tokens.length; ++i) {
            total += _accrueClaim(tokens[i]);
        }
        if (total == 0) revert NothingToDo();
        _sendEth(msg.sender, total);
    }

    // ---------------------------------------------------------------- protocol stream

    /// @notice Pushes pending protocol revenue to the staking vault (or the
    ///         treasury while staking has not launched). Permissionless.
    function flushProtocol() external nonReentrant {
        uint256 amount = protocolPending;
        if (amount == 0) revert NothingToDo();
        protocolPending = 0;

        address vault = stakingVault;
        if (vault != address(0)) {
            IRobinStaking(vault).notifyReward{value: amount}();
            emit ProtocolFlushed(vault, amount);
        } else {
            address to = treasury;
            if (to == address(0)) revert NoSink();
            _sendEth(to, amount);
            emit ProtocolFlushed(to, amount);
        }
    }

    // ---------------------------------------------------------------- maintenance (owner)

    /// @notice Sweeps ETH that entered outside the accounted flows (forced
    ///         sends, rounding dust) to the treasury. Cannot touch creator
    ///         balances or pending protocol revenue.
    function sweepUnaccounted() external onlyOwner nonReentrant {
        address to = treasury;
        if (to == address(0)) revert NoSink();
        uint256 accounted = totalCreatorOwed + protocolPending;
        uint256 amount = address(this).balance - accounted;
        if (amount == 0) revert NothingToDo();
        _sendEth(to, amount);
        emit UnaccountedSwept(to, amount);
    }

    /// @notice Rescues a non-Robinfun ERC-20 sent here by mistake. Robinfun
    ///         tokens are un-rescuable — they are creators' pending levies.
    function rescueToken(address token, address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        if (address(factory) != address(0) && factory.curveOf(token) != address(0)) {
            revert CannotRescueRobinfunToken();
        }
        IERC20(token).safeTransfer(to, IERC20(token).balanceOf(address(this)));
    }

    // ---------------------------------------------------------------- internals

    function _requireKnown(address token) private view {
        if (address(factory) == address(0) || factory.curveOf(token) == address(0)) revert UnknownToken();
    }

    function _splitLevy(address token, uint256 amount) private {
        if (amount == 0) return;
        uint256 creatorShare = (amount * CREATOR_SHARE_BPS) / BPS;
        uint256 protocolShare = amount - creatorShare;
        creatorOwed[token] += creatorShare;
        creatorEarnedLifetime[token] += creatorShare;
        totalCreatorOwed += creatorShare;
        protocolPending += protocolShare;
        protocolEarnedLifetime += protocolShare;
        emit LevyCollected(token, amount, creatorShare, protocolShare);
    }

    /// @dev Zeroes and returns the caller-claimable balance for `token`.
    ///      Only the token's CURRENT creator may claim it.
    function _accrueClaim(address token) private returns (uint256 amount) {
        _requireKnown(token);
        if (IRobinfunToken(token).creator() != msg.sender) revert NotCreator();
        amount = creatorOwed[token];
        if (amount != 0) {
            creatorOwed[token] = 0;
            totalCreatorOwed -= amount;
            emit CreatorClaimed(token, msg.sender, amount);
        }
    }

    function _sendEth(address to, uint256 amount) private {
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert EthTransferFailed();
    }
}
