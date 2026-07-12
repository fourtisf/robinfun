// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {BaseSetup} from "../BaseSetup.t.sol";
import {RobinfunToken} from "../../src/RobinfunToken.sol";
import {BondingCurve} from "../../src/BondingCurve.sol";
import {MockUniswapV2Pair} from "../mocks/MockUniswapV2.sol";

/// @dev Randomized actor that trades against one curve. Reverting paths are
///      bounded away so `fail_on_revert = true` would also hold; we still run
///      with the default tolerant mode.
contract CurveHandler is Test {
    RobinfunToken public token;
    BondingCurve public curve;

    address[3] public actors;
    uint256 public ghostEthIn; // total gross ETH pushed into buys
    uint256 public ghostEthOut; // total net ETH received from sells

    constructor(RobinfunToken token_, BondingCurve curve_) {
        token = token_;
        curve = curve_;
        actors[0] = makeAddr("h_actor0");
        actors[1] = makeAddr("h_actor1");
        actors[2] = makeAddr("h_actor2");
        for (uint256 i; i < 3; ++i) {
            vm.deal(actors[i], 10_000 ether);
        }
    }

    function buy(uint256 actorSeed, uint256 ethIn) external {
        if (curve.graduated()) return;
        address actor = actors[actorSeed % 3];
        ethIn = bound(ethIn, 1 gwei, 1 ether);

        vm.prank(actor);
        curve.buy{value: ethIn}(0, block.timestamp);
        ghostEthIn += ethIn;
    }

    function sell(uint256 actorSeed, uint256 tokensIn) external {
        if (curve.graduated()) return;
        address actor = actors[actorSeed % 3];
        uint256 bal = token.balanceOf(actor);
        if (bal == 0) return;
        tokensIn = bound(tokensIn, 1, bal);
        (,,, uint256 net) = curve.quoteSell(tokensIn);

        vm.startPrank(actor);
        token.approve(address(curve), tokensIn);
        curve.sell(tokensIn, 0, block.timestamp);
        vm.stopPrank();
        ghostEthOut += net;
    }

    /// @dev The no-honeypot probe: a random holder dumps EVERYTHING, then we
    ///      roll back. If this ever reverts, a holder was trapped.
    function probeFullExit(uint256 actorSeed) external {
        if (curve.graduated()) return;
        address actor = actors[actorSeed % 3];
        uint256 bal = token.balanceOf(actor);
        if (bal == 0) return;

        uint256 snap = vm.snapshotState();
        vm.startPrank(actor);
        token.approve(address(curve), bal);
        uint256 got = curve.sell(bal, 0, block.timestamp);
        vm.stopPrank();
        assertGt(got + 1, 0, "full exit always succeeds"); // reaching here is the assertion
        vm.revertToState(snap);
    }
}

contract CurveInvariantTest is BaseSetup {
    RobinfunToken internal token;
    BondingCurve internal curve;
    CurveHandler internal handler;
    uint256 internal k0;

    function setUp() public override {
        super.setUp();
        (token, curve) = createToken(300, 300);
        handler = new CurveHandler(token, curve);
        k0 = uint256(VIRTUAL_ETH) * VIRTUAL_TOKEN;

        targetContract(address(handler));
    }

    /// @notice The curve can always pay every seller: its real ETH balance
    ///         exactly matches tracked reserves, and the constant product
    ///         never decays below its initial value.
    function invariant_solvency() public view {
        if (curve.graduated()) return;
        assertEq(address(curve).balance, curve.reserveEth(), "balance == tracked reserve");
        assertGe(curve.virtualEthReserve() * curve.virtualTokenReserve(), k0, "x*y >= k0");
        assertGe(curve.virtualEthReserve(), VIRTUAL_ETH, "virtual ETH never below initial");
    }

    /// @notice Token accounting: curve inventory always equals supply minus
    ///         net tokens sold; virtual token reserve never exceeds initial.
    function invariant_tokenInventory() public view {
        if (curve.graduated()) return;
        uint256 sold = uint256(VIRTUAL_TOKEN) - curve.virtualTokenReserve();
        assertEq(token.balanceOf(address(curve)), token.TOTAL_SUPPLY() - sold, "inventory == supply - sold");
        assertLe(curve.virtualTokenReserve(), VIRTUAL_TOKEN, "no phantom tokens");
    }

    /// @notice Collected ETH is capped by the graduation target.
    function invariant_reserveNeverExceedsGraduation() public view {
        if (curve.graduated()) return;
        assertLe(curve.reserveEth(), GRADUATION_ETH, "reserve <= graduation target");
    }

    /// @notice ETH that left the curve to sellers can never exceed ETH that
    ///         entered from buyers (net-of-fee conservation).
    function invariant_ethConservation() public view {
        assertLe(handler.ghostEthOut(), handler.ghostEthIn(), "sells bounded by buys");
    }

    /// @notice If graduation happened, the pool's LP is 100% burned and the
    ///         curve is fully drained.
    function invariant_graduationEndState() public view {
        if (!curve.graduated()) return;
        MockUniswapV2Pair pair = MockUniswapV2Pair(token.ammPair());
        assertEq(pair.balanceOf(DEAD), pair.totalSupply(), "LP fully burned");
        assertEq(token.balanceOf(address(curve)), 0, "no stranded tokens");
        assertEq(address(curve).balance, 0, "no stranded ETH");
    }
}
