# Approval card changes

Every change the approval review loop made to a card's tier, text or layout, newest first.
Built from `changes.jsonl` by `node scripts/approval-review/record.mjs log`. Do not edit by hand.

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
