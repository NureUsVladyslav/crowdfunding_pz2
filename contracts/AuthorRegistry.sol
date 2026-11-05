// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IAuthorRegistry} from "./IAuthorRegistry.sol";

/// @title Реєстр авторів кампаній
/// @notice Зберігає ролі: адміністратор (DEFAULT_ADMIN_ROLE) і автор (AUTHOR_ROLE)
contract AuthorRegistry is AccessControl, IAuthorRegistry {
    /// @notice Ідентифікатор ролі автора
    bytes32 public constant AUTHOR_ROLE = keccak256("AUTHOR_ROLE");

    /// @notice Передано нульову адресу
    error ZeroAddress();

    /// @param admin Адреса, яка стане адміністратором
    constructor(address admin) {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Призначає адресу автором кампаній
    /// @dev Подію RoleGranted видає сам AccessControl
    function registerAuthor(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (account == address(0)) revert ZeroAddress();
        _grantRole(AUTHOR_ROLE, account);
    }

    /// @notice Відкликає в адреси роль автора
    /// @dev Подію RoleRevoked видає сам AccessControl
    function removeAuthor(address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _revokeRole(AUTHOR_ROLE, account);
    }

    /// @inheritdoc IAuthorRegistry
    function isAuthor(address account) external view returns (bool) {
        return hasRole(AUTHOR_ROLE, account);
    }

    /// @inheritdoc IAuthorRegistry
    function isAdmin(address account) external view returns (bool) {
        return hasRole(DEFAULT_ADMIN_ROLE, account);
    }
}
