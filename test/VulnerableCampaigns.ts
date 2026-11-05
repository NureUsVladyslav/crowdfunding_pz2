import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();
const { loadFixture, time } = networkHelpers;

const ETH = ethers.parseEther;
const DAY = 24 * 60 * 60;

async function deployFixture() {
  const [owner, alice, stranger] = await ethers.getSigners();
  const vulnerable = await ethers.deployContract("VulnerableCampaigns");
  await vulnerable.createCampaign(ETH("10"), DAY); // кампанія №1
  return { owner, alice, stranger, vulnerable };
}

// Звичайна (не атакуюча) поведінка вразливої копії: потрібна, щоб її код був покритий тестами
describe("VulnerableCampaigns (normal behaviour)", function () {
  it("rejects contributions after the deadline", async function () {
    const { vulnerable, alice } = await loadFixture(deployFixture);
    await time.increase(DAY + 1);

    await expect(vulnerable.connect(alice).contribute(1, { value: 1n })).to.be.revertedWithCustomError(
      vulnerable,
      "CampaignEnded",
    );
  });

  it("rejects a refund before the deadline", async function () {
    const { vulnerable, alice } = await loadFixture(deployFixture);
    await vulnerable.connect(alice).contribute(1, { value: ETH("1") });

    await expect(vulnerable.connect(alice).refund(1)).to.be.revertedWithCustomError(vulnerable, "RefundNotAvailable");
  });

  it("rejects a refund when the goal was reached", async function () {
    const { vulnerable, alice } = await loadFixture(deployFixture);
    await vulnerable.connect(alice).contribute(1, { value: ETH("10") });
    await time.increase(DAY + 1);

    await expect(vulnerable.connect(alice).refund(1)).to.be.revertedWithCustomError(vulnerable, "RefundNotAvailable");
  });

  it("rejects a refund for an address that contributed nothing", async function () {
    const { vulnerable, stranger } = await loadFixture(deployFixture);
    await time.increase(DAY + 1);

    await expect(vulnerable.connect(stranger).refund(1)).to.be.revertedWithCustomError(vulnerable, "NothingToRefund");
  });

  it("refunds an honest contributor of a failed campaign", async function () {
    const { vulnerable, alice } = await loadFixture(deployFixture);
    await vulnerable.connect(alice).contribute(1, { value: ETH("2") });
    await time.increase(DAY + 1);

    await expect(vulnerable.connect(alice).refund(1)).to.changeEtherBalance(ethers, alice, ETH("2"));
  });
});
