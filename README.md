# PolicyGate

A policy in English in, a decision out, and the same decision every time.

Anyone can write "refunds under 500 are approved automatically" and nobody can check it without reading it again. That
is fine for a human reviewer and useless for an agent, an auditor or a counterparty: the answer changes with the
reader, and no one can point at the rule that produced it. PolicyGate splits the job in two. The model reads the
prose exactly once, when the policy is written, and the contract keeps what it read as `(field, op, value)` triples.
After that a request is checked against those triples with arithmetic, so the answer is reproducible, names the rule
that decided it, and costs no consensus round.

## The interesting part: consensus over the translation, none over the enforcement

Whether a rule set is faithful to the paragraph it came from is a judgement. Is "under 500" 499 or 500? Does "US
customers" mean the country or the currency? Two people reading the same policy disagree, and the text is untrusted
input written by the policy's own owner, so a single reader can be talked into a friendlier interpretation with no
way for the contract to notice. That is the one step that needs validators, and it goes through a comparative
equivalence principle:

```python
answer = gl.eq_principle.prompt_comparative(
    ask,
    principle="Both answers must produce exactly the same set of (field, op, value) triples. "
              "Ignore everything else they contain: rule ids, the order of the rules, field "
              "order, key order and any explanatory prose are free to differ. Numbers must be "
              "written as integers, 500 and never 500.0, because a float does not survive "
              "An extra rule, a missing rule, a renamed field, a different operator or a "
              "different value is not a match. An answer that is not a JSON object with a "
              "'rules' list is not a match.",
)
```

The principle compares a normalized set of triples, not prose. Two validators may number their rules differently,
order them differently and explain them differently; they must still agree that `amount <= 500` and
`country in ["US", "CA"]` are the policy, all of it and nothing else. An extra rule is as much a mismatch as a
missing one, because the rule that a validator invented is a permission the owner never wrote.

Everything after that is deterministic. `evaluate` walks the stored rules in order and the first rule that fails
decides the denial, so two nodes have nothing to disagree about. There is no model call, no round, and no room for a
policy to mean something different tomorrow than it meant when it was written.

## Why the state machine matters

- ownership is checked before the model is asked. A stranger's `set_policy` reverts without spending a consensus
  round and without being able to see a translation it does not own;
- a replacement is a version, not an overwrite in place: the same call by the same owner bumps `version`, swaps the
  rules and keeps the counters, so a decision can be attributed to the version that produced it;
- the model's answer is parsed strictly and *before* anything is stored. A missing `rules` list, a `rules` value that
  is not a list, an empty list, an unknown operator, a non-numeric limit on `<`, a boolean, an `in` without a list of
  strings, a field that is not a lowercase identifier or more than twenty rules raises. The temptation is to drop the
  bad rule and keep the good ones; that turns a broken translation into a policy that permits everything, which is
  exactly the failure this contract exists to prevent;
- a rule that names a field the request does not carry is a denial, not an exception. "The request forgot the amount"
  is not a reason to let it through, and it is not a reason to revert either: it is a decision with a named rule and a
  readable detail;
- a value of the wrong type is the same: a string where the policy compares numbers fails the rule instead of raising,
  so a malformed request cannot be used to crash past the check;
- the policy text is fenced in the prompt as untrusted data, and a policy that tries to instruct the model is encoded
  as content, never obeyed;
- `retire` exists so `active` means something: a retired policy refuses to evaluate at all rather than quietly
  starting to allow.

## Flow

1. `set_policy(policy_id, title, text)` — first call creates it with the caller as owner at version 1; a later call by
   the same owner replaces the text and rules and moves the version. Anyone else is refused.
2. `evaluate(policy_id, request_json)` — `request_json` is a JSON object of field to value. Returns
   `{"allowed": ..., "rule": ..., "field": ..., "detail": ...}`, where `rule` is the id of the first rule that failed
   (`""` when everything passes) and `detail` says what was compared with what. Increments the policy's allow or deny
   counter.
3. `retire(policy_id)` — owner only, switches the policy off.
4. `get_policy`, `is_active`, `list_policies(offset, limit)`, `policy_count`, `stats`.

Limits are deliberate: 2000 characters of policy text, 20 rules, 4000 characters of request, 50 policies per page.
Enough for a real policy, small enough that a validator reading the text cannot drift.

## Contract surface

| kind | name |
| --- | --- |
| write | `set_policy`, `evaluate`, `retire` |
| view | `get_policy`, `is_active`, `list_policies`, `policy_count`, `stats` |

`evaluate` is a write only because it records the decision; it reads no external data and calls no model.

## Live

- Contract (Studio Network): `0x3a44f32b7D825a21352ff8C20D6CceD0337491f9`
- Explorer: https://explorer-studio.genlayer.com/address/0x3a44f32b7D825a21352ff8C20D6CceD0337491f9

## One policy, three requests on the live contract

