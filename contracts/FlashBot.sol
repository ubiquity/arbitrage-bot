// SPDX-License-Identifier: GPL-2.0-or-later
pragma solidity 0.8.20;

import '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import '@openzeppelin/contracts/access/Ownable.sol';
import '@openzeppelin/contracts/utils/structs/EnumerableSet.sol';
import 'hardhat/console.sol';
import '@openzeppelin/contracts/utils/math/SafeMath.sol';

import './interfaces/IUniswapV2Pair.sol';
import './interfaces/IWETH.sol';
import './interfaces/IUbiquityPool.sol';
import './libraries/Decimal.sol';

/////////////////////////////////////////////////////////////
//////////////  Forked from AMM-Arbitrageur /////////////////
/////////////////////////////////////////////////////////////

struct OrderedReserves {
    uint256 a1; // base asset
    uint256 b1;
    uint256 a2;
    uint256 b2;
}

struct ArbitrageInfo {
    address baseToken;
    address quoteToken;
    bool baseTokenSmaller;
    address lowerPool; // pool with lower price, denominated in quote asset
    address higherPool; // pool with higher price, denominated in quote asset
}

struct CallbackData {
    address debtPool;
    address targetPool;
    bool debtTokenSmaller;
    address borrowedToken;
    address debtToken;
    uint256 debtAmount;
    uint256 debtTokenOutAmount;
}

