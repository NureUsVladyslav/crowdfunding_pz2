import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();
const { loadFixture } = networkHelpers;

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

async function deployFixture() {
  const [admin, minter, user, stranger] = await ethers.getSigners();
  const token = await ethers.deployContract("RewardToken", [admin.address]);
  const MINTER_ROLE = await token.MINTER_ROLE();
  return { admin, minter, user, stranger, token, MINTER_ROLE };
}

describe("RewardToken", function () {
  it("is an ERC-20 token with the expected name and symbol", async function () {
    const { token } = await loadFixture(deployFixture);

    expect(await token.name()).to.equal("Crowdfund Reward");
    expect(await token.symbol()).to.equal("CFR");
    expect(await token.totalSupply()).to.equal(0n);
  });

  it("reverts the deployment if the admin is the zero address", async function () {
    const { token } = await loadFixture(deployFixture);

    await expect(ethers.deployContract("RewardToken", [ethers.ZeroAddress])).to.be.revertedWithCustomError(
      token,
      "ZeroAddress",
    );
  });

  it("lets the admin grant the minter role", async function () {
    const { token, admin, minter, MINTER_ROLE } = await loadFixture(deployFixture);

    await expect(token.grantRole(MINTER_ROLE, minter.address))
      .to.emit(token, "RoleGranted")
      .withArgs(MINTER_ROLE, minter.address, admin.address);
  });

  it("lets a minter mint tokens and emits Transfer from the zero address", async function () {
    const { token, minter, user, MINTER_ROLE } = await loadFixture(deployFixture);
    await token.grantRole(MINTER_ROLE, minter.address);

    await expect(token.connect(minter).mint(user.address, 500n))
      .to.emit(token, "Transfer")
      .withArgs(ethers.ZeroAddress, user.address, 500n);
    expect(await token.balanceOf(user.address)).to.equal(500n);
    expect(await token.totalSupply()).to.equal(500n);
  });

  it("does not let an address without the minter role mint (even the admin)", async function () {
    const { token, admin, stranger, user, MINTER_ROLE } = await loadFixture(deployFixture);

    await expect(token.connect(stranger).mint(user.address, 1n))
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
      .withArgs(stranger.address, MINTER_ROLE);
    await expect(token.connect(admin).mint(user.address, 1n))
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
      .withArgs(admin.address, MINTER_ROLE);
  });

  it("does not let a non-admin grant the minter role", async function () {
    const { token, stranger, MINTER_ROLE } = await loadFixture(deployFixture);

    await expect(token.connect(stranger).grantRole(MINTER_ROLE, stranger.address))
      .to.be.revertedWithCustomError(token, "AccessControlUnauthorizedAccount")
      .withArgs(stranger.address, DEFAULT_ADMIN_ROLE);
  });

  it("lets token holders transfer tokens (standard ERC-20)", async function () {
    const { token, minter, user, stranger, MINTER_ROLE } = await loadFixture(deployFixture);
    await token.grantRole(MINTER_ROLE, minter.address);
    await token.connect(minter).mint(user.address, 100n);

    await expect(token.connect(user).transfer(stranger.address, 40n)).to.changeTokenBalances(
      ethers,
      token,
      [user, stranger],
      [-40n, 40n],
    );
  });
});
