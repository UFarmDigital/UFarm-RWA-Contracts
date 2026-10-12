// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Mock ERC-20
/// @author UFarm Digital
/// @notice Mintable ERC-20 with constructor-configured decimals for tests.
contract MockERC20 is ERC20 {
    error MockTransferReverted();

    uint8 private immutable CUSTOM_DECIMALS;
    bool private transfersReverting;

    /// @notice Initializes token metadata.
    /// @param name_ Token name.
    /// @param symbol_ Token symbol.
    /// @param decimals_ Token decimals.
    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        CUSTOM_DECIMALS = decimals_;
    }

    /// @notice Returns configured decimals.
    /// @return Token decimals.
    function decimals() public view override returns (uint8) {
        return CUSTOM_DECIMALS;
    }

    /// @notice Mints tokens to an address.
    /// @param to Recipient address.
    /// @param amount Amount to mint.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice Configures transfer failures for payout-atomicity tests.
    /// @param value Whether non-mint token updates should revert.
    function setTransfersReverting(bool value) external {
        transfersReverting = value;
    }

    /// @dev Simulates a failing stablecoin transfer without blocking test funding mints.
    function _update(address from, address to, uint256 amount) internal override {
        if (transfersReverting && from != address(0)) revert MockTransferReverted();
        super._update(from, to, amount);
    }
}
