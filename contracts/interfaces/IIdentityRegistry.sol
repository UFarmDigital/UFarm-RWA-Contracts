// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {IOnchainID} from "./IOnchainID.sol";
import {IIdentityRegistryStorage} from "./IIdentityRegistryStorage.sol";
import {IClaimTopicsRegistry} from "./IClaimTopicsRegistry.sol";
import {ITrustedIssuersRegistry} from "./ITrustedIssuersRegistry.sol";
import {IAgentRole} from "./IAgentRole.sol";

/// @title Identity Registry Interface
/// @author UFarm Digital
/// @notice Manages and verifies eligible wallet addresses for an ERC-3643 token.
/// @dev Verification checks storage linkage + required claim topics + trusted issuers.
interface IIdentityRegistry is IAgentRole {
    error InvalidIdentity(address identity);

    /// @notice Emitted when identity is registered for a wallet.
    /// @param wallet Investor wallet address.
    /// @param identity Identity contract address.
    /// @param country Country code.
    event IdentityRegistered(address indexed wallet, address indexed identity, uint16 country);

    /// @notice Emitted when identity is removed for a wallet.
    /// @param wallet Investor wallet address.
    event IdentityRemoved(address indexed wallet);

    /// @notice Emitted when wallet recovery is performed.
    /// @param lostWallet Old wallet address.
    /// @param newWallet New wallet address.
    /// @param identity Identity contract address.
    event IdentityRecovered(address indexed lostWallet, address indexed newWallet, address indexed identity);

    /// @notice Emitted when the suite token is authorized to recover identities.
    /// @param token Token address.
    event TokenBound(address indexed token);

    /// @notice Returns the storage contract.
    /// @return storageContract Identity registry storage contract.
    function identityStorage() external view returns (IIdentityRegistryStorage storageContract);

    /// @notice Returns the claim topics registry.
    /// @return registry Claim topics registry contract.
    function claimTopicsRegistry() external view returns (IClaimTopicsRegistry registry);

    /// @notice Returns the trusted issuers registry.
    /// @return registry Trusted issuers registry contract.
    function trustedIssuersRegistry() external view returns (ITrustedIssuersRegistry registry);

    /// @notice Binds the suite token authorized to recover identities.
    /// @param token Token address.
    function bindToken(address token) external;

    /// @notice Returns the suite token authorized to recover identities.
    /// @return token Token address.
    function boundToken() external view returns (address token);

    /// @notice Registers a wallet with an identity and country.
    /// @dev Must be restricted to agents in implementation. Identity must be a deployed contract through storage.
    /// @param wallet Investor wallet.
    /// @param identity Identity contract address.
    /// @param country Country code.
    function registerIdentity(address wallet, IOnchainID identity, uint16 country) external;

    /// @notice Removes a wallet registration.
    /// @dev Must be restricted to agents in implementation.
    /// @param wallet Investor wallet.
    function removeIdentity(address wallet) external;

    /// @notice Recovers identity from lost wallet to a new wallet.
    /// @dev Must be restricted to agents in implementation.
    /// @param lostWallet Old wallet address.
    /// @param newWallet New wallet address.
    function recoverIdentity(address lostWallet, address newWallet) external;

    /// @notice Returns whether wallet is verified for holding/transfers.
    /// @dev Returns false if an identity claim accessor or claim-issuer validation call fails.
    ///      Registered identities remain verified when no claim topics are required. Code presence does not prove
    ///      canonical behavior; runtime verification remains fail-closed.
    /// @param wallet Wallet address.
    /// @return True if verified.
    function isVerified(address wallet) external view returns (bool);

    /// @notice Returns investor identity for wallet.
    /// @param wallet Investor wallet address.
    /// @return identity Identity contract address.
    function investorIdentity(address wallet) external view returns (IOnchainID identity);

    /// @notice Returns investor country for wallet.
    /// @param wallet Investor wallet address.
    /// @return country Country code.
    function investorCountry(address wallet) external view returns (uint16 country);
}
