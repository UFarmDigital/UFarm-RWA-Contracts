// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IERC20Metadata} from "@openzeppelin/contracts/interfaces/IERC20Metadata.sol";

import {IAgentRole} from "./IAgentRole.sol";
import {ICompliance} from "./ICompliance.sol";
import {IIdentityRegistry} from "./IIdentityRegistry.sol";

/// @title ERC-3643 Token Interface
/// @author UFarm Digital
/// @notice ERC-20 compatible token with identity and compliance enforcement.
/// @dev This is the primary asset token proxy interface.
interface IERC3643Token is IAgentRole, IERC20Metadata {
    // ===== Events =====

    /// @notice Emitted when identity registry is set.
    /// @param identityRegistry Identity registry address.
    event IdentityRegistrySet(address indexed identityRegistry);

    /// @notice Emitted when compliance module is set.
    /// @param compliance Compliance module address.
    event ComplianceSet(address indexed compliance);

    /// @notice Emitted when token metadata is updated.
    /// @param name Token name.
    /// @param symbol Token symbol.
    /// @param decimals Token decimals.
    /// @param version Token version string.
    event TokenInformationUpdated(string name, string symbol, uint8 decimals, string version);

    /// @notice Emitted when address is frozen/unfrozen.
    /// @param wallet Wallet address.
    /// @param frozen Frozen status.
    event AddressFrozen(address indexed wallet, bool frozen);

    /// @notice Emitted when token amount is frozen/unfrozen for an address.
    /// @param wallet Wallet address.
    /// @param amount Token amount.
    event TokensFrozen(address indexed wallet, uint256 amount);

    /// @notice Emitted when tokens are recovered.
    /// @param lostWallet Lost wallet address.
    /// @param newWallet New wallet address.
    /// @param movedAmount Amount moved.
    event RecoverySuccess(address indexed lostWallet, address indexed newWallet, uint256 movedAmount);

    // ===== ERC-3643 bindings =====

    /// @notice Returns identity registry used for eligibility checks.
    /// @return registry Identity registry contract.
    function identityRegistry() external view returns (IIdentityRegistry registry);

    /// @notice Returns compliance engine used for transfer rules.
    /// @return complianceEngine Compliance contract.
    function compliance() external view returns (ICompliance complianceEngine);

    /// @notice Sets identity registry.
    /// @dev Must be restricted to owner in implementation.
    /// @param registry Identity registry contract.
    function setIdentityRegistry(IIdentityRegistry registry) external;

    /// @notice Sets compliance engine.
    /// @dev Must be restricted to owner in implementation.
    /// @param compliance_ Compliance contract.
    function setCompliance(ICompliance compliance_) external;

    // ===== Admin / Agent operations (no implementation) =====

    /// @notice Mints tokens to a verified wallet.
    /// @dev Must be restricted to agents in implementation.
    /// @param to Recipient address.
    /// @param amount Amount to mint.
    function mint(address to, uint256 amount) external;

    /// @notice Burns tokens from wallet.
    /// @dev Must be restricted to agents in implementation.
    /// @param from Wallet address.
    /// @param amount Amount to burn.
    function burn(address from, uint256 amount) external;

    /// @notice Pauses token transfers.
    /// @dev Must be restricted to agents in implementation.
    function pause() external;

    /// @notice Unpauses token transfers.
    /// @dev Must be restricted to agents in implementation.
    function unpause() external;

    /// @notice Freezes/unfreezes a wallet completely.
    /// @dev Must be restricted to agents in implementation.
    /// @param wallet Wallet address.
    /// @param frozen Frozen status.
    function setAddressFrozen(address wallet, bool frozen) external;

    /// @notice Freezes a portion of tokens for a wallet.
    /// @dev Must be restricted to agents in implementation.
    /// @param wallet Wallet address.
    /// @param amount Amount to freeze.
    function freezePartialTokens(address wallet, uint256 amount) external;

    /// @notice Unfreezes a portion of tokens for a wallet.
    /// @dev Must be restricted to agents in implementation.
    /// @param wallet Wallet address.
    /// @param amount Amount to unfreeze.
    function unfreezePartialTokens(address wallet, uint256 amount) external;

    /// @notice Forced transfer for legal/ops recovery flows.
    /// @dev Must be restricted to agents in implementation.
    /// @param from Sender address.
    /// @param to Recipient address.
    /// @param amount Amount to transfer.
    function forcedTransfer(address from, address to, uint256 amount) external;

    /// @notice Recovery flow moving tokens from lost wallet to new wallet.
    /// @dev Must be restricted to agents; expects identity registry recovery to be done too.
    /// @param lostWallet Lost wallet address.
    /// @param newWallet New wallet address.
    function recoveryAddress(address lostWallet, address newWallet) external;

    // ===== Batch ops (optional but recommended) =====

    /// @notice Batch transfer tokens.
    /// @param to Recipient addresses.
    /// @param amounts Amounts to transfer.
    function batchTransfer(address[] calldata to, uint256[] calldata amounts) external;

    /// @notice Batch mint tokens.
    /// @param to Recipient addresses.
    /// @param amounts Amounts to mint.
    function batchMint(address[] calldata to, uint256[] calldata amounts) external;

    /// @notice Batch burn tokens.
    /// @param from Wallet addresses.
    /// @param amounts Amounts to burn.
    function batchBurn(address[] calldata from, uint256[] calldata amounts) external;
}