The policy below was written in English and translated by the validator set in a single 102 second round. It is
the whole policy: no hidden default, no field the owner did not write.

> Customer refunds are approved automatically when the refund amount is at most 500 USDC and the customer is in
> the US or Canada. A refund above that limit, or from anywhere else, needs a human to approve it.

What came back, and stayed:

```json
[{"field":"amount","id":"r1","op":"<=","value":500},{"field":"country","id":"r2","op":"in","value":["US","CA"]}]
```

| what | transaction |
| --- | --- |
| deploy `0x3a44f32b7D825a21352ff8C20D6CceD0337491f9` | `0xcfd3499a50e8f2355c2ca1fa14e5a40996f1b3993629aa21a31688fb05b4fb15` |
| `set_policy` — the translation round, 102s, version 1 | `0x57581c02228eeff713e89b39c8c1e94c1e35b4f235b7f51a172a16831e7c9cff` |
| `evaluate {amount:240, country:"US"}` → allowed, no model call | `0xb1579fc5fa18c68b2ecebbb5bf886bed35a102275dd780d3848ef1afcdee9453` |
| `evaluate {amount:900, country:"US"}` → denied on `r1` | `0x34d26acd6b9f9fcb630bf3862ad453095f91d78f3a30b55f4f809559805b2137` |
| `evaluate {amount:120, country:"DE"}` → denied on `r2` | `0x3d687d84f841eab88d20f64f804a9c5065240e4b56f4618a38d44c67809e12f7` |
| a stranger tries to replace the policy with "everything is approved" — refused | `0x0034ed6b27be326f2352a99329a07fa90beaf61e8da962fc479507d8b857847b` |

After the run `stats()` reports `{"policies":1,"rules":2,"evaluations":3,"allows":1,"denies":2,"active":1}`, and the
policy read back after the stranger's attempt is still the two rules the owner wrote. The three evaluations cost
40s, 39s and one more round of the same order — the chain's block time, not a model round: no validator reads
anything when a request is judged.

## Tests

```bash
python -m pytest tests/direct -q     # 38 passed
```

Direct mode: the model is mocked, the contract is not, so every test drives the parser, the ownership checks and the
evaluator the validators run.

- `TestCreate` — first call creates the policy with the caller as owner at version 1, rules stored canonically with
  positional ids, the prompt actually carries the untrusted-data warning and the policy text, and the title, text,
  id and 2000 character limits are enforced;
- `TestOwnership` — the owner's replacement keeps one policy and moves the version, a stranger's replacement reverts
  with `only the owner replaces this policy` *before* the model is consulted (the test registers no mock), a stranger
  can still create a policy of their own, and only the owner retires;
- `TestStrictParsing` — a missing `rules` key, rules that are not a list, an empty list, an unknown operator, a
  non-numeric limit, a boolean, `in` without a list of strings, a field that is not a lowercase identifier, a rule
  without an operator, twenty-one rules and a non-JSON answer each revert and leave nothing stored; a rejected
  translation does not burn a version, so the next good call is version 2;
- `TestEvaluate` — the allowed path with its exact `{"allowed": True, "rule": "", ...}` shape, the first failing rule
  deciding the denial, the boundary value inside `<=`, a missing field denied rather than raised, `in`, `==`, `!=`,
  a wrong-typed value denied, a request that is not a JSON object refused, and an unknown policy refused;
- `TestCounters` — allows and denies counted per policy, `stats()` aggregating across policies, counters surviving a
  replacement;
- `TestNoModelAtEvaluation` — evaluation still works with every mock cleared (any model call would raise
  `MockNotFoundError`), and a poisoned wildcard mock that would deny everything is never matched: the same request
  returns the same answer twice and the mock hit set stays empty;
- `TestViews` — paging, the 50 row clamp, `is_active` agreeing with `get_policy`, and unknown ids refused rather than
  read as empty.

## Deploy and run

```bash
npm install
node scripts/deploy_studionet.js
node scripts/e2e_studionet.js <contractAddress>
```

`deploy_studionet.js` deploys with genlayer-js against Studio Network, prints `deploy tx <hash>` and
`contract <address>`, then reads `stats()` back — a deploy whose `__init__` reverted still gets a receipt, so the view
is the proof.

`e2e_studionet.js` takes the address and writes a real refund policy in English, evaluates a request that is inside
every rule, one that breaks the amount rule and one that breaks the country rule, then has a second account try to
replace the policy and checks the refusal through
`receipt.consensus_data.leader_receipt[0].execution_result === "ERROR"`. It finishes by printing the policy and
`stats()`. The three evaluations are not consensus rounds; only the translation is.

## Layout

```
contracts/policy_gate.py       the contract
tests/direct/                  direct-mode suite
scripts/deploy_studionet.js    deploy with genlayer-js, no CLI
scripts/e2e_studionet.js       the policy, two decisions and a refused replacement
```
