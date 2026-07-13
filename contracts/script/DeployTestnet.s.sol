// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {RobinfunFactory} from "../src/RobinfunFactory.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {IBondingCurve} from "../src/interfaces/IRobinfun.sol";
import {MockWETH} from "../test/mocks/MockWETH.sol";
import {MockUniswapV2Factory, MockUniswapV2Router} from "../test/mocks/MockUniswapV2.sol";

/// @title Robinfun — self-contained TESTNET deployment.
///
/// @notice Deploys the whole stack to a testnet (default: Robinhood Chain
/// testnet, chainId 46630) INCLUDING a functional Uniswap-v2-style DEX + WETH,
/// so launch → trade → graduation → LP burn → post-graduation fees all work
/// end to end without depending on an external DEX address.
///
/// TESTNET ONLY — the contracts are NOT audited; never point this at mainnet.
/// For mainnet, use `Deploy.s.sol` with the real audited Uniswap v2 addresses.
///
/// Required env:
///   PRIVATE_KEY   deployer key (a FRESH throwaway wallet funded from the faucet)
/// Optional env:
///   TREASURY      wallet that receives protocol fees (default: the deployer)
///   DEPLOY_FEE    per-launch fee in wei (default: 0.0005 ETH)
contract DeployTestnet is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        address treasury = vm.envOr("TREASURY", deployer);
        uint256 deployFee = vm.envOr("DEPLOY_FEE", uint256(0.001 ether));

        // BETA SAFETY CAP. A curve provably never holds more than `graduationEth`
        // real ETH (invariant `invariant_reserveNeverExceedsGraduation`) before
        // it graduates to Uniswap and burns 100% of the LP — so `graduationEth`
        // IS the per-token at-risk cap. Default 0.05 ETH bounds the blast radius
        // of any residual bug during the mainnet beta; raise it via env as
        // confidence grows. `virtualEth` is the full-size 1.122 ETH scaled by the
        // same 1/52 as graduation (2.6 → 0.05), so the curve shape — price
        // multiple and % of supply sold — is IDENTICAL to production, just
        // denominated 52× smaller.
        uint256 graduationEth = vm.envOr("GRADUATION_ETH", uint256(0.05 ether));
        uint256 virtualEth = vm.envOr("VIRTUAL_ETH", uint256(1.122 ether) / 52);
        uint256 virtualToken = vm.envOr("VIRTUAL_TOKEN", uint256(1_080_000_000e18));
        IBondingCurve.CurveParams memory params = IBondingCurve.CurveParams({
            virtualEth: uint128(virtualEth),
            virtualToken: uint128(virtualToken),
            graduationEth: uint128(graduationEth)
        });

        vm.startBroadcast(pk);

        // Testnet DEX (our functional Uniswap-v2 clone) + WETH.
        MockWETH weth = new MockWETH();
        MockUniswapV2Factory dexFactory = new MockUniswapV2Factory();
        MockUniswapV2Router dexRouter = new MockUniswapV2Router(address(dexFactory), address(weth));

        // Protocol: deployer owns both during wiring so it can seed the beta
        // allowlist, then hands ownership to the treasury (two-step accept).
        FeeRouter feeRouter = new FeeRouter(deployer);
        RobinfunFactory factory =
            new RobinfunFactory(deployer, address(feeRouter), address(dexFactory), address(weth), params, deployFee);

        feeRouter.setFactory(address(factory));
        feeRouter.setDexRouter(address(dexRouter));
        feeRouter.setTreasury(treasury);

        // PRIVATE BETA: only allowlisted wallets may create or trade. Seed the
        // deployer + treasury; add more test wallets via factory.setBetaAllowed
        // after the treasury accepts ownership. Turn beta off (setBetaMode(false))
        // to go permissionless for the public launch.
        factory.setBetaMode(true);
        address[] memory seed = new address[](2);
        seed[0] = deployer;
        seed[1] = treasury;
        factory.setBetaAllowed(seed, true);

        feeRouter.transferOwnership(treasury);
        factory.transferOwnership(treasury);

        vm.stopBroadcast();

        console.log("=== Robinfun testnet deployment ===");
        console.log("deployer     ", deployer);
        console.log("treasury     ", treasury);
        console.log("WETH         ", address(weth));
        console.log("DEX factory  ", address(dexFactory));
        console.log("DEX router   ", address(dexRouter));
        console.log("FeeRouter    ", address(feeRouter));
        console.log("Factory      ", address(factory));
        console.log("  tokenImpl  ", factory.tokenImplementation());
        console.log("  curveImpl  ", factory.curveImplementation());
        console.log("deployFee wei", deployFee);
        console.log("graduation cap wei", graduationEth);
        console.log("PRIVATE BETA on. Allowlisted:", deployer, treasury);
        console.log("NOTE: treasury must call feeRouter.acceptOwnership() AND factory.acceptOwnership()");
        console.log("Add test wallets: factory.setBetaAllowed([wallet...], true)");
        console.log("Go public later: factory.setBetaMode(false)");
    }
}
