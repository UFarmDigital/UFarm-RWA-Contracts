// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {SaleFixPrice} from "../impl/SaleFixPrice.sol";

/// @title SaleFixPrice V2
/// @author UFarm Digital
/// @notice Test implementation used to validate UUPS upgrades.
contract SaleFixPriceV2 is SaleFixPrice {
    /// @notice Returns the v2 marker string.
    function versionV2() external pure returns (string memory) {
        return "v2";
    }
}
