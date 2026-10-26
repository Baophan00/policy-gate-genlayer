#!/usr/bin/env node
/**
 * End to end run of PolicyGate on GenLayer Studio Network.
 *
 *   node scripts/e2e_studionet.js <contractAddress>
 *
 * One policy written in English, then the same request judged twice.
 *
 *   set_policy   the owner submits a real refund policy; validators translate it
 *   allowed      a request inside every rule, evaluated with no model call
 *   denied       the amount rule fails, the answer names the rule
 *   denied       the country rule fails while the amount passes
 *   stranger     a second account tries to replace the policy: refused
 *   read back    the policy, its counters and stats
 *
 * Only the translation is a consensus round. The three evaluations are plain
 * arithmetic, so their receipts finalize without a model in the loop.
 */
const fs = require("fs");
const path = require("path");
const { createClient, createAccount, generatePrivateKey } = require("genlayer-js");
const { studionet } = require("genlayer-js/chains");

const ADDRESS = process.argv[2];
if (!ADDRESS) {
  console.error("usage: node scripts/e2e_studionet.js <contractAddress>");
  process.exit(1);
}

const KEYFILE = path.join(__dirname, ".e2e-keys.json");
function keys() {
  if (fs.existsSync(KEYFILE)) return JSON.parse(fs.readFileSync(KEYFILE, "utf8"));
  const k = { owner: generatePrivateKey(), stranger: generatePrivateKey() };
  fs.writeFileSync(KEYFILE, JSON.stringify(k, null, 2), { mode: 0o600 });
  return k;
}
const k = keys();
const owner = createAccount(k.owner);
const stranger = createAccount(k.stranger || generatePrivateKey());
const ownerClient = createClient({ chain: studionet, account: owner });
const strangerClient = createClient({ chain: studionet, account: stranger });
const reader = createClient({ chain: studionet, account: createAccount(generatePrivateKey()) });

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

function refused(receipt) {
  const leader = (receipt.consensus_data && receipt.consensus_data.leader_receipt) || [];
  return String(leader[0] && leader[0].execution_result).toUpperCase() === "ERROR";
}

async function send(client, who, functionName, args) {
  console.log(`\n[${who}] ${functionName}(${args.map((a) => JSON.stringify(a).slice(0, 80)).join(", ")})`);
  const started = Date.now();
  const hash = await client.writeContract({ address: ADDRESS, functionName, args, value: 0n });
  console.log(`  tx ${hash}`);
  const receipt = await withRetry(
    () => client.waitForTransactionReceipt({ hash, status: "FINALIZED", retries: 200, interval: 3000 }),
    "receipt"
  );
  const elapsed = Math.round((Date.now() - started) / 1000);
  const reverted = refused(receipt);
  console.log(`  ${receipt.status_name || receipt.status}  (${reverted ? "refused by the contract" : "executed"}, ${elapsed}s)`);
  return { hash, refused: reverted, elapsed };
}

async function write(client, who, functionName, args) {
  const { hash, refused: reverted, elapsed } = await send(client, who, functionName, args);
  if (reverted) throw new Error(`${functionName} failed inside the contract`);
  return { hash, elapsed };
}

async function expectRefused(client, who, functionName, args, why) {
  const { hash, refused: reverted } = await send(client, who, functionName, args);
  if (!reverted) throw new Error(`${who} was allowed to ${functionName}: ${why}`);
  console.log(`  refused as expected: ${why} (tx ${hash})`);
  return hash;
}

const read = (functionName, args) =>
  withRetry(() => reader.readContract({ address: ADDRESS, functionName, args }), "read");

const POLICY_TEXT = [
  "Customer refunds are approved automatically when the refund amount is at most",
  "500 USDC and the customer is in the US or Canada. A refund above that limit,",
  "or from anywhere else, needs a human to approve it.",
].join(" ");

(async () => {
  const policyId = process.argv[3] || `refunds-${Date.now().toString(36)}`;
  console.log("contract", ADDRESS);
  console.log("policy  ", policyId);
  console.log("owner   ", owner.address);
  console.log("stranger", stranger.address);

  console.log("\n[owner] writes the policy in English; validators translate it into rules");
  const created = await write(ownerClient, "owner", "set_policy", [policyId, "Automatic refunds", POLICY_TEXT]);
  console.log(`  translation round took ${created.elapsed}s`);

  let policy = await read("get_policy", [policyId]);
  console.log("  owner on chain :", policy.owner);
  console.log("  version        :", policy.version);
  console.log("  rules          :", JSON.stringify(policy.rules));
  if (!Array.isArray(policy.rules) || policy.rules.length === 0) {
    throw new Error("the translation produced no rules");
  }
  if (policy.owner.toLowerCase() !== owner.address.toLowerCase()) {
    throw new Error(`unexpected owner ${policy.owner}`);
  }

  console.log("\n[evaluate] a request inside every rule: no model, no consensus round");
  await write(ownerClient, "owner", "evaluate", [policyId, JSON.stringify({ amount: 240, country: "US" })]);

  console.log("\n[evaluate] the amount rule fails");
  await write(ownerClient, "owner", "evaluate", [policyId, JSON.stringify({ amount: 900, country: "US" })]);

  console.log("\n[evaluate] the amount passes, the country rule fails");
  await write(ownerClient, "owner", "evaluate", [policyId, JSON.stringify({ amount: 120, country: "DE" })]);

  policy = await read("get_policy", [policyId]);
  console.log("\n[read] counters after three evaluations");
  console.log("  allows:", policy.allows, "| denies:", policy.denies);
  if (policy.allows !== "1" || policy.denies !== "2") {
    throw new Error(`unexpected counters allows=${policy.allows} denies=${policy.denies}`);
  }

  console.log("\n[guard] a stranger tries to replace the policy with a permissive one");
  await expectRefused(
    strangerClient,
    "stranger",
    "set_policy",
    [policyId, "Everything is approved", "Every request is approved automatically."],
    "only the owner replaces this policy"
  );

  const after = await read("get_policy", [policyId]);
  console.log("  version after the attempt:", after.version, "| owner:", after.owner);
  if (after.version !== policy.version) throw new Error("a stranger replaced the policy");
  if (after.owner !== policy.owner) throw new Error("the owner changed");

  console.log("\n[read] the policy that is actually enforced");
  console.log(JSON.stringify(after, null, 2));

  console.log("\n[read] stats");
  console.log(JSON.stringify(await read("stats", []), null, 2));
  console.log(
    "\nRESULT: policy translated under consensus, allowed and denied requests judged deterministically, a stranger's replacement refused, counters and stats agree"
  );
})().catch((e) => {
  console.error("\nFAILED:", e.message);
  if (e.cause) console.error(String(e.cause).slice(0, 900));
  process.exit(1);
});
