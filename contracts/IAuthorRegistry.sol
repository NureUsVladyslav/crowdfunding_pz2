// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title Інтерфейс реєстру авторів
/// @notice Через нього контракт кампаній питає реєстр про ролі
interface IAuthorRegistry {
    /// @notice Чи має адреса роль автора кампаній
    function isAuthor(address account) external view returns (bool);

    /// @notice Чи має адреса роль адміністратора
    function isAdmin(address account) external view returns (bool);
}
