const hre = require("hardhat");
const { ethers, waffle } = hre;
const { loadFixture } = waffle;
const { expect } = require("chai");
const { utils } = ethers;

const Utxo = require("../src/utxo");
const {
  transaction,
  registerAndTransact,
  prepareTransaction,
  buildMerkleTree,
} = require("../src/index");
const { toFixedHex, poseidonHash } = require("../src/utils");
const { Keypair } = require("../src/keypair");
const { encodeDataForBridge } = require("./utils");

const MERKLE_TREE_HEIGHT = 5;
const l1ChainId = 1;
const MINIMUM_WITHDRAWAL_AMOUNT = utils.parseEther(
  process.env.MINIMUM_WITHDRAWAL_AMOUNT || "0.05"
);
const MAXIMUM_DEPOSIT_AMOUNT = utils.parseEther(
  process.env.MAXIMUM_DEPOSIT_AMOUNT || "1"
);

describe("Custom Tests", function () {
  this.timeout(20000);

  async function deploy(contractName, ...args) {
    const Factory = await ethers.getContractFactory(contractName);
    const instance = await Factory.deploy(...args);
    return instance.deployed();
  }

  async function fixture() {
    require("../scripts/compileHasher");
    const [sender, gov, l1Unwrapper, multisig] = await ethers.getSigners();
    const verifier2 = await deploy("Verifier2");
    const verifier16 = await deploy("Verifier16");
    const hasher = await deploy("Hasher");

    const token = await deploy(
      "PermittableToken",
      "Wrapped ETH",
      "WETH",
      18,
      l1ChainId
    );
    await token.mint(sender.address, utils.parseEther("10000"));

    const amb = await deploy("MockAMB", gov.address, l1ChainId);
    const omniBridge = await deploy("MockOmniBridge", amb.address);

    /** @type {TornadoPool} */
    const tornadoPoolImpl = await deploy(
      "TornadoPool",
      verifier2.address,
      verifier16.address,
      MERKLE_TREE_HEIGHT,
      hasher.address,
      token.address,
      omniBridge.address,
      l1Unwrapper.address,
      gov.address,
      l1ChainId,
      multisig.address
    );

    const { data } = await tornadoPoolImpl.populateTransaction.initialize(
      MINIMUM_WITHDRAWAL_AMOUNT,
      MAXIMUM_DEPOSIT_AMOUNT
    );
    const proxy = await deploy(
      "CrossChainUpgradeableProxy",
      tornadoPoolImpl.address,
      gov.address,
      data,
      amb.address,
      l1ChainId
    );

    const tornadoPool = tornadoPoolImpl.attach(proxy.address);

    await token.approve(tornadoPool.address, utils.parseEther("10000"));

    return { tornadoPool, token, proxy, omniBridge, amb, gov, multisig };
  }

  it("[assignment] ii. deposit 0.1 ETH in L1 -> withdraw 0.08 ETH in L2 -> assert balances", async () => {
    const { tornadoPool, token, omniBridge } = await loadFixture(fixture);

    const aliceKeypair = new Keypair(); // contains private and public keys

    // Alice deposits into tornado pool
    const aliceDepositAmount = utils.parseEther("0.1");
    const aliceDepositUtxo = new Utxo({
      amount: aliceDepositAmount,
      keypair: aliceKeypair,
    });
    const { args, extData } = await prepareTransaction({
      tornadoPool,
      outputs: [aliceDepositUtxo],
    });

    const onTokenBridgedData = encodeDataForBridge({
      proof: args,
      extData,
    });

    const onTokenBridgedTx =
      await tornadoPool.populateTransaction.onTokenBridged(
        token.address,
        aliceDepositUtxo.amount,
        onTokenBridgedData
      );

    // emulating bridge. first it sends tokens to omnibridge mock then it sends to the pool
    await token.transfer(omniBridge.address, aliceDepositAmount);
    const transferTx = await token.populateTransaction.transfer(
      tornadoPool.address,
      aliceDepositAmount
    );

    await omniBridge.execute([
      { who: token.address, callData: transferTx.data }, // send tokens to pool
      { who: tornadoPool.address, callData: onTokenBridgedTx.data }, // call onTokenBridgedTx
    ]);

    // withdraws a part of his funds from the shielded pool
    const aliceWithdrawAmount = utils.parseEther("0.08");
    const recipient = "0xDeaD00000000000000000000000000000000BEEf";
    const aliceChangeUtxo = new Utxo({
      amount: aliceDepositAmount.sub(aliceWithdrawAmount),
      keypair: aliceKeypair,
    });

    await transaction({
      tornadoPool,
      inputs: [aliceDepositUtxo], // 0.1
      outputs: [aliceChangeUtxo], // 0.02 = 0.1 - 0.08
      recipient: recipient, // 0.08
      isL1Withdrawal: false,
    });

    const recipientBalance = await token.balanceOf(recipient);
    expect(recipientBalance).to.be.equal(aliceWithdrawAmount);
    const omniBridgeBalance = await token.balanceOf(omniBridge.address);
    expect(omniBridgeBalance).to.be.equal(0);
    const tornadoPoolBalance = await token.balanceOf(tornadoPool.address);
    expect(tornadoPoolBalance).to.be.equal(utils.parseEther("0.02"));
  });

  it("[assignment] iii. see assignment doc for details", async () => {
    const { tornadoPool, token, omniBridge } = await loadFixture(fixture);

    const aliceKeypair = new Keypair(); // contains private and public keys

    // Alice deposits into tornado pool
    const aliceDepositAmount = utils.parseEther("0.13");
    const aliceDepositUtxo = new Utxo({ amount: aliceDepositAmount });
    await transaction({ tornadoPool, outputs: [aliceDepositUtxo] });

    // Bob gives Alice address to get some eth inside the shielded pool
    const bobKeypair = new Keypair(); // contains private and public keys
    const bobAddress = bobKeypair.address(); // contains only public key

    // Alice sends some funds to Bob
    const bobSendAmount = utils.parseEther("0.06");
    const bobSendUtxo = new Utxo({
      amount: bobSendAmount,
      keypair: Keypair.fromString(bobAddress),
    });
    const aliceChangeUtxo = new Utxo({
      amount: aliceDepositAmount.sub(bobSendAmount), // 0.07 = 0.13 - 0.06
      keypair: aliceDepositUtxo.keypair,
    });
    await transaction({
      tornadoPool,
      inputs: [aliceDepositUtxo],
      outputs: [bobSendUtxo, aliceChangeUtxo],
    });

    // Bob parses chain to detect incoming funds
    const filter = tornadoPool.filters.NewCommitment();
    const fromBlock = await ethers.provider.getBlock();
    const events = await tornadoPool.queryFilter(filter, fromBlock.number);
    let bobReceiveUtxo;
    try {
      bobReceiveUtxo = Utxo.decrypt(
        bobKeypair,
        events[0].args.encryptedOutput,
        events[0].args.index
      );
    } catch (e) {
      // we try to decrypt another output here because it shuffles outputs before sending to blockchain
      bobReceiveUtxo = Utxo.decrypt(
        bobKeypair,
        events[1].args.encryptedOutput,
        events[1].args.index
      );
    }
    expect(bobReceiveUtxo.amount).to.be.equal(bobSendAmount);

    // Bob withdraws a all his funds from the shielded pool
    const bobWithdrawAmount = utils.parseEther("0.06");
    const bobEthAddress = "0xDeaD00000000000000000000000000000000BEEf";
    const bobChangeUtxo = new Utxo({ amount: 0, keypair: bobKeypair });
    await transaction({
      tornadoPool,
      inputs: [bobReceiveUtxo],
      outputs: [bobChangeUtxo],
      recipient: bobEthAddress,
    });

    // check bob's balance L2
    const bobBalance = await token.balanceOf(bobEthAddress);
    expect(bobBalance).to.be.equal(bobWithdrawAmount);

    // make sure current pool balance is 0.07
    const currentPoolBalance = await token.balanceOf(tornadoPool.address);
    expect(currentPoolBalance).to.be.equal(ethers.utils.parseEther("0.07"));

    // withdraws a part of his funds from the shielded pool
    const aliceWithdrawAmount = utils.parseEther("0.07");
    const recipient = "0xAb69271eeC0CF97f39D40Bd4F1590D460f94d5F9";
    const aliceWithdrawUtxo = new Utxo({
      amount: 0,
      keypair: aliceKeypair,
    });

    await transaction({
      tornadoPool,
      inputs: [aliceChangeUtxo],
      outputs: [aliceWithdrawUtxo],
      recipient: recipient,
      isL1Withdrawal: true,
    });
    // make sure alice L2 balance is 0
    const recipientBalance = await token.balanceOf(recipient);
    expect(recipientBalance).to.be.equal(0);
    // make sure all pool balance is 0
    const tornadoPoolBalance = await token.balanceOf(tornadoPool.address);
    expect(tornadoPoolBalance).to.be.equal(0);
    // make sure alice L1 balance is 0.07
    const omniBridgeBalance = await token.balanceOf(omniBridge.address);
    expect(omniBridgeBalance).to.be.equal(aliceWithdrawAmount);
  });
});
