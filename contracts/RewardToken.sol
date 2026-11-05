// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IRewardToken} from "./IRewardToken.sol";

/// @title Токен винагород вкладників (ERC-20)
/// @notice Випускати токени може лише адреса з роллю MINTER_ROLE (контракт кампаній)
contract RewardToken is ERC20, AccessControl, IRewardToken {
    /// @notice Ідентифікатор ролі, яка має право випускати токени
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Передано нульову адресу
    error ZeroAddress();

    /// @param admin Адреса, яка зможе видати роль MINTER_ROLE
    constructor(address admin) ERC20("Crowdfund Reward", "CFR") {
        if (admin == address(0)) revert ZeroAddress();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @inheritdoc IRewardToken
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
