// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseSetup} from "../BaseSetup.t.sol";
import {RobinfunFactory} from "../../src/RobinfunFactory.sol";
import {RobinfunToken} from "../../src/RobinfunToken.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";

/// @dev Regression tests for the 2026-07-13 internal security-audit fixes
///      (contracts/audit/INTERNAL_AUDIT.md): M-2, M-5/I-1, L-1, L-3.
contract AuditFixesTest is BaseSetup {
    // ---------------------------------------------------------------- helpers

    function _dexBuy(RobinfunToken token, uint256 ethIn, address to) internal {
        address[] memory path = new address[](2);
        path[0] = address(weth);
        path[1] = address(token);
        vm.prank(to);
        dexRouter.swapExactETHForTokensSupportingFeeOnTransferTokens{value: ethIn}(0, path, to, block.timestamp);
    }

    function _dexSellAll(RobinfunToken token, address who) internal {
        uint256 bal = token.balanceOf(who);
        address[] memory path = new address[](2);
        path[0] = address(token);
        path[1] = address(weth);
        vm.startPrank(who);
        token.approve(address(dexRouter), bal);
        dexRouter.swapExactTokensForETHSupportingFeeOnTransferTokens(bal, 0, path, who, block.timestamp);
        vm.stopPrank();
    }

    function _stakeRobin(address who, uint256 amount) internal {
        vm.prank(protocolMultisig);
        robin.transfer(who, amount);
        vm.startPrank(who);
        robin.approve(address(staking), amount);
        staking.stake(amount);
        vm.stopPrank();
    }

    function _notifyEth(uint256 amount) internal {
        vm.deal(address(feeRouter), amount);
        vm.prank(address(feeRouter));
        staking.notifyReward{value: amount}();
    }

    function _params() internal pure returns (RobinfunFactory.CreateParams memory) {
        return RobinfunFactory.CreateParams({
            name: "Hood Rat",
            symbol: "HOODRAT",
            metadataURI: "",
            buyLevyBps: 0,
            sellLevyBps: 0,
            decayAtGraduation: false,
            renounceRateControl: false,
            devBuyMinTokensOut: 0,
            vanitySalt: bytes32(0),
            maxDeployFee: 0
        });
    }

    // ================================================================ M-2
    /// @dev The DEX router is one-shot: it cannot be re-pointed at a malicious
    ///      contract that would drain the levy inventory approved during harvest.
    function test_M2_setDexRouter_isOneShot() public {
        // setUp() already set the router once.
        vm.prank(protocolMultisig);
        vm.expectRevert(FeeRouter.AlreadySet.selector);
        feeRouter.setDexRouter(makeAddr("evilRouter"));
    }

    // ================================================================ M-5 / I-1
    /// @dev Exact harvest split. A token with buyLevy=10%, sellLevy=0%: a pure
    ///      SELL skims ONLY the 0.5% protocol fee, so the creator must be owed
    ///      NOTHING from that harvest. The old average-rate heuristic
    ///      (levyRate=(1000+0)/2=500) wrongly credited the creator ~82% of it —
    ///      i.e. paid the creator the protocol's money.
    function test_M5_sellOnlyVolume_paysCreatorNothing() public {
        (RobinfunToken token, BondingCurve curve) = createToken(1000, 0);
        graduate(token, curve);

        // Give bob tokens via a DEX buy (skims the 10% buy levy → creator basis),
        // then harvest so the composition counters start clean for the sell.
        _dexBuy(token, 1 ether, bob);
        uint256 creatorBeforeBuyHarvest = feeRouter.creatorOwed(address(token));
        feeRouter.harvest(address(token), 0, block.timestamp);
        assertGt(
            feeRouter.creatorOwed(address(token)) - creatorBeforeBuyHarvest, 0, "buy levy pays the creator (sanity)"
        );

        // Isolated SELL: sellLevy is 0, so only the protocol fee is skimmed.
        _dexSellAll(token, bob);
        assertEq(token.levyBasisAccrued(), 0, "sellLevy 0 => zero creator-levy basis");
        assertGt(token.protocolBasisAccrued(), 0, "protocol fee basis accrued");

        uint256 creatorBefore = feeRouter.creatorOwed(address(token));
        uint256 protocolBefore = feeRouter.protocolPending();
        feeRouter.harvest(address(token), 0, block.timestamp);

        assertEq(feeRouter.creatorOwed(address(token)), creatorBefore, "creator earns 0 from a pure protocol-fee harvest");
        assertGt(feeRouter.protocolPending(), protocolBefore, "protocol keeps 100% of it");
    }

    /// @dev The symmetric common case still splits correctly (creator + protocol
    ///      exactly reconstruct the harvest, no value created or lost).
    function test_M5_split_conservesValue() public {
        (RobinfunToken token, BondingCurve curve) = createToken(300, 300);
        graduate(token, curve);
        _dexBuy(token, 1 ether, bob);

        uint256 creatorBefore = feeRouter.creatorOwed(address(token));
        uint256 protocolBefore = feeRouter.protocolPending();
        uint256 ethBefore = address(feeRouter).balance;
        feeRouter.harvest(address(token), 0, block.timestamp);
        uint256 ethOut = address(feeRouter).balance - ethBefore;

        uint256 dCreator = feeRouter.creatorOwed(address(token)) - creatorBefore;
        uint256 dProtocol = feeRouter.protocolPending() - protocolBefore;
        assertEq(dCreator + dProtocol, ethOut, "split conserves the harvested ETH exactly");
        assertGt(dCreator, 0);
    }

    // ================================================================ L-1
    /// @dev Emptying the vault mid-stream parks the un-emitted remainder instead
    ///      of stranding it; it then re-streams to the next staker (conserved).
    function test_L1_emptyingVault_parksAndReStreams() public {
        _stakeRobin(alice, 100e18);
        _notifyEth(7 ether); // ~1 ETH/day for 7 days
        vm.warp(block.timestamp + 2 days);

        vm.prank(alice);
        staking.withdraw(100e18);
        assertEq(staking.totalStaked(), 0);
        assertEq(staking.rewardRate(), 0, "stale stream ended on empty vault");
        uint256 parked = staking.pendingUndistributed();
        assertApproxEqRel(parked, 5 ether, 0.02e18, "~5 ETH remainder parked, not stranded");

        // Re-stream the parked remainder to a fresh staker.
        _stakeRobin(bob, 100e18);
        _notifyEth(0); // amount = pendingUndistributed; folds the parked funds in
        assertEq(staking.pendingUndistributed(), 0, "parked funds re-streamed");
        vm.warp(block.timestamp + staking.rewardsDuration());
        assertApproxEqRel(staking.earned(bob), parked, 0.02e18, "parked remainder reaches the new staker");
    }

    /// @dev A notify too small to emit a non-zero rate is re-parked, not stranded.
    function test_L1_dustNotify_reparks() public {
        _stakeRobin(alice, 100e18);
        uint256 dust = staking.rewardsDuration() - 1; // < duration => rate floors to 0
        _notifyEth(dust);
        assertEq(staking.rewardRate(), 0, "dust does not start a stream");
        assertEq(staking.pendingUndistributed(), dust, "dust re-parked, not stranded");
    }

    /// @dev flushProtocol refuses sub-floor amounts, bounding stream-reset griefing.
    function test_L1_flushProtocol_belowMinReverts() public {
        (, BondingCurve curve) = createToken(0, 0);
        // The deploy fee already sits in protocolPending; flush it to start clean.
        feeRouter.flushProtocol();
        assertEq(feeRouter.protocolPending(), 0);

        // 0.05 ETH curve buy → 1% fee = 0.0005 ETH < MIN_FLUSH (0.001).
        vm.prank(alice);
        curve.buy{value: 0.05 ether}(0, block.timestamp);
        assertLt(feeRouter.protocolPending(), feeRouter.MIN_FLUSH());
        vm.expectRevert(FeeRouter.NothingToDo.selector);
        feeRouter.flushProtocol();

        // Accrue past the floor → flush succeeds (to treasury; staking vault unset).
        vm.prank(alice);
        curve.buy{value: 0.2 ether}(0, block.timestamp);
        assertGe(feeRouter.protocolPending(), feeRouter.MIN_FLUSH());
        feeRouter.flushProtocol();
        assertEq(feeRouter.protocolPending(), 0, "flushed");
    }

    // ================================================================ L-3
    /// @dev maxDeployFee reverts if the owner front-ran the deploy fee higher,
    ///      protecting the creator's dev-buy ETH.
    function test_L3_maxDeployFee_guardsAgainstFrontRun() public {
        vm.prank(protocolMultisig);
        factory.setDeployFee(0.5 ether);

        RobinfunFactory.CreateParams memory p = _params();
        p.maxDeployFee = 0.1 ether; // creator only expected a ~0.1 ETH fee

        vm.deal(creator, 5 ether);
        vm.prank(creator);
        vm.expectRevert(RobinfunFactory.DeployFeeTooHigh.selector);
        factory.createToken{value: 0.6 ether}(p);

        // With the cap at/above the live fee, it goes through.
        p.maxDeployFee = 0.5 ether;
        vm.prank(creator);
        factory.createToken{value: 0.6 ether}(p);
    }

    /// @dev maxDeployFee = 0 keeps the old (unguarded) behaviour.
    function test_L3_maxDeployFee_zeroDisablesGuard() public {
        vm.prank(protocolMultisig);
        factory.setDeployFee(0.5 ether);
        RobinfunFactory.CreateParams memory p = _params(); // maxDeployFee 0
        vm.deal(creator, 5 ether);
        vm.prank(creator);
        factory.createToken{value: 0.6 ether}(p); // succeeds despite the raised fee
    }
}
