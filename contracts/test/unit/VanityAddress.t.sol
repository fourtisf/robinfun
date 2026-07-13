// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {BaseSetup} from "../BaseSetup.t.sol";
import {RobinfunFactory} from "../../src/RobinfunFactory.sol";

/// @title VanityAddressTest
/// @notice Proves the FRONTEND vanity miner derives exactly the address the
///         factory will deploy. The browser (deploy/site/index.html →
///         mineVanity) computes:
///           initCode = EIP-1167 minimal-proxy bytecode for tokenImplementation
///           initHash = keccak256(initCode)
///           salt     = keccak256(abi.encode(creator, vanitySalt))
///           addr     = CREATE2(factory, salt, initHash)   [ethers.getCreate2Address]
///         and grinds `vanitySalt` until `addr` ends in "feed". This test
///         re-implements that exact derivation in Solidity and asserts it
///         equals `factory.predictTokenAddress(creator, vanitySalt)` (which
///         uses OpenZeppelin Clones). If they match for arbitrary salts, a
///         salt the browser mines for a "feed" suffix will produce a token at
///         precisely that address on-chain.
contract VanityAddressTest is BaseSetup {
    /// @dev The canonical EIP-1167 minimal-proxy init code, split around the
    ///      20-byte implementation address — identical bytes to the frontend's
    ///      `initCode` string.
    function _initHash(address impl) internal pure returns (bytes32) {
        bytes memory initCode = abi.encodePacked(
            hex"3d602d80600a3d3981f3363d3d373d3d3d363d73", impl, hex"5af43d82803e903d91602b57fd5bf3"
        );
        return keccak256(initCode);
    }

    /// @dev Mirror of the frontend derivation, byte for byte.
    function _frontendPredict(address creator_, bytes32 vanitySalt, bytes32 initHash) internal view returns (address) {
        bytes32 salt = keccak256(abi.encode(creator_, vanitySalt));
        bytes32 h = keccak256(abi.encodePacked(bytes1(0xff), address(factory), salt, initHash));
        return address(uint160(uint256(h)));
    }

    function test_frontendDerivationMatchesFactory() public {
        bytes32 initHash = _initHash(factory.tokenImplementation());
        address who = makeAddr("vanityCreator");
        for (uint256 i = 0; i < 32; i++) {
            bytes32 vanitySalt = bytes32(i);
            assertEq(
                _frontendPredict(who, vanitySalt, initHash),
                factory.predictTokenAddress(who, vanitySalt),
                "frontend CREATE2 derivation must equal factory.predictTokenAddress"
            );
        }
    }

    /// @dev Different creators with the SAME vanitySalt get different addresses
    ///      (the salt is bound to msg.sender), so a mined salt can't be
    ///      front-run into someone else's launch.
    function test_saltBoundToCreator() public {
        address a = makeAddr("alice");
        address b = makeAddr("bob");
        assertTrue(
            factory.predictTokenAddress(a, bytes32(uint256(1))) != factory.predictTokenAddress(b, bytes32(uint256(1))),
            "same salt must yield different addresses for different creators"
        );
    }

    /// @dev A salt the frontend "mines" (here: the predicted address happens to
    ///      end in a chosen nibble) actually lands at that address when the
    ///      token is created with it. End-to-end proof against a real deploy.
    function test_minedSaltDeploysAtPredictedAddress() public {
        bytes32 initHash = _initHash(factory.tokenImplementation());
        // Grind for a 1-nibble suffix (fast in a test) to exercise the loop.
        bytes32 chosen;
        address predicted;
        bool found;
        // Start at 1: vanitySalt == 0 means "no vanity" on-chain (plain clone),
        // so the miner must never select it — mirror that here.
        for (uint256 i = 1; i < 10000; i++) {
            bytes32 vs = bytes32(i);
            address ad = _frontendPredict(creator, vs, initHash);
            if (uint160(ad) & 0xf == 0xd) { chosen = vs; predicted = ad; found = true; break; }
        }
        assertTrue(found, "should find a salt within budget");
        assertEq(predicted, factory.predictTokenAddress(creator, chosen), "prediction mismatch");

        RobinfunFactory.CreateParams memory p = RobinfunFactory.CreateParams({
            name: "Feed Coin",
            symbol: "FEED",
            metadataURI: "",
            buyLevyBps: 0,
            sellLevyBps: 0,
            decayAtGraduation: false,
            renounceRateControl: false,
            devBuyMinTokensOut: 0,
            vanitySalt: chosen,
            maxDeployFee: 0
        });
        // NB: read the fee BEFORE prank — a call in the args would consume it.
        uint256 fee = factory.deployFee();
        vm.deal(creator, 1 ether);
        vm.prank(creator);
        (address token,) = factory.createToken{value: fee}(p);
        assertEq(token, predicted, "deployed token must land at the mined address");
    }
}
