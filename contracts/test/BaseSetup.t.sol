// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Test} from "forge-std/Test.sol";
import {RobinfunFactory} from "../src/RobinfunFactory.sol";
import {RobinfunToken} from "../src/RobinfunToken.sol";
import {BondingCurve} from "../src/BondingCurve.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {ROBIN} from "../src/ROBIN.sol";
import {RobinStaking} from "../src/RobinStaking.sol";
import {IBondingCurve} from "../src/interfaces/IRobinfun.sol";
import {MockWETH} from "./mocks/MockWETH.sol";
import {MockUniswapV2Factory, MockUniswapV2Pair, MockUniswapV2Router} from "./mocks/MockUniswapV2.sol";

/// @dev Shared deployment fixture. Default curve shape targets the brief's
///      dollar figures at ETH=$3850: ~$4k starting cap, ~$44k graduation.
abstract contract BaseSetup is Test {
    // Default curve parameters (see docs/BUILD-BRIEF.md §4 and the README):
    //   virtualEth   = 1.122 ETH   → starting mcap ≈ 1.0389 ETH ≈ $4,000
    //   virtualToken = 1.08e9      → 80M-token virtual buffer over the 1B supply
    //   graduationEth= 2.6 ETH     → graduation mcap ≈ 11.43 ETH ≈ $44,000
    uint128 internal constant VIRTUAL_ETH = 1.122 ether;
    uint128 internal constant VIRTUAL_TOKEN = 1_080_000_000e18;
    uint128 internal constant GRADUATION_ETH = 2.6 ether;
    uint256 internal constant DEPLOY_FEE = 0.002 ether;
    uint256 internal constant ROBIN_SUPPLY = 1_000_000_000e18;

    uint16 internal constant CURVE_FEE_BPS = 100;
    uint16 internal constant BPS = 10_000;

    address internal constant DEAD = 0x000000000000000000000000000000000000dEaD;

    address internal protocolMultisig = makeAddr("protocolMultisig");
    address internal treasury = makeAddr("treasury");
    address internal creator = makeAddr("creator");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    MockWETH internal weth;
    MockUniswapV2Factory internal dexFactory;
    MockUniswapV2Router internal dexRouter;
    FeeRouter internal feeRouter;
    RobinfunFactory internal factory;
    ROBIN internal robin;
    RobinStaking internal staking;

    function setUp() public virtual {
        weth = new MockWETH();
        dexFactory = new MockUniswapV2Factory();
        dexRouter = new MockUniswapV2Router(address(dexFactory), address(weth));

        feeRouter = new FeeRouter(protocolMultisig);
        factory = new RobinfunFactory(
            protocolMultisig,
            address(feeRouter),
            address(dexFactory),
            address(weth),
            IBondingCurve.CurveParams(VIRTUAL_ETH, VIRTUAL_TOKEN, GRADUATION_ETH),
            DEPLOY_FEE
        );

        robin = new ROBIN(protocolMultisig, ROBIN_SUPPLY);
        staking = new RobinStaking(address(robin), protocolMultisig);

        vm.startPrank(protocolMultisig);
        feeRouter.setFactory(address(factory));
        feeRouter.setDexRouter(address(dexRouter));
        feeRouter.setTreasury(treasury);
        staking.setRewardDistributor(address(feeRouter));
        vm.stopPrank();

        vm.deal(creator, 1_000 ether);
        vm.deal(alice, 1_000 ether);
        vm.deal(bob, 1_000 ether);
        vm.deal(carol, 1_000 ether);
    }

    // ---------------------------------------------------------------- helpers

    function createToken(uint16 buyLevyBps, uint16 sellLevyBps)
        internal
        returns (RobinfunToken token, BondingCurve curve)
    {
        return createTokenFull(buyLevyBps, sellLevyBps, false, false, 0);
    }

    function createTokenFull(
        uint16 buyLevyBps,
        uint16 sellLevyBps,
        bool decay,
        bool renounce,
        uint256 devBuyEth
    ) internal returns (RobinfunToken token, BondingCurve curve) {
        vm.prank(creator);
        (address t, address c) = factory.createToken{value: DEPLOY_FEE + devBuyEth}(
            RobinfunFactory.CreateParams({
                name: "Hood Rat",
                symbol: "HOODRAT",
                metadataURI: "ipfs://hoodrat",
                buyLevyBps: buyLevyBps,
                sellLevyBps: sellLevyBps,
                decayAtGraduation: decay,
                renounceRateControl: renounce,
                devBuyMinTokensOut: 0,
                vanitySalt: bytes32(0),
                maxDeployFee: 0
            })
        );
        return (RobinfunToken(t), BondingCurve(payable(c)));
    }

    /// @dev Buys with enough gross ETH to graduate the curve in one trade.
    function graduate(RobinfunToken token, BondingCurve curve) internal returns (address pair) {
        vm.prank(alice);
        curve.buy{value: 5 ether}(0, block.timestamp);
        assertTrue(curve.graduated(), "graduate() helper: curve did not graduate");
        return token.ammPair();
    }

    /// @dev Net-of-fees ETH that actually enters the curve for a gross buy.
    function netIn(uint256 gross, uint16 levyBps) internal pure returns (uint256) {
        return gross - (gross * CURVE_FEE_BPS) / BPS - (gross * levyBps) / BPS;
    }
}
