// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";

import {IAgentRole} from "../interfaces/IAgentRole.sol";
import {AlreadyExists, NotAgent, NotFound, ZeroAddress} from "../lib/Errors.sol";

/// @title Agent Role Base
/// @author UFarm Digital
/// @notice Provides agent role management with owner-controlled membership.
/// @dev Intended to be inherited by registry and token implementations.
abstract contract AgentRole is Initializable, OwnableUpgradeable, IAgentRole {
    /// @dev Agent membership mapping.
    mapping(address => bool) private _agents;

    /// @notice Restricts function access to agents.
    modifier onlyAgent() {
        if (!_agents[msg.sender]) revert NotAgent();
        _;
    }

    /// @notice Initializes agent role storage.
    /// @param owner_ Initial owner address.
    /// @param agents Initial agent list.
    // OpenZeppelin-compatible upgradeable initializer naming.
    // slither-disable-next-line naming-convention
    function __AgentRole_init(address owner_, address[] memory agents) internal onlyInitializing {
        if (owner_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        _setAgents(agents, true);
    }

    /// @notice Returns whether an address is an agent.
    /// @param agent Address to check.
    /// @return True if the address is an agent.
    function isAgent(address agent) external view override returns (bool) {
        return _agents[agent];
    }

    /// @dev Returns whether an address is an agent for inheriting contracts.
    function _isAgent(address account) internal view returns (bool) {
        return _agents[account];
    }

    /// @notice Adds an agent.
    /// @param agent Agent address.
    function addAgent(address agent) external override onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        if (_agents[agent]) revert AlreadyExists();
        _agents[agent] = true;
        emit AgentAdded(agent);
    }

    /// @notice Removes an agent.
    /// @param agent Agent address.
    function removeAgent(address agent) external override onlyOwner {
        if (!_agents[agent]) revert NotFound();
        delete _agents[agent];
        emit AgentRemoved(agent);
    }

    /// @notice Adds or removes a list of agents.
    /// @param agents Agents list.
    /// @param enabled Whether agents are enabled.
    function _setAgents(address[] memory agents, bool enabled) internal {
        for (uint256 i = 0; i < agents.length; ++i) {
            address agent = agents[i];
            if (agent == address(0)) revert ZeroAddress();
            if (_agents[agent] == enabled) continue;
            _agents[agent] = enabled;
            if (enabled) {
                emit AgentAdded(agent);
            } else {
                emit AgentRemoved(agent);
            }
        }
    }

    /// @dev Storage gap for upgrade safety.
    // slither-disable-next-line naming-convention,unused-state
    uint256[49] private __gap;
}
