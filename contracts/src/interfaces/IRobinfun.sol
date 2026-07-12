// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title Internal interfaces of the Robinfun protocol.

interface IRobinfunToken is IERC20 {
    struct TokenInit {
        string name;
        string symbol;
        address creator;
        address curve;
        address feeRouter;
        uint16 buyLevyBps;
        uint16 sellLevyBps;
        bool decayAtGraduation;
        bool renounceAtCreation;
    }

    function initialize(TokenInit calldata init) external;

    function creator() external view returns (address);
    function curve() external view returns (address);
    function buyLevyBps() external view returns (uint16);
    function sellLevyBps() external view returns (uint16);
    function PROTOCOL_FEE_BPS() external view returns (uint16);
    function decayAtGraduation() external view returns (bool);
    function rateControlRenounced() external view returns (bool);
    function graduated() external view returns (bool);
    function ammPair() external view returns (address);

    function onGraduation(address pair) external;
}

interface IBondingCurve {
    struct CurveParams {
        uint128 virtualEth; // initial virtual ETH reserve (wei)
        uint128 virtualToken; // initial virtual token reserve (wei, 18 decimals)
        uint128 graduationEth; // real ETH collected that triggers graduation (wei)
    }

    function initialize(
        address token_,
        address feeRouter_,
        address dexFactory_,
        address weth_,
        CurveParams calldata params_
    ) external;

    function buyFor(address recipient, uint256 minTokensOut, uint256 deadline)
        external
        payable
        returns (uint256 tokensOut);
    function graduated() external view returns (bool);
}

interface IFeeRouter {
    /// @notice Receive the flat curve fee (ETH). 100% protocol revenue.
    function collectCurveFee(address token) external payable;

    /// @notice Receive a creator levy (ETH). Split 90% creator / 10% protocol.
    function collectLevy(address token) external payable;

    /// @notice Receive the token-deploy fee (ETH). 100% protocol revenue.
    function collectDeployFee(address token) external payable;
}

interface IRobinStaking {
    /// @notice Push ETH protocol revenue into the staking reward stream.
    function notifyReward() external payable;
}
