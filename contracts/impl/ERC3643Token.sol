// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";

import {AgentRole} from "./AgentRole.sol";
import {IERC3643Token} from "../interfaces/IERC3643Token.sol";
import {ICompliance} from "../interfaces/ICompliance.sol";
import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";
import {
    AddressFrozenError,
    ComplianceBlocked,
    LengthMismatch,
    NotVerifiedRecipient,
    PartialFreezeExceeded,
    SameAddress,
    ZeroAddress
} from "../lib/Errors.sol";

/// @title ERC-3643 Token
/// @author UFarm Digital
/// @notice ERC-20 compatible token with identity and compliance enforcement.
contract ERC3643Token is
    Initializable,
    ERC20Upgradeable,
    PausableUpgradeable,
    UUPSUpgradeable,
    AgentRole,
    IERC3643Token
{
    IIdentityRegistry private _identityRegistry;
    ICompliance private _compliance;
    mapping(address => bool) internal _frozen;
    mapping(address => uint256) internal _frozenTokens;
    string private _version;
    uint8 private _decimals;
    bool internal _forceTransfer;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes the token.
    /// @param name_ Token name.
    /// @param symbol_ Token symbol.
    /// @param decimals_ Token decimals.
    /// @param version_ Token version string.
    /// @param owner_ Initial owner address.
    /// @param identityRegistry_ Identity registry contract.
    /// @param compliance_ Compliance contract.
    /// @param agents Initial agents list.
    function initialize(
        string calldata name_,
        string calldata symbol_,
        uint8 decimals_,
        string calldata version_,
        address owner_,
        IIdentityRegistry identityRegistry_,
        ICompliance compliance_,
        address[] calldata agents
    ) external virtual initializer {
        __ERC3643Token_init(name_, symbol_, decimals_, version_, owner_, identityRegistry_, compliance_, agents);
    }

    /// @notice Initializes the token for inheriting token implementations.
    // OpenZeppelin-compatible upgradeable initializer naming.
    // slither-disable-next-line naming-convention
    function __ERC3643Token_init(
        string memory name_,
        string memory symbol_,
        uint8 decimals_,
        string memory version_,
        address owner_,
        IIdentityRegistry identityRegistry_,
        ICompliance compliance_,
        address[] memory agents
    ) internal onlyInitializing {
        if (owner_ == address(0) || address(identityRegistry_) == address(0) || address(compliance_) == address(0)) {
            revert ZeroAddress();
        }
        __ERC20_init(name_, symbol_);
        __Pausable_init();
        __AgentRole_init(owner_, agents);
        _identityRegistry = identityRegistry_;
        _compliance = compliance_;
        _decimals = decimals_;
        _version = version_;
        emit IdentityRegistrySet(address(identityRegistry_));
        emit ComplianceSet(address(compliance_));
        emit TokenInformationUpdated(name_, symbol_, decimals_, version_);
    }

    /// @notice Returns token decimals.
    /// @return Token decimals.
    function decimals() public view override(ERC20Upgradeable, IERC20Metadata) returns (uint8) {
        return _decimals;
    }

    /// @notice Returns identity registry used for eligibility checks.
    /// @return registry Identity registry contract.
    function identityRegistry() external view override returns (IIdentityRegistry registry) {
        return _identityRegistry;
    }

    /// @notice Returns compliance engine used for transfer rules.
    /// @return complianceEngine Compliance contract.
    function compliance() external view override returns (ICompliance complianceEngine) {
        return _compliance;
    }

    /// @notice Sets identity registry.
    /// @param registry Identity registry contract.
    function setIdentityRegistry(IIdentityRegistry registry) external override onlyOwner {
        if (address(registry) == address(0)) revert ZeroAddress();
        _identityRegistry = registry;
        emit IdentityRegistrySet(address(registry));
    }

    /// @notice Sets compliance engine.
    /// @param compliance_ Compliance contract.
    function setCompliance(ICompliance compliance_) external override onlyOwner {
        if (address(compliance_) == address(0)) revert ZeroAddress();
        _compliance = compliance_;
        emit ComplianceSet(address(compliance_));
    }

    /// @notice Mints tokens to a verified wallet.
    /// @param to Recipient address.
    /// @param amount Amount to mint.
    function mint(address to, uint256 amount) external virtual override onlyAgent {
        _mint(to, amount);
    }

    /// @notice Burns tokens from wallet.
    /// @param from Wallet address.
    /// @param amount Amount to burn.
    function burn(address from, uint256 amount) external override onlyAgent {
        _burn(from, amount);
    }

    /// @notice Pauses token transfers.
    function pause() external override onlyAgent {
        _pause();
    }

    /// @notice Unpauses token transfers.
    function unpause() external override onlyAgent {
        _unpause();
    }

    /// @notice Freezes/unfreezes a wallet completely.
    /// @param wallet Wallet address.
    /// @param frozen Frozen status.
    function setAddressFrozen(address wallet, bool frozen) external override onlyAgent {
        if (wallet == address(0)) revert ZeroAddress();
        _frozen[wallet] = frozen;
        emit AddressFrozen(wallet, frozen);
    }

    /// @notice Freezes a portion of tokens for a wallet.
    /// @param wallet Wallet address.
    /// @param amount Amount to freeze.
    function freezePartialTokens(address wallet, uint256 amount) external override onlyAgent {
        if (wallet == address(0)) revert ZeroAddress();
        uint256 balance = balanceOf(wallet);
        uint256 nextFrozen = _frozenTokens[wallet] + amount;
        if (nextFrozen > balance || nextFrozen > _maxFrozenBalance(wallet)) revert PartialFreezeExceeded();
        _frozenTokens[wallet] = nextFrozen;
        emit TokensFrozen(wallet, nextFrozen);
    }

    /// @notice Unfreezes a portion of tokens for a wallet.
    /// @param wallet Wallet address.
    /// @param amount Amount to unfreeze.
    function unfreezePartialTokens(address wallet, uint256 amount) external override onlyAgent {
        if (wallet == address(0)) revert ZeroAddress();
        uint256 frozenAmount = _frozenTokens[wallet];
        if (amount > frozenAmount) revert PartialFreezeExceeded();
        uint256 nextFrozen = frozenAmount - amount;
        _frozenTokens[wallet] = nextFrozen;
        emit TokensFrozen(wallet, nextFrozen);
    }

    /// @notice Forced transfer for legal/ops recovery flows.
    /// @param from Sender address.
    /// @param to Recipient address.
    /// @param amount Amount to transfer.
    function forcedTransfer(address from, address to, uint256 amount) external override onlyAgent {
        // Registry callbacks are owner-selected trusted dependencies.
        // slither-disable-start reentrancy-no-eth,reentrancy-events
        if (from == address(0) || to == address(0)) revert ZeroAddress();
        _requireVerifiedRecipient(to);
        _forceTransfer = true;
        _transfer(from, to, amount);
        _forceTransfer = false;
        uint256 remaining = _maxFrozenBalance(from);
        if (_frozenTokens[from] > remaining) {
            _frozenTokens[from] = remaining;
            emit TokensFrozen(from, remaining);
        }
        // slither-disable-end reentrancy-no-eth,reentrancy-events
    }

    /// @notice Recovery flow moving tokens from lost wallet to new wallet.
    /// @param lostWallet Lost wallet address.
    /// @param newWallet New wallet address.
    function recoveryAddress(address lostWallet, address newWallet) public virtual override onlyAgent {
        // Registry callbacks are owner-selected trusted dependencies.
        // slither-disable-start reentrancy-no-eth
        if (lostWallet == address(0) || newWallet == address(0)) revert ZeroAddress();
        if (lostWallet == newWallet) revert SameAddress();
        _identityRegistry.recoverIdentity(lostWallet, newWallet);
        _beforeRecovery(lostWallet, newWallet);
        uint256 movable = _recoveryBalance(lostWallet);
        if (movable > 0) {
            _requireVerifiedRecipient(newWallet);
            _forceTransfer = true;
            _transfer(lostWallet, newWallet, movable);
            _forceTransfer = false;
        }
        _afterRecovery(lostWallet, newWallet, movable);
        emit RecoverySuccess(lostWallet, newWallet, movable);
        // slither-disable-end reentrancy-no-eth
    }

    /// @dev Returns the balance eligible for recovery. Frozen units remain on the old wallet by default.
    function _recoveryBalance(address lostWallet) internal view virtual returns (uint256) {
        uint256 balance = balanceOf(lostWallet);
        uint256 frozenAmount = _frozenTokens[lostWallet];
        if (frozenAmount > balance) revert PartialFreezeExceeded();
        return balance - frozenAmount;
    }

    /// @dev Runs after identity recovery and before the recovery transfer.
    // solhint-disable-next-line no-empty-blocks
    function _beforeRecovery(address, address) internal virtual {
        // Optional extension hook.
    }

    /// @dev Runs after the recovery transfer.
    // solhint-disable-next-line no-empty-blocks
    function _afterRecovery(address, address, uint256) internal virtual {
        // Optional extension hook.
    }

    /// @notice Batch transfer tokens.
    /// @param to Recipient addresses.
    /// @param amounts Amounts to transfer.
    function batchTransfer(address[] calldata to, uint256[] calldata amounts) external override {
        if (to.length != amounts.length) revert LengthMismatch();
        for (uint256 i = 0; i < to.length; ++i) {
            transfer(to[i], amounts[i]);
        }
    }

    /// @notice Batch mint tokens.
    /// @param to Recipient addresses.
    /// @param amounts Amounts to mint.
    function batchMint(address[] calldata to, uint256[] calldata amounts) external virtual override onlyAgent {
        if (to.length != amounts.length) revert LengthMismatch();
        for (uint256 i = 0; i < to.length; ++i) {
            _mint(to[i], amounts[i]);
        }
    }

    /// @notice Batch burn tokens.
    /// @param from Wallet addresses.
    /// @param amounts Amounts to burn.
    function batchBurn(address[] calldata from, uint256[] calldata amounts) external override onlyAgent {
        if (from.length != amounts.length) revert LengthMismatch();
        for (uint256 i = 0; i < from.length; ++i) {
            _burn(from[i], amounts[i]);
        }
    }

    /// @notice Internal update hook with identity/compliance gates.
    /// @param from Sender address.
    /// @param to Recipient address.
    /// @param amount Amount to transfer.
    function _update(address from, address to, uint256 amount) internal virtual override {
        if (!_forceTransfer) {
            _requireNotPaused();
        }
        if (from == address(0)) {
            _requireVerifiedRecipient(to);
            if (!_forceTransfer) _requireCompliance(from, to, amount);
            super._update(from, to, amount);
            if (!_forceTransfer) {
                // Caller-bounded batch entry points intentionally invoke this required compliance hook.
                // slither-disable-next-line calls-loop
                _compliance.created(to, amount);
            }
            return;
        }
        if (to == address(0)) {
            if (!_forceTransfer) {
                _requireNotFrozen(from);
                _requireFreeBalance(from, amount);
            }
            super._update(from, to, amount);
            if (!_forceTransfer) {
                // Caller-bounded batch entry points intentionally invoke this required compliance hook.
                // slither-disable-next-line calls-loop
                _compliance.destroyed(from, amount);
            }
            return;
        }
        if (!_forceTransfer) {
            _requireNotFrozen(from);
            _requireNotFrozen(to);
            _requireFreeBalance(from, amount);
            _requireVerifiedRecipient(to);
            _requireCompliance(from, to, amount);
        } else {
            _requireVerifiedRecipient(to);
        }
        super._update(from, to, amount);
        if (!_forceTransfer) {
            // Caller-bounded batch entry points intentionally invoke this required compliance hook.
            // slither-disable-next-line calls-loop
            _compliance.transferred(from, to, amount);
        }
    }

    /// @notice Reverts if wallet is frozen.
    /// @param wallet Wallet address.
    function _requireNotFrozen(address wallet) internal view {
        if (_frozen[wallet]) revert AddressFrozenError(wallet);
    }

    /// @notice Reverts if transfer exceeds unfrozen balance.
    /// @param wallet Wallet address.
    /// @param amount Amount requested.
    function _requireFreeBalance(address wallet, uint256 amount) internal view {
        uint256 balance = balanceOf(wallet);
        uint256 frozenAmount = _frozenTokens[wallet];
        if (frozenAmount > balance) revert PartialFreezeExceeded();
        uint256 available = balance - frozenAmount;
        if (amount > available) revert PartialFreezeExceeded();
    }

    function _maxFrozenBalance(address wallet) internal view virtual returns (uint256) {
        return balanceOf(wallet);
    }

    /// @notice Reverts if recipient is not verified.
    /// @param to Recipient address.
    function _requireVerifiedRecipient(address to) internal view {
        if (to == address(0)) revert ZeroAddress();
        // Batch entry points are caller-bounded; this registry call is a required policy check.
        // slither-disable-next-line calls-loop
        if (!_identityRegistry.isVerified(to)) revert NotVerifiedRecipient();
    }

    /// @notice Reverts if compliance blocks transfer.
    /// @param from Sender address.
    /// @param to Recipient address.
    /// @param amount Amount to transfer.
    function _requireCompliance(address from, address to, uint256 amount) internal view {
        // Batch entry points are caller-bounded; this compliance call is a required policy check.
        // slither-disable-next-line calls-loop
        if (!_compliance.canTransfer(from, to, amount)) revert ComplianceBlocked();
    }

    /// @notice Authorizes a UUPS upgrade.
    /// @param newImplementation New implementation address.
    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        if (newImplementation == address(0)) revert ZeroAddress();
    }

    /// @dev Storage gap for upgrade safety.
    // slither-disable-next-line naming-convention,unused-state
    uint256[43] private __gap;
}
