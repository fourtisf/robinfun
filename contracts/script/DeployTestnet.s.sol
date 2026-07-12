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
        uint256 deployFee = vm.envOr("DEPLOY_FEE", uint256(0.0005 ether));

        // Curve shape targeting the brief's dollar figures at ETH≈$3850:
        // ~$4k start, ~$44k graduation.
        IBondingCurve.CurveParams memory params = IBondingCurve.CurveParams({
            virtualEth: 1.122 ether,
            virtualToken: 1_080_000_000e18,
            graduationEth: 2.6 ether
        });

        vm.startBroadcast(pk);

        // Testnet DEX (our functional Uniswap-v2 clone) + WETH.
        MockWETH weth = new MockWETH();
        MockUniswapV2Factory dexFactory = new MockUniswapV2Factory();
        MockUniswapV2Router dexRouter = new MockUniswapV2Router(address(dexFactory), address(weth));

        // Protocol: deployer owns the FeeRouter during wiring; treasury (your
        // wallet) receives protocol fees and owns the factory.
        FeeRouter feeRouter = new FeeRouter(deployer);
        RobinfunFactory factory =
            new RobinfunFactory(treasury, address(feeRouter), address(dexFactory), address(weth), params, deployFee);

        feeRouter.setFactory(address(factory));
        feeRouter.setDexRouter(address(dexRouter));
        feeRouter.setTreasury(treasury);
        // Hand FeeRouter ownership to the treasury (two-step: it must accept).
        feeRouter.transferOwnership(treasury);

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
        console.log("NOTE: treasury must call feeRouter.acceptOwnership()");
    }
}
