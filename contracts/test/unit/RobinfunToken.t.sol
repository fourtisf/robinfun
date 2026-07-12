// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseSetup} from "../BaseSetup.t.sol";
import {RobinfunToken} from "../../src/RobinfunToken.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {IRobinfunToken} from "../../src/interfaces/IRobinfun.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract RobinfunTokenTest is BaseSetup {
    RobinfunToken internal token;
    BondingCurve internal curve;

    uint16 internal constant BUY_LEVY = 500; // 5%
    uint16 internal constant SELL_LEVY = 300; // 3%

    bytes32 internal constant PERMIT_TYPEHASH =
        keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");

    function setUp() public override {
        super.setUp();
        (token, curve) = createToken(BUY_LEVY, SELL_LEVY);
    }

    // ---------------------------------------------------------------- initialization

    function test_init_state() public view {
        assertEq(token.name(), "Hood Rat");
        assertEq(token.symbol(), "HOODRAT");
        assertEq(token.decimals(), 18);

        assertEq(token.creator(), creator);
        assertEq(token.pendingCreator(), address(0));
        assertEq(token.curve(), address(curve));
        assertEq(token.feeRouter(), address(feeRouter));

        assertEq(token.buyLevyBps(), BUY_LEVY);
        assertEq(token.sellLevyBps(), SELL_LEVY);
        assertFalse(token.decayAtGraduation());
        assertFalse(token.rateControlRenounced());
        assertFalse(token.graduated());
        assertEq(token.ammPair(), address(0));
    }

    function test_init_fullSupplyMintedToCurve() public view {
        assertEq(token.TOTAL_SUPPLY(), 1_000_000_000 * 1e18);
        assertEq(token.totalSupply(), token.TOTAL_SUPPLY());
        assertEq(token.balanceOf(address(curve)), token.TOTAL_SUPPLY());
    }

    function test_init_levyExemptSetFrozen() public view {
        assertTrue(token.levyExempt(address(curve)));
        assertTrue(token.levyExempt(address(feeRouter)));
        assertTrue(token.levyExempt(address(factory))); // factory was msg.sender at init
        assertFalse(token.levyExempt(creator));
        assertFalse(token.levyExempt(alice));
    }

    function test_init_reinitializeReverts() public {
        IRobinfunToken.TokenInit memory init = IRobinfunToken.TokenInit({
            name: "Evil",
            symbol: "EVIL",
            creator: bob,
            curve: bob,
            feeRouter: bob,
            buyLevyBps: 0,
            sellLevyBps: 0,
            decayAtGraduation: false,
            renounceAtCreation: false
        });

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        token.initialize(init);

        // The shared implementation is bricked too (_disableInitializers).
        RobinfunToken impl = RobinfunToken(factory.tokenImplementation());
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(init);
    }

    // ---------------------------------------------------------------- lowerLevies

    function test_lowerLevies_creatorCanLowerBoth() public {
        vm.prank(creator);
        token.lowerLevies(200, 100);
        assertEq(token.buyLevyBps(), 200);
        assertEq(token.sellLevyBps(), 100);
    }

    function test_lowerLevies_nonCreatorReverts() public {
        vm.prank(alice);
        vm.expectRevert(RobinfunToken.NotCreator.selector);
        token.lowerLevies(100, 100);
    }

    function test_lowerLevies_raisingBuySideReverts() public {
        vm.prank(creator);
        vm.expectRevert(RobinfunToken.LevyIncreaseForbidden.selector);
        token.lowerLevies(BUY_LEVY + 1, SELL_LEVY);
    }

    function test_lowerLevies_raisingSellSideReverts() public {
        vm.prank(creator);
        vm.expectRevert(RobinfunToken.LevyIncreaseForbidden.selector);
        token.lowerLevies(BUY_LEVY, SELL_LEVY + 1);
    }

    function test_lowerLevies_toZero() public {
        vm.prank(creator);
        token.lowerLevies(0, 0);
        assertEq(token.buyLevyBps(), 0);
        assertEq(token.sellLevyBps(), 0);
    }

    function test_lowerLevies_revertsAfterRenounce() public {
        vm.startPrank(creator);
        token.renounceRateControl();
        vm.expectRevert(RobinfunToken.RateControlIsRenounced.selector);
        token.lowerLevies(100, 100);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- renounceRateControl

    function test_renounce_creatorOnly() public {
        vm.prank(alice);
        vm.expectRevert(RobinfunToken.NotCreator.selector);
        token.renounceRateControl();
    }

    function test_renounce_oneShot() public {
        vm.startPrank(creator);
        token.renounceRateControl();
        assertTrue(token.rateControlRenounced());
        vm.expectRevert(RobinfunToken.RateControlIsRenounced.selector);
        token.renounceRateControl();
        vm.stopPrank();
    }

    function test_renounce_atCreationLocksFromBirth() public {
        (RobinfunToken t2,) = createTokenFull(400, 400, false, true, 0);
        assertTrue(t2.rateControlRenounced());
        vm.prank(creator);
        vm.expectRevert(RobinfunToken.RateControlIsRenounced.selector);
        t2.lowerLevies(0, 0);
    }

    // ---------------------------------------------------------------- two-step creator transfer

    function test_transferCreator_setsPending() public {
        vm.prank(creator);
        token.transferCreator(bob);
        assertEq(token.pendingCreator(), bob);
        // Role has NOT moved yet.
        assertEq(token.creator(), creator);
    }

    function test_transferCreator_nonCreatorReverts() public {
        vm.prank(bob);
        vm.expectRevert(RobinfunToken.NotCreator.selector);
        token.transferCreator(bob);
    }

    function test_transferCreator_zeroAddressReverts() public {
        vm.prank(creator);
        vm.expectRevert(RobinfunToken.ZeroAddress.selector);
        token.transferCreator(address(0));
    }

    function test_acceptCreator_wrongAddressReverts() public {
        vm.prank(creator);
        token.transferCreator(bob);
        vm.prank(carol);
        vm.expectRevert(RobinfunToken.NotCreator.selector);
        token.acceptCreator();
    }

    function test_acceptCreator_completesTransfer() public {
        vm.prank(creator);
        token.transferCreator(bob);
        vm.prank(bob);
        token.acceptCreator();

        assertEq(token.creator(), bob);
        assertEq(token.pendingCreator(), address(0));

        // New creator holds the role; old creator lost it.
        vm.prank(creator);
        vm.expectRevert(RobinfunToken.NotCreator.selector);
        token.lowerLevies(0, 0);
        vm.prank(bob);
        token.lowerLevies(0, 0);
    }

    // ---------------------------------------------------------------- onGraduation

    function test_onGraduation_onlyCurve() public {
        vm.prank(alice);
        vm.expectRevert(RobinfunToken.NotCurve.selector);
        token.onGraduation(makeAddr("fakePair"));

        vm.prank(creator);
        vm.expectRevert(RobinfunToken.NotCurve.selector);
        token.onGraduation(makeAddr("fakePair"));
    }

    function test_onGraduation_setsPairAndFlag() public {
        address pair = graduate(token, curve);
        assertTrue(token.graduated());
        assertTrue(pair != address(0));
        assertEq(token.ammPair(), pair);
    }

    function test_onGraduation_decayHalvesLevies() public {
        (RobinfunToken t2, BondingCurve c2) = createTokenFull(500, 300, true, false, 0);
        graduate(t2, c2);
        assertEq(t2.buyLevyBps(), 250);
        assertEq(t2.sellLevyBps(), 150);
    }

    function test_onGraduation_noDecayKeepsLevies() public {
        graduate(token, curve);
        assertEq(token.buyLevyBps(), BUY_LEVY);
        assertEq(token.sellLevyBps(), SELL_LEVY);
    }

    function test_onGraduation_cannotBeCalledAgain() public {
        graduate(token, curve);
        // The curve never calls twice (its own graduated latch); any direct
        // caller — including the old pair or creator — is stopped by NotCurve.
        vm.prank(alice);
        vm.expectRevert(RobinfunToken.NotCurve.selector);
        token.onGraduation(makeAddr("secondPair"));
    }

    // ---------------------------------------------------------------- fee-on-transfer

    function test_transfer_preGraduation_walletToWalletUntaxed() public {
        vm.prank(alice);
        curve.buy{value: 1 ether}(0, block.timestamp);

        uint256 amount = 1_000e18;
        vm.prank(alice);
        token.transfer(bob, amount);

        assertEq(token.balanceOf(bob), amount);
        assertEq(token.balanceOf(address(feeRouter)), 0);
    }

    function test_transfer_sellToPairSkimsSellLevy() public {
        address pair = graduate(token, curve);
        uint256 amount = 1_000_000e18;
        uint256 levy = (amount * SELL_LEVY) / BPS;

        uint256 pairBefore = token.balanceOf(pair);
        uint256 aliceBefore = token.balanceOf(alice);

        vm.prank(alice);
        token.transfer(pair, amount);

        assertEq(token.balanceOf(pair) - pairBefore, amount - levy, "pair receives amount minus levy");
        assertEq(token.balanceOf(address(feeRouter)), levy, "levy skimmed to feeRouter");
        assertEq(aliceBefore - token.balanceOf(alice), amount, "sender debited the full amount");
    }

    function test_transfer_buyFromPairSkimsBuyLevy() public {
        address pair = graduate(token, curve);
        uint256 amount = 1_000_000e18;
        uint256 levy = (amount * BUY_LEVY) / BPS;

        uint256 pairBefore = token.balanceOf(pair);

        // Simulate the DEX buy leg: the pair pushes tokens to the buyer.
        vm.prank(pair);
        token.transfer(bob, amount);

        assertEq(token.balanceOf(bob), amount - levy, "buyer receives amount minus levy");
        assertEq(token.balanceOf(address(feeRouter)), levy, "levy skimmed to feeRouter");
        assertEq(pairBefore - token.balanceOf(pair), amount, "pair debited the full amount");
    }

    function test_transfer_postGraduation_walletToWalletUntaxed() public {
        graduate(token, curve);
        uint256 amount = 500_000e18;

        vm.prank(alice);
        token.transfer(carol, amount);

        assertEq(token.balanceOf(carol), amount);
        assertEq(token.balanceOf(address(feeRouter)), 0);
    }

    function test_transfer_exemptSenderToPairUntaxed() public {
        address pair = graduate(token, curve);

        // Fund the (levy-exempt) feeRouter with tokens via a taxed sell.
        vm.prank(alice);
        token.transfer(pair, 1_000_000e18);
        uint256 routerBal = token.balanceOf(address(feeRouter));
        assertGt(routerBal, 0);

        uint256 amount = 10_000e18;
        uint256 pairBefore = token.balanceOf(pair);

        vm.prank(address(feeRouter));
        token.transfer(pair, amount);

        assertEq(token.balanceOf(pair) - pairBefore, amount, "exempt sender pays no levy");
        assertEq(token.balanceOf(address(feeRouter)), routerBal - amount, "no skim back to feeRouter");
    }

    function test_transfer_zeroLevyNoSkim() public {
        (RobinfunToken t2, BondingCurve c2) = createToken(0, 0);
        address pair = graduate(t2, c2);

        uint256 amount = 1_000_000e18;
        uint256 pairBefore = t2.balanceOf(pair);

        vm.prank(alice);
        t2.transfer(pair, amount); // sell leg
        assertEq(t2.balanceOf(pair) - pairBefore, amount);

        vm.prank(pair);
        t2.transfer(bob, amount); // buy leg
        assertEq(t2.balanceOf(bob), amount);

        assertEq(t2.balanceOf(address(feeRouter)), 0, "zero levy: nothing skimmed");
    }

    // ---------------------------------------------------------------- anti-honeypot structure

    function test_holderCanAlwaysExitFullBalance() public {
        graduate(token, curve);

        // No owner, no pause, no blacklist, no max-wallet: a plain holder can
        // always move 100% of their balance to any fresh address.
        address freshWallet = makeAddr("freshWallet");
        uint256 bal = token.balanceOf(alice);
        assertGt(bal, 0);

        vm.prank(alice);
        token.transfer(freshWallet, bal);

        assertEq(token.balanceOf(alice), 0);
        assertEq(token.balanceOf(freshWallet), bal);

        // And the fresh wallet can move it on again, in full.
        vm.prank(freshWallet);
        token.transfer(bob, bal);
        assertEq(token.balanceOf(bob), bal);
    }

    // ---------------------------------------------------------------- ERC20Permit

    function test_permit_domainSeparatorExists() public view {
        assertTrue(token.DOMAIN_SEPARATOR() != bytes32(0));
    }

    function test_permit_signedApprovalForCurve() public {
        (address signer, uint256 pk) = makeAddrAndKey("permitSigner");
        uint256 value = 123_456e18;
        uint256 deadline = block.timestamp + 1 hours;

        assertEq(token.nonces(signer), 0);

        bytes32 structHash = keccak256(abi.encode(PERMIT_TYPEHASH, signer, address(curve), value, 0, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(pk, digest);

        token.permit(signer, address(curve), value, deadline, v, r, s);

        assertEq(token.allowance(signer, address(curve)), value);
        assertEq(token.nonces(signer), 1);
    }
}
