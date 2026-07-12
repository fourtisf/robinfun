// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {Script, console} from "forge-std/Script.sol";
import {RobinfunFactory} from "../src/RobinfunFactory.sol";
import {FeeRouter} from "../src/FeeRouter.sol";
import {ROBIN} from "../src/ROBIN.sol";
import {RobinStaking} from "../src/RobinStaking.sol";
import {IBondingCurve} from "../src/interfaces/IRobinfun.sol";

/// @title Robinfun testnet deployment.
///
/// @notice Deploys the M1 core (FeeRouter + Factory, with token/curve
/// implementations) and, optionally, the M2 scaffold (ROBIN + staking vault,
/// still blocked on tokenomics — brief §10.1).
///
/// Required environment (see .env.example — ALL of these are §10 open
/// questions; the script refuses to run without explicit values):
///   PRIVATE_KEY         deployer key (testnet only)
///   PROTOCOL_MULTISIG   admin + treasury owner            (§10.5)
///   DEX_FACTORY         Uniswap-v2 style factory address  (§10.2)
///   DEX_ROUTER          Uniswap-v2 style router02 address (§10.2)
///   WETH                canonical wrapped-ETH             (§10.2)
///
/// Optional overrides (defaults match the brief's dollar figures at
/// ETH/USD = 3850 — swap for oracle-informed values before mainnet, §10.4):
///   VIRTUAL_ETH        default 1.122 ether   (starting mcap ≈ $4,000)
///   VIRTUAL_TOKEN      default 1.08e27       (1B supply + 80M virtual buffer)
///   GRADUATION_ETH     default 2.6 ether     (graduation mcap ≈ $44,000)
///   DEPLOY_FEE         default 0.002 ether   (§10.8)
///   DEPLOY_ROBIN       default false — set true to deploy ROBIN + staking
///   ROBIN_SUPPLY       default 1e27 (1B) — placeholder, §10.1
contract Deploy is Script {
    function run() external {
        uint256 deployerKey = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(deployerKey);
        address multisig = vm.envAddress("PROTOCOL_MULTISIG");
        address dexFactory = vm.envAddress("DEX_FACTORY");
        address dexRouter = vm.envAddress("DEX_ROUTER");
        address weth = vm.envAddress("WETH");

        IBondingCurve.CurveParams memory params = IBondingCurve.CurveParams({
            virtualEth: uint128(vm.envOr("VIRTUAL_ETH", uint256(1.122 ether))),
            virtualToken: uint128(vm.envOr("VIRTUAL_TOKEN", uint256(1_080_000_000e18))),
            graduationEth: uint128(vm.envOr("GRADUATION_ETH", uint256(2.6 ether)))
        });
        uint256 deployFee = vm.envOr("DEPLOY_FEE", uint256(0.002 ether));

        vm.startBroadcast(deployerKey);

        // Deployer owns the routers during wiring, then hands over.
        FeeRouter feeRouter = new FeeRouter(deployer);
        RobinfunFactory factory =
            new RobinfunFactory(multisig, address(feeRouter), dexFactory, weth, params, deployFee);

        feeRouter.setFactory(address(factory));
        feeRouter.setDexRouter(dexRouter);
        feeRouter.setTreasury(multisig);

        if (vm.envOr("DEPLOY_ROBIN", false)) {
            uint256 robinSupply = vm.envOr("ROBIN_SUPPLY", uint256(1_000_000_000e18));
            ROBIN robinToken = new ROBIN(multisig, robinSupply);
            RobinStaking staking = new RobinStaking(address(robinToken), multisig);
            staking.setRewardDistributor(address(feeRouter));
            feeRouter.setStakingVault(address(staking));
            console.log("ROBIN:        ", address(robinToken));
            console.log("RobinStaking: ", address(staking));
        }

        // Hand FeeRouter ownership to the multisig (two-step: it must accept).
        feeRouter.transferOwnership(multisig);

        vm.stopBroadcast();

        console.log("FeeRouter:    ", address(feeRouter));
        console.log("Factory:      ", address(factory));
        console.log("  token impl: ", factory.tokenImplementation());
        console.log("  curve impl: ", factory.curveImplementation());
        console.log("NOTE: multisig must call feeRouter.acceptOwnership()");
    }
}
