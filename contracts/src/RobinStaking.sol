// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IRobinStaking} from "./interfaces/IRobinfun.sol";

/// @title RobinStaking — stake $ROBIN, earn the protocol's revenue in ETH.
///
/// @notice Protocol revenue (the 1% curve fee on every trade plus 10% of every
/// creator levy, platform-wide) arrives here in ETH from the FeeRouter and is
/// distributed pro-rata to stakers using a `rewardPerTokenStored` accumulator
/// (Synthetix/MasterChef-style). The protocol keeps nothing extra.
///
///   - INSTANT unstake, no cooldown, no lockup.
///   - Rewards are claimable at any time, in ETH.
///   - Accounting is checkpointed on every stake / unstake / claim, so newly
///     staked tokens can never earn revenue that accrued before they arrived
///     (no retroactive/flash-stake theft). Revenue in a given `notifyReward`
///     goes to whoever is staked at that moment — the FeeRouter's
///     permissionless `flushProtocol()` keeps those moments frequent and
///     unpredictable.
///
/// @dev Reward math: `rewardPerTokenStored` accumulates
///      `amount * ACC_PRECISION / totalStaked` per notification. Claims can
///      never exceed notified revenue (floor rounding leaves dust in the
///      contract, bounded by a few wei per notification).
contract RobinStaking is Ownable2Step, ReentrancyGuard, IRobinStaking {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    /// @dev 1e27 accumulator precision: with 1B * 1e18 max stake, per-wei
    ///      rewards still resolve without overflow (amounts << 2^128).
    uint256 private constant ACC_PRECISION = 1e27;

    // ---------------------------------------------------------------- state

    /// @notice The $ROBIN token being staked.
    IERC20 public immutable robin;

    /// @notice Only address allowed to push rewards (the FeeRouter).
    address public rewardDistributor;

    /// @notice Total $ROBIN staked.
    uint256 public totalStaked;

    /// @notice Staked balance per account.
    mapping(address => uint256) public stakedBalance;

    /// @notice Global reward accumulator (ETH-wei * ACC_PRECISION per token).
    uint256 public rewardPerTokenStored;

    /// @notice Accumulator snapshot per account at its last checkpoint.
    mapping(address => uint256) public userRewardPerTokenPaid;

    /// @notice Checkpointed, claimable ETH per account.
    mapping(address => uint256) public rewards;

    /// @notice Revenue received while nobody was staked; folds into the next
    ///         notification instead of being lost.
    uint256 public pendingUndistributed;

    /// @notice Lifetime ETH notified (for the stats/APR endpoints).
    uint256 public totalRewardsNotified;

    /// @notice Lifetime ETH claimed.
    uint256 public totalRewardsClaimed;

    // ---------------------------------------------------------------- events

    event RewardDistributorSet(address indexed distributor);
    event Staked(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event RewardPaid(address indexed account, uint256 amount);
    event RewardNotified(uint256 amount, uint256 distributed, uint256 rewardPerTokenStored);

    // ---------------------------------------------------------------- errors

    error ZeroAmount();
    error ZeroAddress();
    error NotDistributor();
    error InsufficientStake();
    error EthTransferFailed();

    constructor(address robin_, address owner_) Ownable(owner_) {
        if (robin_ == address(0)) revert ZeroAddress();
        robin = IERC20(robin_);
    }

    // ---------------------------------------------------------------- config

    /// @notice Points the vault at its reward source (the FeeRouter).
    function setRewardDistributor(address distributor) external onlyOwner {
        if (distributor == address(0)) revert ZeroAddress();
        rewardDistributor = distributor;
        emit RewardDistributorSet(distributor);
    }

    // ---------------------------------------------------------------- staking

    /// @notice Stakes `amount` $ROBIN. Earning starts from this checkpoint.
    function stake(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        _checkpoint(msg.sender);
        totalStaked += amount;
        stakedBalance[msg.sender] += amount;
        robin.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /// @notice Unstakes `amount` $ROBIN — instant, no cooldown. Accrued
    ///         rewards stay claimable.
    function withdraw(uint256 amount) public nonReentrant {
        if (amount == 0) revert ZeroAmount();
        if (stakedBalance[msg.sender] < amount) revert InsufficientStake();
        _checkpoint(msg.sender);
        totalStaked -= amount;
        stakedBalance[msg.sender] -= amount;
        robin.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Claims all accrued ETH rewards.
    function claim() public nonReentrant {
        _checkpoint(msg.sender);
        uint256 reward = rewards[msg.sender];
        if (reward != 0) {
            rewards[msg.sender] = 0;
            totalRewardsClaimed += reward;
            (bool ok,) = msg.sender.call{value: reward}("");
            if (!ok) revert EthTransferFailed();
            emit RewardPaid(msg.sender, reward);
        }
    }

    /// @notice Unstakes everything and claims in one transaction.
    function exit() external {
        withdraw(stakedBalance[msg.sender]);
        claim();
    }

    // ---------------------------------------------------------------- rewards in

    /// @inheritdoc IRobinStaking
    /// @dev Distributes `msg.value` (plus anything received while the vault
    ///      was empty) to current stakers instantly.
    function notifyReward() external payable {
        if (msg.sender != rewardDistributor) revert NotDistributor();
        uint256 amount = msg.value + pendingUndistributed;
        if (amount == 0) revert ZeroAmount();

        uint256 staked = totalStaked;
        if (staked == 0) {
            pendingUndistributed = amount;
            emit RewardNotified(msg.value, 0, rewardPerTokenStored);
            return;
        }

        pendingUndistributed = 0;
        rewardPerTokenStored += (amount * ACC_PRECISION) / staked;
        totalRewardsNotified += amount;
        emit RewardNotified(msg.value, amount, rewardPerTokenStored);
    }

    // ---------------------------------------------------------------- views

    /// @notice ETH claimable by `account` right now.
    function earned(address account) public view returns (uint256) {
        return rewards[account]
            + (stakedBalance[account] * (rewardPerTokenStored - userRewardPerTokenPaid[account])) / ACC_PRECISION;
    }

    // ---------------------------------------------------------------- internals

    function _checkpoint(address account) private {
        rewards[account] = earned(account);
        userRewardPerTokenPaid[account] = rewardPerTokenStored;
    }
}
