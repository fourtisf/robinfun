// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseSetup} from "../BaseSetup.t.sol";
import {RobinStaking} from "../../src/RobinStaking.sol";

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

    /// @dev Pushes `amount` ETH of protocol revenue as the FeeRouter.
    function _notify(uint256 amount) internal {
        vm.deal(address(feeRouter), amount);
        vm.prank(address(feeRouter));
        staking.notifyReward{value: amount}();
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

        // Same block, no warp: unstake is instant.
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

    function test_withdraw_moreThanStakedReverts() public {
        _stake(alice, 100e18);
        vm.prank(alice);
        vm.expectRevert(RobinStaking.InsufficientStake.selector);
        staking.withdraw(100e18 + 1);
    }

    function test_withdraw_rewardsSurviveFullExitOfStake() public {
        _stake(alice, 100e18);
        _notify(2 ether);

        vm.prank(alice);
        staking.withdraw(100e18);

        // Fully unstaked, but the accrued ETH is still claimable.
        assertEq(staking.stakedBalance(alice), 0);
        assertEq(staking.earned(alice), 2 ether);

        uint256 balBefore = alice.balance;
        vm.prank(alice);
        staking.claim();
        assertEq(alice.balance - balBefore, 2 ether);
        assertEq(staking.earned(alice), 0);
    }

    // ---------------------------------------------------------------- notifyReward auth

    function test_notifyReward_nonDistributorReverts() public {
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        vm.expectRevert(RobinStaking.NotDistributor.selector);
        staking.notifyReward{value: 1 ether}();
    }

    function test_notifyReward_distributorWorks() public {
        _stake(alice, 100e18);
        _notify(1 ether);
        assertEq(address(staking).balance, 1 ether);
        assertEq(staking.totalRewardsNotified(), 1 ether);
    }

    // ---------------------------------------------------------------- reward math

    function test_rewards_singleStakerExact() public {
        _stake(alice, 100e18);
        _notify(1 ether);

        assertEq(staking.earned(alice), 1 ether);

        uint256 balBefore = alice.balance;
        vm.prank(alice);
        staking.claim();
        assertEq(alice.balance - balBefore, 1 ether, "claim pays exactly what was earned");
        assertEq(staking.earned(alice), 0, "claim resets accrual");
        assertEq(staking.totalRewardsClaimed(), 1 ether);

        // Second claim with nothing accrued is a no-op, not a revert.
        uint256 balAfter = alice.balance;
        vm.prank(alice);
        staking.claim();
        assertEq(alice.balance, balAfter, "empty claim moves no ETH");
    }

    function test_rewards_proRata() public {
        _stake(alice, 300e18);
        _stake(bob, 100e18);
        _notify(4 ether);

        assertEq(staking.earned(alice), 3 ether);
        assertEq(staking.earned(bob), 1 ether);

        uint256 aBefore = alice.balance;
        uint256 bBefore = bob.balance;
        vm.prank(alice);
        staking.claim();
        vm.prank(bob);
        staking.claim();
        assertEq(alice.balance - aBefore, 3 ether);
        assertEq(bob.balance - bBefore, 1 ether);
    }

    // ---------------------------------------------------------------- checkpointing / no retroactive rewards

    function test_rewards_noRetroactiveForLateStaker() public {
        _stake(alice, 100e18);
        _notify(1 ether);

        // Bob flash-stakes 10,000x alice AFTER the revenue arrived.
        _stake(bob, 1_000_000e18);

        assertEq(staking.earned(bob), 0, "late staker gets nothing retroactively");
        assertEq(staking.earned(alice), 1 ether, "incumbent keeps the full past notification");

        // A new notification splits pro-rata from this point on.
        // 1.0001 ether over 1,000,100e18 staked divides exactly:
        //   alice: 0.0001 ether, bob: 1 ether.
        _notify(1.0001 ether);
        assertEq(staking.earned(alice), 1 ether + 0.0001 ether);
        assertEq(staking.earned(bob), 1 ether);
    }

    function test_rewards_stakeAfterNotifyThenClaimYieldsZero() public {
        _stake(alice, 100e18);
        _notify(1 ether);

        _stake(carol, 100e18);
        uint256 balBefore = carol.balance;
        vm.prank(carol);
        staking.claim();
        assertEq(carol.balance, balBefore, "immediate claim after late stake pays nothing");
        assertEq(staking.earned(carol), 0);
    }

    // ---------------------------------------------------------------- pendingUndistributed

    function test_pendingUndistributed_parksThenFoldsIntoNextNotify() public {
        // Nobody staked: revenue is parked, not lost and not distributed.
        _notify(1 ether);
        assertEq(staking.pendingUndistributed(), 1 ether);
        assertEq(staking.totalRewardsNotified(), 0);
        assertEq(staking.earned(alice), 0);

        _stake(alice, 100e18);
        assertEq(staking.earned(alice), 0, "staking alone does not release parked funds");

        // Next notification folds the parked amount in.
        _notify(0.5 ether);
        assertEq(staking.pendingUndistributed(), 0);
        assertEq(staking.earned(alice), 1.5 ether, "alice earns parked + new");
        assertEq(staking.totalRewardsNotified(), 1.5 ether);
    }

    // ---------------------------------------------------------------- exit

    function test_exit_unstakesAndPaysInOneCall() public {
        _stake(alice, 100e18);
        _notify(1 ether);

        uint256 ethBefore = alice.balance;
        vm.prank(alice);
        staking.exit();

        assertEq(robin.balanceOf(alice), 100e18, "all stake returned");
        assertEq(alice.balance - ethBefore, 1 ether, "all rewards paid");
        assertEq(staking.stakedBalance(alice), 0);
        assertEq(staking.totalStaked(), 0);
        assertEq(staking.earned(alice), 0);
    }

    // ---------------------------------------------------------------- earned() vs claim across a sequence

    function test_earned_matchesClaimAcrossSequence() public {
        _stake(alice, 100e18);
        _notify(1 ether);
        _stake(alice, 100e18);
        _notify(1 ether);
        vm.prank(alice);
        staking.withdraw(100e18);
        _notify(1 ether);

        uint256 snapshot = staking.earned(alice);
        assertEq(snapshot, 3 ether, "sole staker earns every notification in full");

        uint256 balBefore = alice.balance;
        vm.prank(alice);
        staking.claim();
        assertEq(alice.balance - balBefore, snapshot, "claim pays exactly the earned() view");
        assertEq(staking.earned(alice), 0);
    }

    // ---------------------------------------------------------------- fuzz

    /// @dev ETH never leaks: claimed + vault balance == notified, and claims
    ///      can never exceed what was notified (dust stays in the vault).
    function testFuzz_conservation(uint96 a, uint96 b, uint96 r1, uint96 r2) public {
        uint256 stakeA = bound(uint256(a), 1e18, 4e26);
        uint256 stakeB = bound(uint256(b), 1e18, 4e26);
        uint256 reward1 = bound(uint256(r1), 1 gwei, 100 ether);
        uint256 reward2 = bound(uint256(r2), 1 gwei, 100 ether);

        _stake(alice, stakeA);
        _stake(bob, stakeB);
        _notify(reward1);

        vm.prank(bob);
        staking.withdraw(stakeB / 2);

        _notify(reward2);

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
        // Floor rounding leaves at most a few wei per notification behind.
        assertLe(notified - claimed, 4, "dust bounded to a few wei per notification");
        assertEq(staking.totalRewardsClaimed(), claimed);
    }

    /// @dev Equal stakes entered at the same time earn exactly equal rewards.
    function testFuzz_fairness(uint96 s, uint96 r) public {
        uint256 stakeAmt = bound(uint256(s), 1e18, 4e26);
        uint256 reward = bound(uint256(r), 1 gwei, 100 ether);

        _stake(alice, stakeAmt);
        _stake(bob, stakeAmt);
        _notify(reward);

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
