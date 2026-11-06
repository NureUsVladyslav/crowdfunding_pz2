import fs from "node:fs";
import path from "node:path";
import { network } from "hardhat";

/**
 * Розгортає систему краудфандингу: AuthorRegistry, RewardToken, Campaigns,
 * видає контракту Campaigns роль MINTER_ROLE і зберігає адреси у deployments/<мережа>.json.
 *
 * Параметри:
 *   --network <назва>     у якій мережі розгортати (за замовчуванням локальна)
 *   AUTHOR_ADDRESS        необов'язково: адреса, якій одразу видати роль автора
 *                         (змінна середовища або рядок у файлі .env)
 *
 * Запуск:
 *   локально:  npx hardhat run scripts/deploy.ts
 *   Sepolia:   npx hardhat run scripts/deploy.ts --network sepolia
 */
const { ethers, networkName } = await network.create();

const [deployer] = await ethers.getSigners();
const chainId = (await ethers.provider.getNetwork()).chainId;
const balance = await ethers.provider.getBalance(deployer.address);

console.log(`Мережа:      ${networkName} (chainId ${chainId})`);
console.log(`Розгортальник: ${deployer.address}`);
console.log(`Баланс:      ${ethers.formatEther(balance)} ETH`);

if (balance === 0n) {
  throw new Error("На акаунті немає ETH. Для Sepolia спочатку отримайте тестові ETH через кран.");
}

// 1. Реєстр авторів: адміністратором стає розгортальник
const registry = await ethers.deployContract("AuthorRegistry", [deployer.address]);
await registry.waitForDeployment();
const registryAddress = await registry.getAddress();
// Блок розгортання потрібен індексатору подій, щоб знати, з якого місця читати журнал
const deployBlock = (await registry.deploymentTransaction()?.wait())?.blockNumber;
console.log(`AuthorRegistry: ${registryAddress}`);

// 2. Токен винагород: адміністратором стає розгортальник
const token = await ethers.deployContract("RewardToken", [deployer.address]);
await token.waitForDeployment();
const tokenAddress = await token.getAddress();
console.log(`RewardToken:    ${tokenAddress}`);

// 3. Головний контракт: знає адреси реєстру й токена
const campaigns = await ethers.deployContract("Campaigns", [registryAddress, tokenAddress]);
await campaigns.waitForDeployment();
const campaignsAddress = await campaigns.getAddress();
console.log(`Campaigns:      ${campaignsAddress}`);

// 4. Без цієї ролі claimReward не зможе випускати токени
const grantTx = await token.grantRole(await token.MINTER_ROLE(), campaignsAddress);
await grantTx.wait();
console.log("Роль MINTER_ROLE видано контракту Campaigns");

// 5. За бажанням одразу призначаємо автора (параметр AUTHOR_ADDRESS)
const authorAddress = process.env.AUTHOR_ADDRESS;
if (authorAddress) {
  if (!ethers.isAddress(authorAddress)) {
    throw new Error(`AUTHOR_ADDRESS не є коректною адресою: ${authorAddress}`);
  }
  const authorTx = await registry.registerAuthor(authorAddress);
  await authorTx.wait();
  console.log(`Роль автора видано адресі ${authorAddress}`);
}

// 6. Зберігаємо адреси (вони не секретні) для інтерфейсу та звіту
const result = {
  network: networkName,
  chainId: Number(chainId),
  deployer: deployer.address,
  deployBlock: deployBlock ?? null,
  author: authorAddress ?? null,
  contracts: {
    AuthorRegistry: registryAddress,
    RewardToken: tokenAddress,
    Campaigns: campaignsAddress,
  },
};
const dir = path.join(process.cwd(), "deployments");
fs.mkdirSync(dir, { recursive: true });
const fileLabel = chainId === 31337n ? "local" : networkName;
const file = path.join(dir, `${fileLabel}.json`);
fs.writeFileSync(file, JSON.stringify(result, null, 2) + "\n");
console.log(`Адреси збережено у ${path.relative(process.cwd(), file)}`);

// 7. Підказка для верифікації коду в оглядачі блоків
if (chainId !== 31337n) {
  console.log("\nВерифікація (виконайте по черзі):");
  console.log(`npx hardhat verify --network ${networkName} ${registryAddress} ${deployer.address}`);
  console.log(`npx hardhat verify --network ${networkName} ${tokenAddress} ${deployer.address}`);
  console.log(`npx hardhat verify --network ${networkName} ${campaignsAddress} ${registryAddress} ${tokenAddress}`);
}
