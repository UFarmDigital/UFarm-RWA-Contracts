// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title Claim Topics Registry Interface
/// @author UFarm Digital
/// @notice Stores the set of required claim topics for an ERC-3643 token.
/// @dev Used by IdentityRegistry to verify that identities have required claims.
interface IClaimTopicsRegistry {
    /// @notice Emitted when a claim topic is added.
    /// @param topic The topic added.
    event ClaimTopicAdded(uint256 indexed topic);

    /// @notice Emitted when a claim topic is removed.
    /// @param topic The topic removed.
    event ClaimTopicRemoved(uint256 indexed topic);

    /// @notice Returns the list of required claim topics.
    /// @return topics Array of required claim topic ids.
    function getClaimTopics() external view returns (uint256[] memory topics);

    /// @notice Adds a claim topic.
    /// @dev Must be restricted to owner/admin in implementation.
    /// @param topic Topic id.
    function addClaimTopic(uint256 topic) external;

    /// @notice Removes a claim topic.
    /// @dev Must be restricted to owner/admin in implementation.
    /// @param topic Topic id.
    function removeClaimTopic(uint256 topic) external;
}
