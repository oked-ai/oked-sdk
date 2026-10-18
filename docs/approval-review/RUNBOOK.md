# Approval review loop: one run

This runbook is what each scheduled run follows. It is a plain doc so you can
read and change it in a PR. The gate (`scripts/approval-review/gate.mjs`)
blocks a run from changing it on its own.

Goal: every card that reaches a person must be worth a person's attention,
and must tell the whole action in a few lines. Too many cards cause approval
fatigue. A card that hides the risky step is worse than no card.

Write all text (PR bodies, commit messages, record reasons) in ASD-STE100
Simplified Technical English. Do not use em dashes.

## 0. Set up

1. Work in a fresh worktree of `oked-sdk` off `origin/main`, on the branch
   `approval-review/<run>`. `<run>` is the UTC time, for example
   `2026-10-19T0800`. Never work in the user's own checkouts.
2. `npm ci`, then `npm run build --workspace=@oked/sdk`.
3. Stop if an earlier run's PR is still open:
   `gh pr list --search "head:approval-review/" --state open`. A person must
   look at it first. If it is older than 24 hours, send one push notification
   that names it.

Keep scratch files (`fetched.json`, `diff.json`) in the scratchpad, never in
the repo. They hold raw tool input.

## 1. Fetch

```bash
node scripts/approval-review/fetch.mjs --out <scratch>/fetched.json
```

It prints one line per card shape: times shown, ✅ approved, ❌ denied,
⏱ timed out, decided by a rule, median seconds to decide, and the tiers. If
there are no cards, save the cursor (step 7) and stop.

```bash
node scripts/approval-review/diff.mjs <scratch>/fetched.json
```

This shows cards that `main` already changes (fixed but not released yet).
Do not fix those again.

## 2. Review each shape

Read the items of each shape in `fetched.json` (`toolInput`, `fields`,
`tier`, `decision`, `decidedVia`). Write a verdict per shape: OK, wrong tier,
weak text, or weak layout. A card can have more than one problem. Also look
across all cards for layout problems.

### Tier

- Does it leave the machine (network write, message, publish, push)? Then at
  least `review`.
- Is it hard or impossible to undo (delete, merge, deploy, pay, send)? Then
  `high_stakes`.
- Is it a reversible local change in the project? Then `warning` (logged, no
  card).
- Is it session housekeeping only (plans, chapters, panes, wrap-up)? Then
  `safe`.
- Were there denies? A deny is data, not a verdict. Look at each one: the
  input, the deny reason if any, and what the agent did next. Decide if the
  deny was about the tier or only about that one call. Write the finding in
  the record reason.
- Fast 100% approvals are a fatigue signal. A fatigue signal alone never
  lowers a tier. A rule above must also allow it.
- Check the opposite direction too: risky steps that the classifier marks
  `safe`. (The PR #124 card showed that `gh pr merge` was safe.)

### Text

- Does the title say verb + object + place in about 60 characters or fewer?
- Does the title name the step that set the tier?
- Is every fact true (method, host, file, recipient)?
- Does the target name the exact resource (repo and PR, file, URL path,
  recipient)?
- Does the body show what the person needs to decide (diff, SQL, payload),
  and no noise?
- Can the person decide from the card alone, with no terminal?
- Is the wording plain, with correct casing and no internal names?

### Layout (the card structure)

- Is each piece of data in the right slot? Title is the short "what". Target
  is the "where". Code goes in a code block. Details go in the footnote.
- Does the tier line say the tier in words a person understands?
- Does each emoji add meaning? Remove emojis that only decorate or repeat.
- Are there empty lines, repeated words, or a quote block that holds code?
- Is the decided state short and easy to scan?
- Does the same card read well in Telegram and in the iOS app?

Where things live:

- Tier: `packages/sdk/src/classify.ts`.
- Text and data slots: `packages/sdk/src/describe.ts` (`Rendered`,
  `describeFields`). New kinds go in `packages/sdk/src/kinds.ts`.
- Telegram card: `oked-app` `backend/src/telegram/telegram.service.ts`
  (`renderApprovalText`, `decidedLine`, `TIER_LABEL`, `KIND_EMOJI`, the
  buttons). Use a fresh `oked-app` worktree off `origin/main` in the
  scratchpad. Its renderer test is `backend/test/telegram-render.test.ts`.
- iOS card: `oked-ios`. Open a PR only. Never merge it.

## 3. Fix

For each shape you fix:

1. Change the code. Keep the style of the code around it.
2. Add a unit test next to the similar tests in
   `packages/sdk/test/classify.test.ts` or
   `packages/sdk/test/describe-fields.test.ts`.
3. `npm run build --workspace=@oked/sdk`.
4. Pin one real card of the shape in the corpus (it is sanitized first):
   `node scripts/approval-review/corpus.mjs add --from <scratch>/fetched.json --request <id> --name <slug>`
5. `node scripts/approval-review/diff.mjs <scratch>/fetched.json --out <scratch>/diff.json`
   and check that the after column is what you want.

Do not change `scripts/approval-review/`, `docs/approval-review/RUNBOOK.md`,
`packages/claude-code` or `packages/receipt-core` in a run. The gate blocks
those, so the PR waits for a person. Do not create or change OKed rules.

## 4. Record

One entry per fixed shape:

```bash
node scripts/approval-review/record.mjs add --run <run> --type tier|text \
  --diff <scratch>/diff.json --shape "<shape from diff.json>" \
  --reason "<why, in STE>" --corpus <corpus id> --files <changed files>
```

For a layout change, render a few sample cards with the old and the new
renderer. Record them with `--type layout --before '{"telegram":"..."}'
--after '{"telegram":"..."}' --subject "Telegram card (all cards)"`.

Then rebuild the log: `node scripts/approval-review/record.mjs log`.

## 5. PR

1. Commit on `approval-review/<run>`, push, and open a PR to `main`. The PR
   body lists each change: the shape, why, and the before and after tier and
   title. End it with the attribution line.
2. `node scripts/approval-review/record.mjs pr <url> --run <run>`, rebuild
   the log, then commit and push again.
3. For a backend layout change, open a second PR in `oked-app` the same way.

## 6. Gate, merge, release

```bash
node scripts/approval-review/gate.mjs --fetched <scratch>/fetched.json
node scripts/approval-review/gate.mjs --backend <oked-app worktree>   # only with a backend PR
```

- **PASS:** merge with `gh pr merge <n> --squash --delete-branch`. Merge the
  backend PR the same way (a merge to `oked-app` `main` deploys). Then run the
  `oked-release` skill with a `patch` bump. It publishes the SDK and bumps the
  backend pin, so the new tiers reach the phone.
- **BLOCKED:** leave the PRs open. Send one push notification: "Approval
  review: N changes wait for you." plus the gate reasons.

The merge, the publish and the deploy each ask for approval on Oren's phone
through OKed. That card is the last human check. Do not try to avoid it.

## 7. Finish

1. Write this run's rows to the "Approval fixes" artifact page database.
   `node scripts/approval-review/record.mjs rows --run <run>` gives the rows.
   Write each row with the `ArtifactData` tool to the collection `changes`,
   with `doc_id` = the row `id`, in one `batch`. The page URL is
   `artifactUrl` in `~/.oked/review-state.json`.
2. Save the cursor:
   `node scripts/approval-review/fetch.mjs --advance <until from fetched.json>`.
   Save it only when the run ends (PASS or BLOCKED), so a failed run reads
   the same cards again.
3. If anything changed, send one push notification: "Approval review: N
   cards fixed (tier X, text Y, layout Z)." plus the artifact link.
