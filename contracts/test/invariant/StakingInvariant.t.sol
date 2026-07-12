// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BaseSetup} from "../BaseSetup.t.sol";
import {ROBIN} from "../../src/ROBIN.sol";
import {RobinStaking} from "../../src/RobinStaking.sol";

/// @dev Randomized stake/withdraw/claim/notify sequences.
contract StakingHandler is Test {
    ROBIN public robin;
    RobinStaking public staking;
    address public distributor;

    address[3] public actors;
    uint256 public ghostNotified; // ETH pushed in while stakers existed or parked
    uint256 public ghostClaimed; // ETH paid out

    constructor(ROBIN robin_, RobinStaking staking_, address distributor_) {
        robin = robin_;
        staking = staking_;
        distributor = distributor_;
        actors[0] = makeAddr("s_actor0");
        actors[1] = makeAddr("s_actor1");
        actors[2] = makeAddr("s_actor2");
    }

    function seed(address from) external {
        vm.startPrank(from);
        for (uint256 i; i < 3; ++i) {
            robin.transfer(actors[i], 100_000_000e18);
        }
        vm.stopPrank();
    }

    function stake(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % 3];
        uint256 bal = robin.balanceOf(actor);
        if (bal == 0) return;
        amount = bound(amount, 1, bal);
        vm.startPrank(actor);
        robin.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    function withdraw(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % 3];
        uint256 staked = staking.stakedBalance(actor);
        if (staked == 0) return;
        amount = bound(amount, 1, staked);
        vm.prank(actor);
        staking.withdraw(amount);
    }

    function claim(uint256 actorSeed) external {
        address actor = actors[actorSeed % 3];
        uint256 before = actor.balance;
        vm.prank(actor);
        staking.claim();
        ghostClaimed += actor.balance - before;
    }

    function notify(uint256 amount) external {
        amount = bound(amount, 1 wei, 50 ether);
        vm.deal(distributor, amount);
        vm.prank(distributor);
        staking.notifyReward{value: amount}();
        ghostNotified += amount;
    }
}

contract StakingInvariantTest is BaseSetup {
    StakingHandler internal handler;

    function setUp() public override {
        super.setUp();
        handler = new StakingHandler(robin, staking, address(feeRouter));
        handler.seed(protocolMultisig);
        targetContract(address(handler));
    }

    /// @notice Reward conservation: claims can never exceed revenue in, and
    ///         every un-claimed wei is still sitting in the vault.
    function invariant_rewardConservation() public view {
        assertLe(handler.ghostClaimed(), handler.ghostNotified(), "sum(claims) <= sum(revenue)");
        assertEq(
            address(staking).balance,
            handler.ghostNotified() - handler.ghostClaimed(),
            "vault balance == notified - claimed"
        );
    }

    /// @notice Claimable rewards (checkpointed + streaming + parked) are
    ///         always covered by the vault's actual ETH.
    function invariant_earnedCovered() public view {
        uint256 owed = staking.pendingUndistributed();
        for (uint256 i; i < 3; ++i) {
            owed += staking.earned(handler.actors(i));
        }
        assertLe(owed, address(staking).balance, "owed <= vault balance");
    }

    /// @notice Stake accounting: the vault's ROBIN balance always equals the
    ///         sum of individual stakes, which equals totalStaked.
    function invariant_stakeAccounting() public view {
        uint256 sum;
        for (uint256 i; i < 3; ++i) {
            sum += staking.stakedBalance(handler.actors(i));
        }
        assertEq(sum, staking.totalStaked(), "sum(stakes) == totalStaked");
        assertEq(robin.balanceOf(address(staking)), sum, "vault ROBIN == totalStaked");
    }
}
