// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IMockWETH is IERC20 {
    function deposit() external payable;
    function withdraw(uint256) external;
}

/// @dev Functional Uniswap-v2 pair: real constant-product math with the 0.3%
///      LP fee, MINIMUM_LIQUIDITY lock, mint/swap/skim/sync. Faithful enough
///      that fee-on-transfer swaps, graduation LP-adds and LP burns behave as
///      they will on a mainnet v2 fork.
contract MockUniswapV2Pair {
    uint256 public constant MINIMUM_LIQUIDITY = 1e3;

    address public immutable factory;
    address public token0;
    address public token1;

    uint112 private reserve0;
    uint112 private reserve1;
    uint32 private blockTimestampLast;

    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;

    event Mint(address indexed sender, uint256 amount0, uint256 amount1);
    event Swap(
        address indexed sender,
        uint256 amount0In,
        uint256 amount1In,
        uint256 amount0Out,
        uint256 amount1Out,
        address indexed to
    );
    event Sync(uint112 reserve0, uint112 reserve1);
    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor() {
        factory = msg.sender;
    }

    function initialize(address token0_, address token1_) external {
        require(msg.sender == factory, "pair: forbidden");
        token0 = token0_;
        token1 = token1_;
    }

    function getReserves() public view returns (uint112, uint112, uint32) {
        return (reserve0, reserve1, blockTimestampLast);
    }

    function mint(address to) external returns (uint256 liquidity) {
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0 = balance0 - _reserve0;
        uint256 amount1 = balance1 - _reserve1;

        if (totalSupply == 0) {
            liquidity = Math.sqrt(amount0 * amount1) - MINIMUM_LIQUIDITY;
            _mint(address(0xdead), MINIMUM_LIQUIDITY);
        } else {
            liquidity = Math.min((amount0 * totalSupply) / _reserve0, (amount1 * totalSupply) / _reserve1);
        }
        require(liquidity > 0, "pair: insufficient liquidity minted");
        _mint(to, liquidity);
        _update(balance0, balance1);
        emit Mint(msg.sender, amount0, amount1);
    }

    function swap(uint256 amount0Out, uint256 amount1Out, address to, bytes calldata) external {
        require(amount0Out > 0 || amount1Out > 0, "pair: insufficient output");
        (uint112 _reserve0, uint112 _reserve1,) = getReserves();
        require(amount0Out < _reserve0 && amount1Out < _reserve1, "pair: insufficient liquidity");

        if (amount0Out > 0) IERC20(token0).transfer(to, amount0Out);
        if (amount1Out > 0) IERC20(token1).transfer(to, amount1Out);

        uint256 balance0 = IERC20(token0).balanceOf(address(this));
        uint256 balance1 = IERC20(token1).balanceOf(address(this));
        uint256 amount0In = balance0 > _reserve0 - amount0Out ? balance0 - (_reserve0 - amount0Out) : 0;
        uint256 amount1In = balance1 > _reserve1 - amount1Out ? balance1 - (_reserve1 - amount1Out) : 0;
        require(amount0In > 0 || amount1In > 0, "pair: insufficient input");

        uint256 adjusted0 = balance0 * 1000 - amount0In * 3;
        uint256 adjusted1 = balance1 * 1000 - amount1In * 3;
        require(adjusted0 * adjusted1 >= uint256(_reserve0) * _reserve1 * 1000 ** 2, "pair: K");

        _update(balance0, balance1);
        emit Swap(msg.sender, amount0In, amount1In, amount0Out, amount1Out, to);
    }

    function skim(address to) external {
        IERC20(token0).transfer(to, IERC20(token0).balanceOf(address(this)) - reserve0);
        IERC20(token1).transfer(to, IERC20(token1).balanceOf(address(this)) - reserve1);
    }

    function sync() external {
        _update(IERC20(token0).balanceOf(address(this)), IERC20(token1).balanceOf(address(this)));
    }

    function _mint(address to, uint256 value) private {
        totalSupply += value;
        balanceOf[to] += value;
        emit Transfer(address(0), to, value);
    }

    function _update(uint256 balance0, uint256 balance1) private {
        require(balance0 <= type(uint112).max && balance1 <= type(uint112).max, "pair: overflow");
        reserve0 = uint112(balance0);
        reserve1 = uint112(balance1);
        blockTimestampLast = uint32(block.timestamp);
        emit Sync(reserve0, reserve1);
    }
}

