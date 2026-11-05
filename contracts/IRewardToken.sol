// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title Інтерфейс токена винагород
/// @notice Через нього контракт кампаній просить токен випустити винагороди
interface IRewardToken {
    /// @notice Випускає `amount` токенів на адресу `to`
    function mint(address to, uint256 amount) external;
}
