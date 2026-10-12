// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {IClaimTopicsRegistry} from "../interfaces/IClaimTopicsRegistry.sol";
import {AlreadyExists, NotFound, ZeroAddress} from "../lib/Errors.sol";

/// @title Claim Topics Registry
/// @author UFarm Digital
/// @notice Stores required claim topics for identity verification.
contract ClaimTopicsRegistry is Initializable, OwnableUpgradeable, UUPSUpgradeable, IClaimTopicsRegistry {
    uint256[] private _topics;
    mapping(uint256 => bool) private _exists;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the registry.
    /// @param owner_ Initial owner address.
    /// @param topics Initial required claim topics.
    function initialize(address owner_, uint256[] calldata topics) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        for (uint256 i = 0; i < topics.length; ++i) {
            _addTopic(topics[i]);
        }
    }

    /// @notice Returns the list of required claim topics.
    /// @return topics Array of required claim topic ids.
    function getClaimTopics() external view override returns (uint256[] memory topics) {
        return _topics;
    }

    /// @notice Adds a claim topic.
    /// @param topic Topic id.
    function addClaimTopic(uint256 topic) external override onlyOwner {
        _addTopic(topic);
        emit ClaimTopicAdded(topic);
    }

    /// @notice Removes a claim topic.
    /// @param topic Topic id.
    function removeClaimTopic(uint256 topic) external override onlyOwner {
        if (!_exists[topic]) revert NotFound();
        _exists[topic] = false;
        _removeTopicFromArray(topic);
        emit ClaimTopicRemoved(topic);
    }

    /// @notice Adds a topic internally to avoid duplicates.
    /// @param topic Topic id.
    function _addTopic(uint256 topic) internal {
        if (_exists[topic]) revert AlreadyExists();
        _exists[topic] = true;
        _topics.push(topic);
    }

    /// @notice Removes a topic from the array using swap-and-pop.
    /// @param topic Topic id.
    function _removeTopicFromArray(uint256 topic) internal {
        uint256 length = _topics.length;
        for (uint256 i = 0; i < length; ++i) {
            if (_topics[i] == topic) {
                uint256 last = _topics[length - 1];
                _topics[i] = last;
                _topics.pop();
                break;
            }
        }
    }

    /// @notice Authorizes a UUPS upgrade.
    /// @param newImplementation New implementation address.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /// @dev Storage gap for upgrade safety.
    // slither-disable-next-line naming-convention,unused-state
    uint256[50] private __gap;
}
