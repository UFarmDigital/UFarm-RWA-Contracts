// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title Trusted Issuers Registry Interface
/// @author UFarm Digital
/// @notice Maintains trusted claim issuers and which claim topics they may issue.
/// @dev IdentityRegistry consults this registry during verification.
interface ITrustedIssuersRegistry {
    error InvalidTrustedIssuer(address issuer);

    /// @notice Emitted when a trusted issuer is added.
    /// @param issuer The issuer added.
    event TrustedIssuerAdded(address indexed issuer);

    /// @notice Emitted when a trusted issuer is removed.
    /// @param issuer The issuer removed.
    event TrustedIssuerRemoved(address indexed issuer);

    /// @notice Emitted when issuer claim topics are updated.
    /// @param issuer The issuer updated.
    event TrustedIssuerTopicsUpdated(address indexed issuer);

    /// @notice Returns whether an issuer is trusted for a topic.
    /// @param issuer Issuer address.
    /// @param topic Claim topic.
    /// @return True if trusted.
    function isTrustedIssuerForTopic(address issuer, uint256 topic) external view returns (bool);

    /// @notice Returns claim topics that an issuer is allowed to issue.
    /// @param issuer Issuer address.
    /// @return topics Array of topic ids.
    function getTrustedIssuerTopics(address issuer) external view returns (uint256[] memory topics);

    /// @notice Returns all trusted issuers.
    /// @return issuers Array of issuer addresses.
    function getTrustedIssuers() external view returns (address[] memory issuers);

    /// @notice Adds a trusted issuer with allowed topics.
    /// @dev Must be restricted to owner/admin in implementation. Issuer must be a deployed contract.
    /// @param issuer Issuer address.
    /// @param topics Claim topics the issuer is trusted for.
    function addTrustedIssuer(address issuer, uint256[] calldata topics) external;

    /// @notice Removes a trusted issuer.
    /// @dev Must be restricted to owner/admin in implementation.
    /// @param issuer Issuer address.
    function removeTrustedIssuer(address issuer) external;

    /// @notice Updates trusted topics for an issuer.
    /// @dev Must be restricted to owner/admin in implementation.
    /// @param issuer Issuer address.
    /// @param topics Updated topics.
    function updateTrustedIssuerTopics(address issuer, uint256[] calldata topics) external;
}
