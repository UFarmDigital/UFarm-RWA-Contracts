// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISaleFixPrice} from "../interfaces/ISaleFixPrice.sol";
import {
    DecimalDifferenceTooLarge,
    DuplicateStablecoin,
    EmptyStablecoinList,
    InvalidStablecoin,
    NonRepresentableAmount,
    UnsupportedToken,
    ZeroAddress,
    ZeroAmount
} from "../lib/Errors.sol";

/// @title Fixed Price Sale
/// @author UFarm Digital
/// @notice Holds one sale token and swaps it against initialized stablecoins at normalized 1:1 value.
contract SaleFixPrice is Initializable, OwnableUpgradeable, PausableUpgradeable, UUPSUpgradeable, ISaleFixPrice {
    using SafeERC20 for IERC20;

    uint256 private constant MAX_DECIMAL_DIFF = 18;

    address private _token;
    address[] private _stablecoins;
    mapping(address => bool) private _isStablecoin;

    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes sale token and stablecoin allowlist.
    /// @param owner_ Initial owner address.
    /// @param token_ Sale token address.
    /// @param stablecoins_ Accepted stablecoin addresses.
    function initialize(address owner_, address token_, address[] calldata stablecoins_) external initializer {
        if (owner_ == address(0) || token_ == address(0)) revert ZeroAddress();
        if (stablecoins_.length == 0) revert EmptyStablecoinList();

        __Ownable_init(owner_);
        __Pausable_init();

        _token = token_;
        uint8 tokenDecimals = IERC20Metadata(token_).decimals();

        for (uint256 i = 0; i < stablecoins_.length; ++i) {
            address stablecoin = stablecoins_[i];
            if (stablecoin == address(0)) revert ZeroAddress();
            if (stablecoin == token_) revert InvalidStablecoin(stablecoin);
            if (_isStablecoin[stablecoin]) revert DuplicateStablecoin(stablecoin);

            // Each configured stablecoin has its own decimal precision; initialization is owner-configured.
            // slither-disable-next-line calls-loop
            uint8 stablecoinDecimals = IERC20Metadata(stablecoin).decimals();
            uint256 difference = tokenDecimals > stablecoinDecimals
                ? tokenDecimals - stablecoinDecimals
                : stablecoinDecimals - tokenDecimals;
            if (difference > MAX_DECIMAL_DIFF) revert DecimalDifferenceTooLarge(tokenDecimals, stablecoinDecimals);

            _isStablecoin[stablecoin] = true;
            _stablecoins.push(stablecoin);
        }
    }

    /// @notice Buys sale tokens with an accepted stablecoin.
    /// @param amountTokenOut Sale token amount to receive.
    /// @param stablecoin Stablecoin used for payment.
    function buyWith(uint256 amountTokenOut, address stablecoin) external override whenNotPaused {
        if (amountTokenOut == 0) revert ZeroAmount();
        _requireStablecoin(stablecoin);

        uint256 stablecoinAmount = _stablecoinAmountForTokenAmount(amountTokenOut, stablecoin);
        IERC20(stablecoin).safeTransferFrom(msg.sender, address(this), stablecoinAmount);
        IERC20(_token).safeTransfer(msg.sender, amountTokenOut);

        emit Bought(msg.sender, stablecoin, amountTokenOut, stablecoinAmount);
    }

    /// @notice Sells sale tokens for an accepted stablecoin.
    /// @param amountTokenIn Sale token amount to sell.
    /// @param stablecoin Stablecoin to receive.
    function sellFor(uint256 amountTokenIn, address stablecoin) external override whenNotPaused {
        if (amountTokenIn == 0) revert ZeroAmount();
        _requireStablecoin(stablecoin);

        uint256 stablecoinAmount = _stablecoinAmountForTokenAmount(amountTokenIn, stablecoin);
        IERC20(_token).safeTransferFrom(msg.sender, address(this), amountTokenIn);
        IERC20(stablecoin).safeTransfer(msg.sender, stablecoinAmount);

        emit Sold(msg.sender, stablecoin, amountTokenIn, stablecoinAmount);
    }

    /// @notice Deposits sale token or accepted stablecoin liquidity.
    /// @param amount Amount to deposit.
    /// @param tokenAddress Token address to deposit.
    function deposit(uint256 amount, address tokenAddress) external override onlyOwner {
        if (amount == 0) revert ZeroAmount();
        _requireSupportedToken(tokenAddress);

        IERC20(tokenAddress).safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, tokenAddress, amount);
    }

    /// @notice Withdraws sale token or accepted stablecoin liquidity.
    /// @param amount Amount to withdraw.
    /// @param tokenAddress Token address to withdraw.
    function withdraw(uint256 amount, address tokenAddress) external override onlyOwner {
        if (amount == 0) revert ZeroAmount();
        IERC20(tokenAddress).safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, tokenAddress, amount);
    }

    /// @notice Returns the sale token address.
    /// @return saleToken Sale token address.
    function token() external view override returns (address saleToken) {
        return _token;
    }

    /// @notice Returns accepted stablecoin addresses.
    /// @return stablecoins Accepted stablecoin list.
    function getStablecoins() external view override returns (address[] memory stablecoins) {
        return _stablecoins;
    }

    /// @notice Returns whether an address is an accepted stablecoin.
    /// @param stablecoin Address to check.
    /// @return supported True when the stablecoin is accepted.
    function isStablecoin(address stablecoin) external view override returns (bool supported) {
        return _isStablecoin[stablecoin];
    }

    /// @notice Stops swaps while preserving owner liquidity management.
    function pause() external override onlyOwner {
        _pause();
    }

    /// @notice Resumes swaps.
    function unpause() external override onlyOwner {
        _unpause();
    }

    /// @notice Removes a stablecoin from the swap allowlist.
    function disableStablecoin(address stablecoin) external override onlyOwner {
        if (!_isStablecoin[stablecoin]) revert UnsupportedToken(stablecoin);
        _isStablecoin[stablecoin] = false;
        emit StablecoinDisabled(stablecoin);
    }

    /// @notice Requires stablecoin support.
    /// @param stablecoin Stablecoin address.
    function _requireStablecoin(address stablecoin) internal view {
        if (!_isStablecoin[stablecoin]) revert UnsupportedToken(stablecoin);
    }

    /// @notice Requires sale token or stablecoin support.
    /// @param tokenAddress Token address.
    function _requireSupportedToken(address tokenAddress) internal view {
        if (tokenAddress != _token && !_isStablecoin[tokenAddress]) revert UnsupportedToken(tokenAddress);
    }

    /// @notice Converts a sale token amount to stablecoin amount at 1:1 whole-token value.
    /// @param amount Sale token amount.
    /// @param stablecoin Stablecoin address.
    /// @return stablecoinAmount Normalized stablecoin amount.
    function _stablecoinAmountForTokenAmount(
        uint256 amount,
        address stablecoin
    ) internal view returns (uint256 stablecoinAmount) {
        uint8 tokenDecimals = IERC20Metadata(_token).decimals();
        uint8 stablecoinDecimals = IERC20Metadata(stablecoin).decimals();
        return _convertDecimals(amount, tokenDecimals, stablecoinDecimals);
    }

    /// @notice Converts an amount between decimals exactly, reverting if rounding would be needed.
    /// @param amount Amount in source decimals.
    /// @param fromDecimals Source decimals.
    /// @param toDecimals Target decimals.
    /// @return converted Converted amount in target decimals.
    function _convertDecimals(
        uint256 amount,
        uint8 fromDecimals,
        uint8 toDecimals
    ) internal pure returns (uint256 converted) {
        if (toDecimals == fromDecimals) {
            return amount;
        }

        if (toDecimals > fromDecimals) {
            uint256 increase = uint256(toDecimals - fromDecimals);
            if (increase > MAX_DECIMAL_DIFF) revert DecimalDifferenceTooLarge(fromDecimals, toDecimals);
            return amount * (10 ** increase);
        }

        uint256 decrease = uint256(fromDecimals - toDecimals);
        if (decrease > MAX_DECIMAL_DIFF) revert DecimalDifferenceTooLarge(fromDecimals, toDecimals);

        uint256 factor = 10 ** decrease;
        if (amount % factor != 0) revert NonRepresentableAmount(amount, fromDecimals, toDecimals);
        return amount / factor;
    }

    /// @notice Authorizes a UUPS upgrade.
    /// @param newImplementation New implementation address.
    function _authorizeUpgrade(address newImplementation) internal view override onlyOwner {
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /// @dev Storage gap for upgrade safety.
    // slither-disable-next-line naming-convention,unused-state
    uint256[47] private __gap;
}
