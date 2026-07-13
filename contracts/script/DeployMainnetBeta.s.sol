// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {RobinfunFactory} from "../src/RobinfunFactory.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {IBondingCurve} from "../src/interfaces/IRobinfun.sol";
import {MockWETH} from "../test/mocks/MockWETH.sol";
import {MockUniswapV2Factory, MockUniswapV2Router} from "../test/mocks/MockUniswapV2.sol";

/// @title Robinfun — MAINNET PRIVATE-BETA deployment.
///
/// @notice Deploys the full stack to a mainnet (Robinhood Chain), INCLUDING our
/// own Uniswap-v2 DEX (a faithful constant-product pair — real K invariant,
/// 0.3% fee, MINIMUM_LIQUIDITY lock, real LP mint/burn) + WETH, because a token
/// graduates by minting LP directly into a v2 pair and burning it to 0xdead.
///
/// This is a DELIBERATELY LOCKED-DOWN beta:
///   - betaMode ON — ONLY the allowlisted BETA_TESTER wallet may create tokens
///     or trade on any curve. Everyone else is rejected at create/buy/sell.
///   - graduationEth (the provable per-token at-risk cap) defaults to 0.001 ETH
///     (~$1-2). A curve never holds more than this before it graduates and
///     burns 100% of the LP, so a bug can strand at most ~$1-2 per token.
///   - The admin (owner + fee treasury) is the DEPLOYER wallet, which should be
///     a FRESH, never-exposed key — NOT the tester. The tester key can be a
///     low-value hot wallet; the admin key controls the allowlist/fees.
///
/// Required env:
///   PRIVATE_KEY   deployer key — a FRESH mainnet wallet, funded with real ETH
///                 for gas + deploy. This becomes owner + treasury by default.
/// Optional env:
///   TREASURY      owner + fee recipient (default: deployer). If different from
///                 the deployer it must call acceptOwnership() on both.
///   BETA_TESTER   the ONE wallet allowed to create/trade
///                 (default: 0xA49dc277A65CCb35D94522cecDa19CA340AE991C).
///   DEPLOY_FEE    per-launch fee, wei (default 0.001 ether).
///   GRADUATION_ETH / VIRTUAL_ETH / VIRTUAL_TOKEN — curve shape (defaults keep
///                 the production 11x shape scaled to the 0.001 ETH cap).
contract DeployMainnetBeta is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address treasury = vm.envOr("TREASURY", deployer);
        address tester = vm.envOr("BETA_TESTER", address(0xA49dc277A65CCb35D94522cecDa19CA340AE991C));
        uint256 deployFee = vm.envOr("DEPLOY_FEE", uint256(0.001 ether));

        // BETA SAFETY CAP — see contract docs. graduationEth IS the per-token
        // at-risk cap (invariant reserveEth <= graduationEth). 0.001 ETH default.
        // virtualEth is the full-size 1.122 ETH scaled by the same 1/2600 as the
        // cap, so the curve SHAPE (price multiple, % of supply sold) is identical
        // to production, just denominated 2600x smaller.
        uint256 graduationEth = vm.envOr("GRADUATION_ETH", uint256(0.001 ether));
        uint256 virtualEth = vm.envOr("VIRTUAL_ETH", uint256(1.122 ether) / 2600);
        uint256 virtualToken = vm.envOr("VIRTUAL_TOKEN", uint256(1_080_000_000e18));
        IBondingCurve.CurveParams memory params = IBondingCurve.CurveParams({
            virtualEth: uint128(virtualEth),
            virtualToken: uint128(virtualToken),
            graduationEth: uint128(graduationEth)
        });

        require(tester != address(0), "BETA_TESTER cannot be zero");

        vm.startBroadcast(pk);

        // Our own DEX (faithful Uniswap-v2 clone) + WETH.
        MockWETH weth = new MockWETH();
        MockUniswapV2Factory dexFactory = new MockUniswapV2Factory();
        MockUniswapV2Router dexRouter = new MockUniswapV2Router(address(dexFactory), address(weth));

        // Protocol. Deployer owns both during wiring so it can seed the beta
        // allowlist; ownership is handed to the treasury only if that is a
        // different wallet (two-step accept).
        FeeRouter feeRouter = new FeeRouter(deployer);
        RobinfunFactory factory =
            new RobinfunFactory(deployer, address(feeRouter), address(dexFactory), address(weth), params, deployFee);

        feeRouter.setFactory(address(factory));
        feeRouter.setDexRouter(address(dexRouter));
        feeRouter.setTreasury(treasury);

        // PRIVATE BETA: allowlist ONLY the tester wallet. Nobody else — not even
        // the deployer/treasury — can create or trade until betaMode is turned
        // off (which is a deliberate later decision, not part of this deploy).
        factory.setBetaMode(true);
        address[] memory seed = new address[](1);
        seed[0] = tester;
        factory.setBetaAllowed(seed, true);

        if (treasury != deployer) {
            feeRouter.transferOwnership(treasury);
            factory.transferOwnership(treasury);
        }

        vm.stopBroadcast();

        console.log("=== Robinfun MAINNET private-beta deployment ===");
        console.log("deployer (admin)  ", deployer);
        console.log("treasury/owner    ", treasury);
        console.log("beta tester (only)", tester);
        console.log("WETH              ", address(weth));
        console.log("DEX factory       ", address(dexFactory));
        console.log("DEX router        ", address(dexRouter));
        console.log("FeeRouter         ", address(feeRouter));
        console.log("Factory           ", address(factory));
        console.log("  tokenImpl       ", factory.tokenImplementation());
        console.log("  curveImpl       ", factory.curveImplementation());
        console.log("deployFee wei     ", deployFee);
        console.log("graduation cap wei", graduationEth);
        console.log("betaMode ON. ONLY the tester wallet can create/trade.");
        if (treasury != deployer) {
            console.log("NOTE: treasury must call feeRouter.acceptOwnership() AND factory.acceptOwnership()");
        }
        console.log("Add testers later: factory.setBetaAllowed([wallet...], true)  (from the owner)");
        console.log("Go public later:   factory.setBetaMode(false)                 (from the owner)");
    }
}
