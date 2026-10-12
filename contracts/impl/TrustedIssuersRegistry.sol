// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {ITrustedIssuersRegistry} from "../interfaces/ITrustedIssuersRegistry.sol";
import {AlreadyExists, LengthMismatch, NotFound, ZeroAddress} from "../lib/Errors.sol";

/// @title Trusted Issuers Registry
/// @author UFarm Digital
/// @notice Tracks trusted claim issuers and their allowed claim topics.
contract TrustedIssuersRegistry is Initializable, OwnableUpgradeable, UUPSUpgradeable, ITrustedIssuersRegistry {
    address[] private _issuers;
    mapping(address => bool) private _isIssuer;
    mapping(address => mapping(uint256 => bool)) private _issuerTopicAllowed;
    mapping(address => uint256[]) private _issuerTopics;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the registry.
    /// @param owner_ Initial owner address.
    /// @param issuers Initial trusted issuers.
    /// @param issuerTopics Initial issuer topics matching issuers array.
    function initialize(
        address owner_,
        address[] calldata issuers,
        uint256[][] calldata issuerTopics
    ) external initializer {
        if (owner_ == address(0)) revert ZeroAddress();
        if (issuers.length != issuerTopics.length) revert LengthMismatch();
        __Ownable_init(owner_);
        for (uint256 i = 0; i < issuers.length; ++i) {
            _addTrustedIssuer(issuers[i], issuerTopics[i]);
        }
    }

    /// @notice Returns whether an issuer is trusted for a topic.
    /// @param issuer Issuer address.
    /// @param topic Claim topic.
    /// @return True if trusted.
    function isTrustedIssuerForTopic(address issuer, uint256 topic) external view override returns (bool) {
        return _issuerTopicAllowed[issuer][topic];
    }

    /// @notice Returns claim topics that an issuer is allowed to issue.
    /// @param issuer Issuer address.
    /// @return topics Array of topic ids.
    function getTrustedIssuerTopics(address issuer) external view override returns (uint256[] memory topics) {
        return _issuerTopics[issuer];
    }

    /// @notice Returns all trusted issuers.
    /// @return issuers Array of issuer addresses.
    function getTrustedIssuers() external view override returns (address[] memory issuers) {
        return _issuers;
    }

    /// @notice Adds a trusted issuer with allowed topics.
    /// @param issuer Issuer address.
    /// @param topics Claim topics the issuer is trusted for.
    function addTrustedIssuer(address issuer, uint256[] calldata topics) external override onlyOwner {
        _addTrustedIssuer(issuer, topics);
        emit TrustedIssuerAdded(issuer);
    }

    /// @notice Removes a trusted issuer.
    /// @param issuer Issuer address.
    function removeTrustedIssuer(address issuer) external override onlyOwner {
        if (!_isIssuer[issuer]) revert NotFound();
        _removeIssuerFromArray(issuer);
        _isIssuer[issuer] = false;
        _clearTopics(issuer);
        emit TrustedIssuerRemoved(issuer);
    }

    /// @notice Updates trusted topics for an issuer.
    /// @param issuer Issuer address.
    /// @param topics Updated topics.
    function updateTrustedIssuerTopics(address issuer, uint256[] calldata topics) external override onlyOwner {
        if (!_isIssuer[issuer]) revert NotFound();
        _clearTopics(issuer);
        _setTopics(issuer, topics);
        emit TrustedIssuerTopicsUpdated(issuer);
    }

    /// @notice Adds a trusted issuer and topics.
    /// @param issuer Issuer address.
    /// @param topics Topics list.
    function _addTrustedIssuer(address issuer, uint256[] memory topics) internal {
        if (issuer == address(0)) revert ZeroAddress();
        if (_isIssuer[issuer]) revert AlreadyExists();
        if (issuer.code.length == 0) revert InvalidTrustedIssuer(issuer);
        _isIssuer[issuer] = true;
        _issuers.push(issuer);
        _setTopics(issuer, topics);
    }

    /// @notice Sets topic permissions for issuer.
    /// @param issuer Issuer address.
    /// @param topics Topics list.
    function _setTopics(address issuer, uint256[] memory topics) internal {
        for (uint256 i = 0; i < topics.length; ++i) {
            uint256 topic = topics[i];
            if (_issuerTopicAllowed[issuer][topic]) continue;
            _issuerTopicAllowed[issuer][topic] = true;
            _issuerTopics[issuer].push(topic);
        }
    }

    /// @notice Clears topic permissions for issuer.
    /// @param issuer Issuer address.
    function _clearTopics(address issuer) internal {
        uint256[] storage topics = _issuerTopics[issuer];
        for (uint256 i = 0; i < topics.length; ++i) {
            _issuerTopicAllowed[issuer][topics[i]] = false;
        }
        delete _issuerTopics[issuer];
    }

    /// @notice Removes issuer from array using swap-and-pop.
    /// @param issuer Issuer address.
    function _removeIssuerFromArray(address issuer) internal {
        uint256 length = _issuers.length;
        for (uint256 i = 0; i < length; ++i) {
            if (_issuers[i] == issuer) {
                address last = _issuers[length - 1];
                _issuers[i] = last;
                _issuers.pop();
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
