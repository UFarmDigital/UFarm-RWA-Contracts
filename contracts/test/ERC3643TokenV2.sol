// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ERC3643Token} from "../impl/ERC3643Token.sol";

/// @title ERC3643Token V2
/// @author UFarm Digital
/// @notice Test implementation used to validate UUPS upgrades.
contract ERC3643TokenV2 is ERC3643Token {
    /// @notice Returns the v2 marker string.
    function versionV2() external pure returns (string memory) {
        return "v2";
    }
}
