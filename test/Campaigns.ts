import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();
const { loadFixture, time } = networkHelpers;

const ETH = ethers.parseEther;
const DAY = 24 * 60 * 60;
const GOAL = ETH("10");

// Статуси кампанії (відповідають enum Status у контракті)
const ACTIVE = 0n;
const SUCCEEDED = 1n;
const FAILED = 2n;
const PAID_OUT = 3n;

// ---------- Фікстури: кожна наступна будується на попередній ----------

/** Розгортає всі три контракти, видає ролі. Кампаній ще немає */
async function deployFixture() {
  const [admin, author, alice, bob, stranger] = await ethers.getSigners();
  const registry = await ethers.deployContract("AuthorRegistry", [admin.address]);
  const token = await ethers.deployContract("RewardToken", [admin.address]);
  const campaigns = await ethers.deployContract("Campaigns", [
    await registry.getAddress(),
    await token.getAddress(),
  ]);
  await token.grantRole(await token.MINTER_ROLE(), await campaigns.getAddress());
  await registry.registerAuthor(author.address);
  return { admin, author, alice, bob, stranger, registry, token, campaigns };
}

/** Кампанія №1: ціль 10 ETH, тривалість доба. Внесків ще немає */
async function campaignFixture() {
  const env = await deployFixture();
  await env.campaigns.connect(env.author).createCampaign(GOAL, DAY);
  return env;
}

/** Кампанія зібрала рівно ціль (alice 6 + bob 4), час ще не вийшов */
async function fundedFixture() {
  const env = await campaignFixture();
  await env.campaigns.connect(env.alice).contribute(1, { value: ETH("6") });
  await env.campaigns.connect(env.bob).contribute(1, { value: ETH("4") });
  return env;
}

/** Дедлайн минув, ціль зібрано: кампанія успішна, кошти ще не виплачено */
async function succeededFixture() {
  const env = await fundedFixture();
  await time.increase(DAY + 1);
  return env;
}

/** Дедлайн минув, зібрано лише 3 ETH (alice): кампанія провалена */
async function failedFixture() {
  const env = await campaignFixture();
  await env.campaigns.connect(env.alice).contribute(1, { value: ETH("3") });
  await time.increase(DAY + 1);
  return env;
}

// ---------- Тести ----------