contract FlashBot is Ownable {
    using Decimal for Decimal.D256;
    using SafeMath for uint256;
    using Decimal for Decimal.D256;
    using SafeERC20 for IERC20;
    using EnumerableSet for EnumerableSet.AddressSet;

    // ACCESS CONTROL
    // Only the `permissionedPairAddress` may call the `uniswapV2Call` function
    address permissionedPairAddress = address(1);

    // WETH on ETH network
    address immutable WETH;

    // AVAILABLE BASE TOKENS
    // Add base token from Ubiquity to the list
    EnumerableSet.AddressSet baseTokens;

    event Withdrawn(address indexed to, uint256 indexed value);
    event BaseTokenAdded(address indexed token);
    event BaseTokenRemoved(address indexed token);

    constructor(address _WETH) {
        WETH = _WETH;
        baseTokens.add(_WETH);
    }

    receive() external payable {}

    function withdraw() external {
        uint256 balance = address(this).balance;
        if (balance > 0) {
            payable(owner()).transfer(balance);
            emit Withdrawn(owner(), balance);
        }

        for (uint256 i = 0; i < baseTokens.length(); i++) {
            address token = baseTokens.at(i);
            balance = IERC20(token).balanceOf(address(this));
            if (balance > 0) {
                // do not use safe transfer here to prevents revert by any shitty token
                IERC20(token).transfer(owner(), balance);
            }
        }
    }

    function addBaseToken(address token) external onlyOwner {
        baseTokens.add(token);
        emit BaseTokenAdded(token);
    }

    function removeBaseToken(address token) external onlyOwner {
        uint256 balance = IERC20(token).balanceOf(address(this));
        if (balance > 0) {
            // do not use safe transfer to prevents revert by any shitty token
            IERC20(token).transfer(owner(), balance);
        }
        baseTokens.remove(token);
        emit BaseTokenRemoved(token);
    }

    function getBaseTokens() external view returns (address[] memory tokens) {
        uint256 length = baseTokens.length();
        tokens = new address[](length);
        for (uint256 i = 0; i < length; i++) {
            tokens[i] = baseTokens.at(i);
        }
    }

    function baseTokensContains(address token) public view returns (bool) {
        return baseTokens.contains(token);
    }

    function isBaseTokenSmaller(address uniswapPool, address ubiquityPool, uint256 collateralIndex)
        internal
        view
        returns (
            bool baseSmaller,
            address baseToken,
            address quoteToken
        )
    {
        require(uniswapPool != ubiquityPool, 'Same pair address');

        // Fetch tokens from Uniswap pool
        (address uniswapToken0, address uniswapToken1) = (IUniswapV2Pair(uniswapPool).token0(), IUniswapV2Pair(uniswapPool).token1());

        // Fetch the collateral token from the Ubiquity pool
        CollateralInformation memory collateralInfo = IUbiquityPool(ubiquityPool).collateralInformation(
            IUbiquityPool(ubiquityPool).allCollaterals()[collateralIndex]
        );
        address collateralToken = collateralInfo.collateralAddress;

        // Ubiquity Dollar as base token
        address ubiquityDollar = IUbiquityPool(ubiquityPool).getDollarPriceUsd() > 0 ? address(ubiquityPool) : address(0); // Replace with actual Ubiquity Dollar token address

        // Ensure that both the Uniswap pool and Ubiquity pool deal with the same tokens
        require((uniswapToken0 == collateralToken || uniswapToken1 == collateralToken), 'No matching collateral in Uniswap pair');

        // Logic to check if the base token is smaller
        // Comparing Ubiquity Dollar (assumed to be the base token) with collateral
        if (ubiquityDollar < collateralToken) {
            (baseSmaller, baseToken, quoteToken) = (true, ubiquityDollar, collateralToken);
        } else {
            (baseSmaller, baseToken, quoteToken) = (false, collateralToken, ubiquityDollar);
        }
    }

    /// @dev Compare price denominated in quote token between two pools
    /// We borrow base token by using flash swap from lower price pool and sell them to higher price pool
    function getOrderedReserves(
        address uniswapPool,
        address ubiquityPool,
        bool baseTokenSmaller
    )
        internal
        view
        returns (
            address lowerPool,
            address higherPool,
            OrderedReserves memory orderedReserves
        )
    {
        (uint256 uniswapReserve0, uint256 uniswapReserve1, ) = IUniswapV2Pair(uniswapPool).getReserves();

        uint256 ubiquityDollarPriceUsd = IUbiquityPool(ubiquityPool).getDollarPriceUsd();

        // Calculate Uniswap pool price denominated in quote asset token
        Decimal.D256 memory uniswapPrice = baseTokenSmaller
            ? Decimal.from(uniswapReserve0).div(uniswapReserve1)
            : Decimal.from(uniswapReserve1).div(uniswapReserve0);

         // Ubiquity pool price is already in USD terms (assumed precision 1e6)
        Decimal.D256 memory ubiquityPrice = Decimal.from(ubiquityDollarPriceUsd).div(1e6);


        // Determine the pool with lower price denominated in quote asset token
        if (uniswapPrice.lessThan(ubiquityPrice)) {
            lowerPool = uniswapPool;
            higherPool = ubiquityPool;
            // Uniswap pool reserves
            (orderedReserves.a1, orderedReserves.b1) = baseTokenSmaller
                ? (uniswapReserve0, uniswapReserve1)
                : (uniswapReserve1, uniswapReserve0);
            // No concept of reserves in Ubiquity pool, just assign a large value to indicate it's available
            (orderedReserves.a2, orderedReserves.b2) = (1e18, 1e18); // Arbitrary large number as Ubiquity pool doesn't track traditional reserves
        } else {
            lowerPool = ubiquityPool;
            higherPool = uniswapPool;
            // Ubiquity pool acts as the source
            (orderedReserves.a1, orderedReserves.b1) = (1e18, 1e18); // Ubiquity pool does not have a direct reserve structure
            // Uniswap pool reserves
            (orderedReserves.a2, orderedReserves.b2) = baseTokenSmaller
                ? (uniswapReserve0, uniswapReserve1)
                : (uniswapReserve1, uniswapReserve0);
        }
        console.log('Borrow from pool:', lowerPool);
        console.log('Sell to pool:', higherPool);
    }

    /// @notice Do an arbitrage between Uniswap and Ubiquity pool
    /// @dev One pool must be a Uniswap-like pool, and the other must be the Ubiquity pool
    function flashArbitrage(address uniswapPool, address ubiquityPool, uint256 collateralIndex) external {
        ArbitrageInfo memory info;

        // Determine whether the base token (Ubiquity Dollar) is smaller
        (info.baseTokenSmaller, info.baseToken, info.quoteToken) = isBaseTokenSmaller(uniswapPool, ubiquityPool, collateralIndex);

        OrderedReserves memory orderedReserves;
        (info.lowerPool, info.higherPool, orderedReserves) = getOrderedReserves(uniswapPool, ubiquityPool, info.baseTokenSmaller);

        permissionedPairAddress = info.lowerPool;

        uint256 balanceBefore = IERC20(info.baseToken).balanceOf(address(this));

        {
            uint256 borrowAmount = calcBorrowAmount(orderedReserves);
            uint256 debtAmount;
            uint256 baseTokenOutAmount;

            if (info.lowerPool == uniswapPool) {
                // Arbitrage by borrowing from Uniswap pool and selling to Ubiquity pool

                // Borrow quote token from Uniswap
                (uint256 amount0Out, uint256 amount1Out) = info.baseTokenSmaller
                    ? (uint256(0), borrowAmount)
                    : (borrowAmount, uint256(0));

                debtAmount = getAmountIn(borrowAmount, orderedReserves.a1, orderedReserves.b1);

                // Mint Ubiquity Dollars from the collateral token borrowed
                (, uint256 collateralNeeded, ) = IUbiquityPool(ubiquityPool).mintDollar(
                    collateralIndex, 
                    borrowAmount, 
                    1,  // slippage protection
                    borrowAmount, 
                    0,  // no governance tokens needed
                    true // Only collateral used
                );

                baseTokenOutAmount = collateralNeeded; // Amount of base token (Ubiquity Dollar) received
            } else {
                // Arbitrage by borrowing from Ubiquity pool and selling to Uniswap pool

                // Borrow Ubiquity Dollars using the mint function
                (uint256 totalDollarMint, , ) = IUbiquityPool(ubiquityPool).mintDollar(
                    collateralIndex, 
                    borrowAmount, 
                    1, // slippage protection
                    borrowAmount, 
                    0,  // no governance tokens needed
                    true // Only collateral used
                );

                // Calculate debt in the Uniswap pool in base tokens
                debtAmount = getAmountIn(totalDollarMint, orderedReserves.a1, orderedReserves.b1);

                // Sell Ubiquity Dollars on the Uniswap pool
                baseTokenOutAmount = getAmountOut(totalDollarMint, orderedReserves.b2, orderedReserves.a2);
            }

            require(baseTokenOutAmount > debtAmount, 'Arbitrage fail, no profit');
            console.log('Profit:', (baseTokenOutAmount - debtAmount) / 1 ether);

            // Callback data for the swap, depending on the flow (borrowing from either Uniswap or Ubiquity)
            CallbackData memory callbackData;
            callbackData.debtPool = info.lowerPool;
            callbackData.targetPool = info.higherPool;
            callbackData.debtTokenSmaller = info.baseTokenSmaller;
            callbackData.borrowedToken = info.quoteToken;
            callbackData.debtToken = info.baseToken;
            callbackData.debtAmount = debtAmount;
            callbackData.debtTokenOutAmount = baseTokenOutAmount;

            // Encode the callback data for the swap
            bytes memory data = abi.encode(callbackData);

            // If borrowing from Uniswap, trigger the swap
            if (info.lowerPool == uniswapPool) {
                IUniswapV2Pair(info.lowerPool).swap(
                    info.baseTokenSmaller ? uint256(0) : borrowAmount,
                    info.baseTokenSmaller ? borrowAmount : uint256(0),
                    address(this),
                    data
                );
            } else {
                // No swap call for Ubiquity pool, handle manually via minting and redemption
                IUbiquityPool(ubiquityPool).redeemDollar(
                    collateralIndex, 
                    borrowAmount, 
                    0, // slippage protection
                    1  // collateral out min
                );
            }
        }

        uint256 balanceAfter = IERC20(info.baseToken).balanceOf(address(this));
        require(balanceAfter > balanceBefore, 'Losing money');

        if (info.baseToken == WETH) {
            IWETH(info.baseToken).withdraw(balanceAfter);
        }

        permissionedPairAddress = address(1);
    }

    function uniswapV2Call(
        address sender,
        uint256 amount0,
        uint256 amount1,
        bytes memory data
    ) public {
        // access control
        require(msg.sender == permissionedPairAddress, 'Non permissioned address call');
        require(sender == address(this), 'Not from this contract');

        uint256 borrowedAmount = amount0 > 0 ? amount0 : amount1;
        CallbackData memory info = abi.decode(data, (CallbackData));

        IERC20(info.borrowedToken).safeTransfer(info.targetPool, borrowedAmount);

        (uint256 amount0Out, uint256 amount1Out) =
            info.debtTokenSmaller ? (info.debtTokenOutAmount, uint256(0)) : (uint256(0), info.debtTokenOutAmount);
        IUniswapV2Pair(info.targetPool).swap(amount0Out, amount1Out, address(this), new bytes(0));

        IERC20(info.debtToken).safeTransfer(info.debtPool, info.debtAmount);
    }

    // /// @notice Calculate how much profit we can by arbitraging between two pools
    // function getProfit(address uniswapPool, address ubiquityPool, uint256 collateralIndex) external view returns (uint256 profit, address baseToken) {
    //     (bool baseTokenSmaller, , ) = isBaseTokenSmaller(uniswapPool, ubiquityPool, collateralIndex);

    //     // OrderedReserves memory orderedReserves;
    //     (address lowerPool, address higherPool, OrderedReserves memory orderedReserves) = getOrderedReserves(uniswapPool, ubiquityPool, baseTokenSmaller);

    //     uint256 borrowAmount = calcBorrowAmount(orderedReserves);
    //     uint256 debtAmount;
    //     uint256 baseTokenOutAmount;

    //     if (lowerPool == uniswapPool) {
    //         // Borrow from Uniswap and sell on Ubiquity Pool
    //         debtAmount = getAmountIn(borrowAmount, orderedReserves.a1, orderedReserves.b1);

    //         // Mint Ubiquity Dollars from the borrowed collateral (collateralIndex corresponds to the collateral token)
    //         (, uint256 collateralNeeded, ) = IUbiquityPool(ubiquityPool).mintDollar(
    //             collateralIndex,
    //             borrowAmount,
    //             1, // slippage protection
    //             borrowAmount, // Max collateral to send
    //             0,  // no governance tokens needed
    //             true // Only collateral used
    //         );

    //         // Profit is the collateral we receive after minting Ubiquity Dollars
    //         baseTokenOutAmount = collateralNeeded; // This is the value we receive after minting
    //     } else {
    //         // Borrow Ubiquity Dollars and sell on Uniswap Pool
    //         (uint256 totalDollarMint, , ) = IUbiquityPool(ubiquityPool).mintDollar(
    //             collateralIndex,
    //             borrowAmount,
    //             1, // slippage protection
    //             borrowAmount, // Max collateral to send
    //             0,  // no governance tokens needed
    //             true // Only collateral used
    //         );

    //         // Calculate the debt in Uniswap pool (amount to repay)
    //         debtAmount = getAmountIn(totalDollarMint, orderedReserves.a1, orderedReserves.b1);

    //         // Sell Ubiquity Dollars on Uniswap to get base token
    //         baseTokenOutAmount = getAmountOut(totalDollarMint, orderedReserves.b2, orderedReserves.a2);
    //     }

    //     // Calculate profit (if any)
    //     if (baseTokenOutAmount < debtAmount) {
    //         profit = 0;
    //     } else {
    //         profit = baseTokenOutAmount - debtAmount;
    //     }
    // }

    /// @dev calculate the maximum base asset amount to borrow in order to get maximum profit during arbitrage
    function calcBorrowAmount(OrderedReserves memory reserves) internal pure returns (uint256 amount) {
        // we can't use a1,b1,a2,b2 directly, because it will result overflow/underflow on the intermediate result
        // so we:
        //    1. divide all the numbers by d to prevent from overflow/underflow
        //    2. calculate the result by using above numbers
        //    3. multiply d with the result to get the final result
        // Note: this workaround is only suitable for ERC20 token with 18 decimals, which I believe most tokens do

        uint256 min1 = reserves.a1 < reserves.b1 ? reserves.a1 : reserves.b1;
        uint256 min2 = reserves.a2 < reserves.b2 ? reserves.a2 : reserves.b2;
        uint256 min = min1 < min2 ? min1 : min2;

        // choose appropriate number to divide based on the minimum number
        uint256 d;
        if (min > 1e24) {
            d = 1e20;
        } else if (min > 1e23) {
            d = 1e19;
        } else if (min > 1e22) {
            d = 1e18;
        } else if (min > 1e21) {
            d = 1e17;
        } else if (min > 1e20) {
            d = 1e16;
        } else if (min > 1e19) {
            d = 1e15;
        } else if (min > 1e18) {
            d = 1e14;
        } else if (min > 1e17) {
            d = 1e13;
        } else if (min > 1e16) {
            d = 1e12;
        } else if (min > 1e15) {
            d = 1e11;
        } else {
            d = 1e10;
        }

        (int256 a1, int256 a2, int256 b1, int256 b2) =
            (int256(reserves.a1 / d), int256(reserves.a2 / d), int256(reserves.b1 / d), int256(reserves.b2 / d));

        int256 a = a1 * b1 - a2 * b2;
        int256 b = 2 * b1 * b2 * (a1 + a2);
        int256 c = b1 * b2 * (a1 * b2 - a2 * b1);

        (int256 x1, int256 x2) = calcSolutionForQuadratic(a, b, c);

        // 0 < x < b1 and 0 < x < b2
        require((x1 > 0 && x1 < b1 && x1 < b2) || (x2 > 0 && x2 < b1 && x2 < b2), 'Wrong input order');
        amount = (x1 > 0 && x1 < b1 && x1 < b2) ? uint256(x1) * d : uint256(x2) * d;
    }

    /// @dev find solution of quadratic equation: ax^2 + bx + c = 0, only return the positive solution
    function calcSolutionForQuadratic(
        int256 a,
        int256 b,
        int256 c
    ) internal pure returns (int256 x1, int256 x2) {
        int256 m = b**2 - 4 * a * c;
        // m < 0 leads to complex number
        require(m > 0, 'Complex number');

        int256 sqrtM = int256(sqrt(uint256(m)));
        x1 = (-b + sqrtM) / (2 * a);
        x2 = (-b - sqrtM) / (2 * a);
    }

    /// @dev Newton’s method for caculating square root of n
    function sqrt(uint256 n) internal pure returns (uint256 res) {
        assert(n > 1);

        // The scale factor is a crude way to turn everything into integer calcs.
        // Actually do (n * 10 ^ 4) ^ (1/2)
        uint256 _n = n * 10**6;
        uint256 c = _n;
        res = _n;

        uint256 xi;
        while (true) {
            xi = (res + c / res) / 2;
            // don't need be too precise to save gas
            if (res - xi < 1000) {
                break;
            }
            res = xi;
        }
        res = res / 10**3;
    }

    // copy from UniswapV2Library
    // given an output amount of an asset and pair reserves, returns a required input amount of the other asset
    function getAmountIn(
        uint256 amountOut,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256 amountIn) {
        require(reserveIn > 0 && reserveOut > 0, 'UniswapV2Library: INSUFFICIENT_LIQUIDITY');
        uint256 numerator = reserveIn.mul(amountOut).mul(1000);
        uint256 denominator = reserveOut.sub(amountOut).mul(997);
        amountIn = (numerator / denominator).add(1);
    }

    // copy from UniswapV2Library
    // given an input amount of an asset and pair reserves, returns the maximum output amount of the other asset
    function getAmountOut(
        uint256 amountIn,
        uint256 reserveIn,
        uint256 reserveOut
    ) internal pure returns (uint256 amountOut) {
        require(amountIn > 0, 'UniswapV2Library: INSUFFICIENT_INPUT_AMOUNT');
        require(reserveIn > 0 && reserveOut > 0, 'UniswapV2Library: INSUFFICIENT_LIQUIDITY');
        uint256 amountInWithFee = amountIn.mul(997);
        uint256 numerator = amountInWithFee.mul(reserveOut);
        uint256 denominator = reserveIn.mul(1000).add(amountInWithFee);
        amountOut = numerator / denominator;
    }
}
