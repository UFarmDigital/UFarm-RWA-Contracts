// SPDX-License-Identifier: MIT
pragma solidity 0.8.35;

import {ICompliance} from "../interfaces/ICompliance.sol";
import {IIdentityRegistry} from "../interfaces/IIdentityRegistry.sol";

/// @title Mock Bound Token
/// @author UFarm Digital
/// @notice Test helper to call compliance hooks as a bound token.
contract MockBoundToken {
    /// @notice Calls identity recovery as this unbound contract.
    function recoverIdentity(IIdentityRegistry identityRegistry, address lostWallet, address newWallet) external {
        identityRegistry.recoverIdentity(lostWallet, newWallet);
    }

    /// @notice Calls compliance.canTransfer as this contract.
    function canTransfer(
        ICompliance compliance,
        address from,
        address to,
        uint256 amount
    ) external view returns (bool) {
        return compliance.canTransfer(from, to, amount);
    }

    /// @notice Calls compliance.transferred as this contract.
    function transferred(ICompliance compliance, address from, address to, uint256 amount) external {
        compliance.transferred(from, to, amount);
    }

    /// @notice Calls compliance.created as this contract.
    function created(ICompliance compliance, address to, uint256 amount) external {
        compliance.created(to, amount);
    }

    /// @notice Calls compliance.destroyed as this contract.
    function destroyed(ICompliance compliance, address from, uint256 amount) external {
        compliance.destroyed(from, amount);
    }
}
