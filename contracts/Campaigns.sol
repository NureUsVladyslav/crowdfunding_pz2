// SPDX-License-Identifier: MIT
pragma solidity ^0.8.34;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IAuthorRegistry} from "./IAuthorRegistry.sol";
import {IRewardToken} from "./IRewardToken.sol";

/// @title Краудфандинг із поверненням коштів
/// @notice Автор створює кампанію з ціллю та дедлайном. Якщо до дедлайну ціль зібрано,
///         автор забирає кошти, а вкладники отримують винагороди. Інакше вкладники повертають внески.
/// @dev Усі виплати працюють за схемою «отримувач забирає сам» (pull payments)
contract Campaigns is Pausable, ReentrancyGuard {
    /// @notice Стан кампанії. Обчислюється з часу та суми, окремо не зберігається
    enum Status {
        Active, // дедлайн ще не настав
        Succeeded, // дедлайн минув, зібрано не менше цілі, кошти ще не виплачено
        Failed, // дедлайн минув, зібрано менше цілі
        PaidOut // автор забрав кошти
    }

    /// @notice Дані кампанії
    /// @dev Поля впаковано у два слоти сховища: (author, deadline, withdrawn) і (goal, raised)
    struct Campaign {
        address author;
        uint64 deadline;
        bool withdrawn;
        uint128 goal;
        uint128 raised;
    }

    /// @notice Скільки найменших одиниць токена видається за 1 wei внеску (1000 токенів за 1 ETH)
    uint256 public constant REWARD_RATE = 1000;

    /// @notice Реєстр авторів і ролей
    IAuthorRegistry public immutable registry;
    /// @notice Токен винагород
    IRewardToken public immutable rewardToken;
    /// @notice Кількість створених кампаній; ідентифікатори йдуть з 1
    uint256 public campaignCount;

    mapping(uint256 id => Campaign) private _campaigns;
    /// @notice Скільки адреса внесла в кампанію і ще не забрала назад чи у вигляді винагороди
    mapping(uint256 id => mapping(address contributor => uint256)) public contributions;

    event CampaignCreated(uint256 indexed id, address indexed author, uint256 goal, uint256 deadline);
    event Contributed(uint256 indexed id, address indexed contributor, uint256 amount);
    event Withdrawn(uint256 indexed id, address indexed author, uint256 amount);
    event Refunded(uint256 indexed id, address indexed contributor, uint256 amount);
    event RewardClaimed(uint256 indexed id, address indexed contributor, uint256 reward);

    error ZeroAddress();
    error NotAdmin(address caller);
    error NotAuthor(address caller);
    error ZeroGoal();
    error ZeroDuration();
    error ZeroAmount();
    error CampaignNotFound(uint256 id);
    error CampaignEnded(uint256 id, uint256 deadline);
    error CampaignNotEnded(uint256 id);
    error GoalNotReached(uint256 id);
    error GoalAlreadyReached(uint256 id);
    error NotCampaignAuthor(uint256 id, address caller);
    error AlreadyWithdrawn(uint256 id);
    error NothingToRefund(uint256 id, address contributor);
    error NothingToClaim(uint256 id, address contributor);
    error TransferFailed();

    modifier onlyAdmin() {
        if (!registry.isAdmin(msg.sender)) revert NotAdmin(msg.sender);
        _;
    }

    /// @param registry_ Адреса контракту AuthorRegistry
    /// @param rewardToken_ Адреса контракту RewardToken
    constructor(IAuthorRegistry registry_, IRewardToken rewardToken_) {
        if (address(registry_) == address(0) || address(rewardToken_) == address(0)) revert ZeroAddress();
        registry = registry_;
        rewardToken = rewardToken_;
    }

    /// @notice Створює кампанію. Лише для адрес з роллю автора
    /// @param goal Цільова сума у wei
    /// @param duration Тривалість у секундах від поточного моменту
    /// @return id Ідентифікатор нової кампанії
    function createCampaign(uint256 goal, uint256 duration) external whenNotPaused returns (uint256 id) {
        if (!registry.isAuthor(msg.sender)) revert NotAuthor(msg.sender);
        if (goal == 0) revert ZeroGoal();
        if (duration == 0) revert ZeroDuration();

        // SafeCast відкочує транзакцію, якщо значення не вміщується у вужчий тип
        uint128 goal128 = SafeCast.toUint128(goal);
        uint64 deadline = SafeCast.toUint64(block.timestamp + duration);

        id = ++campaignCount;
        _campaigns[id] = Campaign({author: msg.sender, deadline: deadline, withdrawn: false, goal: goal128, raised: 0});

        emit CampaignCreated(id, msg.sender, goal, deadline);
    }

    /// @notice Вносить ETH в активну кампанію
    /// @param id Ідентифікатор кампанії
    function contribute(uint256 id) external payable whenNotPaused {
        Campaign storage c = _getCampaign(id);
        if (block.timestamp >= c.deadline) revert CampaignEnded(id, c.deadline);
        if (msg.value == 0) revert ZeroAmount();

        c.raised += SafeCast.toUint128(msg.value);
        contributions[id][msg.sender] += msg.value;

        emit Contributed(id, msg.sender, msg.value);
    }

    /// @notice Автор забирає зібрані кошти успішної кампанії (один раз)
    /// @param id Ідентифікатор кампанії
    function withdraw(uint256 id) external nonReentrant whenNotPaused {
        Campaign storage c = _getCampaign(id);
        if (msg.sender != c.author) revert NotCampaignAuthor(id, msg.sender);

        Status s = _statusOf(c);
        if (s == Status.Active) revert CampaignNotEnded(id);
        if (s == Status.Failed) revert GoalNotReached(id);
        if (s == Status.PaidOut) revert AlreadyWithdrawn(id);

        uint256 amount = c.raised;
        c.withdrawn = true;
        emit Withdrawn(id, msg.sender, amount);

        _sendEther(msg.sender, amount);
    }

    /// @notice Вкладник забирає свій внесок назад, якщо кампанія провалилась
    /// @param id Ідентифікатор кампанії
    function refund(uint256 id) external nonReentrant whenNotPaused {
        Campaign storage c = _getCampaign(id);

        Status s = _statusOf(c);
        if (s == Status.Active) revert CampaignNotEnded(id);
        if (s != Status.Failed) revert GoalAlreadyReached(id);

        uint256 amount = contributions[id][msg.sender];
        if (amount == 0) revert NothingToRefund(id, msg.sender);

        contributions[id][msg.sender] = 0;
        emit Refunded(id, msg.sender, amount);

        _sendEther(msg.sender, amount);
    }

    /// @notice Вкладник забирає токени-винагороди за успішну кампанію (один раз)
    /// @param id Ідентифікатор кампанії
    function claimReward(uint256 id) external nonReentrant whenNotPaused {
        Campaign storage c = _getCampaign(id);

        Status s = _statusOf(c);
        if (s == Status.Active) revert CampaignNotEnded(id);
        if (s == Status.Failed) revert GoalNotReached(id);

        uint256 amount = contributions[id][msg.sender];
        if (amount == 0) revert NothingToClaim(id, msg.sender);

        contributions[id][msg.sender] = 0;
        uint256 reward = amount * REWARD_RATE;
        emit RewardClaimed(id, msg.sender, reward);

        rewardToken.mint(msg.sender, reward);
    }

    /// @notice Вмикає аварійну паузу. Лише адміністратор
    function pause() external onlyAdmin {
        _pause();
    }

    /// @notice Знімає аварійну паузу. Лише адміністратор
    function unpause() external onlyAdmin {
        _unpause();
    }

    /// @notice Повертає дані кампанії
    function getCampaign(uint256 id) external view returns (Campaign memory) {
        return _getCampaign(id);
    }

    /// @notice Повертає поточний стан кампанії
    function status(uint256 id) external view returns (Status) {
        return _statusOf(_getCampaign(id));
    }

    /// @notice Повертає кампанії частинами
    /// @param offset Скільки кампаній пропустити з початку
    /// @param limit Максимальна кількість кампаній у відповіді
    function getCampaigns(uint256 offset, uint256 limit) external view returns (Campaign[] memory page) {
        uint256 total = campaignCount;
        if (offset >= total) return new Campaign[](0);

        uint256 remaining = total - offset;
        uint256 size = limit < remaining ? limit : remaining;
        page = new Campaign[](size);
        for (uint256 i = 0; i < size; ++i) {
            page[i] = _campaigns[offset + i + 1];
        }
    }

    function _getCampaign(uint256 id) private view returns (Campaign storage c) {
        c = _campaigns[id];
        if (c.author == address(0)) revert CampaignNotFound(id);
    }

    function _statusOf(Campaign storage c) private view returns (Status) {
        if (block.timestamp < c.deadline) return Status.Active;
        if (c.raised < c.goal) return Status.Failed;
        return c.withdrawn ? Status.PaidOut : Status.Succeeded;
    }

    function _sendEther(address to, uint256 amount) private {
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }
}
