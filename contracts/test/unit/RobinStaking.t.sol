// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseSetup} from "../BaseSetup.t.sol";
import {RobinStaking} from "../../src/RobinStaking.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @dev Unit tests for the Synthetix-style, time-STREAMED reward vault.
///
/// Rewards notified via `notifyReward()` are no longer credited instantly; they
/// vest linearly over `rewardsDuration()` (default 7 days). This is what defends
/// against just-in-time / flash-stake capture (the reward source
/// `FeeRouter.flushProtocol()` is permissionless, so an attacker can pick the
/// firing block — but a one-block stake earns only ~1 block / duration of it).
///
/// Streaming introduces floor-rounding dust larger than the old lump-sum model
/// (`rewardRate = amount / rewardsDuration` loses up to ~duration wei per notify,
/// plus small accumulator dust), so earnings are asserted with tolerances. The
/// hard conservation identities still hold EXACTLY and are asserted as such:
///   - `claimed <= notified`
///   - `claimed + address(staking).balance == notified`
///     (ROBIN is a separate token, so the vault's ETH is exactly notified-claimed)
contract RobinStakingTest is BaseSetup {
    // ---------------------------------------------------------------- helpers

    /// @dev Hands `amount` ROBIN from the multisig (holds full supply) to `who`.
    function _fund(address who, uint256 amount) internal {
        vm.prank(protocolMultisig);
        robin.transfer(who, amount);
    }

    /// @dev Funds, approves and stakes in one go.
    function _stake(address who, uint256 amount) internal {
        _fund(who, amount);
        vm.startPrank(who);
        robin.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    /// @dev Raw notification: pushes `amount` ETH of protocol revenue as the
    ///      FeeRouter, starting/topping-up a stream WITHOUT advancing time. Right
    ///      after this, `earned()` is ~0 for a fresh stream. Used by
    ///      streaming-specific tests that need to observe partial vesting.
    function _notify(uint256 amount) internal {
        vm.deal(address(feeRouter), amount);
        vm.prank(address(feeRouter));
        staking.notifyReward{value: amount}();
    }

    /// @dev Notifies `amount` then warps a full `rewardsDuration` so the whole
    ///      amount fully vests to current stakers.
    function _stream(uint256 amount) internal {
        _notify(amount);
        vm.warp(block.timestamp + staking.rewardsDuration());
    }

    // ---------------------------------------------------------------- stake

    function test_stake_transfersAndAccounts() public {
        _fund(alice, 100e18);

        vm.startPrank(alice);
        robin.approve(address(staking), 100e18);
        staking.stake(100e18);
        vm.stopPrank();

        assertEq(robin.balanceOf(alice), 0);
        assertEq(robin.balanceOf(address(staking)), 100e18);
        assertEq(staking.stakedBalance(alice), 100e18);
        assertEq(staking.totalStaked(), 100e18);
    }

    function test_stake_zeroAmountReverts() public {
        vm.prank(alice);
        vm.expectRevert(RobinStaking.ZeroAmount.selector);
        staking.stake(0);
    }

    function test_stake_withoutApprovalReverts() public {
        _fund(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert();
        staking.stake(100e18);
    }

    // ---------------------------------------------------------------- withdraw

    function test_withdraw_instantFullNoCooldown() public {
        _stake(alice, 100e18);

        // Same block, no warp: unstake is instant, no cooldown, no lockup.
        vm.prank(alice);
        staking.withdraw(100e18);

        assertEq(robin.balanceOf(alice), 100e18);
        assertEq(staking.stakedBalance(alice), 0);
        assertEq(staking.totalStaked(), 0);
    }

    function test_withdraw_partial() public {
        _stake(alice, 100e18);

        vm.prank(alice);
        staking.withdraw(40e18);

        assertEq(robin.balanceOf(alice), 40e18);
        assertEq(staking.stakedBalance(alice), 60e18);
        assertEq(staking.totalStaked(), 60e18);
    }

    function test_withdraw_zeroAmountReverts() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert(RobinStaking.ZeroAmount.selector);
        staking.withdraw(0);
    }

    function test_withdraw_moreThanStakedReverts() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert(RobinStaking.InsufficientStake.selector);
        staking.withdraw(100e18 + 1);
    }

    function test_withdraw_rewardsSurviveFullExitOfStake() public {
        _stake(alice, 100e18);
        _stream(2 ether);

        vm.prank(alice);
        staking.withdraw(100e18);

        // Fully unstaked, but the accrued ETH is still claimable.
        assertEq(staking.stakedBalance(alice), 0);
        assertApproxEqAbs(staking.earned(alice), 2 ether, 1e10, "accrual survives full unstake");

        uint256 owed = staking.earned(alice);
        uint256 balBefore = alice.balance;
        vm.prank(alice);
        staking.claim();
        assertEq(alice.balance - balBefore, owed, "claim pays the surviving accrual");
        assertEq(staking.earned(alice), 0);
    }

    // ---------------------------------------------------------------- notifyReward auth

    function test_notifyReward_nonDistributorReverts() public {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(RobinStaking.NotDistributor.selector);
        staking.notifyReward{value: 1 ether}();
    }

    function test_notifyReward_distributorIncreasesBalanceAndNotified() public {
        _stake(alice, 100e18);
        _notify(1 ether);
        // Vault balance jumps immediately; totalRewardsNotified is credited at
        // notify time (the stream vests it out over the duration).
        assertEq(address(staking).balance, 1 ether);
        assertEq(staking.totalRewardsNotified(), 1 ether);
        // ...but with a fresh stream almost nothing has vested yet.
        assertApproxEqAbs(staking.earned(alice), 0, 1e10, "fresh stream has not vested yet");
    }

    // ---------------------------------------------------------------- reward math (full stream)

    function test_rewards_singleStakerFullStream() public {
        _stake(alice, 100e18);
        _stream(1 ether);

        assertApproxEqAbs(staking.earned(alice), 1 ether, 1e10, "full stream vests to sole staker");

        uint256 owed = staking.earned(alice);
        uint256 balBefore = alice.balance;
        vm.prank(alice);
        staking.claim();
        assertEq(alice.balance - balBefore, owed, "claim pays exactly what was earned");
        assertEq(staking.earned(alice), 0, "claim resets accrual");
        assertEq(staking.totalRewardsClaimed(), owed);

        // Second claim with nothing accrued is a no-op, not a revert.
        uint256 balAfter = alice.balance;
        vm.prank(alice);
        staking.claim();
        assertEq(alice.balance, balAfter, "empty claim moves no ETH");
    }

    function test_rewards_proRataFullStream() public {
        _stake(alice, 300e18);
        _stake(bob, 100e18);
        _stream(4 ether);

        uint256 owedA = staking.earned(alice);
        uint256 owedB = staking.earned(bob);
        assertApproxEqRel(owedA, 3 ether, 1e12, "alice earns 3/4 of the stream");
        assertApproxEqRel(owedB, 1 ether, 1e12, "bob earns 1/4 of the stream");

        uint256 aBefore = alice.balance;
        uint256 bBefore = bob.balance;
        vm.prank(alice);
        staking.claim();
        vm.prank(bob);
        staking.claim();
        assertEq(alice.balance - aBefore, owedA, "alice paid exactly her earned");
        assertEq(bob.balance - bBefore, owedB, "bob paid exactly his earned");
    }

    // ---------------------------------------------------------------- streaming partial vest

    function test_rewards_streamingPartialVest() public {
        _stake(alice, 100e18);
        _notify(1 ether);

        uint256 half = staking.rewardsDuration() / 2;
        vm.warp(block.timestamp + half);
        assertApproxEqRel(staking.earned(alice), 0.5 ether, 1e12, "half the stream vests at the midpoint");

        vm.warp(block.timestamp + (staking.rewardsDuration() - half));
        assertApproxEqRel(staking.earned(alice), 1 ether, 1e12, "the whole stream vests by period end");
    }

    // ------------------------------------------------------ JIT / flash-stake protection

    /// @dev THE security test. Because `FeeRouter.flushProtocol()` is
    ///      permissionless, an attacker times a distribution to the exact block
    ///      and flash-stakes a colossal amount to try to seize it. Streaming
    ///      caps the one-block take at ~(1 block / rewardsDuration), which is
    ///      negligible — the honest incumbent who stays the whole window keeps
    ///      essentially the entire stream.
    function test_security_jitFlashStakeCannotSeizeDistribution() public {
        // Alice is the incumbent; a full 1 ETH stream has already vested to her.
        _stake(alice, 100e18);
        _stream(1 ether);
        assertApproxEqAbs(staking.earned(alice), 1 ether, 1e10, "incumbent fully vested");

        // A fresh 1 ETH stream starts. Bob controls the firing block, so he
        // front-runs it with a gigantic flash-stake at t=0 of the stream.
        _notify(1 ether);
        uint256 aliceBase = staking.earned(alice); // her already-vested ether, checkpointed at the notify
        assertApproxEqAbs(aliceBase, 1 ether, 1e10);

        uint256 flash = 100_000_000e18; // 1e26 — a million times alice's stake
        _stake(bob, flash);

        // He waits a single block (~12s), then claims and unwinds.
        vm.warp(block.timestamp + 12);
        uint256 bobBefore = bob.balance;
        vm.prank(bob);
        staking.claim();
        vm.prank(bob);
        staking.withdraw(flash);
        uint256 bobClaimed = bob.balance - bobBefore;

        // Despite owning ~99.9999% of the stake for that block, his take is
        // capped at ~12/604800 of the 1 ETH stream: a negligible fraction.
        assertLt(bobClaimed, 1 ether / 1000, "flash-staker cannot seize the distribution");

        // Contrast: alice, who stays for the whole window, collects essentially
        // the entire stream (minus bob's dust).
        vm.warp(block.timestamp + staking.rewardsDuration());
        uint256 aliceGain = staking.earned(alice) - aliceBase;
        assertGt(aliceGain, 0.99 ether, "honest full-duration staker collects ~the whole stream");
    }

    // ---------------------------------------------------------------- no retroactive capture

    function test_rewards_noRetroactiveForLateStaker() public {
        _stake(alice, 100e18);
        _stream(1 ether);
        assertApproxEqAbs(staking.earned(alice), 1 ether, 1e10, "incumbent vested");

        // Bob stakes only AFTER the first stream completed.
        _stake(bob, 100e18);
        assertEq(staking.earned(bob), 0, "late staker gets nothing retroactively");
        assertApproxEqAbs(staking.earned(alice), 1 ether, 1e10, "incumbent keeps the past stream");

        // A fresh full stream splits pro-rata from this point (equal stakes → 50/50).
        uint256 aliceBase = staking.earned(alice);
        _stream(1 ether);

        uint256 aliceGain = staking.earned(alice) - aliceBase;
        uint256 bobGain = staking.earned(bob);
        assertApproxEqRel(bobGain, 0.5 ether, 1e12, "bob earns half of the fresh stream");
        assertApproxEqRel(aliceGain, 0.5 ether, 1e12, "alice earns half of the fresh stream");
        assertEq(aliceGain, bobGain, "equal stakes checkpointed together split the fresh stream exactly");
    }

    function test_rewards_stakeAfterStreamThenClaimYieldsZero() public {
        _stake(alice, 100e18);
        _stream(1 ether);

        _stake(carol, 100e18);
        uint256 balBefore = carol.balance;
        vm.prank(carol);
        staking.claim();
        assertEq(carol.balance, balBefore, "immediate claim after a completed stream pays nothing");
        assertEq(staking.earned(carol), 0);
    }

    // ---------------------------------------------------------------- parking

    function test_pendingUndistributed_parksThenFoldsIntoNextStream() public {
        // Nobody staked: revenue is parked — not lost, not streamed, not counted.
        _notify(1 ether);
        assertEq(staking.pendingUndistributed(), 1 ether);
        assertEq(staking.totalRewardsNotified(), 0, "parked revenue is not counted as notified");
        assertEq(staking.earned(alice), 0);

        _stake(alice, 100e18);
        assertEq(staking.earned(alice), 0, "staking alone does not release parked funds");

        // A later stream folds the parked amount in with the new one; both vest.
        _stream(0.5 ether);
        assertEq(staking.pendingUndistributed(), 0);
        assertApproxEqAbs(staking.earned(alice), 1.5 ether, 1e10, "alice earns parked + new");
        assertEq(staking.totalRewardsNotified(), 1.5 ether);
    }

    // ---------------------------------------------------------------- exit

    function test_exit_unstakesAndPaysInOneCall() public {
        _stake(alice, 100e18);
        _stream(1 ether);

        uint256 owed = staking.earned(alice);
        assertApproxEqAbs(owed, 1 ether, 1e10);

        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        staking.exit();

        assertEq(robin.balanceOf(alice), 100e18, "all stake returned");
        assertEq(alice.balance - ethBefore, owed, "all rewards paid");
        assertEq(staking.stakedBalance(alice), 0);
        assertEq(staking.totalStaked(), 0);
        assertEq(staking.earned(alice), 0);
    }

    // ---------------------------------------------------------------- setRewardsDuration

    function test_setRewardsDuration_ownerSetsWhenIdle() public {
        vm.prank(protocolMultisig);
        staking.setRewardsDuration(1 days);
        assertEq(staking.rewardsDuration(), 1 days);
    }

    function test_setRewardsDuration_outOfRangeReverts() public {
        vm.startPrank(protocolMultisig);
        vm.expectRevert(RobinStaking.BadDuration.selector);
        staking.setRewardsDuration(1 hours - 1);

        vm.expectRevert(RobinStaking.BadDuration.selector);
        staking.setRewardsDuration(30 days + 1);
        vm.stopPrank();
    }

    function test_setRewardsDuration_duringActiveStreamReverts() public {
        _stake(alice, 100e18);
        _notify(1 ether); // starts an active stream (periodFinish in the future)

        vm.prank(protocolMultisig);
        vm.expectRevert(RobinStaking.BadDuration.selector);
        staking.setRewardsDuration(1 days);
    }

    function test_setRewardsDuration_nonOwnerReverts() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        staking.setRewardsDuration(1 days);
    }

    // ---------------------------------------------------------------- fuzz

    /// @dev ETH never leaks under streaming + top-ups + partial vesting:
    ///      `claimed + vault balance == notified` EXACTLY, and claims can never
    ///      exceed what was notified. Streaming leaves larger floor dust in the
    ///      vault than the old model, so NO tight dust bound is asserted.
    function testFuzz_conservation(uint96 a, uint96 b, uint96 r1, uint96 r2) public {
        uint256 stakeA = bound(uint256(a), 1e18, 1e26);
        uint256 stakeB = bound(uint256(b), 1e18, 1e26);
        uint256 reward1 = bound(uint256(r1), 1 gwei, 100 ether);
        uint256 reward2 = bound(uint256(r2), 1 gwei, 100 ether);

        _stake(alice, stakeA);
        _stake(bob, stakeB);

        _notify(reward1);

        // Partially through the first stream, bob unwinds half his stake.
        vm.warp(block.timestamp + 1 days);
        vm.prank(bob);
        staking.withdraw(stakeB / 2);

        // Top-up folds the un-vested leftover into a fresh full-duration stream.
        _notify(reward2);

        // Warp past periodFinish so everything fully vests.
        vm.warp(block.timestamp + staking.rewardsDuration() + 1);

        uint256 aBefore = alice.balance;
        uint256 bBefore = bob.balance;
        vm.prank(alice);
        staking.claim();
        vm.prank(bob);
        staking.claim();

        uint256 claimed = (alice.balance - aBefore) + (bob.balance - bBefore);
        uint256 notified = reward1 + reward2;

        assertLe(claimed, notified, "claims can never exceed notified revenue");
        assertEq(claimed + address(staking).balance, notified, "ETH conservation inside the vault");
        assertEq(staking.totalRewardsClaimed(), claimed, "accounting matches actual payout");
    }

    /// @dev Equal stakes entered together earn EXACTLY equal rewards from a
    ///      stream: identical stake, checkpoint and rewardPerToken → exact.
    function testFuzz_fairness(uint96 s, uint96 r) public {
        uint256 stakeAmt = bound(uint256(s), 1e18, 1e26);
        uint256 reward = bound(uint256(r), 1 gwei, 100 ether);

        _stake(alice, stakeAmt);
        _stake(bob, stakeAmt);
        _stream(reward);

        assertEq(staking.earned(alice), staking.earned(bob), "equal stakes, equal earnings");

        uint256 aBefore = alice.balance;
        uint256 bBefore = bob.balance;
        vm.prank(alice);
        staking.claim();
        vm.prank(bob);
        staking.claim();
        assertEq(alice.balance - aBefore, bob.balance - bBefore, "equal stakes, equal payouts");
    }
}
