// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ICompliance} from "../interfaces/ICompliance.sol";

/// @title Mock Compliance
/// @author UFarm Digital
/// @notice Test helper to simulate compliance decisions and track hooks.
contract MockCompliance is ICompliance {
    bool public allowTransfers = true;
    uint256 public transferCount;
    uint256 public mintCount;
    uint256 public burnCount;

    /// @notice Sets whether transfers are allowed.
    /// @param allowed True to allow transfers.
    function setAllowTransfers(bool allowed) external {
        allowTransfers = allowed;
    }

    /// @notice Checks whether a transfer is allowed.
    function canTransfer(address, address, uint256) external view override returns (bool) {
        return allowTransfers;
    }

    /// @notice Hook called after transfer.
    function transferred(address, address, uint256) external override {
        ++transferCount;
    }

    /// @notice Hook called after mint.
    function created(address, uint256) external override {
        ++mintCount;
    }

    /// @notice Hook called after burn.
    function destroyed(address, uint256) external override {
        ++burnCount;
    }

    /// @notice Binds a token contract to this compliance engine.
    function bindToken(address token) external override {
        emit TokenBound(token);
    }

    /// @notice Unbinds a token contract from this compliance engine.
    function unbindToken(address token) external override {
        emit TokenUnbound(token);
    }

    /// @notice Returns whether token is bound.
    function isTokenBound(address) external pure override returns (bool) {
        return true;
    }
}
