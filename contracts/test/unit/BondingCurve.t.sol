// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseSetup} from "../BaseSetup.t.sol";
import {RobinfunToken} from "../../src/RobinfunToken.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {MockUniswapV2Pair} from "../mocks/MockUniswapV2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract BondingCurveTest is BaseSetup {
    RobinfunToken internal token;
    BondingCurve internal curve;

    uint16 internal constant BUY_LEVY = 300; // 3%
    uint16 internal constant SELL_LEVY = 300;

    function setUp() public override {
        super.setUp();
        (token, curve) = createToken(BUY_LEVY, SELL_LEVY);
    }

    // ---------------------------------------------------------------- initial state

    function test_initialState() public view {
        assertEq(curve.virtualEthReserve(), VIRTUAL_ETH);
        assertEq(curve.virtualTokenReserve(), VIRTUAL_TOKEN);
        assertEq(curve.reserveEth(), 0);
        assertFalse(curve.graduated());
        assertEq(token.balanceOf(address(curve)), token.TOTAL_SUPPLY());

        // Starting market cap ≈ $4,000 at ETH=$3850 → ≈ 1.0389 ETH.
        uint256 mcapEth = curve.marketCapEth();
        assertApproxEqRel(mcapEth, 1.0389 ether, 0.001e18);
    }

    function test_startingPriceMatchesBrief() public view {
        // price = virtualEth / virtualToken ≈ 1.0389e-9 ETH per token
        uint256 price = curve.currentPrice();
        assertApproxEqRel(price * 1_000_000_000, 1.0389 ether, 0.001e18);
    }

    // ---------------------------------------------------------------- buys

    function test_buy_transfersTokensAndRoutesFees() public {
        uint256 gross = 1 ether;
        uint256 fee = (gross * CURVE_FEE_BPS) / BPS;
        uint256 levy = (gross * BUY_LEVY) / BPS;
        uint256 net = gross - fee - levy;

        uint256 expectedOut = (uint256(VIRTUAL_TOKEN) * net) / (VIRTUAL_ETH + net);

        vm.prank(alice);
        uint256 out = curve.buy{value: gross}(0, block.timestamp);

        assertEq(out, expectedOut);
        assertEq(token.balanceOf(alice), expectedOut);
        assertEq(curve.reserveEth(), net);
        assertEq(address(curve).balance, net);

        // 1% curve fee → 100% protocol; levy → 90/10.
        assertEq(feeRouter.protocolPending(), _protocolCut(fee, levy) + DEPLOY_FEE);
        assertEq(feeRouter.creatorOwed(address(token)), (levy * 9_000) / BPS);
    }

    function test_buy_quoteMatchesExecution() public {
        (uint256 qFee, uint256 qLevy, uint256 qNet, uint256 qTokens, uint256 qRefund) = curve.quoteBuy(0.7 ether);
        assertEq(qRefund, 0);
        assertEq(qNet, netIn(0.7 ether, BUY_LEVY));
        assertEq(qFee + qLevy + qNet, 0.7 ether);

        vm.prank(alice);
        uint256 out = curve.buy{value: 0.7 ether}(0, block.timestamp);
        assertEq(out, qTokens);
    }

    function test_buy_priceMonotonicallyIncreases() public {
        uint256 lastPrice = curve.currentPrice();
        for (uint256 i; i < 10; ++i) {
            vm.prank(alice);
            curve.buy{value: 0.2 ether}(0, block.timestamp);
            uint256 p = curve.currentPrice();
            assertGt(p, lastPrice, "price must rise with every buy");
            lastPrice = p;
        }
    }

    function test_buy_slippageProtection() public {
        (,,, uint256 quoted,) = curve.quoteBuy(1 ether);
        vm.prank(alice);
        vm.expectRevert(BondingCurve.SlippageExceeded.selector);
        curve.buy{value: 1 ether}(quoted + 1, block.timestamp);
    }

    function test_buy_deadlineEnforced() public {
        vm.prank(alice);
        vm.expectRevert(BondingCurve.DeadlineExpired.selector);
        curve.buy{value: 1 ether}(0, block.timestamp - 1);
    }

    function test_buy_zeroValueReverts() public {
        vm.prank(alice);
        vm.expectRevert(BondingCurve.ZeroAmount.selector);
        curve.buy{value: 0}(0, block.timestamp);
    }

    function test_buyFor_recipientReceives() public {
        vm.prank(alice);
        uint256 out = curve.buyFor{value: 1 ether}(bob, 0, block.timestamp);
        assertEq(token.balanceOf(bob), out);
        assertEq(token.balanceOf(alice), 0);
    }

    // ---------------------------------------------------------------- sells

    function test_sell_roundtripAndFees() public {
        vm.startPrank(alice);
        uint256 out = curve.buy{value: 1 ether}(0, block.timestamp);

        (uint256 gross, uint256 fee, uint256 levy, uint256 net) = curve.quoteSell(out);
        token.approve(address(curve), out);
        uint256 balBefore = alice.balance;
        uint256 got = curve.sell(out, 0, block.timestamp);
        vm.stopPrank();

        assertEq(got, net);
        assertEq(alice.balance - balBefore, net);
        assertEq(gross, fee + levy + net);
        // Roundtrip must never profit the trader (fees + rounding).
        assertLt(net, 1 ether);
        // Curve returns to its starting virtual state (all tokens back).
        assertEq(curve.virtualTokenReserve(), VIRTUAL_TOKEN);
    }

    function test_sell_holderCanAlwaysExitFully() public {
        // Three buyers at different price points; every one can dump 100%.
        address[3] memory buyers = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            vm.prank(buyers[i]);
            curve.buy{value: 0.8 ether}(0, block.timestamp);
        }
        for (uint256 i; i < 3; ++i) {
            uint256 bal = token.balanceOf(buyers[i]);
            vm.startPrank(buyers[i]);
            token.approve(address(curve), bal);
            curve.sell(bal, 0, block.timestamp);
            vm.stopPrank();
            assertEq(token.balanceOf(buyers[i]), 0);
        }
        // Curve stays solvent to the wei.
        assertEq(curve.virtualTokenReserve(), VIRTUAL_TOKEN);
        assertGe(address(curve).balance, curve.reserveEth());
    }

    function test_sell_slippageProtection() public {
        vm.startPrank(alice);
        uint256 out = curve.buy{value: 1 ether}(0, block.timestamp);
        token.approve(address(curve), out);
        (,,, uint256 net) = curve.quoteSell(out);
        vm.expectRevert(BondingCurve.SlippageExceeded.selector);
        curve.sell(out, net + 1, block.timestamp);
        vm.stopPrank();
    }

    function test_sell_withoutApprovalReverts() public {
        vm.startPrank(alice);
        uint256 out = curve.buy{value: 1 ether}(0, block.timestamp);
        vm.expectRevert();
        curve.sell(out, 0, block.timestamp);
        vm.stopPrank();
    }

    // ---------------------------------------------------------------- graduation

    function test_graduation_happyPath() public {
        vm.prank(alice);
        curve.buy{value: 5 ether}(0, block.timestamp);

        assertTrue(curve.graduated());
        assertTrue(token.graduated());

        address pair = token.ammPair();
        assertTrue(pair != address(0));

        // All raised ETH is in the pool as WETH.
        assertEq(weth.balanceOf(pair), GRADUATION_ETH);

        // 100% of LP burned: pair supply is held by the dead address only.
        MockUniswapV2Pair p = MockUniswapV2Pair(pair);
        assertEq(p.balanceOf(DEAD), p.totalSupply());

        // Curve is completely drained: no ETH, no tokens.
        assertEq(address(curve).balance, 0);
        assertEq(token.balanceOf(address(curve)), 0);
        assertEq(curve.reserveEth(), 0);
    }

    function test_graduation_finalBuyCappedAndRefunded() public {
        // Walk close to the target, then overshoot hugely.
        vm.prank(alice);
        curve.buy{value: 2 ether}(0, block.timestamp);
        assertFalse(curve.graduated());

        uint256 balBefore = bob.balance;
        vm.prank(bob);
        curve.buy{value: 10 ether}(0, block.timestamp);

        assertTrue(curve.graduated());
        uint256 spent = balBefore - bob.balance;
        // Bob paid only the gross needed to close the curve, not 10 ETH.
        assertLt(spent, 1.2 ether);

        // Collected net ETH landed exactly on the graduation target → the
        // pool holds exactly GRADUATION_ETH.
        assertEq(weth.balanceOf(token.ammPair()), GRADUATION_ETH);
    }

    function test_graduation_poolOpensAtCurvePrice() public {
        vm.prank(alice);
        curve.buy{value: 5 ether}(0, block.timestamp);

        address pair = token.ammPair();
        (uint112 r0, uint112 r1,) = MockUniswapV2Pair(pair).getReserves();
        (uint256 tokenReserve, uint256 wethReserve) =
            address(token) < address(weth) ? (uint256(r0), uint256(r1)) : (uint256(r1), uint256(r0));

        // Pool spot price == curve graduation price (±1 wei rounding).
        // Graduation mcap ≈ $44k at $3850 → ≈ 11.43 ETH over 1B tokens.
        uint256 poolMcapEth = (wethReserve * token.TOTAL_SUPPLY()) / tokenReserve;
        assertApproxEqRel(poolMcapEth, 11.43 ether, 0.001e18);
    }

    function test_graduation_tradingClosedAfter() public {
        graduate(token, curve);

        vm.prank(bob);
        vm.expectRevert(BondingCurve.AlreadyGraduatedErr.selector);
        curve.buy{value: 1 ether}(0, block.timestamp);

        vm.startPrank(alice);
        uint256 bal = token.balanceOf(alice);
        token.approve(address(curve), bal);
        vm.expectRevert(BondingCurve.AlreadyGraduatedErr.selector);
        curve.sell(bal, 0, block.timestamp);
        vm.stopPrank();
    }

    function test_graduation_donationGriefingNeutralized() public {
        // Attacker pre-creates and seeds the pair to skew the opening price.
        address pair = dexFactory.createPair(address(token), address(weth));
        vm.deal(address(this), 1 ether);
        weth.deposit{value: 1 ether}();
        weth.transfer(pair, 1 ether);

        vm.prank(alice);
        curve.buy{value: 5 ether}(0, block.timestamp);

        // The donation was skimmed before the LP mint: pool opens exactly at
        // graduation price with exactly the curve's ETH.
        assertEq(weth.balanceOf(pair), GRADUATION_ETH);
    }

    function test_graduation_decayHalvesLevies() public {
        (RobinfunToken t2, BondingCurve c2) = createTokenFull(400, 600, true, false, 0);
        vm.prank(alice);
        c2.buy{value: 5 ether}(0, block.timestamp);
        assertTrue(t2.graduated());
        assertEq(t2.buyLevyBps(), 200);
        assertEq(t2.sellLevyBps(), 300);
    }

    /// @dev Regression: an attacker who mints REAL LP into the pair before
    ///      graduation (skewed cheap-token price) must not capture any of the
    ///      curve's fair-launch liquidity, and the curve's LP is still 100%
    ///      burned to the dead address.
    function test_graduation_preMintedLpCannotStealLiquidity() public {
        address attacker = makeAddr("attacker");
        vm.deal(attacker, 100 ether);

        // Attacker buys a slice of tokens on the curve (untaxed pre-grad).
        vm.prank(attacker);
        curve.buy{value: 0.5 ether}(0, block.timestamp);
        uint256 attackerTokens = token.balanceOf(attacker);

        // Attacker pre-creates the pair and mints skewed LP (lots of tokens,
        // little WETH → token looks very cheap), holding all the LP.
        address pair = dexFactory.createPair(address(token), address(weth));
        vm.startPrank(attacker);
        token.transfer(pair, attackerTokens);
        weth.deposit{value: 0.01 ether}();
        weth.transfer(pair, 0.01 ether);
        uint256 attackerLp = MockUniswapV2Pair(pair).mint(attacker);
        vm.stopPrank();
        assertGt(attackerLp, 0, "attacker seeded real LP");

        uint256 attackerSpent = 0.5 ether + 0.01 ether; // curve buy + seed WETH

        // Graduate.
        vm.prank(alice);
        curve.buy{value: 5 ether}(0, block.timestamp);
        assertTrue(curve.graduated());
        assertEq(token.ammPair(), pair, "attacker pair became canonical");

        MockUniswapV2Pair p = MockUniswapV2Pair(pair);

        // The curve's LP contribution is 100% burned: DEAD holds the entire
        // supply except the attacker's own pre-existing seed LP.
        assertEq(p.balanceOf(DEAD), p.totalSupply() - attackerLp, "curve LP 100% burned");

        // M-1 fix: the arb corrects the mispriced seed, so graduation now LOCKS
        // real liquidity (instead of the old griefed outcome where it was
        // diverted to the protocol). The burned (DEAD) LP dominates the seed.
        (uint112 r0, uint112 r1,) = p.getReserves();
        uint256 wethReserve = address(token) < address(weth) ? uint256(r1) : uint256(r0);
        assertGe(wethReserve, 2 ether, "graduation locked real liquidity despite the seed");
        assertGt(p.balanceOf(DEAD), attackerLp, "burned LP dominates the seed");

        // The attacker STILL cannot profit: arbitraging their own mispriced pool
        // to fair is zero-sum-at-best for them (AM-GM). Their LP redeems — both
        // sides, valued at the pool price — to less than they spent.
        uint256 redeemableValue = (2 * wethReserve * attackerLp) / p.totalSupply();
        assertLt(redeemableValue, attackerSpent, "seeder cannot profit from the arb");

        assertEq(address(curve).balance, 0, "no stranded ETH");
        assertEq(token.balanceOf(address(curve)), 0, "no stranded tokens");
    }

    /// @dev Regression: an attacker seeding an EXTREME-ratio pool (so the
    ///      ratio-matched deposit would mint zero LP) must not be able to brick
    ///      graduation. The curve falls back to routing the ETH to the protocol
    ///      and burning the tokens — the token still graduates.
    function test_graduation_degenerateSeedCannotBrick() public {
        address attacker = makeAddr("attacker");
        vm.deal(attacker, 100 ether);

        // Attacker grabs a sliver of tokens, then seeds a pool priced absurdly
        // high — 1 wei of token against 40 ETH — so the ratio-matched
        // `tokensToLp` rounds to zero and the deposit would mint no LP.
        vm.prank(attacker);
        curve.buy{value: 0.2 ether}(0, block.timestamp);

        address pair = dexFactory.createPair(address(token), address(weth));
        vm.startPrank(attacker);
        token.transfer(pair, 1); // one wei of token
        weth.deposit{value: 40 ether}();
        weth.transfer(pair, 40 ether);
        MockUniswapV2Pair(pair).mint(attacker);
        vm.stopPrank();

        uint256 protocolBefore = feeRouter.protocolPending();

        // Graduation must still succeed.
        vm.prank(alice);
        curve.buy{value: 5 ether}(0, block.timestamp);
        assertTrue(curve.graduated(), "token graduates despite the griefing seed");

        // The curve is fully drained; graduation ETH (plus, with the M-1 arb,
        // the griefer's own over-priced 40-ETH seed swept in at market) is
        // locked/routed to the protocol — never recoverable by the attacker.
        assertEq(address(curve).balance, 0, "no stranded ETH");
        assertEq(token.balanceOf(address(curve)), 0, "no stranded tokens");
        assertGe(feeRouter.protocolPending() - protocolBefore, GRADUATION_ETH, "at least all graduation ETH accounted");

        // The griefer's mispriced 40-ETH seed is not recoverable via their LP.
        MockUniswapV2Pair p = MockUniswapV2Pair(pair);
        (uint112 r0, uint112 r1,) = p.getReserves();
        uint256 wethReserve = address(token) < address(weth) ? uint256(r1) : uint256(r0);
        uint256 attackerLp = p.balanceOf(attacker);
        uint256 redeemable = p.totalSupply() == 0 ? 0 : (2 * wethReserve * attackerLp) / p.totalSupply();
        assertLt(redeemable, 40 ether, "griefer cannot recover their seed");
    }

    /// @dev Regression: a buy sized one wei below the exact gross needed to
    ///      graduate must not underflow the refund and revert.
    function test_graduation_boundaryBuyDoesNotRevert() public {
        // Walk almost to the target so a precise final buy triggers the cap.
        vm.prank(alice);
        curve.buy{value: 2 ether}(0, block.timestamp);
        (uint256 collected, uint256 target) = curve.graduationProgress();
        uint256 room = target - collected;

        uint256 cutBps = uint256(CURVE_FEE_BPS) + BUY_LEVY;
        uint256 grossCapped = (room * BPS + (BPS - cutBps) - 1) / (BPS - cutBps);

        // Exactly the boundary that used to underflow: grossCapped - 1.
        vm.prank(bob);
        curve.buy{value: grossCapped - 1}(0, block.timestamp);
        assertTrue(curve.graduated(), "boundary buy graduates instead of reverting");
    }

    // ---------------------------------------------------------------- fuzz

    /// @dev Any single buy: exact ETH conservation and correct routing.
    function testFuzz_buy_conservation(uint96 rawEth) public {
        uint256 ethIn = bound(uint256(rawEth), 1 gwei, 100 ether);

        uint256 protocolBefore = feeRouter.protocolPending();
        uint256 creatorBefore = feeRouter.creatorOwed(address(token));
        uint256 aliceBefore = alice.balance;

        vm.prank(alice);
        curve.buy{value: ethIn}(0, block.timestamp);

        uint256 spent = aliceBefore - alice.balance;
        uint256 curveGain = address(curve).balance;
        uint256 protocolGain = feeRouter.protocolPending() - protocolBefore;
        uint256 creatorGain = feeRouter.creatorOwed(address(token)) - creatorBefore;

        if (!curve.graduated()) {
            // gross spent = net (curve) + fee + levy, split exactly.
            assertEq(spent, curveGain + protocolGain + creatorGain, "ETH conservation");
            assertEq(curve.reserveEth(), curveGain, "tracked reserve matches balance");
        } else {
            // Graduated: curve ETH went into the pool.
            assertEq(weth.balanceOf(token.ammPair()), GRADUATION_ETH);
        }
    }

    /// @dev Buy then sell everything: trader can never profit, curve solvent.
    function testFuzz_roundtripNeverProfits(uint96 rawEth) public {
        uint256 ethIn = bound(uint256(rawEth), 1 gwei, 2 ether); // below graduation

        vm.startPrank(alice);
        uint256 out = curve.buy{value: ethIn}(0, block.timestamp);
        token.approve(address(curve), out);
        uint256 balBefore = alice.balance;
        uint256 got = curve.sell(out, 0, block.timestamp);
        vm.stopPrank();

        assertEq(alice.balance - balBefore, got);
        assertLe(got, ethIn, "roundtrip must never profit");
        assertGe(address(curve).balance, curve.reserveEth(), "curve solvency");
    }

    /// @dev Interleaved multi-actor trades keep the invariant x*y >= k0 and
    ///      the tracked reserve equal to the real balance.
    function testFuzz_interleavedTrades(uint256 seed) public {
        uint256 k0 = uint256(VIRTUAL_ETH) * VIRTUAL_TOKEN;
        address[3] memory actors = [alice, bob, carol];

        for (uint256 i; i < 12 && !curve.graduated(); ++i) {
            seed = uint256(keccak256(abi.encode(seed, i)));
            address actor = actors[seed % 3];
            bool doBuy = (seed >> 8) % 2 == 0 || token.balanceOf(actor) == 0;

            vm.startPrank(actor);
            if (doBuy) {
                uint256 ethIn = bound((seed >> 16) % 1e18, 0.001 ether, 0.4 ether);
                curve.buy{value: ethIn}(0, block.timestamp);
            } else {
                uint256 amt = bound(seed >> 16, 1, token.balanceOf(actor));
                token.approve(address(curve), amt);
                curve.sell(amt, 0, block.timestamp);
            }
            vm.stopPrank();

            // A buy can graduate the curve mid-loop; once it has, the curve is
            // drained and the pre-graduation reserve identities no longer apply.
            if (curve.graduated()) {
                assertEq(token.balanceOf(address(curve)), 0, "graduated: no stranded tokens");
                assertEq(address(curve).balance, 0, "graduated: no stranded ETH");
                break;
            }

            assertGe(curve.virtualEthReserve() * curve.virtualTokenReserve(), k0, "k never decreases");
            assertEq(address(curve).balance, curve.reserveEth(), "balance == tracked reserve");
            assertEq(
                token.balanceOf(address(curve)),
                token.TOTAL_SUPPLY() - (VIRTUAL_TOKEN - curve.virtualTokenReserve()),
                "token inventory == supply - sold"
            );
        }
    }

    /// @dev The graduation cap: any overshoot buy lands the reserve exactly
    ///      on target and refunds the rest.
    function testFuzz_graduationCapExact(uint96 rawEth) public {
        uint256 ethIn = bound(uint256(rawEth), 3 ether, 500 ether);
        vm.prank(alice);
        curve.buy{value: ethIn}(0, block.timestamp);
        assertTrue(curve.graduated());
        assertEq(weth.balanceOf(token.ammPair()), GRADUATION_ETH, "pool ETH == graduation target");
    }

    // ---------------------------------------------------------------- helpers

    function _protocolCut(uint256 fee, uint256 levy) internal pure returns (uint256) {
        return fee + levy - (levy * 9_000) / BPS;
    }

    receive() external payable {}
}
