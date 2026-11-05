import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();

const ETH = ethers.parseEther;
const DAY = 24 * 60 * 60;

/**
 * Спільний сценарій: ті самі кроки запускаються проти обох контрактів.
 * Кампанія з недосяжною ціллю, двоє чесних вкладників і атакувальник.
 */
async function prepareScenario(target: any, createCampaign: (goal: bigint, duration: number) => Promise<unknown>) {
  const [, alice, bob, hacker] = await ethers.getSigners();

  await createCampaign(ETH("10"), DAY); // кампанія №1, ціль 10 ETH недосяжна
  await target.connect(alice).contribute(1, { value: ETH("3") });
  await target.connect(bob).contribute(1, { value: ETH("3") });

  const attacker = await ethers.deployContract("ReentrancyAttacker", [await target.getAddress()], hacker);
  await attacker.deposit(1, { value: ETH("1") }); // власний внесок атакувальника

  await networkHelpers.time.increase(DAY + 1); // дедлайн минув, кампанія провалена

  return { alice, bob, attacker };
}

async function deployVulnerable() {
  const [, , , hacker] = await ethers.getSigners();
  const target = await ethers.deployContract("VulnerableCampaigns");
  return { target, createCampaign: (goal: bigint, duration: number) => target.createCampaign(goal, duration), hacker };
}

async function deployFixed() {
  const [admin, author] = await ethers.getSigners();
  const registry = await ethers.deployContract("AuthorRegistry", [admin.address]);
  const token = await ethers.deployContract("RewardToken", [admin.address]);
  const campaigns = await ethers.deployContract("Campaigns", [
    await registry.getAddress(),
    await token.getAddress(),
  ]);
  await token.grantRole(await token.MINTER_ROLE(), await campaigns.getAddress());
  await registry.registerAuthor(author.address);
  return {
    target: campaigns,
    createCampaign: (goal: bigint, duration: number) => campaigns.connect(author).createCampaign(goal, duration),
  };
}

describe("Reentrancy attack on refund()", function () {
  describe("vulnerable version (VulnerableCampaigns)", function () {
    it("the attack succeeds: the attacker drains other contributors' funds", async function () {
      const { target, createCampaign } = await deployVulnerable();
      const { attacker } = await prepareScenario(target, createCampaign);

      // у контракті 3 + 3 (чесні) + 1 (атакувальник) = 7 ETH
      expect(await ethers.provider.getBalance(await target.getAddress())).to.equal(ETH("7"));

      await attacker.attack();

      // жертва спорожніла, а атакувальник отримав 7 ETH при власному внеску 1 ETH
      expect(await ethers.provider.getBalance(await target.getAddress())).to.equal(0n);
      expect(await ethers.provider.getBalance(await attacker.getAddress())).to.equal(ETH("7"));
    });

    it("after the attack an honest contributor cannot get the money back", async function () {
      const { target, createCampaign } = await deployVulnerable();
      const { attacker, alice } = await prepareScenario(target, createCampaign);

      await attacker.attack();

      await expect(target.connect(alice).refund(1)).to.be.revertedWithCustomError(target, "TransferFailed");
    });
  });

  describe("fixed version (Campaigns)", function () {
    it("the same attack is rejected and reverts", async function () {
      const { target, createCampaign } = await deployFixed();
      const { attacker } = await prepareScenario(target, createCampaign);

      await expect(attacker.attack()).to.be.revertedWithCustomError(target, "TransferFailed");

      // нічого не вкрадено: кошти на місці, в атакувальника нуль
      expect(await ethers.provider.getBalance(await target.getAddress())).to.equal(ETH("7"));
      expect(await ethers.provider.getBalance(await attacker.getAddress())).to.equal(0n);
    });

    it("honest contributors still get their money back", async function () {
      const { target, createCampaign } = await deployFixed();
      const { alice } = await prepareScenario(target, createCampaign);

      await expect(target.connect(alice).refund(1)).to.changeEtherBalance(ethers, alice, ETH("3"));
    });
  });
});
