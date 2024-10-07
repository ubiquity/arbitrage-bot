import { ethers, run } from "hardhat";

// import deployer from "../.secret.ts";

// WBNB address on BSC, WETH address on ETH
const wethAddr = "0xbb4CdB9CBd36B01bD1cBaEBF2De08d9173bc095c";

async function main() {
  await run("compile");
  const tFlashBot = await ethers.getContractFactory("FlashBot");
  const flashBot = await tFlashBot.deploy(wethAddr);

  console.log(`FlashBot deployed to ${await flashBot.getAddress()}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
