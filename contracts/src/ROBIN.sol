// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";

/// @title ROBIN — the Robinfun platform token.
///
/// @notice Plain, fixed-supply ERC-20 with EIP-2612 permit. Stake it in
/// `RobinStaking` to earn a pro-rata share of all protocol revenue in ETH.
///
/// @dev ⚠️ Supply, distribution and launch mechanism are an OPEN QUESTION
/// (brief §10.1) — both are constructor parameters so nothing here needs to
/// change once the team decides. The prototype display assumes ~1B supply.
contract ROBIN is ERC20, ERC20Permit {
    constructor(address recipient, uint256 supply) ERC20("Robinfun", "ROBIN") ERC20Permit("Robinfun") {
        _mint(recipient, supply);
    }
}
