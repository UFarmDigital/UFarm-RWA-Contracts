// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";

import {ICompliance} from "../interfaces/ICompliance.sol";
import {AlreadyBound, NotBoundToken, NotFound, NotOwnerOrFactory, ZeroAddress} from "../lib/Errors.sol";

/// @title Compliance
/// @author UFarm Digital
/// @notice Minimal compliance module with token binding.
contract Compliance is Initializable, OwnableUpgradeable, UUPSUpgradeable, ICompliance {
    mapping(address => bool) private _bound;
    address[] private _tokens;
    mapping(address => uint256) private _tokenIndexPlus1;
    address private _factory;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the compliance module.
    /// @param owner_ Initial owner address.
    /// @param factory_ Factory allowed to bind tokens during deployment.
    function initialize(address owner_, address factory_) external initializer {
        if (owner_ == address(0) || factory_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        _factory = factory_;
    }

    /// @notice Checks whether a transfer is allowed.
    /// @dev This minimal implementation intentionally allows every transfer from a bound token.
    /// @return True if allowed.
    function canTransfer(address, address, uint256) external view override onlyBoundToken returns (bool) {
        return true;
    }

    /// @notice Hook called after transfer.
    /// @dev Intentionally empty because this minimal implementation has no transfer state.
    function transferred(address, address, uint256) external view override onlyBoundToken {
        return;
    }

    /// @notice Hook called after mint.
    /// @dev Intentionally empty because this minimal implementation has no issuance state.
    function created(address, uint256) external view override onlyBoundToken {
        return;
    }

    /// @notice Hook called after burn.
    /// @dev Intentionally empty because this minimal implementation has no destruction state.
    function destroyed(address, uint256) external view override onlyBoundToken {
        return;
    }

    /// @notice Binds a token contract to this compliance engine.
    /// @param token Token address.
    function bindToken(address token) external override onlyOwnerOrFactory {
        if (token == address(0)) revert ZeroAddress();
        if (_bound[token]) revert AlreadyBound();
        _bound[token] = true;
        _tokens.push(token);
        _tokenIndexPlus1[token] = _tokens.length;
        emit TokenBound(token);
    }

    /// @notice Unbinds a token contract from this compliance engine.
    /// @param token Token address.
    function unbindToken(address token) external override onlyOwner {
        if (!_bound[token]) revert NotFound();
        _bound[token] = false;
        _removeToken(token);
        emit TokenUnbound(token);
    }

    /// @notice Returns whether token is bound.
    /// @param token Token address.
    /// @return True if bound.
    function isTokenBound(address token) external view override returns (bool) {
        return _bound[token];
    }

    /// @notice Returns the configured factory address.
    /// @return factoryAddress Factory address.
    function factory() external view returns (address factoryAddress) {
        return _factory;
    }

    /// @dev Restricts to bound tokens.
    modifier onlyBoundToken() {
        if (!_bound[msg.sender]) revert NotBoundToken();
        _;
    }

    /// @dev Restricts to owner or configured factory.
    modifier onlyOwnerOrFactory() {
        if (msg.sender != owner() && msg.sender != _factory) revert NotOwnerOrFactory();
        _;
    }

    /// @notice Removes token from enumeration using swap-and-pop.
    /// @param token Token address.
    function _removeToken(address token) internal {
        uint256 index = _tokenIndexPlus1[token];
        if (index == 0) return;
        uint256 lastIndex = _tokens.length;
        if (index != lastIndex) {
            address last = _tokens[lastIndex - 1];
            _tokens[index - 1] = last;
            _tokenIndexPlus1[last] = index;
        }
        _tokens.pop();
        delete _tokenIndexPlus1[token];
    }

    /// @notice Authorizes a UUPS upgrade.
    /// @param newImplementation New implementation address.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /// @dev Storage gap for upgrade safety.
    // slither-disable-next-line naming-convention,unused-state
    uint256[48] private __gap;
}
