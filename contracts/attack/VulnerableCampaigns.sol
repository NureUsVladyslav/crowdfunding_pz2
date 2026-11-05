// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

/// @title Вразлива версія краудфандингу (ЛИШЕ ДЛЯ НАВЧАННЯ)
/// @notice Спрощена копія контракту Campaigns, у якій функція refund навмисно містить вразливість
/// @dev НЕ РОЗГОРТАТИ В РЕАЛЬНІЙ МЕРЕЖІ. Вразливість: повторний вхід (reentrancy)
contract VulnerableCampaigns {
    struct Campaign {
        address author;
        uint256 goal;
        uint256 deadline;
        uint256 raised;
    }

    uint256 public campaignCount;
    mapping(uint256 id => Campaign) public campaigns;
    mapping(uint256 id => mapping(address contributor => uint256)) public contributions;

    error CampaignEnded();
    error RefundNotAvailable();
    error NothingToRefund();
    error TransferFailed();

    /// @notice Створює кампанію (у цій версії без перевірки ролей)
    function createCampaign(uint256 goal, uint256 duration) external returns (uint256 id) {
        id = ++campaignCount;
        campaigns[id] = Campaign(msg.sender, goal, block.timestamp + duration, 0);
    }

    /// @notice Вносить ETH в активну кампанію
    function contribute(uint256 id) external payable {
        Campaign storage c = campaigns[id];
        if (block.timestamp >= c.deadline) revert CampaignEnded();
        c.raised += msg.value;
        contributions[id][msg.sender] += msg.value;
    }

    /// @notice ВРАЗЛИВА версія повернення внеску
    /// @dev Помилка: ETH надсилається ДО того, як внесок обнулено, і немає nonReentrant
    function refund(uint256 id) external {
        Campaign storage c = campaigns[id];
        if (block.timestamp < c.deadline || c.raised >= c.goal) revert RefundNotAvailable();

        uint256 amount = contributions[id][msg.sender];
        if (amount == 0) revert NothingToRefund();

        // ВРАЗЛИВІСТЬ: зовнішній виклик виконується раніше за зміну стану
        (bool ok, ) = msg.sender.call{value: amount}("");
        if (!ok) revert TransferFailed();

        contributions[id][msg.sender] = 0; // занадто пізно
    }
}
