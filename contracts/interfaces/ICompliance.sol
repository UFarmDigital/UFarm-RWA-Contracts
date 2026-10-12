// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title Compliance Interface
/// @author UFarm Digital
/// @notice Pluggable transfer rule engine for ERC-3643 token.
/// @dev Token calls canTransfer() pre-transfer and hooks post-transfer/mint/burn.
interface ICompliance {
    /// @notice Emitted when token is bound to this compliance instance.
    /// @param token Token address.
    event TokenBound(address indexed token);

    /// @notice Emitted when token is unbound from this compliance instance.
    /// @param token Token address.
    event TokenUnbound(address indexed token);

    /// @notice Checks whether a transfer is allowed.
    /// @param from Sender address.
    /// @param to Receiver address.
    /// @param amount Transfer amount.
    /// @return True if allowed.
    function canTransfer(address from, address to, uint256 amount) external view returns (bool);

    /// @notice Hook called after transfer.
    /// @param from Sender.
    /// @param to Receiver.
    /// @param amount Amount.
    function transferred(address from, address to, uint256 amount) external;

    /// @notice Hook called after mint.
    /// @param to Receiver.
    /// @param amount Amount.
    function created(address to, uint256 amount) external;

    /// @notice Hook called after burn.
    /// @param from Address burned from.
    /// @param amount Amount.
    function destroyed(address from, uint256 amount) external;

    /// @notice Binds a token contract to this compliance engine.
    /// @dev Must be restricted to owner/admin in implementation.
    /// @param token Token address.
    function bindToken(address token) external;

    /// @notice Unbinds a token contract from this compliance engine.
    /// @dev Must be restricted to owner/admin in implementation.
    /// @param token Token address.
    function unbindToken(address token) external;

    /// @notice Returns whether token is bound.
    /// @param token Token address.
    /// @return True if bound.
    function isTokenBound(address token) external view returns (bool);
}
