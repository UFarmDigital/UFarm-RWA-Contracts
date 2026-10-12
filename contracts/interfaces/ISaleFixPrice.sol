// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title Fixed Price Sale Interface
/// @author UFarm Digital
/// @notice Swaps one sale token against initialized stablecoins at normalized 1:1 value.
interface ISaleFixPrice {
    event StablecoinDisabled(address indexed stablecoin);

    function pause() external;

    function unpause() external;

    function disableStablecoin(address stablecoin) external;
    /// @notice Emitted when a user buys sale tokens with a stablecoin.
    /// @param buyer Buyer address.
    /// @param stablecoin Stablecoin used for payment.
    /// @param tokenAmount Sale token amount sent to buyer.
    /// @param stablecoinAmount Stablecoin amount paid by buyer.
    event Bought(address indexed buyer, address indexed stablecoin, uint256 tokenAmount, uint256 stablecoinAmount);

    /// @notice Emitted when a user sells sale tokens for a stablecoin.
    /// @param seller Seller address.
    /// @param stablecoin Stablecoin paid to seller.
    /// @param tokenAmount Sale token amount paid by seller.
    /// @param stablecoinAmount Stablecoin amount sent to seller.
    event Sold(address indexed seller, address indexed stablecoin, uint256 tokenAmount, uint256 stablecoinAmount);

    /// @notice Emitted when the owner deposits liquidity.
    /// @param operator Owner address.
    /// @param tokenAddress Deposited token address.
    /// @param amount Deposited amount.
    event Deposited(address indexed operator, address indexed tokenAddress, uint256 amount);

    /// @notice Emitted when the owner withdraws liquidity.
    /// @param operator Owner address.
    /// @param tokenAddress Withdrawn token address.
    /// @param amount Withdrawn amount.
    event Withdrawn(address indexed operator, address indexed tokenAddress, uint256 amount);

    /// @notice Buys sale tokens with an accepted stablecoin.
    /// @param amountTokenOut Sale token amount to receive.
    /// @param stablecoin Stablecoin used for payment.
    function buyWith(uint256 amountTokenOut, address stablecoin) external;

    /// @notice Sells sale tokens for an accepted stablecoin.
    /// @param amountTokenIn Sale token amount to sell.
    /// @param stablecoin Stablecoin to receive.
    function sellFor(uint256 amountTokenIn, address stablecoin) external;

    /// @notice Deposits sale token or accepted stablecoin liquidity.
    /// @param amount Amount to deposit.
    /// @param tokenAddress Token address to deposit.
    function deposit(uint256 amount, address tokenAddress) external;

    /// @notice Withdraws sale token or accepted stablecoin liquidity.
    /// @param amount Amount to withdraw.
    /// @param tokenAddress Token address to withdraw.
    function withdraw(uint256 amount, address tokenAddress) external;

    /// @notice Returns the sale token address.
    /// @return saleToken Sale token address.
    function token() external view returns (address saleToken);

    /// @notice Returns accepted stablecoin addresses.
    /// @return stablecoins Accepted stablecoin list.
    function getStablecoins() external view returns (address[] memory stablecoins);

    /// @notice Returns whether an address is an accepted stablecoin.
    /// @param stablecoin Address to check.
    /// @return supported True when the stablecoin is accepted.
    function isStablecoin(address stablecoin) external view returns (bool supported);
}
