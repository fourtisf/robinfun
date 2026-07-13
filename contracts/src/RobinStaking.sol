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
/// distributed pro-rata to stakers using a Synthetix-style `StakingRewards`
/// accumulator. The protocol keeps nothing extra.
///
///   - INSTANT unstake, no cooldown, no lockup.
///   - Rewards are claimable at any time, in ETH.
///
/// @dev Each `notifyReward` does NOT dump its amount into stakers instantly.
/// It is STREAMED linearly over `rewardsDuration` (default 7 days). This is
/// what defends against just-in-time / flash-stake capture: because the reward
/// source `FeeRouter.flushProtocol()` is permissionless, an attacker can pick
/// the exact block a distribution fires — but streaming means a one-block
/// stake earns only ~(1 block / rewardsDuration) of it, which is negligible.
/// A staker who stays for the whole window earns their full pro-rata share.
/// Reward accounting is checkpointed on every stake/withdraw/claim/notify, so
/// there is no retroactive capture either.
///
/// Reward math cannot pay out more ETH than was notified: `notifyReward`
/// asserts `rewardRate * rewardsDuration <= address(this).balance`, so the
/// stream is always fully funded and claims are conserved (floor rounding
/// leaves bounded dust in the contract).
contract RobinStaking is Ownable2Step, ReentrancyGuard, IRobinStaking {
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    /// @dev Fixed-point scale for the reward accumulator (1e27).
    uint256 private constant ACC_PRECISION = 1e27;

    /// @dev Bounds on the reward-streaming window.
    uint256 public constant MIN_DURATION = 1 hours;
    uint256 public constant MAX_DURATION = 30 days;

    // ---------------------------------------------------------------- state

    /// @notice The $ROBIN token being staked.
    IERC20 public immutable robin;

    /// @notice Only address allowed to push rewards (the FeeRouter).
    address public rewardDistributor;

    /// @notice Length of the linear reward stream for each notification.
    uint256 public rewardsDuration = 7 days;

    /// @notice Total $ROBIN staked.
    uint256 public totalStaked;

    /// @notice Staked balance per account.
    mapping(address => uint256) public stakedBalance;

    // Synthetix StakingRewards accounting -------------------------------------

    /// @notice Timestamp the current reward stream ends.
    uint256 public periodFinish;

    /// @notice Current reward emission rate, in ETH-wei per second.
    uint256 public rewardRate;

    /// @notice Last time the global accumulator was updated.
    uint256 public lastUpdateTime;

    /// @notice Global reward accumulator (ETH-wei * ACC_PRECISION per token).
    uint256 public rewardPerTokenStored;

    /// @notice Accumulator snapshot per account at its last checkpoint.
    mapping(address => uint256) public userRewardPerTokenPaid;

    /// @notice Checkpointed, claimable ETH per account.
    mapping(address => uint256) public rewards;

    /// @notice Revenue received while nobody was staked; folds into the next
    ///         notification instead of being lost.
    uint256 public pendingUndistributed;

    /// @notice Lifetime ETH notified into streams (for the stats/APR endpoints).
    uint256 public totalRewardsNotified;

    /// @notice Lifetime ETH claimed.
    uint256 public totalRewardsClaimed;

    // ---------------------------------------------------------------- events

    event RewardDistributorSet(address indexed distributor);
    event RewardsDurationSet(uint256 duration);
    event Staked(address indexed account, uint256 amount);
    event Withdrawn(address indexed account, uint256 amount);
    event RewardPaid(address indexed account, uint256 amount);
    event RewardNotified(uint256 amount, uint256 rewardRate, uint256 periodFinish);

    // ---------------------------------------------------------------- errors

    error ZeroAmount();
    error ZeroAddress();
    error NotDistributor();
    error InsufficientStake();
    error EthTransferFailed();
    error BadDuration();
    error InsufficientRewardBalance();

    constructor(address robin_, address owner_) Ownable(owner_) {
        if (robin_ == address(0)) revert ZeroAddress();
        robin = IERC20(robin_);
    }

    // ---------------------------------------------------------------- modifier

    /// @dev Checkpoints the global accumulator and, if given, one account.
    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            rewards[account] = earned(account);
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    // ---------------------------------------------------------------- config

    /// @notice Points the vault at its reward source (the FeeRouter).
    function setRewardDistributor(address distributor) external onlyOwner {
        if (distributor == address(0)) revert ZeroAddress();
        rewardDistributor = distributor;
        emit RewardDistributorSet(distributor);
    }

    /// @notice Sets the reward-streaming window. Only between streams (never
    ///         mid-stream, so an in-flight distribution's rate cannot be
    ///         retimed under stakers).
    function setRewardsDuration(uint256 duration) external onlyOwner {
        if (duration < MIN_DURATION || duration > MAX_DURATION) revert BadDuration();
        if (block.timestamp <= periodFinish) revert BadDuration();
        rewardsDuration = duration;
        emit RewardsDurationSet(duration);
    }

    // ---------------------------------------------------------------- staking

    /// @notice Stakes `amount` $ROBIN. Earning starts from this checkpoint.
    function stake(uint256 amount) external nonReentrant updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        totalStaked += amount;
        stakedBalance[msg.sender] += amount;
        robin.safeTransferFrom(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /// @notice Unstakes `amount` $ROBIN — instant, no cooldown. Accrued
    ///         rewards stay claimable.
    function withdraw(uint256 amount) public nonReentrant updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        if (stakedBalance[msg.sender] < amount) revert InsufficientStake();
        totalStaked -= amount;
        stakedBalance[msg.sender] -= amount;
        // If this empties the vault mid-stream, park the un-emitted remainder.
        // Otherwise `rewardPerToken` stops accruing (totalStaked == 0) and those
        // emissions would be permanently stranded — or, if the vault refills
        // before `periodFinish`, silently raked by a just-in-time restaker
        // resuming the stale stream. Parking folds them into the next stream.
        if (totalStaked == 0 && block.timestamp < periodFinish) {
            pendingUndistributed += (periodFinish - block.timestamp) * rewardRate;
            rewardRate = 0;
            periodFinish = block.timestamp;
        }
        robin.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /// @notice Claims all accrued ETH rewards.
    function claim() public nonReentrant updateReward(msg.sender) {
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
    /// @dev Starts (or tops up) a linear reward stream over `rewardsDuration`.
    ///      Anything received while the vault is empty is parked and folded in
    ///      on the next notification with stakers present.
    function notifyReward() external payable updateReward(address(0)) {
        if (msg.sender != rewardDistributor) revert NotDistributor();

        uint256 amount = msg.value + pendingUndistributed;
        if (amount == 0) revert ZeroAmount();

        // With no stakers the stream would emit into the void; park instead.
        if (totalStaked == 0) {
            pendingUndistributed = amount;
            emit RewardNotified(0, rewardRate, periodFinish);
            return;
        }
        pendingUndistributed = 0;

        uint256 newRate;
        if (block.timestamp >= periodFinish) {
            newRate = amount / rewardsDuration;
        } else {
            uint256 leftover = (periodFinish - block.timestamp) * rewardRate;
            newRate = (amount + leftover) / rewardsDuration;
        }

        // Amount too small to emit a non-zero per-second rate (would floor to 0
        // and strand the funds while advancing periodFinish). Re-park it and
        // leave any active stream untouched; it folds into the next notify.
        if (newRate == 0) {
            pendingUndistributed = amount;
            emit RewardNotified(0, rewardRate, periodFinish);
            return;
        }
        rewardRate = newRate;

        // Solvency: the stream must be fully funded by ETH actually held (net
        // of parked funds, which are reserved for a future stream, and of the
        // undistributed portion of any prior stream already counted in ETH).
        if (rewardRate * rewardsDuration > address(this).balance) revert InsufficientRewardBalance();

        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardsDuration;
        totalRewardsNotified += amount;
        emit RewardNotified(amount, rewardRate, periodFinish);
    }

    // ---------------------------------------------------------------- views

    /// @notice Last timestamp rewards are being distributed for.
    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    /// @notice Current value of the global reward accumulator.
    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) return rewardPerTokenStored;
        return rewardPerTokenStored
            + ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * ACC_PRECISION) / totalStaked;
    }

    /// @notice ETH claimable by `account` right now.
    function earned(address account) public view returns (uint256) {
        return rewards[account]
            + (stakedBalance[account] * (rewardPerToken() - userRewardPerTokenPaid[account])) / ACC_PRECISION;
    }

    /// @notice Reward emitted per second at the current rate (for APR display).
    function rewardRatePerSecond() external view returns (uint256) {
        return block.timestamp < periodFinish ? rewardRate : 0;
    }
}