describe("Campaigns", function () {
  describe("constructor", function () {
    it("stores the registry and token addresses and the reward rate", async function () {
      const { campaigns, registry, token } = await loadFixture(deployFixture);

      expect(await campaigns.registry()).to.equal(await registry.getAddress());
      expect(await campaigns.rewardToken()).to.equal(await token.getAddress());
      expect(await campaigns.REWARD_RATE()).to.equal(1000n);
    });

    it("rejects the zero address as registry", async function () {
      const { campaigns, token } = await loadFixture(deployFixture);

      await expect(
        ethers.deployContract("Campaigns", [ethers.ZeroAddress, await token.getAddress()]),
      ).to.be.revertedWithCustomError(campaigns, "ZeroAddress");
    });

    it("rejects the zero address as token", async function () {
      const { campaigns, registry } = await loadFixture(deployFixture);

      await expect(
        ethers.deployContract("Campaigns", [await registry.getAddress(), ethers.ZeroAddress]),
      ).to.be.revertedWithCustomError(campaigns, "ZeroAddress");
    });

    it("rejects plain ETH transfers (no receive function)", async function () {
      const { campaigns, alice } = await loadFixture(deployFixture);

      await expect(alice.sendTransaction({ to: await campaigns.getAddress(), value: 1n })).to.be.revert(ethers);
    });
  });

  describe("createCampaign", function () {
    it("creates a campaign, stores its data and emits CampaignCreated", async function () {
      const { campaigns, author } = await loadFixture(deployFixture);
      const start = (await time.latest()) + 100;
      await time.setNextBlockTimestamp(start);

      await expect(campaigns.connect(author).createCampaign(GOAL, DAY))
        .to.emit(campaigns, "CampaignCreated")
        .withArgs(1n, author.address, GOAL, BigInt(start + DAY));

      const c = await campaigns.getCampaign(1);
      expect(c.author).to.equal(author.address);
      expect(c.goal).to.equal(GOAL);
      expect(c.deadline).to.equal(BigInt(start + DAY));
      expect(c.raised).to.equal(0n);
      expect(c.withdrawn).to.equal(false);
      expect(await campaigns.campaignCount()).to.equal(1n);
    });

    it("assigns sequential ids", async function () {
      const { campaigns, author } = await loadFixture(deployFixture);

      await campaigns.connect(author).createCampaign(GOAL, DAY);
      await campaigns.connect(author).createCampaign(GOAL, DAY);

      expect(await campaigns.campaignCount()).to.equal(2n);
      expect((await campaigns.getCampaign(2)).author).to.equal(author.address);
    });

    it("rejects an address without the author role", async function () {
      const { campaigns, stranger } = await loadFixture(deployFixture);

      await expect(campaigns.connect(stranger).createCampaign(GOAL, DAY))
        .to.be.revertedWithCustomError(campaigns, "NotAuthor")
        .withArgs(stranger.address);
    });

    it("rejects an author whose role was revoked", async function () {
      const { campaigns, registry, author } = await loadFixture(deployFixture);
      await registry.removeAuthor(author.address);

      await expect(campaigns.connect(author).createCampaign(GOAL, DAY)).to.be.revertedWithCustomError(
        campaigns,
        "NotAuthor",
      );
    });

    it("rejects a zero goal", async function () {
      const { campaigns, author } = await loadFixture(deployFixture);

      await expect(campaigns.connect(author).createCampaign(0, DAY)).to.be.revertedWithCustomError(
        campaigns,
        "ZeroGoal",
      );
    });

    it("rejects a zero duration", async function () {
      const { campaigns, author } = await loadFixture(deployFixture);

      await expect(campaigns.connect(author).createCampaign(GOAL, 0)).to.be.revertedWithCustomError(
        campaigns,
        "ZeroDuration",
      );
    });

    it("is blocked while the contract is paused", async function () {
      const { campaigns, author } = await loadFixture(deployFixture);
      await campaigns.pause();

      await expect(campaigns.connect(author).createCampaign(GOAL, DAY)).to.be.revertedWithCustomError(
        campaigns,
        "EnforcedPause",
      );
    });

    it("rejects a goal that does not fit into uint128", async function () {
      const { campaigns, author } = await loadFixture(deployFixture);

      await expect(campaigns.connect(author).createCampaign(2n ** 128n, DAY))
        .to.be.revertedWithCustomError(campaigns, "SafeCastOverflowedUintDowncast")
        .withArgs(128n, 2n ** 128n);
    });

    it("rejects a duration that makes the deadline overflow uint64", async function () {
      const { campaigns, author } = await loadFixture(deployFixture);

      await expect(campaigns.connect(author).createCampaign(GOAL, 2n ** 64n)).to.be.revertedWithCustomError(
        campaigns,
        "SafeCastOverflowedUintDowncast",
      );
    });
  });

  describe("contribute", function () {
    it("records the contribution, moves the ETH and emits Contributed", async function () {
      const { campaigns, alice } = await loadFixture(campaignFixture);

      const tx = campaigns.connect(alice).contribute(1, { value: ETH("1") });

      await expect(tx).to.emit(campaigns, "Contributed").withArgs(1n, alice.address, ETH("1"));
      await expect(tx).to.changeEtherBalances(ethers, [alice, campaigns], [-ETH("1"), ETH("1")]);
      expect((await campaigns.getCampaign(1)).raised).to.equal(ETH("1"));
      expect(await campaigns.contributions(1, alice.address)).to.equal(ETH("1"));
    });

    it("accumulates repeated contributions of the same address", async function () {
      const { campaigns, alice } = await loadFixture(campaignFixture);

      await campaigns.connect(alice).contribute(1, { value: ETH("1") });
      await campaigns.connect(alice).contribute(1, { value: ETH("2") });

      expect(await campaigns.contributions(1, alice.address)).to.equal(ETH("3"));
      expect((await campaigns.getCampaign(1)).raised).to.equal(ETH("3"));
    });

    it("sums contributions of different addresses", async function () {
      const { campaigns } = await loadFixture(fundedFixture);

      expect((await campaigns.getCampaign(1)).raised).to.equal(ETH("10"));
    });

    it("rejects an unknown campaign id (0 and a non-existent one)", async function () {
      const { campaigns, alice } = await loadFixture(campaignFixture);

      await expect(campaigns.connect(alice).contribute(0, { value: 1n }))
        .to.be.revertedWithCustomError(campaigns, "CampaignNotFound")
        .withArgs(0n);
      await expect(campaigns.connect(alice).contribute(99, { value: 1n }))
        .to.be.revertedWithCustomError(campaigns, "CampaignNotFound")
        .withArgs(99n);
    });

    it("rejects a zero amount", async function () {
      const { campaigns, alice } = await loadFixture(campaignFixture);

      await expect(campaigns.connect(alice).contribute(1, { value: 0 })).to.be.revertedWithCustomError(
        campaigns,
        "ZeroAmount",
      );
    });

    it("accepts a contribution one second before the deadline", async function () {
      const { campaigns, alice } = await loadFixture(campaignFixture);
      const { deadline } = await campaigns.getCampaign(1);
      await time.setNextBlockTimestamp(deadline - 1n);

      await expect(campaigns.connect(alice).contribute(1, { value: 1n })).to.emit(campaigns, "Contributed");
    });

    it("rejects a contribution at the deadline second", async function () {
      const { campaigns, alice } = await loadFixture(campaignFixture);
      const { deadline } = await campaigns.getCampaign(1);
      await time.setNextBlockTimestamp(deadline);

      await expect(campaigns.connect(alice).contribute(1, { value: 1n }))
        .to.be.revertedWithCustomError(campaigns, "CampaignEnded")
        .withArgs(1n, deadline);
    });

    it("keeps accepting contributions after the goal is reached but before the deadline", async function () {
      const { campaigns, alice } = await loadFixture(fundedFixture);

      await campaigns.connect(alice).contribute(1, { value: ETH("1") });

      expect((await campaigns.getCampaign(1)).raised).to.equal(ETH("11"));
    });

    it("is blocked while the contract is paused", async function () {
      const { campaigns, alice } = await loadFixture(campaignFixture);
      await campaigns.pause();

      await expect(campaigns.connect(alice).contribute(1, { value: 1n })).to.be.revertedWithCustomError(
        campaigns,
        "EnforcedPause",
      );
    });
  });

  describe("withdraw", function () {
    it("pays the raised funds to the author, marks the campaign as paid out and emits Withdrawn", async function () {
      const { campaigns, author } = await loadFixture(succeededFixture);

      const tx = campaigns.connect(author).withdraw(1);

      await expect(tx).to.emit(campaigns, "Withdrawn").withArgs(1n, author.address, ETH("10"));
      await expect(tx).to.changeEtherBalances(ethers, [campaigns, author], [-ETH("10"), ETH("10")]);
      expect((await campaigns.getCampaign(1)).withdrawn).to.equal(true);
      expect(await campaigns.status(1)).to.equal(PAID_OUT);
    });

    it("treats exactly the goal amount as success", async function () {
      const { campaigns } = await loadFixture(succeededFixture);

      expect((await campaigns.getCampaign(1)).raised).to.equal(GOAL);
      expect(await campaigns.status(1)).to.equal(SUCCEEDED);
    });

    it("treats one wei below the goal as failure", async function () {
      const { campaigns, alice } = await loadFixture(campaignFixture);
      await campaigns.connect(alice).contribute(1, { value: GOAL - 1n });
      await time.increase(DAY + 1);

      expect(await campaigns.status(1)).to.equal(FAILED);
    });

    it("rejects withdrawal before the deadline even if the goal is reached", async function () {
      const { campaigns, author } = await loadFixture(fundedFixture);

      await expect(campaigns.connect(author).withdraw(1))
        .to.be.revertedWithCustomError(campaigns, "CampaignNotEnded")
        .withArgs(1n);
    });

    it("rejects withdrawal when the goal was not reached", async function () {
      const { campaigns, author } = await loadFixture(failedFixture);

      await expect(campaigns.connect(author).withdraw(1))
        .to.be.revertedWithCustomError(campaigns, "GoalNotReached")
        .withArgs(1n);
    });

    it("rejects a second withdrawal", async function () {
      const { campaigns, author } = await loadFixture(succeededFixture);
      await campaigns.connect(author).withdraw(1);

      await expect(campaigns.connect(author).withdraw(1))
        .to.be.revertedWithCustomError(campaigns, "AlreadyWithdrawn")
        .withArgs(1n);
    });

    it("rejects withdrawal by anyone except the campaign author", async function () {
      const { campaigns, stranger } = await loadFixture(succeededFixture);

      await expect(campaigns.connect(stranger).withdraw(1))
        .to.be.revertedWithCustomError(campaigns, "NotCampaignAuthor")
        .withArgs(1n, stranger.address);
    });

    it("still lets an author whose role was revoked withdraw from an old successful campaign", async function () {
      const { campaigns, registry, author } = await loadFixture(succeededFixture);
      await registry.removeAuthor(author.address);

      await expect(campaigns.connect(author).withdraw(1)).to.emit(campaigns, "Withdrawn");
    });

    it("is blocked while the contract is paused", async function () {
      const { campaigns, author } = await loadFixture(succeededFixture);
      await campaigns.pause();

      await expect(campaigns.connect(author).withdraw(1)).to.be.revertedWithCustomError(campaigns, "EnforcedPause");
    });
  });

  describe("refund", function () {
    it("returns the contribution of a failed campaign and emits Refunded", async function () {
      const { campaigns, alice } = await loadFixture(failedFixture);

      const tx = campaigns.connect(alice).refund(1);

      await expect(tx).to.emit(campaigns, "Refunded").withArgs(1n, alice.address, ETH("3"));
      await expect(tx).to.changeEtherBalances(ethers, [campaigns, alice], [-ETH("3"), ETH("3")]);
      expect(await campaigns.contributions(1, alice.address)).to.equal(0n);
    });

    it("returns only the caller's own contribution", async function () {
      const { campaigns, alice, bob } = await loadFixture(campaignFixture);
      await campaigns.connect(alice).contribute(1, { value: ETH("2") });
      await campaigns.connect(bob).contribute(1, { value: ETH("3") });
      await time.increase(DAY + 1);

      await campaigns.connect(alice).refund(1);

      expect(await campaigns.contributions(1, bob.address)).to.equal(ETH("3"));
      expect(await ethers.provider.getBalance(await campaigns.getAddress())).to.equal(ETH("3"));
    });

    it("rejects a refund before the deadline", async function () {
      const { campaigns, alice } = await loadFixture(campaignFixture);
      await campaigns.connect(alice).contribute(1, { value: ETH("1") });

      await expect(campaigns.connect(alice).refund(1))
        .to.be.revertedWithCustomError(campaigns, "CampaignNotEnded")
        .withArgs(1n);
    });

    it("rejects a refund from a successful campaign", async function () {
      const { campaigns, alice } = await loadFixture(succeededFixture);

      await expect(campaigns.connect(alice).refund(1))
        .to.be.revertedWithCustomError(campaigns, "GoalAlreadyReached")
        .withArgs(1n);
    });

    it("rejects a refund from a campaign that was already paid out", async function () {
      const { campaigns, author, alice } = await loadFixture(succeededFixture);
      await campaigns.connect(author).withdraw(1);

      await expect(campaigns.connect(alice).refund(1)).to.be.revertedWithCustomError(campaigns, "GoalAlreadyReached");
    });

    it("rejects a refund for an address that contributed nothing", async function () {
      const { campaigns, stranger } = await loadFixture(failedFixture);

      await expect(campaigns.connect(stranger).refund(1))
        .to.be.revertedWithCustomError(campaigns, "NothingToRefund")
        .withArgs(1n, stranger.address);
    });

    it("rejects a second refund", async function () {
      const { campaigns, alice } = await loadFixture(failedFixture);
      await campaigns.connect(alice).refund(1);

      await expect(campaigns.connect(alice).refund(1)).to.be.revertedWithCustomError(campaigns, "NothingToRefund");
    });

    it("is blocked while the contract is paused", async function () {
      const { campaigns, alice } = await loadFixture(failedFixture);
      await campaigns.pause();

      await expect(campaigns.connect(alice).refund(1)).to.be.revertedWithCustomError(campaigns, "EnforcedPause");
    });
  });

  describe("claimReward", function () {
    it("mints 1000 tokens per 1 ETH contributed and emits RewardClaimed", async function () {
      const { campaigns, token, alice } = await loadFixture(succeededFixture);

      const tx = campaigns.connect(alice).claimReward(1);

      await expect(tx).to.emit(campaigns, "RewardClaimed").withArgs(1n, alice.address, ETH("6000"));
      await expect(tx).to.emit(token, "Transfer").withArgs(ethers.ZeroAddress, alice.address, ETH("6000"));
      await expect(tx).to.changeTokenBalance(ethers, token, alice, ETH("6000"));
      expect(await campaigns.contributions(1, alice.address)).to.equal(0n);
    });

    it("still works after the author has withdrawn the funds", async function () {
      const { campaigns, token, author, bob } = await loadFixture(succeededFixture);
      await campaigns.connect(author).withdraw(1);

      await campaigns.connect(bob).claimReward(1);

      expect(await token.balanceOf(bob.address)).to.equal(ETH("4000"));
    });

    it("rejects a claim before the deadline", async function () {
      const { campaigns, alice } = await loadFixture(fundedFixture);

      await expect(campaigns.connect(alice).claimReward(1))
        .to.be.revertedWithCustomError(campaigns, "CampaignNotEnded")
        .withArgs(1n);
    });

    it("rejects a claim for a failed campaign", async function () {
      const { campaigns, alice } = await loadFixture(failedFixture);

      await expect(campaigns.connect(alice).claimReward(1))
        .to.be.revertedWithCustomError(campaigns, "GoalNotReached")
        .withArgs(1n);
    });

    it("rejects a claim for an address that contributed nothing", async function () {
      const { campaigns, stranger } = await loadFixture(succeededFixture);

      await expect(campaigns.connect(stranger).claimReward(1))
        .to.be.revertedWithCustomError(campaigns, "NothingToClaim")
        .withArgs(1n, stranger.address);
    });

    it("rejects a second claim", async function () {
      const { campaigns, alice } = await loadFixture(succeededFixture);
      await campaigns.connect(alice).claimReward(1);

      await expect(campaigns.connect(alice).claimReward(1)).to.be.revertedWithCustomError(
        campaigns,
        "NothingToClaim",
      );
    });

    it("is blocked while the contract is paused", async function () {
      const { campaigns, alice } = await loadFixture(succeededFixture);
      await campaigns.pause();

      await expect(campaigns.connect(alice).claimReward(1)).to.be.revertedWithCustomError(campaigns, "EnforcedPause");
    });

    it("reverts if Campaigns was never given the minter role", async function () {
      const { registry, token, author, alice } = await loadFixture(deployFixture);
      const noRole = await ethers.deployContract("Campaigns", [
        await registry.getAddress(),
        await token.getAddress(),
      ]);
      await noRole.connect(author).createCampaign(GOAL, DAY);
      await noRole.connect(alice).contribute(1, { value: GOAL });
      await time.increase(DAY + 1);

      await expect(noRole.connect(alice).claimReward(1))
        .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
        .withArgs(await noRole.getAddress(), await token.MINTER_ROLE());
    });
  });

  describe("pause and unpause", function () {
    it("lets the admin pause and emits Paused", async function () {
      const { campaigns, admin } = await loadFixture(deployFixture);

      await expect(campaigns.pause()).to.emit(campaigns, "Paused").withArgs(admin.address);
      expect(await campaigns.paused()).to.equal(true);
    });

    it("lets the admin unpause and emits Unpaused", async function () {
      const { campaigns, admin } = await loadFixture(deployFixture);
      await campaigns.pause();

      await expect(campaigns.unpause()).to.emit(campaigns, "Unpaused").withArgs(admin.address);
      expect(await campaigns.paused()).to.equal(false);
    });

    it("does not let a non-admin pause (even an author)", async function () {
      const { campaigns, author, stranger } = await loadFixture(deployFixture);

      await expect(campaigns.connect(stranger).pause())
        .to.be.revertedWithCustomError(campaigns, "NotAdmin")
        .withArgs(stranger.address);
      await expect(campaigns.connect(author).pause())
        .to.be.revertedWithCustomError(campaigns, "NotAdmin")
        .withArgs(author.address);
    });

    it("does not let a non-admin unpause", async function () {
      const { campaigns, stranger } = await loadFixture(deployFixture);
      await campaigns.pause();

      await expect(campaigns.connect(stranger).unpause()).to.be.revertedWithCustomError(campaigns, "NotAdmin");
    });

    it("rejects pausing twice and unpausing when not paused", async function () {
      const { campaigns } = await loadFixture(deployFixture);

      await expect(campaigns.unpause()).to.be.revertedWithCustomError(campaigns, "ExpectedPause");
      await campaigns.pause();
      await expect(campaigns.pause()).to.be.revertedWithCustomError(campaigns, "EnforcedPause");
    });

    it("restores normal operation after unpause", async function () {
      const { campaigns, alice } = await loadFixture(campaignFixture);
      await campaigns.pause();
      await campaigns.unpause();

      await expect(campaigns.connect(alice).contribute(1, { value: 1n })).to.emit(campaigns, "Contributed");
    });
  });

  describe("views", function () {
    it("follows the state diagram: Active, Succeeded, PaidOut and Failed", async function () {
      const { campaigns, author, alice } = await loadFixture(campaignFixture);
      await campaigns.connect(author).createCampaign(GOAL, DAY); // кампанія №2
      await campaigns.connect(alice).contribute(1, { value: GOAL });
      await campaigns.connect(alice).contribute(2, { value: ETH("1") });
      expect(await campaigns.status(1)).to.equal(ACTIVE);

      await time.increase(DAY + 1);
      expect(await campaigns.status(1)).to.equal(SUCCEEDED);
      expect(await campaigns.status(2)).to.equal(FAILED);

      await campaigns.connect(author).withdraw(1);
      expect(await campaigns.status(1)).to.equal(PAID_OUT);
    });

    it("reverts for an unknown campaign id", async function () {
      const { campaigns } = await loadFixture(campaignFixture);

      await expect(campaigns.getCampaign(5)).to.be.revertedWithCustomError(campaigns, "CampaignNotFound");
      await expect(campaigns.status(5)).to.be.revertedWithCustomError(campaigns, "CampaignNotFound");
    });

    it("returns campaigns in pages", async function () {
      const { campaigns, author } = await loadFixture(deployFixture);
      for (const goal of ["1", "2", "3"]) {
        await campaigns.connect(author).createCampaign(ETH(goal), DAY);
      }

      const first = await campaigns.getCampaigns(0, 2);
      expect(first.map((c: any) => c.goal)).to.deep.equal([ETH("1"), ETH("2")]);

      const rest = await campaigns.getCampaigns(2, 10); // ліміт більший за залишок
      expect(rest.map((c: any) => c.goal)).to.deep.equal([ETH("3")]);

      expect(await campaigns.getCampaigns(3, 10)).to.have.length(0); // зсув за межами
      expect(await campaigns.getCampaigns(10, 5)).to.have.length(0);
      expect(await campaigns.getCampaigns(0, 0)).to.have.length(0); // порожня сторінка
    });
  });
});
