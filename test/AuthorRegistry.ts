import { expect } from "chai";
import { network } from "hardhat";

const { ethers, networkHelpers } = await network.create();
const { loadFixture } = networkHelpers;

const DEFAULT_ADMIN_ROLE = ethers.ZeroHash;

async function deployFixture() {
  const [admin, author, stranger] = await ethers.getSigners();
  const registry = await ethers.deployContract("AuthorRegistry", [admin.address]);
  const AUTHOR_ROLE = await registry.AUTHOR_ROLE();
  return { admin, author, stranger, registry, AUTHOR_ROLE };
}

describe("AuthorRegistry", function () {
  it("gives the admin role to the address passed to the constructor", async function () {
    const { registry, admin, stranger } = await loadFixture(deployFixture);

    expect(await registry.isAdmin(admin.address)).to.equal(true);
    expect(await registry.isAdmin(stranger.address)).to.equal(false);
  });

  it("reverts the deployment if the admin is the zero address", async function () {
    const { registry } = await loadFixture(deployFixture);

    await expect(ethers.deployContract("AuthorRegistry", [ethers.ZeroAddress])).to.be.revertedWithCustomError(
      registry,
      "ZeroAddress",
    );
  });

  it("lets the admin register an author and emits RoleGranted", async function () {
    const { registry, admin, author, AUTHOR_ROLE } = await loadFixture(deployFixture);

    await expect(registry.registerAuthor(author.address))
      .to.emit(registry, "RoleGranted")
      .withArgs(AUTHOR_ROLE, author.address, admin.address);
    expect(await registry.isAuthor(author.address)).to.equal(true);
  });

  it("does not let a non-admin register an author", async function () {
    const { registry, stranger, author } = await loadFixture(deployFixture);

    await expect(registry.connect(stranger).registerAuthor(author.address))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
      .withArgs(stranger.address, DEFAULT_ADMIN_ROLE);
  });

  it("rejects registering the zero address as an author", async function () {
    const { registry } = await loadFixture(deployFixture);

    await expect(registry.registerAuthor(ethers.ZeroAddress)).to.be.revertedWithCustomError(registry, "ZeroAddress");
  });

  it("lets the admin revoke the author role and emits RoleRevoked", async function () {
    const { registry, admin, author, AUTHOR_ROLE } = await loadFixture(deployFixture);
    await registry.registerAuthor(author.address);

    await expect(registry.removeAuthor(author.address))
      .to.emit(registry, "RoleRevoked")
      .withArgs(AUTHOR_ROLE, author.address, admin.address);
    expect(await registry.isAuthor(author.address)).to.equal(false);
  });

  it("does not let a non-admin revoke the author role", async function () {
    const { registry, author, stranger } = await loadFixture(deployFixture);
    await registry.registerAuthor(author.address);

    await expect(registry.connect(stranger).removeAuthor(author.address))
      .to.be.revertedWithCustomError(registry, "AccessControlUnauthorizedAccount")
      .withArgs(stranger.address, DEFAULT_ADMIN_ROLE);
  });

  it("does not treat an author as an admin", async function () {
    const { registry, author } = await loadFixture(deployFixture);
    await registry.registerAuthor(author.address);

    expect(await registry.isAdmin(author.address)).to.equal(false);
  });
});
