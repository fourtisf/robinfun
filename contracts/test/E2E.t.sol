// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseSetup} from "./BaseSetup.t.sol";
import {RobinfunToken} from "../src/RobinfunToken.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {MockUniswapV2Pair} from "./mocks/MockUniswapV2.sol";

/// @dev Full protocol lifecycle in one narrative test, mirroring the product
///      flow the prototype simulates: launch → curve trading → graduation →
///      DEX trading with the levy still active → harvest → creator claim →
///      staker rewards. This is the M1 acceptance test.
contract E2ETest is BaseSetup {
    function test_fullLifecycle() public {
        // ------------------------------------------------ 1. launch (3%/3%)
        (RobinfunToken token, BondingCurve curve) = createTokenFull(300, 300, false, false, 0.1 ether);

        // Deploy fee is protocol revenue; the dev buy seeded the curve.
        assertEq(feeRouter.protocolPending(), DEPLOY_FEE + _protocolShare(0.1 ether, 300));
        assertGt(token.balanceOf(creator), 0, "dev buy delivered");

        // ------------------------------------------------ 2. curve trading
        vm.prank(alice);
        curve.buy{value: 1 ether}(0, block.timestamp);
        vm.prank(bob);
        curve.buy{value: 0.8 ether}(0, block.timestamp);

        // Bob takes profit on the curve — sells half.
        uint256 half = token.balanceOf(bob) / 2;
        vm.startPrank(bob);
        token.approve(address(curve), half);
        curve.sell(half, 0, block.timestamp);
        vm.stopPrank();

        uint256 creatorAccruedOnCurve = feeRouter.creatorOwed(address(token));
        assertGt(creatorAccruedOnCurve, 0, "creator levy accrues from curve trades");
        assertFalse(curve.graduated());

        // ------------------------------------------------ 3. graduation
        vm.prank(carol);
        curve.buy{value: 4 ether}(0, block.timestamp);

        assertTrue(curve.graduated());
        address pair = token.ammPair();
        MockUniswapV2Pair p = MockUniswapV2Pair(pair);
        assertEq(p.balanceOf(DEAD), p.totalSupply(), "100% of LP burned");
        assertEq(weth.balanceOf(pair), GRADUATION_ETH, "all raised ETH in the pool");
        assertEq(token.balanceOf(address(curve)), 0, "curve fully drained");

        // ------------------------------------------------ 4. DEX trading — levy lives on
        address[] memory buyPath = new address[](2);
        buyPath[0] = address(weth);
        buyPath[1] = address(token);

        uint256 routerLevyBefore = token.balanceOf(address(feeRouter));
        vm.prank(alice);
        dexRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: 0.5 ether}(
            0, buyPath, alice, block.timestamp
        );
        uint256 levyTokens = token.balanceOf(address(feeRouter)) - routerLevyBefore;
        assertGt(levyTokens, 0, "buy levy skimmed on DEX trade (the differentiator)");

        // A holder can always sell on the DEX too (no honeypot post-grad).
        uint256 sellAmt = token.balanceOf(alice) / 4;
        address[] memory sellPath = new address[](2);
        sellPath[0] = address(token);
        sellPath[1] = address(weth);
        vm.startPrank(alice);
        token.approve(address(dexRouter), sellAmt);
        uint256 aliceEthBefore = alice.balance;
        dexRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(sellAmt, 0, sellPath, alice, block.timestamp);
        vm.stopPrank();
        assertGt(alice.balance, aliceEthBefore, "DEX sell paid out");

        // ------------------------------------------------ 5. harvest → 90/10 split
        uint256 creatorBefore = feeRouter.creatorOwed(address(token));
        uint256 protocolBefore = feeRouter.protocolPending();

        feeRouter.harvest(address(token), 0, block.timestamp); // permissionless keeper call

        uint256 creatorGain = feeRouter.creatorOwed(address(token)) - creatorBefore;
        uint256 protocolGain = feeRouter.protocolPending() - protocolBefore;
        assertGt(creatorGain, 0);
        assertApproxEqAbs(creatorGain, protocolGain * 9, 10, "harvest splits 90/10");
        assertEq(token.balanceOf(address(feeRouter)), 0, "levy inventory fully harvested");

        // ------------------------------------------------ 6. creator claims (Treasury page)
        uint256 owed = feeRouter.creatorOwed(address(token));
        uint256 creatorEthBefore = creator.balance;
        vm.prank(creator);
        feeRouter.claim(address(token));
        assertEq(creator.balance - creatorEthBefore, owed, "creator paid in real ETH");

        // ------------------------------------------------ 7. staking revenue share
        vm.startPrank(protocolMultisig);
        robin.transfer(alice, 300_000_000e18);
        robin.transfer(bob, 100_000_000e18);
        feeRouter.setStakingVault(address(staking));
        vm.stopPrank();

        vm.startPrank(alice);
        robin.approve(address(staking), 300_000_000e18);
        staking.stake(300_000_000e18);
        vm.stopPrank();
        vm.startPrank(bob);
        robin.approve(address(staking), 100_000_000e18);
        staking.stake(100_000_000e18);
        vm.stopPrank();

        uint256 pending = feeRouter.protocolPending();
        feeRouter.flushProtocol(); // permissionless

        // Pro-rata 75/25, paid in ETH, claimable instantly.
        assertApproxEqAbs(staking.earned(alice), (pending * 3) / 4, 4);
        assertApproxEqAbs(staking.earned(bob), pending / 4, 4);

        uint256 aliceEth = alice.balance;
        vm.prank(alice);
        staking.claim();
        assertEq(alice.balance - aliceEth, (pending * 3) / 4 - _dust(pending, 3, 4));

        // Instant unstake, no cooldown.
        vm.prank(bob);
        staking.exit();
        assertEq(robin.balanceOf(bob), 100_000_000e18);
        assertEq(staking.stakedBalance(bob), 0);
    }

    /// @dev protocol share of a gross curve buy: 1% fee + 10% of the levy.
    function _protocolShare(uint256 gross, uint16 levyBps) internal pure returns (uint256) {
        uint256 fee = (gross * CURVE_FEE_BPS) / BPS;
        uint256 levy = (gross * levyBps) / BPS;
        return fee + (levy - (levy * 9_000) / BPS);
    }

    /// @dev accumulator floor-rounding dust for a pending/num/den split.
    function _dust(uint256, uint256, uint256) internal pure returns (uint256) {
        return 0; // exact for these round stake numbers; kept for readability
    }
}
