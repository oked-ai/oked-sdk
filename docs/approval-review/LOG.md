# Approval card changes

Every change the approval review loop made to a card's tier, text or layout, newest first.
Built from `changes.jsonl` by `node scripts/approval-review/record.mjs log`. Do not edit by hand.

## 2026-10-19 · tier · `Bash`

**Why:** The command splitter did not read backslash escapes. It ended a double-quoted grep pattern at an escaped quote and split on an escaped pipe. Thus the text git branch -D in a grep pattern became a separate step and the card was high_stakes. The command only reads files, so the tier is now safe. A real step after quoted text keeps its tier. The card was approved in 15 seconds.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | ⚪ safe (no card) |
| Title | Run command | Run command |
| Body | grep -n "npm_publish\\|describe(\"\\|^describe(" packages/sdk/test/describe-fields.test.ts \| head -20; grep -n "^describe(\\|git branch -D\\|mktemp" packages/sdk/test/classify.test.ts \| head -20; sed -n… | S=/private/tmp/claude-501/-Users-oren-Dev-OKed/c09c967e-e074-4d51-9dab-1b4f1dd76fdf/scratchpad; cd $S/sdk-wt && grep -n "npm_publish\\|describe(\"\\|^describe(" packages/sdk/test/describe-fields.test.t… |
| Footnote | Other steps in this command need no approval | · |
| Kind | shell_pipeline | shell_pipeline |

Seen 1× (✅ 1, ❌ 0) · Corpus: `2026-10-19-grep-escaped-pattern` · PR: https://github.com/oked-ai/oked-sdk/pull/78

## 2026-10-19 · text · `Bash`