/// @dev Uniswap-v2 style factory over the mock pair.
contract MockUniswapV2Factory {
    mapping(address => mapping(address => address)) public getPair;
    address[] public allPairs;

    event PairCreated(address indexed token0, address indexed token1, address pair, uint256);

    function createPair(address tokenA, address tokenB) external returns (address pair) {
        require(tokenA != tokenB, "factory: identical");
        (address token0, address token1) = tokenA < tokenB ? (tokenA, tokenB) : (tokenB, tokenA);
        require(token0 != address(0), "factory: zero address");
        require(getPair[token0][token1] == address(0), "factory: exists");

        pair = address(new MockUniswapV2Pair{salt: keccak256(abi.encodePacked(token0, token1))}());
        MockUniswapV2Pair(pair).initialize(token0, token1);
        getPair[token0][token1] = pair;
        getPair[token1][token0] = pair;
        allPairs.push(pair);
        emit PairCreated(token0, token1, pair, allPairs.length);
    }

    function allPairsLength() external view returns (uint256) {
        return allPairs.length;
    }
}

/// @dev Minimal v2 router: just the fee-on-transfer-supporting exact-in swaps
///      the protocol and its tests need.
contract MockUniswapV2Router {
    MockUniswapV2Factory public immutable factoryContract;
    IMockWETH public immutable wethContract;

    constructor(address factory_, address weth_) {
        factoryContract = MockUniswapV2Factory(factory_);
        wethContract = IMockWETH(weth_);
    }

    receive() external payable {}

    function factory() external view returns (address) {
        return address(factoryContract);
    }

    function WETH() external view returns (address) {
        return address(wethContract);
    }

    function swapExactTokensForETHSupportingFeeOnTransferTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external {
        require(block.timestamp <= deadline, "router: expired");
        require(path.length == 2 && path[1] == address(wethContract), "router: bad path");

        address pair = factoryContract.getPair(path[0], path[1]);
        require(pair != address(0), "router: no pair");

        IERC20(path[0]).transferFrom(msg.sender, pair, amountIn);
        _swapSupportingFee(pair, path[0], path[1], address(this));

        uint256 amountOut = wethContract.balanceOf(address(this));
        require(amountOut >= amountOutMin, "router: insufficient output");
        wethContract.withdraw(amountOut);
        (bool ok,) = to.call{value: amountOut}("");
        require(ok, "router: eth send");
    }

    function swapExactETHForTokensSupportingFeeOnTransferTokens(
        uint256 amountOutMin,
        address[] calldata path,
        address to,
        uint256 deadline
    ) external payable {
        require(block.timestamp <= deadline, "router: expired");
        require(path.length == 2 && path[0] == address(wethContract), "router: bad path");

        address pair = factoryContract.getPair(path[0], path[1]);
        require(pair != address(0), "router: no pair");

        wethContract.deposit{value: msg.value}();
        wethContract.transfer(pair, msg.value);
        uint256 balanceBefore = IERC20(path[1]).balanceOf(to);
        _swapSupportingFee(pair, path[0], path[1], to);
        require(IERC20(path[1]).balanceOf(to) - balanceBefore >= amountOutMin, "router: insufficient output");
    }

    /// @dev Mirrors UniswapV2Router02's supporting-fee internal swap: amounts
    ///      are derived from live pair balances, so fee-on-transfer input is
    ///      handled correctly.
    function _swapSupportingFee(address pairAddr, address input, address output, address to) private {
        MockUniswapV2Pair pair = MockUniswapV2Pair(pairAddr);
        (uint112 r0, uint112 r1,) = pair.getReserves();
        (uint112 reserveIn, uint112 reserveOut) = input < output ? (r0, r1) : (r1, r0);

        uint256 amountIn = IERC20(input).balanceOf(pairAddr) - reserveIn;
        uint256 amountInWithFee = amountIn * 997;
        uint256 amountOut = (amountInWithFee * reserveOut) / (uint256(reserveIn) * 1000 + amountInWithFee);

        (uint256 amount0Out, uint256 amount1Out) =
            input < output ? (uint256(0), amountOut) : (amountOut, uint256(0));
        pair.swap(amount0Out, amount1Out, to, "");
    }
}
