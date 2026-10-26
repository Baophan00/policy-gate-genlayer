#!/usr/bin/env node
/**
 * Deploy PolicyGate to GenLayer Studio Network with genlayer-js, no CLI needed.
 *
 *   node scripts/deploy_studionet.js
 *
 * Reuses the two-key file from the e2e script, or creates one. Prints the
 * address and then reads `stats()` back, because a deploy can be reported as
 * successful while `__init__` reverted.
 */
const fs = require("fs");
const path = require("path");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const KEYFILE = path.join(__dirname, ".e2e-keys.json");

function keys() {
  if (fs.existsSync(KEYFILE)) return JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  const k = { owner: generatePrivateKey(), stranger: generatePrivateKey() };
  fs.writeFileSync(KEYFILE, JSON.stringify(k, null, 2), { mode: 0o600 });
  return k;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function withRetry(fn, label) {
  let last;
  for (let i = 0; i < 8; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = String(e && e.message);
      if (!/DOCTYPE|fetch failed|ECONNRESET|timeout|temporarily unavailable|not available/i.test(msg)) throw e;
      console.log(`  ${label}: rpc hiccup, retry ${i + 1}`);
      await sleep(4000);
    }
  }
  throw last;
}

(async () => {
  const k = keys();
  const deployer = createAccount(k.owner);
  const client = createClient({ chain: studionet, account: deployer });
  const code = new Uint8Array(fs.readFileSync(path.join(process.cwd(), "contracts/policy_gate.py")));

  console.log("deployer", deployer.address);
  await withRetry(() => client.initializeConsensusSmartContract(), "consensus");

  const hash = await client.deployContract({ code, args: [] });
  console.log("deploy tx", hash);

  const receipt = await withRetry(
    () => client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 200, interval: 3000 }),
    "receipt"
  );
  const address =
    receipt.data?.contract_address ||
    receipt.txDataDecoded?.contractAddress ||
    receipt.data?.contractAddress;
  if (!address) {
    throw new Error(`no contract address in receipt: ${JSON.stringify(receipt).slice(0, 800)}`);
  }
  console.log("contract", address);

  // A deploy whose __init__ raised still gets a receipt; the view is the proof.
  const stats = await withRetry(() => client.readContract({ address, functionName: "stats", args: [] }), "stats");
  console.log("stats", JSON.stringify(stats));
  console.log("\nnext: set a policy, then evaluate a request against it");
  console.log(`  node scripts/e2e_studionet.js ${address}`);
})().catch((e) => {
  console.error("FAILED:", e.message);
  if (e.cause) console.error(String(e.cause).slice(0, 800));
  process.exit(1);
});
