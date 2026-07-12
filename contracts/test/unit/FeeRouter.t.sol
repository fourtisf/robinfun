// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseSetup} from "../BaseSetup.t.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {RobinfunToken} from "../../src/RobinfunToken.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract FeeRouterTest is BaseSetup {
    uint16 internal constant BUY_LEVY = 300; // 3%
    uint16 internal constant SELL_LEVY = 300;

    // ---------------------------------------------------------------- collect* gating

    function test_collect_unknownTokenReverts() public {
        address rando = makeAddr("rando");

        vm.startPrank(alice);
        vm.expectRevert(FeeRouter.UnknownToken.selector);
        feeRouter.collectCurveFee{value: 1 ether}(rando);

        vm.expectRevert(FeeRouter.UnknownToken.selector);
        feeRouter.collectLevy{value: 1 ether}(rando);

        vm.expectRevert(FeeRouter.UnknownToken.selector);
        feeRouter.collectDeployFee{value: 1 ether}(rando);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- split math

    function test_split_curveBuyRoutes90_10() public {
        (RobinfunToken token, BondingCurve curve) = createToken(BUY_LEVY, SELL_LEVY);

        vm.prank(alice);
        curve.buy{value: 1 ether}(0, block.timestamp);

        // Gross 1 ETH: fee = 1% = 1e16 (100% protocol); levy = 3% = 3e16,
        // split 90% creator (2.7e16) / 10% protocol (3e15).
        uint256 fee = 1e16;
        uint256 levyProtocolCut = 3e15;

        assertEq(feeRouter.protocolPending(), DEPLOY_FEE + fee + levyProtocolCut);
        assertEq(feeRouter.creatorOwed(address(token)), 2.7e16);
        assertEq(feeRouter.creatorEarnedLifetime(address(token)), 2.7e16);
        assertEq(feeRouter.totalCreatorOwed(), 2.7e16);
        assertEq(feeRouter.protocolEarnedLifetime(), DEPLOY_FEE + fee + levyProtocolCut);
    }

    // ---------------------------------------------------------------- claim

    function test_claim_nonCreatorReverts() public {
        (RobinfunToken token, BondingCurve curve) = createToken(BUY_LEVY, SELL_LEVY);
        vm.prank(alice);
        curve.buy{value: 1 ether}(0, block.timestamp);

        vm.prank(alice);
        vm.expectRevert(FeeRouter.NotCreator.selector);
        feeRouter.claim(address(token));
    }

    function test_claim_paysCreatorExactlyOnce() public {
        (RobinfunToken token, BondingCurve curve) = createToken(BUY_LEVY, SELL_LEVY);
        vm.prank(alice);
        curve.buy{value: 1 ether}(0, block.timestamp);

        uint256 owed = feeRouter.creatorOwed(address(token));
        assertEq(owed, 2.7e16);

        uint256 balBefore = creator.balance;
        vm.prank(creator);
        feeRouter.claim(address(token));

        assertEq(creator.balance - balBefore, owed);
        assertEq(feeRouter.creatorOwed(address(token)), 0);
        assertEq(feeRouter.totalCreatorOwed(), 0);
        // Lifetime accounting survives the claim.
        assertEq(feeRouter.creatorEarnedLifetime(address(token)), owed);

        vm.prank(creator);
        vm.expectRevert(FeeRouter.NothingToDo.selector);
        feeRouter.claim(address(token));
    }

    function test_claim_followsCreatorTransfer() public {
        (RobinfunToken token, BondingCurve curve) = createToken(BUY_LEVY, SELL_LEVY);
        vm.prank(alice);
        curve.buy{value: 1 ether}(0, block.timestamp);

        // Two-step creator hand-off to bob.
        vm.prank(creator);
        token.transferCreator(bob);
        vm.prank(bob);
        token.acceptCreator();

        // The old creator can no longer claim.
        vm.prank(creator);
        vm.expectRevert(FeeRouter.NotCreator.selector);
        feeRouter.claim(address(token));

        // The NEW creator claims the accrued earnings.
        uint256 owed = feeRouter.creatorOwed(address(token));
        uint256 balBefore = bob.balance;
        vm.prank(bob);
        feeRouter.claim(address(token));
        assertEq(bob.balance - balBefore, owed);
        assertEq(feeRouter.creatorOwed(address(token)), 0);
    }

    // ---------------------------------------------------------------- claimMany

    function test_claimMany_sweepsAllInOneTransfer() public {
        (RobinfunToken a, BondingCurve curveA) = createToken(BUY_LEVY, SELL_LEVY);
        (RobinfunToken b, BondingCurve curveB) = createToken(BUY_LEVY, SELL_LEVY);

        vm.prank(alice);
        curveA.buy{value: 1 ether}(0, block.timestamp);
        vm.prank(alice);
        curveB.buy{value: 2 ether}(0, block.timestamp);

        uint256 owedA = feeRouter.creatorOwed(address(a));
        uint256 owedB = feeRouter.creatorOwed(address(b));
        assertGt(owedA, 0);
        assertGt(owedB, 0);

        address[] memory tokens = new address[](2);
        tokens[0] = address(a);
        tokens[1] = address(b);

        uint256 balBefore = creator.balance;
        vm.prank(creator);
        feeRouter.claimMany(tokens);

        assertEq(creator.balance - balBefore, owedA + owedB);
        assertEq(feeRouter.creatorOwed(address(a)), 0);
        assertEq(feeRouter.creatorOwed(address(b)), 0);
        assertEq(feeRouter.totalCreatorOwed(), 0);

        // Nothing left to sweep.
        vm.prank(creator);
        vm.expectRevert(FeeRouter.NothingToDo.selector);
        feeRouter.claimMany(tokens);
    }

    // ---------------------------------------------------------------- harvest

    function test_harvest_swapsLevyInventoryAndSplits() public {
        (RobinfunToken token, BondingCurve curve) = createToken(BUY_LEVY, SELL_LEVY);
        graduate(token, curve);

        // Post-graduation DEX buy: the pair→bob transfer skims the 3% buy
        // levy in TOKENS to the fee router.
        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(token);
        vm.prank(bob);
        dexRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 0.5 ether}(0, path, bob, block.timestamp);

        uint256 inventory = token.balanceOf(address(feeRouter));
        assertGt(inventory, 0, "DEX buy must skim levy tokens to the router");

        uint256 ethBefore = address(feeRouter).balance;
        uint256 creatorOwedBefore = feeRouter.creatorOwed(address(token));
        uint256 protocolBefore = feeRouter.protocolPending();

        // Permissionless: a random keeper harvests.
        vm.prank(makeAddr("keeper"));
        feeRouter.harvest(address(token), 0, block.timestamp);

        // Harvest proceeds = the router's own ETH balance delta (swap output
        // is paid to the router and immediately split, staying in-contract).
        uint256 ethOut = address(feeRouter).balance - ethBefore;
        assertGt(ethOut, 0);
        assertEq(token.balanceOf(address(feeRouter)), 0, "all inventory swapped");

        // Harvested tokens = creator levy (3%) + the 0.5% protocol fee, so the
        // creator is owed 90% of only the levy portion: ethOut * (300*0.9)/(300+50).
        uint256 levyRate = (uint256(BUY_LEVY) + SELL_LEVY) / 2;
        uint256 totalRate = levyRate + token.PROTOCOL_FEE_BPS();
        uint256 creatorShare = (ethOut * ((levyRate * 9_000) / BPS)) / totalRate;
        assertEq(feeRouter.creatorOwed(address(token)) - creatorOwedBefore, creatorShare);
        assertEq(feeRouter.protocolPending() - protocolBefore, ethOut - creatorShare);
    }

    /// @dev The whole point of the protocol fee: a token launched with a 0/0
    ///      creator levy STILL earns Robinfun 0.5% on every post-graduation DEX
    ///      trade, and 100% of it goes to the protocol (nothing to the creator).
    function test_harvest_zeroLevyTokenEarnsProtocolPostGraduation() public {
        (RobinfunToken t0, BondingCurve c0) = createToken(0, 0);
        graduate(t0, c0);

        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(t0);
        vm.prank(bob);
        dexRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 0.5 ether}(0, path, bob, block.timestamp);
        assertGt(t0.balanceOf(address(feeRouter)), 0, "0.5% protocol fee skimmed even at 0/0");

        uint256 creatorBefore = feeRouter.creatorOwed(address(t0));
        uint256 protocolBefore = feeRouter.protocolPending();
        feeRouter.harvest(address(t0), 0, block.timestamp);

        assertEq(feeRouter.creatorOwed(address(t0)), creatorBefore, "0/0 creator earns nothing");
        assertGt(feeRouter.protocolPending() - protocolBefore, 0, "protocol earns from a 0/0 token after graduation");
    }

    function test_harvest_zeroInventoryReverts() public {
        (RobinfunToken token, BondingCurve curve) = createToken(BUY_LEVY, SELL_LEVY);
        graduate(token, curve);

        vm.expectRevert(FeeRouter.NothingToDo.selector);
        feeRouter.harvest(address(token), 0, block.timestamp);
    }

    function test_harvest_unknownTokenReverts() public {
        vm.expectRevert(FeeRouter.UnknownToken.selector);
        feeRouter.harvest(makeAddr("unknown"), 0, block.timestamp);
    }

    /// @dev With a keeper gate set, only the keeper may harvest; unsetting it
    ///      restores permissionless behavior.
    function test_harvest_keeperGate() public {
        (RobinfunToken token, BondingCurve curve) = createToken(BUY_LEVY, SELL_LEVY);
        graduate(token, curve);
        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(token);
        vm.prank(bob);
        dexRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 0.5 ether}(0, path, bob, block.timestamp);

        address keeper = makeAddr("keeper");
        vm.prank(protocolMultisig);
        feeRouter.setHarvester(keeper);

        // A random caller is now rejected.
        vm.prank(alice);
        vm.expectRevert(FeeRouter.NotHarvester.selector);
        feeRouter.harvest(address(token), 0, block.timestamp);

        // The keeper can harvest.
        vm.prank(keeper);
        feeRouter.harvest(address(token), 0, block.timestamp);
        assertEq(token.balanceOf(address(feeRouter)), 0, "keeper harvested");
    }

    function test_setHarvester_onlyOwner() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        feeRouter.setHarvester(alice);
    }

    // ---------------------------------------------------------------- flushProtocol

    function test_flushProtocol_toTreasuryWhenNoVault() public {
        (, BondingCurve curve) = createToken(BUY_LEVY, SELL_LEVY);
        vm.prank(alice);
        curve.buy{value: 1 ether}(0, block.timestamp);

        uint256 pending = feeRouter.protocolPending();
        assertGt(pending, 0);

        uint256 balBefore = treasury.balance;
        vm.prank(carol); // permissionless
        feeRouter.flushProtocol();

        assertEq(treasury.balance - balBefore, pending);
        assertEq(feeRouter.protocolPending(), 0);
    }

    function test_flushProtocol_toStakingVaultWhenSet() public {
        // Someone stakes ROBIN first so notifyReward has a live distribution.
        vm.startPrank(protocolMultisig);
        robin.approve(address(staking), 1_000e18);
        staking.stake(1_000e18);
        feeRouter.setStakingVault(address(staking));
        vm.stopPrank();

        (, BondingCurve curve) = createToken(BUY_LEVY, SELL_LEVY);
        vm.prank(alice);
        curve.buy{value: 1 ether}(0, block.timestamp);

        uint256 pending = feeRouter.protocolPending();
        assertGt(pending, 0);

        uint256 balBefore = address(staking).balance;
        vm.prank(carol);
        feeRouter.flushProtocol();

        assertEq(address(staking).balance - balBefore, pending);
        assertEq(feeRouter.protocolPending(), 0);
        assertEq(staking.totalRewardsNotified(), pending);

        // The vault streams rewards over time; after the window the sole
        // staker has earned (approximately) the whole flushed amount.
        vm.warp(block.timestamp + staking.rewardsDuration());
        assertApproxEqRel(staking.earned(protocolMultisig), pending, 1e12);
    }

    function test_flushProtocol_zeroPendingReverts() public {
        assertEq(feeRouter.protocolPending(), 0);
        vm.expectRevert(FeeRouter.NothingToDo.selector);
        feeRouter.flushProtocol();
    }

    // ---------------------------------------------------------------- owner config

    function test_setFactory_alreadySetReverts() public {
        vm.prank(protocolMultisig);
        vm.expectRevert(FeeRouter.AlreadySet.selector);
        feeRouter.setFactory(makeAddr("otherFactory"));
    }

    function test_setFactory_zeroAddressReverts() public {
        vm.prank(protocolMultisig);
        vm.expectRevert(FeeRouter.ZeroAddress.selector);
        feeRouter.setFactory(address(0));
    }

    function test_config_nonOwnerReverts() public {
        address target = makeAddr("target");
        bytes memory err = abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice);

        vm.startPrank(alice);
        vm.expectRevert(err);
        feeRouter.setFactory(target);

        vm.expectRevert(err);
        feeRouter.setDexRouter(target);

        vm.expectRevert(err);
        feeRouter.setStakingVault(target);

        vm.expectRevert(err);
        feeRouter.setTreasury(target);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- sweepUnaccounted

    function test_sweepUnaccounted_sweepsOnlyStrayEth() public {
        (RobinfunToken token, BondingCurve curve) = createToken(BUY_LEVY, SELL_LEVY);
        vm.prank(alice);
        curve.buy{value: 1 ether}(0, block.timestamp);

        uint256 owed = feeRouter.creatorOwed(address(token));
        uint256 pending = feeRouter.protocolPending();

        // Stray ETH lands via receive() outside any accounted flow.
        vm.prank(alice);
        (bool ok,) = payable(address(feeRouter)).call{value: 1 ether}("");
        assertTrue(ok);

        uint256 balBefore = treasury.balance;
        vm.prank(protocolMultisig);
        feeRouter.sweepUnaccounted();

        assertEq(treasury.balance - balBefore, 1 ether);
        // Accounted balances are untouched and still fully backed.
        assertEq(feeRouter.creatorOwed(address(token)), owed);
        assertEq(feeRouter.protocolPending(), pending);
        assertEq(address(feeRouter).balance, owed + pending);
    }

    function test_sweepUnaccounted_nonOwnerReverts() public {
        vm.prank(alice);
        (bool ok,) = payable(address(feeRouter)).call{value: 1 ether}("");
        assertTrue(ok);

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice));
        feeRouter.sweepUnaccounted();
    }

    // ---------------------------------------------------------------- rescueToken

    function test_rescueToken_plainErc20() public {
        JunkToken junk = new JunkToken(1_000e18);
        junk.transfer(address(feeRouter), 500e18);

        vm.prank(protocolMultisig);
        feeRouter.rescueToken(address(junk), treasury);

        assertEq(junk.balanceOf(treasury), 500e18);
        assertEq(junk.balanceOf(address(feeRouter)), 0);
    }

    function test_rescueToken_robinfunTokenReverts() public {
        (RobinfunToken token,) = createToken(BUY_LEVY, SELL_LEVY);

        vm.prank(protocolMultisig);
        vm.expectRevert(FeeRouter.CannotRescueRobinfunToken.selector);
        feeRouter.rescueToken(address(token), treasury);
    }

    receive() external payable {}
}

/// @dev Throwaway ERC-20 for the rescue test — NOT a Robinfun token.
contract JunkToken is ERC20 {
    constructor(uint256 supply) ERC20("Junk", "JUNK") {
        _mint(msg.sender, supply);
    }
}