**Why:** The target was ~/Dev/OKed/$SP/oked-sdk/], which is not a real folder. The card joined an unknown shell variable to the cwd and read a bracket from quoted data as the folder. Now the card shows no target when the folder is not known. The tier stays high_stakes, because a quoted argument to a node script can run as a command.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🔴 high stakes (Face ID) |
| Title | Publish package to npm | Publish package to npm |
| Target | ~/Dev/OKed/$SP/oked-sdk/] | · |
| Subline | tag latest | tag latest |
| Body | SP=/private/tmp/claude-501/-Users-oren-Dev-OKed/e08403ec-f24b-4277-9fff-0b9e09d49e93/scratchpad; cd $SP/oked-sdk && cat > $SP/probe.mjs <<'EOF'<br>const s = await import(process.argv[2]);<br>for (const c o… | SP=/private/tmp/claude-501/-Users-oren-Dev-OKed/e08403ec-f24b-4277-9fff-0b9e09d49e93/scratchpad; cd $SP/oked-sdk && cat > $SP/probe.mjs <<'EOF'<br>const s = await import(process.argv[2]);<br>for (const c o… |
| Footnote | Other steps in this command need no approval | Other steps in this command need no approval |
| Kind | npm_publish | npm_publish |

Seen 1× (✅ 1, ❌ 0) · Corpus: `2026-10-19-publish-in-quoted-probe-args` · PR: https://github.com/oked-ai/oked-sdk/pull/75

## 2026-10-19 · text · `Bash`

**Why:** The command merged PR #130 and then deleted the remote branch with git push --delete. The card did not show the branch delete, and the footnote said that other steps need no approval. A remote branch delete leaves the machine and is hard to undo, so it is now high_stakes with the title Delete remote Git branch. The merge card now lists it on the Also line.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🔴 high stakes (Face ID) |
| Title | Merge PR #130 in aml11/oked-app | Merge PR #130 in aml11/oked-app |
| Annotation | squash | squash |
| Subline | · | Also: Delete remote Git branch chore/bump-sdk-0.6.9 on origin |
| Body | gh pr merge 130 --repo aml11/oked-app --squash 2>&1 \| tail -2 | gh pr merge 130 --repo aml11/oked-app --squash 2>&1 \| tail -2<br>git push -q origin --delete chore/bump-sdk-0.6.9 2>&1 \| tail -1 |
| Footnote | Other steps in this command need no approval | Other steps in this command need no approval |
| Kind | git_pr_merge | git_pr_merge |

Seen 1× (✅ 1, ❌ 0) · Corpus: `2026-10-19-merge-then-delete-remote-branch` · PR: https://github.com/oked-ai/oked-sdk/pull/75

## 2026-10-19 · tier · `Bash`

**Why:** The command made _smoke.mjs with a heredoc, ran it, and then deleted it. That is a local change that you can undo, so the tier is warning. Two bugs caused the card. A node -p step earlier on the same line made the cat heredoc body count as code, so its text was scanned. Also, the heredoc strip removed the closing line, so all later steps were joined into one step. That second bug also hid real risks: after a data heredoc, echo a; rm -rf ~/important got warning and no card. Now those steps get high_stakes.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🟡 warning (logged, no card) |
| Title | Delete file | Create file |
| Target | _smoke.mjs | _smoke.mjs |
| Body | rm -f _smoke.mjs | SP=/private/tmp/claude-501/-Users-oren-Dev-OKed/e08403ec-f24b-4277-9fff-0b9e09d49e93/scratchpad; cd ~/Dev/OKed/oked-app && git fetch -q origin && git worktree add -q -b chore/bump-sdk-0.6.9… |
| Footnote | Other steps in this command need no approval | · |
| Kind | file_delete | file_create |

Seen 1× (✅ 1, ❌ 0) · Corpus: `2026-10-19-smoke-heredoc-after-node-p` · PR: https://github.com/oked-ai/oked-sdk/pull/75

## 2026-10-19 · tier · `Bash`

**Why:** The card said Push to now → titles. No push ran. The words git push were in a quoted --reason value of a node script. Quoted long-option values of a node script file are now text, so this card is not sent. A real git push in the same command keeps its tier.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | ⚪ safe (no card) |
| Title | Push | Run command |
| Target | now → titles | · |
| Body | \<br>node scripts/approval-review/record.mjs add --run $R --type text --diff $S/diff.json --shape "Bash · shell_pipeline · Run command" --reason "The title said Apply Prisma database migrations to prod.… | S=/private/tmp/claude-501/-Users-oren-Dev-OKed/a75756dd-3fa5-4a6f-9896-47c50f106b36/scratchpad; W=$S/sdk-2026-10-18T1713; cd $W && R=2026-10-18T1713; F1=packages/sdk/src/classify.ts,packages/sdk/src/… |
| Footnote | Other steps in this command need no approval | · |
| Kind | git_push | shell_pipeline |

Seen 1× (✅ 1, ❌ 0) · Corpus: `2026-10-19-node-script-reason-mentions-git-push` · PR: https://github.com/oked-ai/oked-sdk/pull/74

## 2026-10-19 · tier · `Bash`

**Why:** A node script command got a high-stakes card. The words that set the tier were in a quoted --reason value, and that value is only text. Quoted long-option values of a node script file are now text for the scan. Quoted positional arguments keep their tier, because the script can run them. The rmdir title now ignores quoted text too.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | ⚪ safe (no card) |
| Title | Run command | Run command |
| Subline | Also: Push now → titles | · |
| Body | \<br>node scripts/approval-review/record.mjs add --run 2026-10-18T1713 --type tier --diff /private/tmp/claude-501/-Users-oren-Dev-OKed/a75756dd-3fa5-4a6f-9896-47c50f106b36/scratchpad/diff.json --shape "… | S=/private/tmp/claude-501/-Users-oren-Dev-OKed/a75756dd-3fa5-4a6f-9896-47c50f106b36/scratchpad; W=$S/sdk-2026-10-18T1713; cd $W && R=2026-10-18T1713; F1=packages/sdk/src/classify.ts,packages/sdk/src/… |
| Footnote | Other steps in this command need no approval | · |
| Kind | unknown_bash | shell_pipeline |

Seen 1× (✅ 1, ❌ 0) · Corpus: `2026-10-19-node-script-reason-mentions-push` · PR: https://github.com/oked-ai/oked-sdk/pull/74

## 2026-10-18 · text · `Bash`

**Why:** The title said Apply Prisma database migrations to prod.example.com. That text was only a string in a node -e test script, and no migration ran. The npm publish, Prisma, npx deploy and git push titles now ignore quoted search text and inline script bodies.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | ⚪ safe (no card) |
| Title | Run command | Run command |
| Body | python3 -I - <<'EOF'<br>p='packages/sdk/src/classify.ts'<br>s=open(p).read()<br>old='''  const ghApiTier = classifyGhApiStage(bareStage);'''<br>assert s.count(old)==1<br>s=s.replace(old,'''  // `DATABASE_URL=<local… | cd /private/tmp/claude-501/-Users-oren-Dev-OKed--claude-worktrees-approval-quality-fatigue-a3223c/2645de95-3217-4731-b368-267a937e308b/scratchpad/review && python3 -I - <<'EOF'<br>npm run build --worksp… |
| Footnote | Other steps in this command need no approval | · |
| Kind | shell_pipeline | shell_pipeline |

Seen 1× (✅ 1, ❌ 0) · Corpus: `2026-10-18-node-e-string-mentions-prisma-deploy` · PR: https://github.com/oked-ai/oked-sdk/pull/73

## 2026-10-18 · tier · `Bash`

**Why:** rmdir of an empty temp folder from mktemp made a high-stakes card because of the 2>/dev/null redirect. A redirect is not a target now. rmdir removes only empty folders, so no data is lost and mkdir undoes it. rmdir is now warning. The title is now Delete empty folder.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🟡 warning (logged, no card) |
| Title | Delete file | Delete empty folder |
| Target | $EMPTYHOME | $EMPTYHOME |
| Body | rmdir "$EMPTYHOME" 2>/dev/null | · |
| Footnote | Other steps in this command need no approval | · |
| Kind | file_delete | file_delete |

Seen 1× (✅ 1, ❌ 0) · Corpus: `2026-10-18-rmdir-mktemp-home-with-redirect` · PR: https://github.com/oked-ai/oked-sdk/pull/73

## 2026-10-18 · tier · `Bash`

**Why:** A grep search for the words npm publish, piped to head, made a high-stakes publish card. The card timed out once. The command only reads files. Quoted text of a search command is now blank for the scan when the pipe goes to a reader, not to a shell. Text piped to sh, xargs or an interpreter keeps its tier.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | ⚪ safe (no card) |
| Title | Publish package to npm | Run command |
| Target | oked-sdk-repo@0.0.0 | · |
| Subline | tag latest | · |
| Body | cd ~/Dev/OKed/oked-sdk && grep -n "verify\\|workspace\\|npm publish" .github/workflows/publish.yml \| head; npm view @oked/verify versions --json 2>/dev/null \| tail -4; grep -n '"private"\\|"ve… | cd ~/Dev/OKed/oked-sdk && grep -n "verify\\|workspace\\|npm publish" .github/workflows/publish.yml \| head; npm view @oked/verify versions --json 2>/dev/null \| tail -4; grep -n '"private"\\|"ve… |
| Footnote | package.json is marked private, npm will refuse to publish it | · |
| Kind | npm_publish | shell_pipeline |

Seen 1× (✅ 1, ❌ 0) · Corpus: `2026-10-18-grep-pattern-mentions-npm-publish` · PR: https://github.com/oked-ai/oked-sdk/pull/73

## 2026-10-18 · tier · `Bash: pkill / killall / kill of a local dev server`

**Why:** You chose this on 2026-10-18. Stopping a local dev server (pkill -f "tsx src/main.ts", killall node, kill $(lsof -t -iTCP:3000), kill $(pgrep -f vite)) was high stakes with Face ID. It is now review: it asks, without Face ID. The card says Stop processes matching and names the pattern or port. A bare kill <pid> and other processes stay high stakes. 13 kill cards in 2 weeks, 4 timed out while the agent waited.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🔵 review (asks you) |
| Title | Kill processes | Stop processes matching |
| Target | · | tsx src/main.ts |
| Body | pkill -f "tsx src/main.ts" | pkill -f "tsx src/main.ts" |
| Footnote | Other steps in this command need no approval | Other steps in this command need no approval |
| Kind | kill_process | kill_process |

Corpus: `2026-10-18-pkill-dev-server` · PR: https://github.com/oked-ai/oked-sdk/pull/72

## 2026-10-18 · tier · `Bash: echo … | sh`

**Why:** Gap found during the review: text piped into sh or bash ran with no card, because no single step looked risky. It now needs review, and the card says Run text as a sh script.

| | Before | After |
|---|---|---|
| Tier | ⚪ safe (no card) | 🔵 review (asks you) |
| Title | Delete file recursively | Run text as a sh script |
| Target | build | · |
| Body | · | echo 'rm -rf build' \| sh |
| Kind | file_delete | shell_pipeline |

Corpus: `2026-10-18-pipe-text-to-shell` · PR: https://github.com/oked-ai/oked-sdk/pull/72

## 2026-10-18 · tier · `Bash: npx prisma migrate deploy (local DB)`

**Why:** Migrations to a local test database (localhost:5433) were high stakes, like a production deploy. With a local DATABASE_URL in the command they are now logged. Without one, or with any other host, they stay high stakes. Seen 3 times.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🟡 warning (logged, no card) |
| Title | Deploy via npx | Apply Prisma database migrations |
| Target | · | localhost:5433/oked_test_e2e |
| Body | npx prisma migrate deploy 2>&1 \| tail -2 | · |
| Footnote | Other steps in this command need no approval | · |
| Kind | npx_deploy | sql_migrate |

Corpus: `2026-10-18-prisma-migrate-local` · PR: https://github.com/oked-ai/oked-sdk/pull/72

## 2026-10-18 · tier · `mcp__Claude_Code_iOS_Simulator__control`

**Why:** Every iOS Simulator action asked you, even a screenshot. The simulator is a local test device. Looking is now safe, and taps, typing and local installs are logged, like clicks in the built-in browser. Seen 5 times in 2 weeks.

| | Before | After |
|---|---|---|
| Tier | 🔵 review (asks you) | ⚪ safe (no card) |
| Title | Control via Claude_Code_iOS_Simulator | Take an iOS Simulator screenshot |
| Kind | unknown_tool | simulator |

Corpus: `2026-10-18-simulator-screenshot` · PR: https://github.com/oked-ai/oked-sdk/pull/72

## 2026-10-18 · tier · `Bash: pkill -f scratchpad/…`

**Why:** Stopping a test database that ran from the session scratchpad was high stakes. You approved each one in seconds. pkill -f of a temp or scratchpad path is now logged, and the card names the pattern.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🟡 warning (logged, no card) |
| Title | Kill processes | Stop processes matching |
| Target | · | scratchpad/pg/start.mjs |
| Body | pkill -TERM -f "scratchpad/pg/start.mjs" | pkill -TERM -f "scratchpad/pg/start.mjs"; sleep 3; pgrep -f "scratchpad/pg" >/dev/null && echo "still running" \|\| echo "postgres stopped" |
| Footnote | Other steps in this command need no approval | · |
| Kind | kill_process | kill_process |

Corpus: `2026-10-18-pkill-scratchpad-postgres` · PR: https://github.com/oked-ai/oked-sdk/pull/72

## 2026-10-18 · tier · `Bash: rm -rf $W (temp path)`

**Why:** rm -rf $W was high stakes, though W was set to a scratchpad path one step before. A variable set to a temp path, a file an earlier step made, and a relative path after cd into a temp dir now count as temp. These deletes are logged, not asked.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🟡 warning (logged, no card) |
| Title | Delete file recursively | Delete file recursively |
| Target | $W | /private/tmp/claude-501/-Users-oren-Dev-OKed-oked-openshell/fbe57da5-4d01-4f78-b8f1-f1c3816d6f15/scratchpad/wt |
| Body | rm -rf $W | · |
| Footnote | Other steps in this command need no approval | · |
| Kind | file_delete | file_delete |

Corpus: `2026-10-18-rm-temp-worktree-var` · PR: https://github.com/oked-ai/oked-sdk/pull/72

## 2026-10-18 · tier · `Bash: git commit -m`

**Why:** A commit message that said curl -d made a high-stakes POST card. The quoted text of git, grep, echo and printf is not run, so it no longer sets the tier. grep "curl -X POST" had the same problem.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🟡 warning (logged, no card) |
| Title | POST request to URL | Git commit "Never write form body text as a key in the capture" |
| Body | sends | · |
| Footnote | Other steps in this command need no approval | · |
| Kind | http_post | git_commit |

Corpus: `2026-10-18-commit-message-mentions-curl` · PR: https://github.com/oked-ai/oked-sdk/pull/72

## 2026-10-18 · tier · `Bash: python3 - <<'EOF' (file edit)`

**Why:** A Python script that edited RELEASING.md was high stakes and said Publish package to npm, because the text it wrote mentioned npm publish. A script fed by a heredoc is code: words in it no longer set the tier or the title. Scripts like this made about 15 false high-stakes cards in 2 weeks (titles Run command, Run SQL statement, POST request to URL, Force push).

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🟡 warning (logged, no card) |
| Title | Publish package to npm | Create file |
| Target | · | packages/receipt-core/README.md |
| Subline | tag latest · public access | · |
| Body | python3 - <<'EOF'<br>p='RELEASING.md'; s=open(p).read()<br>old='''### Why the workflow publishes one package per job'''<br>new='''### Adding a new package<br><br>npm only lets you attach a Trusted Publisher to a pa… | python3 - <<'EOF'<br>cat > packages/receipt-core/README.md <<'EOF'<br># @oked/receipt-core<br><br>The format and the cryptography of OKed signed approval receipts, shared by the<br>OKed backend (which signs), `@oke… |
| Footnote | Other steps in this command need no approval | · |
| Kind | npm_publish | file_create |

Corpus: `2026-10-18-heredoc-script-mentions-npm-publish` · PR: https://github.com/oked-ai/oked-sdk/pull/72

## 2026-10-18 · text · `Bash: npx prisma migrate deploy`

**Why:** The card said Deploy via npx, which reads like a production deploy. The command applies database migrations to a local test database. Now the title says so and names the database host and name.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🔴 high stakes (Face ID) |
| Title | Deploy via npx | Apply Prisma database migrations |
| Target | · | localhost:5433/oked_test_e2e |
| Body | npx prisma migrate deploy 2>&1 \| tail -2 | npx prisma migrate deploy 2>&1 \| tail -2 |
| Footnote | Other steps in this command need no approval | Other steps in this command need no approval |
| Kind | npx_deploy | sql_migrate |

Corpus: `2026-10-18-prisma-migrate-local` · PR: https://github.com/oked-ai/oked-sdk/pull/70

## 2026-10-18 · text · `mcp__scheduled-tasks__create_scheduled_task`

**Why:** The card did not show the schedule or the prompt that Claude will run on its own. Now it shows the task name, the schedule, the prompt and a note that it runs without you.

| | Before | After |
|---|---|---|
| Tier | 🔵 review (asks you) | 🔵 review (asks you) |
| Title | Create scheduled task "OKed approval review" via scheduled-tasks | Create a scheduled task |
| Target | · | OKed approval review |
| Annotation | · | cron 0 */4 * * * |
| Body | · | Run one pass of the OKed approval review loop.<br><br>Context: OKed sends approval cards for AI agent actions to Oren's Telegram and the OKed iPhone app. Some cards have the wrong risk tier (noise that cau… |
| Footnote | · | Claude runs this prompt on its own on this schedule |
| Kind | mcp_create | schedule |

Corpus: `2026-10-18-scheduled-task-create` · PR: https://github.com/oked-ai/oked-sdk/pull/70

## 2026-10-18 · text · `mcp__Claude_Code_iOS_Simulator__control`

**Why:** Every iOS Simulator card said Control via Claude_Code_iOS_Simulator, so you could not tell a screenshot from a tap. Now the title names the action and the target shows where it taps. Seen 5 times.

| | Before | After |
|---|---|---|
| Tier | 🔵 review (asks you) | 🔵 review (asks you) |
| Title | Control via Claude_Code_iOS_Simulator | Tap in the iOS Simulator |
| Target | · | (201, 636) |
| Kind | unknown_tool | simulator |

Corpus: `2026-10-18-simulator-tap` · PR: https://github.com/oked-ai/oked-sdk/pull/70

## 2026-10-18 · text · `Bash: git branch -D`

**Why:** The card title was the raw command. Now it says Delete local Git branch, names the branch, and says when the branch is deleted even if not merged.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🔴 high stakes (Face ID) |
| Title | git branch -D claude/settings-sections | Delete local Git branch |
| Target | · | claude/settings-sections |
| Annotation | · | even if not merged |
| Body | git branch -D claude/settings-sections | git branch -D claude/settings-sections |
| Footnote | Other steps in this command need no approval | Other steps in this command need no approval |
| Kind | unknown_bash | git_branch_delete |

Corpus: `2026-10-18-git-branch-delete` · PR: https://github.com/oked-ai/oked-sdk/pull/70

## 2026-10-18 · text · `Bash: rm -f`

**Why:** An rm -f card said Delete file recursively, because any flag counted as recursive. The path showed as $D/answer-in-ste100.md, not the real file. Now only an r flag means recursive, and a variable set earlier in the command shows as its value. Seen on 13 delete cards in 2 weeks.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🔴 high stakes (Face ID) |
| Title | Delete file recursively | Delete file |
| Target | $D/answer-in-ste100.md | ~/.claude/projects/-Users-oren-Dev-OKed/memory/answer-in-ste100.md |
| Body | rm -f $D/answer-in-ste100.md | rm -f $D/answer-in-ste100.md |
| Footnote | Other steps in this command need no approval | Other steps in this command need no approval |
| Kind | file_delete | file_delete |

Corpus: `2026-10-18-rm-f-memory-file` · PR: https://github.com/oked-ai/oked-sdk/pull/70

## 2026-10-18 · layout · `Telegram card (all cards)`

**Why:** Code sat in a quote block, unknown cards showed a ⚙️ that meant nothing, the button under each card was a bare ⚙️, and the decided state took two lines in capitals. Now code shows in a code block, unknown cards have no icon, the button reads ⚙️ Rule, and the decided state is one line: ✅ Approved by Oren Dor · 🧾 receipt.

**Before**

```html
🔴 High stakes · irreversible

🌐 POST request to github.com
<code>/aml11/oked-app/pull/124</code>
<blockquote>state,mergeCommit</blockquote>

→ ✅ APPROVED by Oren Dor
→ 🧾 Receipt <code>rcpt_2ABPEFGC</code>
[ ⚙️ ]

🔵 <b>Review</b>

⚙️ <b>Frobnicate via acme</b>
[ ✅ Approve ][ ❌ Deny ][ ⚙️ ]
```

**After**

```html
🔴 High stakes · irreversible

🔀 Merge PR #124 in aml11/oked-app
<i>squash</i>
   Also: POST request to api.oked.ai /api/mobile/v1/auth/token
<pre>gh pr merge https://github.com/aml11/oked-app/pull/124 --squash 2&gt;&amp;1 | tail -1
curl -s -w " %{http_code}\n" -X POST https://api.oked.ai/api/mobile/v1/auth/token -H 'Content-Type: application/json' -d…</pre>
<i>Other steps in this command need no approval</i>

✅ Approved by Oren Dor · 🧾 <code>rcpt_2ABPEFGC</code>
[ ⚙️ Rule ]

🔵 <b>Review</b>

<b>Frobnicate via acme</b>
[ ✅ Approve ][ ❌ Deny ][ ⚙️ Rule ]
```

PR: https://github.com/aml11/oked-app/pull/126

## 2026-10-18 · tier · `Bash: railway up`

**Why:** Railway deploys were safe and the card only showed the raw command. A deploy changes a live service, so it is high stakes now, with the title Deploy to Railway.

| | Before | After |
|---|---|---|
| Tier | ⚪ safe (no card) | 🔴 high stakes (Face ID) |
| Title | railway up | Deploy to Railway |
| Kind | unknown_bash | deploy |

PR: https://github.com/oked-ai/oked-sdk/pull/69

## 2026-10-18 · tier · `Bash: gh pr comment`

**Why:** GitHub writes that other people see (PR and issue comments, reviews, closes, releases, workflow runs, secrets) were safe. They now ask for review, like an email send. gh api writes are high stakes, like a curl POST.

| | Before | After |
|---|---|---|
| Tier | ⚪ safe (no card) | 🔵 review (asks you) |
| Title | gh pr comment 12 --body 'LGTM' | Comment on PR #12 |
| Body | · | LGTM |
| Kind | unknown_bash | git_pr_write |

PR: https://github.com/oked-ai/oked-sdk/pull/69

## 2026-10-18 · tier · `Bash: gh pr merge`

**Why:** Found while checking the PR #124 card: gh pr merge was safe, so a merge alone never asked you. A merge changes the base branch for everyone and often deploys. gh deletes and archives are high stakes too.

| | Before | After |
|---|---|---|
| Tier | ⚪ safe (no card) | 🔴 high stakes (Face ID) |
| Title | gh pr merge 12 --squash | Merge PR #12 |
| Annotation | · | squash |
| Kind | unknown_bash | git_pr_merge |

PR: https://github.com/oked-ai/oked-sdk/pull/69

## 2026-10-18 · tier · `mcp__ccd_turn__wrap_up`

**Why:** The end-of-turn summary box only changes what the app shows. It matched no rule and fell to review. The old title read Wrap UP because every short word was capitalized.

| | Before | After |
|---|---|---|
| Tier | 🔵 review (asks you) | ⚪ safe (no card) |
| Title | Wrap UP via Claude desktop app | Show the end-of-turn summary in the Claude app |
| Body | · | The fix is in. Tests pass. Nothing is committed. |
| Kind | unknown_tool | session_housekeeping |

Corpus: `2026-10-18-wrap-up` · PR: https://github.com/oked-ai/oked-sdk/pull/69

## 2026-10-18 · tier · `mcp__ccd_turn__update_plan`

**Why:** Updating the task list under Claude's message only changes what the app shows. It asked for review because its name starts with update_.

| | Before | After |
|---|---|---|
| Tier | 🔵 review (asks you) | ⚪ safe (no card) |
| Title | Update plan via Claude desktop app | Update the task list in the Claude app |
| Kind | mcp_update | session_housekeeping |

Corpus: `2026-10-18-update-plan` · PR: https://github.com/oked-ai/oked-sdk/pull/69

## 2026-10-18 · text · `Bash`

**Why:** The card said POST to github.com with the quote state,mergeCommit. The command merged PR #124 and then sent a POST to api.oked.ai. The card built its title from bits of three steps. Now the title comes from the step that set the tier, and other risky steps are listed.

| | Before | After |
|---|---|---|
| Tier | 🔴 high stakes (Face ID) | 🔴 high stakes (Face ID) |
| Title | POST request to github.com | Merge PR #124 in aml11/oked-app |
| Target | /aml11/oked-app/pull/124 | · |
| Annotation | · | squash |
| Subline | · | Also: POST request to api.oked.ai /api/mobile/v1/auth/token |
| Body | state,mergeCommit | gh pr merge https://github.com/aml11/oked-app/pull/124 --squash 2>&1 \| tail -1<br>curl -s -w " %{http_code}\n" -X POST https://api.oked.ai/api/mobile/v1/auth/token -H 'Content-Type: application/json' -d… |
| Footnote | · | Other steps in this command need no approval |
| Kind | http_post | git_pr_merge |

Corpus: `2026-10-18-gh-merge-then-post` · PR: https://github.com/oked-ai/oked-sdk/pull/69
