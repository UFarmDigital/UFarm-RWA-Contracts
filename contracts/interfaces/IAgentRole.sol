// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

/// @title Agent Role Interface
/// @author UFarm Digital
/// @notice Standardized agent role management for ERC-3643 components.
/// @dev Agents are operational actors authorized by the owner to execute admin actions.
interface IAgentRole {
    /// @notice Emitted when an agent is added.
    /// @param agent The agent address added.
    event AgentAdded(address indexed agent);

    /// @notice Emitted when an agent is removed.
    /// @param agent The agent address removed.
    event AgentRemoved(address indexed agent);

    /// @notice Checks whether an address is an agent.
    /// @param agent The address to check.
    /// @return True if agent.
    function isAgent(address agent) external view returns (bool);

    /// @notice Adds an agent.
    /// @dev Must be restricted to owner/admin in implementation.
    /// @param agent The agent to add.
    function addAgent(address agent) external;

    /// @notice Removes an agent.
    /// @dev Must be restricted to owner/admin in implementation.
    /// @param agent The agent to remove.
    function removeAgent(address agent) external;
}
