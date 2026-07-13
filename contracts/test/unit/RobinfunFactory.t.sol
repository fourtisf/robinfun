// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseSetup} from "../BaseSetup.t.sol";
import {RobinfunFactory} from "../../src/RobinfunFactory.sol";
import {RobinfunToken} from "../../src/RobinfunToken.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {IRobinfunToken, IBondingCurve} from "../../src/interfaces/IRobinfun.sol";
import {MockWETH} from "../mocks/MockWETH.sol";
import {MockUniswapV2Factory} from "../mocks/MockUniswapV2.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";

contract RobinfunFactoryTest is BaseSetup {
    uint16 internal constant BUY_LEVY = 300; // 3%
    uint16 internal constant SELL_LEVY = 450; // 4.5%

    // ---------------------------------------------------------------- create: happy path

    function test_createToken_happyPath() public {
        RobinfunFactory.CreateParams memory p = _params("Hood Rat", "HOODRAT");
        p.decayAtGraduation = true;

        vm.prank(creator);
        (address t, address c) = factory.createToken{value: DEPLOY_FEE}(p);

        assertTrue(t != address(0));
        assertTrue(c != address(0));
        assertTrue(t != c);

        // Registry.
        assertEq(factory.curveOf(t), c);
        assertEq(factory.allTokensLength(), 1);
        assertEq(factory.allTokens(0), t);

        // Token initialized from the caller's params.
        RobinfunToken token = RobinfunToken(t);
        assertEq(token.name(), "Hood Rat");
        assertEq(token.symbol(), "HOODRAT");
        assertEq(token.creator(), creator);
        assertEq(token.curve(), c);
        assertEq(token.feeRouter(), address(feeRouter));
        assertEq(token.buyLevyBps(), BUY_LEVY);
        assertEq(token.sellLevyBps(), SELL_LEVY);
        assertTrue(token.decayAtGraduation());
        assertFalse(token.rateControlRenounced());
        assertEq(token.balanceOf(c), token.TOTAL_SUPPLY());
        assertEq(token.totalSupply(), token.TOTAL_SUPPLY());

        // Curve initialized from the factory's current config.
        BondingCurve curve = BondingCurve(payable(c));
        assertEq(address(curve.token()), t);
        assertEq(address(curve.feeRouter()), address(feeRouter));
        assertEq(address(curve.dexFactory()), address(dexFactory));
        assertEq(address(curve.weth()), address(weth));
        assertEq(curve.virtualEthReserve(), VIRTUAL_ETH);
        assertEq(curve.virtualTokenReserve(), VIRTUAL_TOKEN);
        (uint128 ve, uint128 vt, uint128 ge) = curve.params();
        assertEq(ve, VIRTUAL_ETH);
        assertEq(vt, VIRTUAL_TOKEN);
        assertEq(ge, GRADUATION_ETH);
        assertEq(curve.reserveEth(), 0);
        assertFalse(curve.graduated());
    }

    function test_createToken_emitsTokenCreated() public {
        RobinfunFactory.CreateParams memory p = _params("Hood Rat", "HOODRAT");

        // token/curve addresses (topics 1-2) aren't predictable — skip them,
        // check the creator topic and the full data payload.
        vm.expectEmit(false, false, true, true, address(factory));
        emit RobinfunFactory.TokenCreated(
            address(0), // unchecked
            address(0), // unchecked
            creator,
            "Hood Rat",
            "HOODRAT",
            "ipfs://hoodrat",
            BUY_LEVY,
            SELL_LEVY,
            false,
            false,
            DEPLOY_FEE,
            0.25 ether // devBuyEth = msg.value - deployFee
        );
        vm.prank(creator);
        factory.createToken{value: DEPLOY_FEE + 0.25 ether}(p);
    }

    // ---------------------------------------------------------------- deploy fee

    function test_deployFee_insufficientValueReverts() public {
        vm.prank(creator);
        vm.expectRevert(RobinfunFactory.InsufficientDeployFee.selector);
        factory.createToken{value: DEPLOY_FEE - 1}(_params("Hood Rat", "HOODRAT"));
    }

    function test_deployFee_exactValueWorksAndAccruesToProtocol() public {
        assertEq(feeRouter.protocolPending(), 0);

        vm.prank(creator);
        (address t,) = factory.createToken{value: DEPLOY_FEE}(_params("Hood Rat", "HOODRAT"));

        assertEq(factory.curveOf(t) != address(0), true);
        // Deploy fee is 100% protocol revenue, parked in the router.
        assertEq(feeRouter.protocolPending(), DEPLOY_FEE);
        assertEq(address(feeRouter).balance, DEPLOY_FEE);
    }

    function test_deployFee_zeroFeeAllowsFreeCreation() public {
        vm.prank(protocolMultisig);
        factory.setDeployFee(0);

        vm.prank(creator);
        (address t, address c) = factory.createToken{value: 0}(_params("Hood Rat", "HOODRAT"));

        assertEq(factory.curveOf(t), c);
        assertEq(factory.allTokensLength(), 1);
        assertEq(feeRouter.protocolPending(), 0);
    }

    function test_deployFee_newFeeAppliesToFutureLaunchesOnly() public {
        vm.prank(protocolMultisig);
        factory.setDeployFee(0.01 ether);

        // The old fee no longer clears the bar.
        vm.prank(creator);
        vm.expectRevert(RobinfunFactory.InsufficientDeployFee.selector);
        factory.createToken{value: DEPLOY_FEE}(_params("Hood Rat", "HOODRAT"));

        vm.prank(creator);
        factory.createToken{value: 0.01 ether}(_params("Hood Rat", "HOODRAT"));
        assertEq(feeRouter.protocolPending(), 0.01 ether);
    }

    // ---------------------------------------------------------------- levy validation

    function test_levy_aboveCapReverts() public {
        RobinfunFactory.CreateParams memory p = _params("Hood Rat", "HOODRAT");

        p.buyLevyBps = 1_050;
        vm.prank(creator);
        vm.expectRevert(RobinfunFactory.LevyTooHigh.selector);
        factory.createToken{value: DEPLOY_FEE}(p);

        p.buyLevyBps = 0;
        p.sellLevyBps = 1_050;
        vm.prank(creator);
        vm.expectRevert(RobinfunFactory.LevyTooHigh.selector);
        factory.createToken{value: DEPLOY_FEE}(p);
    }

    function test_levy_offStepReverts() public {
        RobinfunFactory.CreateParams memory p = _params("Hood Rat", "HOODRAT");

        p.buyLevyBps = 333;
        vm.prank(creator);
        vm.expectRevert(RobinfunFactory.LevyNotOnStep.selector);
        factory.createToken{value: DEPLOY_FEE}(p);

        p.buyLevyBps = 0;
        p.sellLevyBps = 333;
        vm.prank(creator);
        vm.expectRevert(RobinfunFactory.LevyNotOnStep.selector);
        factory.createToken{value: DEPLOY_FEE}(p);
    }

    function test_levy_maxAccepted() public {
        (RobinfunToken token,) = createToken(1_000, 1_000);
        assertEq(token.buyLevyBps(), 1_000);
        assertEq(token.sellLevyBps(), 1_000);
    }

    function test_levy_zeroAccepted() public {
        (RobinfunToken token,) = createToken(0, 0);
        assertEq(token.buyLevyBps(), 0);
        assertEq(token.sellLevyBps(), 0);
    }

    // ---------------------------------------------------------------- name / symbol validation

    function test_name_emptyReverts() public {
        vm.prank(creator);
        vm.expectRevert(RobinfunFactory.BadName.selector);
        factory.createToken{value: DEPLOY_FEE}(_params("", "HOODRAT"));
    }

    function test_name_tooLongReverts() public {
        // 65 bytes — one over the cap.
        string memory name65 = "01234567890123456789012345678901234567890123456789012345678901234";
        assertEq(bytes(name65).length, 65);

        vm.prank(creator);
        vm.expectRevert(RobinfunFactory.BadName.selector);
        factory.createToken{value: DEPLOY_FEE}(_params(name65, "HOODRAT"));
    }

    function test_symbol_emptyReverts() public {
        vm.prank(creator);
        vm.expectRevert(RobinfunFactory.BadName.selector);
        factory.createToken{value: DEPLOY_FEE}(_params("Hood Rat", ""));
    }

    function test_symbol_tooLongReverts() public {
        // 17 bytes — one over the cap.
        string memory symbol17 = "ABCDEFGHIJKLMNOPQ";
        assertEq(bytes(symbol17).length, 17);

        vm.prank(creator);
        vm.expectRevert(RobinfunFactory.BadName.selector);
        factory.createToken{value: DEPLOY_FEE}(_params("Hood Rat", symbol17));
    }

    function test_nameSymbol_boundaryLengthsAccepted() public {
        string memory name64 = "0123456789012345678901234567890123456789012345678901234567890123";
        string memory symbol16 = "ABCDEFGHIJKLMNOP";
        assertEq(bytes(name64).length, 64);
        assertEq(bytes(symbol16).length, 16);

        vm.prank(creator);
        (address t,) = factory.createToken{value: DEPLOY_FEE}(_params(name64, symbol16));
        assertEq(RobinfunToken(t).name(), name64);
        assertEq(RobinfunToken(t).symbol(), symbol16);
    }

    // ---------------------------------------------------------------- dev buy

    function test_devBuy_executesAtomicallyForCreator() public {
        uint256 devBuy = 0.5 ether;
        (RobinfunToken token, BondingCurve curve) = createTokenFull(BUY_LEVY, SELL_LEVY, false, false, devBuy);

        // The creator holds tokens straight out of the creation tx, priced
        // off the fresh virtual reserves with fees/levy taken off the gross.
        uint256 net = netIn(devBuy, BUY_LEVY);
        uint256 expectedOut = (uint256(VIRTUAL_TOKEN) * net) / (VIRTUAL_ETH + net);
        assertEq(token.balanceOf(creator), expectedOut);
        assertEq(curve.reserveEth(), net);
        assertEq(address(curve).balance, net);
        assertFalse(curve.graduated());
    }

    function test_devBuy_exactGrossGraduatesInstantly() public {
        // The exact gross whose net (after the 1% curve fee, 0% levy) lands
        // on GRADUATION_ETH to the wei — no refund leg is needed.
        uint256 gross = (uint256(GRADUATION_ETH) * BPS) / (BPS - CURVE_FEE_BPS);
        uint256 fee = (gross * CURVE_FEE_BPS) / BPS;
        assertEq(gross - fee, GRADUATION_ETH, "fixture: gross must net to the target exactly");

        uint256 balBefore = creator.balance;
        (RobinfunToken token, BondingCurve curve) = createTokenFull(0, 0, false, false, gross);

        // Graduated inside the creation tx.
        assertTrue(curve.graduated());
        assertTrue(token.graduated());
        assertGt(token.balanceOf(creator), 0);
        assertEq(weth.balanceOf(token.ammPair()), GRADUATION_ETH);

        // Creator paid deployFee + gross-needed: fee + exactly the target.
        assertEq(balBefore - creator.balance, DEPLOY_FEE + fee + GRADUATION_ETH);
        assertEq(address(factory).balance, 0);
    }

    /// @dev BUG (documented, do not "fix" the test): a dev buy that OVERSHOOTS
    ///      the graduation target should graduate the token and refund the
    ///      surplus to the creator ("capped final buy refunds surplus ETH to
    ///      the factory, which forwards it back"). But RobinfunFactory has no
    ///      receive()/fallback, so the curve's refund transfer to msg.sender
    ///      (the factory) fails and the WHOLE creation reverts with
    ///      EthTransferFailed. Intended behavior: spent = deployFee + gross
    ///      needed, surplus back to creator. Fix: add a receive() to the
    ///      factory (or refund directly to a passed-through recipient).
    /// @dev An overshooting dev buy graduates the token at creation; the
    ///      curve refunds the surplus to the factory (via its curve-gated
    ///      receive()), which forwards it to the creator.
    function test_devBuy_hugeOvershootGraduatesAndRefundsCreator() public {
        uint256 balBefore = creator.balance;

        vm.prank(creator);
        (address t, address c) = factory.createToken{value: DEPLOY_FEE + 10 ether}(_params("Hood Rat", "HOODRAT"));

        assertTrue(BondingCurve(payable(c)).graduated(), "instant graduation");
        assertGt(RobinfunToken(t).balanceOf(creator), 0, "creator holds the dev buy");

        // Creator paid deployFee + exactly (graduation target + fees on the
        // capped gross); every other wei of the 10 ETH came back, including
        // the ceil-division dust the curve refunds.
        uint256 spent = balBefore - creator.balance;
        uint256 gross = (uint256(GRADUATION_ETH) * BPS + (BPS - CURVE_FEE_BPS - BUY_LEVY) - 1)
            / (BPS - CURVE_FEE_BPS - BUY_LEVY);
        uint256 feesOnGross = (gross * CURVE_FEE_BPS) / BPS + (gross * BUY_LEVY) / BPS;
        assertEq(spent, DEPLOY_FEE + GRADUATION_ETH + feesOnGross, "surplus fully refunded");

        // Nothing stranded on the factory.
        assertEq(address(factory).balance, 0, "factory holds no ETH");
    }

    /// @dev The factory's receive() only accepts ETH from its own curves.
    function test_receive_rejectsStrayEth() public {
        vm.prank(alice);
        (bool ok,) = address(factory).call{value: 1 ether}("");
        assertFalse(ok, "stray ETH rejected");
    }

    // ---------------------------------------------------------------- owner config

    function test_ownerConfig_onlyOwner() public {
        bytes memory unauthorized = abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", alice);

        vm.prank(alice);
        vm.expectRevert(unauthorized);
        factory.setDeployFee(1 ether);

        vm.prank(alice);
        vm.expectRevert(unauthorized);
        factory.setCurveParams(IBondingCurve.CurveParams(VIRTUAL_ETH, VIRTUAL_TOKEN, GRADUATION_ETH));

        vm.prank(alice);
        vm.expectRevert(unauthorized);
        factory.setDex(address(dexFactory), address(weth));
    }

    function test_setCurveParams_onlyAffectsFutureLaunches() public {
        (, BondingCurve curveA) = createToken(0, 0);

        vm.prank(protocolMultisig);
        factory.setCurveParams(IBondingCurve.CurveParams(2 * VIRTUAL_ETH, VIRTUAL_TOKEN, GRADUATION_ETH));

        // Token A's curve is frozen at the params it launched with.
        assertEq(curveA.virtualEthReserve(), VIRTUAL_ETH);
        (uint128 veA,,) = curveA.params();
        assertEq(veA, VIRTUAL_ETH);

        // Token B picks up the new shape.
        (, BondingCurve curveB) = createToken(0, 0);
        assertEq(curveB.virtualEthReserve(), 2 * VIRTUAL_ETH);
        (uint128 veB, uint128 vtB, uint128 geB) = curveB.params();
        assertEq(veB, 2 * VIRTUAL_ETH);
        assertEq(vtB, VIRTUAL_TOKEN);
        assertEq(geB, GRADUATION_ETH);
    }

    function test_setDex_onlyAffectsFutureLaunches() public {
        (, BondingCurve curveA) = createToken(0, 0);

        MockWETH weth2 = new MockWETH();
        MockUniswapV2Factory dex2 = new MockUniswapV2Factory();
        vm.prank(protocolMultisig);
        factory.setDex(address(dex2), address(weth2));

        assertEq(factory.dexFactory(), address(dex2));
        assertEq(factory.weth(), address(weth2));
        assertEq(address(curveA.dexFactory()), address(dexFactory));
        assertEq(address(curveA.weth()), address(weth));

        (, BondingCurve curveB) = createToken(0, 0);
        assertEq(address(curveB.dexFactory()), address(dex2));
        assertEq(address(curveB.weth()), address(weth2));
    }

    // ---------------------------------------------------------------- curve params validation

    function test_setCurveParams_zeroParamsRevert() public {
        vm.startPrank(protocolMultisig);

        vm.expectRevert(RobinfunFactory.BadCurveParams.selector);
        factory.setCurveParams(IBondingCurve.CurveParams(0, VIRTUAL_TOKEN, GRADUATION_ETH));

        vm.expectRevert(RobinfunFactory.BadCurveParams.selector);
        factory.setCurveParams(IBondingCurve.CurveParams(VIRTUAL_ETH, 0, GRADUATION_ETH));

        vm.expectRevert(RobinfunFactory.BadCurveParams.selector);
        factory.setCurveParams(IBondingCurve.CurveParams(VIRTUAL_ETH, VIRTUAL_TOKEN, 0));

        vm.stopPrank();
    }

    function test_setCurveParams_insolventSupplyReverts() public {
        // An absurd graduation target sells nearly the whole virtual reserve
        // (~1.079B tokens > 1B supply) before LP tokens are even counted.
        vm.prank(protocolMultisig);
        vm.expectRevert(RobinfunFactory.BadCurveParams.selector);
        factory.setCurveParams(IBondingCurve.CurveParams(VIRTUAL_ETH, VIRTUAL_TOKEN, 1_000 ether));
    }

    // ---------------------------------------------------------------- clones

    function test_clones_distinctAndIndependent() public {
        (RobinfunToken tokenA, BondingCurve curveA) = createToken(BUY_LEVY, BUY_LEVY);
        (RobinfunToken tokenB, BondingCurve curveB) = createToken(BUY_LEVY, BUY_LEVY);

        assertTrue(address(tokenA) != address(tokenB));
        assertTrue(address(curveA) != address(curveB));
        assertEq(factory.allTokensLength(), 2);
        assertEq(factory.allTokens(0), address(tokenA));
        assertEq(factory.allTokens(1), address(tokenB));
        assertEq(factory.curveOf(address(tokenA)), address(curveA));
        assertEq(factory.curveOf(address(tokenB)), address(curveB));

        // Both markets trade independently.
        vm.prank(alice);
        curveA.buy{value: 0.3 ether}(0, block.timestamp);
        vm.prank(bob);
        curveB.buy{value: 0.7 ether}(0, block.timestamp);

        assertGt(tokenA.balanceOf(alice), 0);
        assertEq(tokenA.balanceOf(bob), 0);
        assertGt(tokenB.balanceOf(bob), 0);
        assertEq(tokenB.balanceOf(alice), 0);
        assertEq(curveA.reserveEth(), netIn(0.3 ether, BUY_LEVY));
        assertEq(curveB.reserveEth(), netIn(0.7 ether, BUY_LEVY));
    }

    // ---------------------------------------------------------------- implementations bricked

    function test_implementations_initializeDisabled() public {
        IRobinfunToken.TokenInit memory init = IRobinfunToken.TokenInit({
            name: "Evil",
            symbol: "EVIL",
            creator: alice,
            curve: alice,
            feeRouter: alice,
            buyLevyBps: 0,
            sellLevyBps: 0,
            decayAtGraduation: false,
            renounceAtCreation: false
        });
        RobinfunToken tokenImpl = RobinfunToken(factory.tokenImplementation());
        BondingCurve curveImpl = BondingCurve(payable(factory.curveImplementation()));

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        tokenImpl.initialize(init);

        vm.expectRevert(Initializable.InvalidInitialization.selector);
        curveImpl.initialize(
            alice,
            address(feeRouter),
            address(dexFactory),
            address(weth),
            IBondingCurve.CurveParams(VIRTUAL_ETH, VIRTUAL_TOKEN, GRADUATION_ETH)
        );
    }

    // ---------------------------------------------------------------- helpers

    function _params(string memory name, string memory symbol)
        internal
        pure
        returns (RobinfunFactory.CreateParams memory)
    {
        return RobinfunFactory.CreateParams({
            name: name,
            symbol: symbol,
            metadataURI: "ipfs://hoodrat",
            buyLevyBps: BUY_LEVY,
            sellLevyBps: SELL_LEVY,
            decayAtGraduation: false,
            renounceRateControl: false,
            devBuyMinTokensOut: 0,
            vanitySalt: bytes32(0),
            maxDeployFee: 0
        });
    }

    // ---------------------------------------------------------------- vanity address (…feed)

    function test_vanity_predictMatchesDeployed() public {
        bytes32 salt = keccak256("some-mined-salt");
        RobinfunFactory.CreateParams memory p = _params("Feed Me", "FEED");
        p.vanitySalt = salt;

        address predicted = factory.predictTokenAddress(creator, salt);
        vm.prank(creator);
        (address token,) = factory.createToken{value: DEPLOY_FEE}(p);
        assertEq(token, predicted, "deployed token address must equal the predicted one");
    }

    /// @dev Locks the exact CREATE2 inputs the off-chain JS miner replicates:
    ///      the EIP-1167 minimal-proxy init code around the token impl, the
    ///      salt = keccak256(abi.encode(creator, vanitySalt)), and the standard
    ///      0xff CREATE2 address formula. If this passes, the JS miner using the
    ///      same bytes computes identical addresses.
    function test_vanity_formulaMatchesRawCreate2() public view {
        bytes32 vanitySalt = keccak256("mine");
        address impl = factory.tokenImplementation();

        bytes memory initCode =
            abi.encodePacked(hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3");
        bytes32 initCodeHash = keccak256(initCode);
        bytes32 salt = keccak256(abi.encode(creator, vanitySalt));
        address raw = address(
            uint160(uint256(keccak256(abi.encodePacked(bytes1(0xff), address(factory), salt, initCodeHash))))
        );

        assertEq(raw, factory.predictTokenAddress(creator, vanitySalt), "raw CREATE2 formula must match predict()");
    }

    function test_vanity_saltBoundToCreator() public {
        bytes32 salt = keccak256("shared-salt");
        // Same salt, different creators → different predicted addresses, so a
        // mined salt cannot be front-run into another wallet's address.
        assertTrue(factory.predictTokenAddress(alice, salt) != factory.predictTokenAddress(bob, salt));
    }

    function test_vanity_reusedSaltReverts() public {
        bytes32 salt = keccak256("once");
        RobinfunFactory.CreateParams memory p = _params("One", "ONE");
        p.vanitySalt = salt;
        vm.prank(creator);
        factory.createToken{value: DEPLOY_FEE}(p);
        // Same creator + same salt → same address → CREATE2 collision reverts.
        vm.prank(creator);
        vm.expectRevert();
        factory.createToken{value: DEPLOY_FEE}(p);
    }

    /// @dev Proves the end-to-end vanity flow: mine a salt off-chain (here in
    ///      the test) until the predicted address ends in a target hex nibble,
    ///      then deploy and confirm the real address carries the suffix. A
    ///      single nibble keeps the test fast; production mines 4 nibbles (feed).
    function test_vanity_minedSuffixLandsOnChain() public {
        bytes32 salt;
        address predicted;
        for (uint256 i = 0; i < 4096; ++i) {
            salt = keccak256(abi.encode("mine", i));
            predicted = factory.predictTokenAddress(creator, salt);
            if (uint160(predicted) & 0xf == 0xd) break; // last nibble == 'd' (…feeD)
        }
        assertEq(uint160(predicted) & 0xf, 0xd, "miner should find a matching salt");

        RobinfunFactory.CreateParams memory p = _params("Feed", "FEED");
        p.vanitySalt = salt;
        vm.prank(creator);
        (address token,) = factory.createToken{value: DEPLOY_FEE}(p);
        assertEq(token, predicted);
        assertEq(uint160(token) & 0xf, 0xd, "deployed token address ends in the mined nibble");
    }

    receive() external payable {}
}
