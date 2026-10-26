import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describeFields, describe as describeOne } from "../src/describe.js";

describe("Bash — SQL via host language", () => {
  it("node heredoc with CREATE TABLE → title 'Create table', target 'users'", () => {
    const cmd = `node - <<'EOF'
const db = require('better-sqlite3')('demo.db');
db.exec(\`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY)\`);
EOF`;
    const f = describeFields("Bash", { command: cmd });
    assert.equal(f!.Title, "Create SQL table");
    assert.equal(f!.Target, "users");
  });

  it("node heredoc with DROP TABLE wins over CREATE TABLE", () => {
    const cmd = `node - <<'EOF'
db.exec('CREATE TABLE foo (id INT)');
db.exec('DROP TABLE bar');
EOF`;
    const f = describeFields("Bash", { command: cmd });
    assert.equal(f!.Title, "Drop table");
    assert.equal(f!.Target, "bar");
  });

  it("node heredoc INSERT only → 'Insert rows into' + target", () => {
    const cmd = `node - <<'EOF'
db.exec(\`INSERT INTO users (name) VALUES ('Alice')\`);
EOF`;
    const f = describeFields("Bash", { command: cmd });
    assert.equal(f!.Title, "Insert rows into");
    assert.equal(f!.Target, "users");
  });

  it("python -c DELETE no WHERE → 'Delete ALL rows from' + target", () => {
    const f = describeFields("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('x').execute('DELETE FROM users')"`,
    });
    assert.equal(f!.Title, "Delete ALL rows from");
    assert.equal(f!.Target, "users");
  });

  it("node -e with CREATE TABLE", () => {
    const f = describeFields("Bash", {
      command: `node -e "require('better-sqlite3')('x').exec('CREATE TABLE t (id INT)')"`,
    });
    assert.equal(f!.Title, "Create SQL table");
    assert.equal(f!.Target, "t");
  });

  it("node -e DROP TABLE with arrow function in body is not misread as shell redirect", () => {
    const cmd = `cd /home/ubuntu/.openclaw/workspace && node -e "const Database = require('better-sqlite3'); const db = new Database('random_db.sqlite'); db.exec('DROP TABLE IF EXISTS space_missions;'); console.log('Table dropped.'); const tables = db.prepare(\\"SELECT name FROM sqlite_master WHERE type='table'\\").all(); console.log('Remaining tables:', tables.length ? tables.map(t => t.name) : 'none'); db.close();"`;
    const f = describeFields("Bash", { command: cmd });
    assert.equal(f!.Title, "Drop table");
    assert.equal(f!.Target, "space_missions");
  });
});

describe("Bash — semantic rerendering", () => {
  it("rm -rf path → title 'Delete file recursively', target = path", () => {
    const f = describeFields("Bash", { command: "rm -rf node_modules" });
    assert.equal(f!.Title, "Delete file recursively");
    assert.equal(f!.Target, "node_modules");
    assert.equal(f!.Body, undefined);
  });

  it("trash <path> → title 'Delete file', target = path", () => {
    const f = describeFields("Bash", { command: "trash /home/ubuntu/.openclaw/workspace/note.txt" });
    assert.equal(f!.Title, "Delete file");
    assert.match(f!.Target, /note\.txt/);
  });

  it("rm <path>.sql → 'Delete SQL file' with .sql target", () => {
    const f = describeFields("Bash", { command: "rm /home/ubuntu/.openclaw/workspace/employees_table.sql" });
    assert.equal(f!.Title, "Delete SQL file");
    assert.equal(f!.Kind, "file_delete");
    assert.match(f!.Target!, /employees_table\.sql/);
  });

  it("rm -rf <path>.sql → still 'Delete file recursively' (recursive flag wins)", () => {
    const f = describeFields("Bash", { command: "rm -rf /tmp/schema.sql" });
    assert.equal(f!.Title, "Delete file recursively");
  });

  it("DROP TABLE → title 'Drop table', target = table name", () => {
    const f = describeFields("Bash", { command: 'psql -c "DROP TABLE sessions"' });
    assert.equal(f!.Title, "Drop table");
    assert.equal(f!.Target, "sessions");
  });

  it("multiple DROP TABLEs → 'Drop N tables', target lists all", () => {
    const f = describeFields("Bash", {
      command: `sqlite3 data.db "DROP TABLE books; DROP TABLE orders; DROP TABLE customers;"`,
    });
    assert.equal(f!.Title, "Drop 3 tables");
    assert.ok(f!.Target!.includes("books"));
    assert.ok(f!.Target!.includes("orders"));
    assert.ok(f!.Target!.includes("customers"));
    assert.equal(f!.Target!.split("\n").length, 3);
  });

  it("multiple DELETEs without WHERE → 'Delete ALL rows from N tables'", () => {
    const f = describeFields("Bash", {
      command: `sqlite3 data.db "DELETE FROM books; DELETE FROM orders;"`,
    });
    assert.equal(f!.Title, "Delete ALL rows from 2 tables");
    assert.ok(f!.Target!.includes("books"));
    assert.ok(f!.Target!.includes("orders"));
  });

  it("describe() returns just title for multi-table drop", () => {
    assert.equal(
      describeOne("Bash", { command: `sqlite3 db "DROP TABLE a; DROP TABLE b;"` }),
      "Drop 2 tables"
    );
  });

  it("DELETE FROM with WHERE → title 'Delete rows from', target = table", () => {
    const f = describeFields("Bash", {
      command: `psql -c "DELETE FROM users WHERE created_at < '2024-01-01'"`,
    });
    assert.equal(f!.Title, "Delete rows from");
    assert.equal(f!.Target, "users");
    assert.ok(f!.Body && f!.Body.includes("WHERE"));
  });

  it("a quoted connection string before -c stays out of the body", () => {
    const f = describeFields("Bash", {
      command: `psql "$DATABASE_URL" -c "DELETE FROM users WHERE last_login < now() - interval '2 years'"`,
    });
    assert.equal(f!.Title, "Delete rows from");
    assert.equal(f!.Target, "users");
    assert.equal(f!.Body, "DELETE FROM users WHERE last_login < now() - interval '2 years'");
  });

  it("mysql -e after a quoted password keeps the password out of the body", () => {
    const f = describeFields("Bash", {
      command: `mysql -u root -p"s3cret" shop -e "DELETE FROM orders WHERE status='void'"`,
    });
    assert.equal(f!.Target, "orders");
    assert.ok(!f!.Body?.includes("s3cret"), `body leaked the password: ${f!.Body}`);
  });

  it("psql -e (echo queries) is not taken as the statement", () => {
    const f = describeFields("Bash", { command: `psql -e -c "DROP TABLE sessions"` });
    assert.equal(f!.Title, "Drop table");
    assert.equal(f!.Target, "sessions");
  });

  it("DELETE without WHERE → 'Delete ALL rows from'", () => {
    const f = describeFields("Bash", { command: 'psql -c "DELETE FROM users"' });
    assert.equal(f!.Title, "Delete ALL rows from");
    assert.equal(f!.Target, "users");
  });

  it("UPDATE with WHERE → 'Update rows in'", () => {
    const f = describeFields("Bash", {
      command: `psql -c "UPDATE users SET role='admin' WHERE id=1"`,
    });
    assert.equal(f!.Title, "Update rows in");
    assert.equal(f!.Target, "users");
  });

  it("UPDATE without WHERE → flag 'EVERY row'", () => {
    const f = describeFields("Bash", { command: `psql -c "UPDATE users SET role='admin'"` });
    assert.equal(f!.Title, "Update EVERY row in");
    assert.equal(f!.Target, "users");
  });

  it("git push --force → title 'Force push', target = 'branch → remote'", () => {
    const f = describeFields("Bash", { command: "git push --force origin main" });
    assert.equal(f!.Title, "Force push");
    assert.equal(f!.Target, "main → origin");
  });

  it("git push → title 'Push', target = 'branch → remote'", () => {
    const f = describeFields("Bash", { command: "git push origin main" });
    assert.equal(f!.Title, "Push");
    assert.equal(f!.Target, "main → origin");
  });

  it("curl POST → 'POST request to <host>'", () => {
    const f = describeFields("Bash", { command: "curl -X POST https://api.stripe.com/v1/charges -d foo=bar" });
    assert.equal(f!.Title, "POST request to api.stripe.com");
  });

  it("multi-step pipeline → 'Run command' + body has full pipeline", () => {
    const f = describeFields("Bash", { command: "cd backend && npm install && npm run build" });
    assert.equal(f!.Title, "Run command");
    assert.ok(f!.Body && f!.Body.includes("&&"));
  });

  it("short safe form passes through unchanged", () => {
    const f = describeFields("Bash", { command: "ls -la" });
    assert.equal(f!.Title, "ls -la");
    assert.equal(f!.Body, undefined);
  });
});

describe("Bash — multi-file rm", () => {
  it("rm file1 file2 → 'Delete 2 files', target lists both", () => {
    const f = describeFields("Bash", { command: "rm file1.txt file2.txt" });
    assert.equal(f!.Title, "Delete 2 files");
    assert.ok(f!.Target!.includes("file1.txt"));
    assert.ok(f!.Target!.includes("file2.txt"));
    assert.equal(f!.Target!.split("\n").length, 2);
    assert.equal(f!.Annotation, undefined);
  });

  it("rm -rf dir1 dir2 dir3 → 'Delete 3 files recursively'", () => {
    const f = describeFields("Bash", { command: "rm -rf dir1 dir2 dir3" });
    assert.equal(f!.Title, "Delete 3 files recursively");
    assert.equal(f!.Target!.split("\n").length, 3);
  });

  it("rm inside if/else compound → only the real target, not shell tokens", () => {
    // Regression: parseRmTargets used to sweep the trailing `;`/`else`/`echo`/
    // `fi` (and the echo's quoted text) in as "files", rendering a bogus
    // "Delete 7 files recursively" with an unreadable body.
    const f = describeFields("Bash", {
      command: `if [ -f "$PROFILE" ]; then rm -rf "$PROFILE"; else echo "no existing profile (clean)"; fi`,
    });
    assert.equal(f!.Title, "Delete file recursively");
    assert.equal(f!.Target, "$PROFILE");
  });

  it("rm target list stops at a redirect (2>/dev/null is not a file)", () => {
    const f = describeFields("Bash", { command: `rm -rf "$P" 2>/dev/null` });
    assert.equal(f!.Title, "Delete file recursively");
    assert.equal(f!.Target, "$P");
  });

  it("rm followed by a piped command lists only the rm target", () => {
    const f = describeFields("Bash", { command: "rm -rf build && echo done" });
    assert.equal(f!.Title, "Delete file recursively");
    assert.equal(f!.Target, "build");
  });

  it("compound command headlines the POST, not an incidental file redirect", () => {
    // Regression: `node … > /tmp/x.log … && curl -X POST …` was titled
    // "Create file" even though the prompt is driven by the POST.
    const f = describeFields("Bash", {
      command: "node index.js > /tmp/oked-test.log 2>&1 &\ncurl -s -X POST http://localhost:3999/api/draft -d '{}'",
    });
    assert.equal(f!.Title, "POST request to localhost");
  });

  it("curl POST shows the endpoint path as target and the payload as body", () => {
    const f = describeFields("Bash", {
      command: `SP=/private/tmp/claude-501/some/long/scratchpad; (curl -s -N -X POST http://localhost:3000/api/v1/approve -H "Content-Type: application/json" -d '{"description":"Force-push to main"}' > $SP/out 2>&1 &)`,
    });
    assert.equal(f!.Title, "POST request to localhost");
    assert.equal(f!.Target, "/api/v1/approve");
    assert.equal(f!.Body, '{"description":"Force-push to main"}');
  });

  it("every -d value is in the body, joined with & as curl sends it", () => {
    const f = describeFields("Bash", {
      command: "curl -X POST https://api.stripe.com/v1/refunds -u $STRIPE_KEY: -d charge=ch_3PqL2x -d amount=4900",
    });
    assert.equal(f!.Target, "/v1/refunds");
    assert.equal(f!.Body, "charge=ch_3PqL2x&amount=4900");
  });

  it("each -F form part gets its own line", () => {
    const f = describeFields("Bash", {
      command: `curl https://api.example.com/upload -F "name=report" -F "file=@q3.pdf"`,
    });
    assert.equal(f!.Body, "name=report\nfile=@q3.pdf");
  });

  it("a request body without -X is described as a POST", () => {
    const f = describeFields("Bash", { command: "curl --json '{}' https://api.example.com/x" });
    assert.equal(f!.Title, "POST request to api.example.com");
  });

  it("method-only curl (no body) is described by its method", () => {
    // `-X` is preceded by whitespace, so the matcher must not use `\b-X`.
    assert.equal(
      describeFields("Bash", { command: "curl -s -X DELETE https://api.example.com/items/5" })!.Title,
      "DELETE request to api.example.com",
    );
    assert.equal(
      describeFields("Bash", { command: "curl -X PUT https://api.example.com/items/5" })!.Title,
      "PUT request to api.example.com",
    );
  });

  it("a curl inside $( ) does not take the closing ) into the path", () => {
    const cmd = "for i in 1 2; do c=$(curl -s -X DELETE https://api.example.com/api/v1/account); done";
    assert.equal(describeFields("Bash", { command: cmd })!.Target, "/api/v1/account");
    assert.equal(describeFields("Bash", { command: `curl -X DELETE "https://h.io/a(b)"` })!.Target, "/a(b)");
  });

  it("a release headlines over the notes file it reads and then deletes", () => {
    const cmd = "sed -n 1p CHANGELOG.md > ../../n.md && gh release create v0.1.0 -R o/r --notes-file ../../n.md 2>&1 | tail -2; rm ../../n.md";
    assert.equal(describeFields("Bash", { command: cmd })!.Title, "Create release v0.1.0 in o/r");
  });

  it("loopback DELETE in a for-loop headlines the request", () => {
    const cmd = "for id in 1 2 3; do curl -s -X DELETE http://localhost:3997/api/tweet-drafts/$id; done";
    assert.equal(describeFields("Bash", { command: cmd })!.Title, "DELETE request to localhost");
  });

  it("plain `> file` (no curl) is still Create file", () => {
    const f = describeFields("Bash", { command: "echo hi > /tmp/note.log" });
    assert.equal(f!.Title, "Create file");
  });

  it("a compound script that kills a process headlines the kill and its pattern", () => {
    // Regression: the compound "Run command" catch-all ran before the kill
    // handler, so `if pgrep …; then pkill -f …; fi` showed "Run command".
    const cmd =
      'if pgrep -f "user-data-dir=$PROFILE" >/dev/null 2>&1; then\n  echo "Stale Chrome — killing it."\n  pkill -f "user-data-dir=$PROFILE"\nfi';
    const f = describeFields("Bash", { command: cmd })!;
    assert.equal(f.Title, "Stop processes matching");
    assert.equal(f.Target, "user-data-dir=$PROFILE");
  });

  it("'killing' inside echo text is not mislabeled as a kill", () => {
    const f = describeFields("Bash", { command: 'echo "killing it is bad" && ls' });
    assert.ok(!/^Stop process/.test(f!.Title));
  });

  it("rm on an interior line of a multi-line script headlines 'Delete file'", () => {
    // Regression: the rm matcher used `(.+)$`, which only reaches end-of-string,
    // so a `rm` on a middle line (followed by more commands) fell back to
    // "Run command" instead of naming the delete.
    const cmd = 'WT=/repo/.claude/worktrees/x\nrm "$WT/backend/node_modules"\ncd "$WT" && git status --short';
    const f = describeFields("Bash", { command: cmd });
    assert.equal(f!.Title, "Delete file");
    // WT is set to a literal path earlier in the script, so the card shows it.
    assert.equal(f!.Target, "/repo/.claude/worktrees/x/backend/node_modules");
  });

  it("rm with quoted paths containing spaces", () => {
    const f = describeFields("Bash", {
      command: 'rm "path with spaces/file1.txt" \'another path/file2.txt\' plain.txt',
    });
    assert.equal(f!.Title, "Delete 3 files");
    assert.ok(f!.Target!.includes("path with spaces/file1.txt"));
    assert.ok(f!.Target!.includes("another path/file2.txt"));
    assert.ok(f!.Target!.includes("plain.txt"));
  });

  it("single file rm still works as before", () => {
    const f = describeFields("Bash", { command: "rm /home/ubuntu/note.txt" });
    assert.equal(f!.Title, "Delete file");
    assert.equal(f!.Target, "~/note.txt");
  });

  it("rm with home path shortening on multi-file", () => {
    const f = describeFields("Bash", {
      command: "rm /home/ubuntu/file1.txt /home/ubuntu/file2.txt",
    });
    assert.equal(f!.Title, "Delete 2 files");
    assert.ok(f!.Target!.includes("~/file1.txt"));
    assert.ok(f!.Target!.includes("~/file2.txt"));
  });

  it("describe() returns just title for multi-file (no inline target list)", () => {
    assert.equal(
      describeOne("Bash", { command: "rm file1 file2 file3" }),
      "Delete 3 files"
    );
  });
});

describe("Edit — diff preview", () => {
  it("emits title 'Edit file', target = path, annotation = +/- counts, body = diff", () => {
    const f = describeFields("Edit", {
      file_path: "/Users/oren/src/foo.ts",
      old_string: "  return token(user);",
      new_string: "  if (await bcrypt.compare(user.password, stored)) {\n    return token(user);\n  }",
    });
    assert.equal(f!.Title, "Edit file");
    assert.equal(f!.Target, "~/src/foo.ts");
    assert.match(f!.Annotation, /\+3 −1/);
    assert.ok(f!.Body && f!.Body.includes("- "));
    assert.ok(f!.Body && f!.Body.includes("+ "));
  });

  it("falls back to 'Edit file' + path without diff", () => {
    const f = describeFields("Edit", { file_path: "/Users/oren/x.ts" });
    assert.equal(f!.Title, "Edit file");
    assert.equal(f!.Target, "~/x.ts");
    assert.equal(f!.Body, undefined);
  });
});

describe("Write / file-write signature", () => {
  it("renders title 'Create file', target = path, annotation = size, body = content", () => {
    const f = describeFields("write", { path: "/home/ubuntu/note.txt", content: "hello world" });
    assert.equal(f!.Title, "Create file");
    assert.equal(f!.Target, "~/note.txt");
    assert.equal(f!.Annotation, "(11 B)");
    assert.equal(f!.Body, "hello world");
  });

  it("flags sensitive files in title", () => {
    const f = describeFields("Write", { file_path: "/home/u/.env", content: "SECRET=abc" });
    assert.equal(f!.Title, "Create sensitive file");
  });
});

describe("Email — sentence-style", () => {
  it("subject + multiple recipients + cc in subline", () => {
    const f = describeFields("mcp__gmail__send_email", {
      from: "contact@oked.ai",
      to: ["alice@example.com", "bob@example.com"],
      cc: "legal@company.com",
      subject: "Q3 contract terms",
      body: "Hi Alice, attached is the revised contract.",
    });
    assert.match(f!.Title, /^Send "Q3 contract terms"/);
    assert.ok(f!.Subline && f!.Subline.startsWith("to alice@example.com, bob@example.com"));
    assert.ok(f!.Subline && f!.Subline.includes("cc legal@company.com"));
    assert.ok(f!.Subline && f!.Subline.includes("(external)"));
    assert.equal(f!.Body, "Hi Alice, attached is the revised contract.");
  });

  it("no subject falls back to recipient in title", () => {
    const f = describeFields("mcp__gmail__send_email", { to: "alice@example.com", body: "hi" });
    assert.match(f!.Title, /^Send email to alice@example\.com/);
  });

  it("attachments appear in subline", () => {
    const f = describeFields("mcp__gmail__send_email", {
      to: "a@b.com",
      subject: "s",
      attachments: [{ name: "contract.pdf", size: 412 * 1024 }],
    });
    assert.ok(f!.Subline && f!.Subline.includes("📎 contract.pdf (412 KB)"));
  });

  it("no Key:value Path/Cc/Subject keys in output", () => {
    const f = describeFields("mcp__gmail__send_email", { to: "a@b.com", subject: "s", body: "b" });
    assert.equal(f!.To, undefined);
    assert.equal(f!.Cc, undefined);
    assert.equal(f!.Subject, undefined);
    assert.equal(f!.From, undefined);
  });
});

describe("Payment — sentence-style", () => {
  it("charge_card → 'Charge $X to card ending Y' + merchant subline", () => {
    const f = describeFields("mcp__stripe__charge_card", {
      amount: 4200,
      currency: "usd",
      last4: "4242",
      merchant: "Acme Inc",
    });
    assert.match(f!.Title, /^Charge \$42\.00 to card ending 4242/);
    assert.match(f!.Subline!, /merchant Acme Inc/);
  });

  it("create_payment with merchant → 'Send $X to <merchant>'", () => {
    const f = describeFields("mcp__bank__create_payment", {
      amount: 100000,
      currency: "usd",
      merchant: "Acme Inc",
      memo: "October retainer",
    });
    assert.match(f!.Title, /^Send \$1,000\.00 to Acme Inc/);
    assert.match(f!.Subline!, /memo: October retainer/);
  });

  it("no Amount/Card/Merchant key:value pairs", () => {
    const f = describeFields("mcp__stripe__charge_card", { amount: 100, currency: "usd", last4: "1234" });
    assert.equal(f!.Amount, undefined);
    assert.equal(f!.Card, undefined);
    assert.equal(f!.Merchant, undefined);
  });
});

describe("Send message — sentence-style", () => {
  it("'Send Slack message to <channel>' with body", () => {
    const f = describeFields("mcp__slack__send_message", { to: "#engineering", text: "deploy starting" });
    assert.match(f!.Title, /^Send Slack message to #engineering/);
    assert.equal(f!.Body, "deploy starting");
  });
});

describe("MCP delete/update enrichment", () => {
  it("delete_* uses target identifier", () => {
    const f = describeFields("mcp__github__delete_repository", { repo: "acme/legacy-api" });
    assert.equal(f!.Title, "Delete repository");
    assert.equal(f!.Target, "acme/legacy-api");
  });

  it("update_* uses numeric id as target", () => {
    const f = describeFields("mcp__linear__update_issue", { id: 4421, title: "Outage" });
    assert.equal(f!.Title, "Update issue");
    assert.equal(f!.Target, "#4421");
  });
});

describe("describe() backwards compatibility", () => {
  it("returns the title as a single line", () => {
    assert.equal(describeOne("Bash", { command: "rm -rf foo" }), "Delete foo recursively");
    assert.equal(describeOne("Bash", { command: "git push origin main" }), "Push main → origin");
  });
});

describe("Bash — shell file writes", () => {
  it("echo > path → title 'Create file', target = path, body = content", () => {
    const f = describeFields("Bash", { command: 'echo "hello world" > /home/u/note.txt' });
    assert.equal(f!.Title, "Create file");
    assert.equal(f!.Target, "~/note.txt");
    assert.equal(f!.Body, "hello world");
  });

  it("echo >> path → title 'Append to file', target = path", () => {
    const f = describeFields("Bash", { command: 'echo "hello" >> /tmp/log.txt' });
    assert.equal(f!.Title, "Append to file");
    assert.equal(f!.Target, "/tmp/log.txt");
    assert.equal(f!.Body, "hello");
  });

  it("/dev/null redirect is not a file write", () => {
    const f = describeFields("Bash", { command: 'echo "hi" > /dev/null' });
    assert.notEqual(f!.Title, "Create file");
  });

  it("a redirect inside $(...) ends at the closing parenthesis", () => {
    const quiet = describeFields("Bash", { command: "V=$(npm view @oked/sdk version 2>/dev/null); echo $V" });
    assert.notEqual(quiet!.Title, "Create file");
    const f = describeFields("Bash", { command: "x=$(make > build.log)" });
    assert.equal(f!.Title, "Create file");
    assert.equal(f!.Target, "build.log");
  });

  it("cp → title 'Copy file', target = 'src → dest'", () => {
    const f = describeFields("Bash", { command: "cp /etc/passwd /tmp/backup" });
    assert.equal(f!.Title, "Copy file");
    assert.equal(f!.Target, "/etc/passwd → /tmp/backup");
  });

  it("mv → title 'Move file', target = 'src → dest'", () => {
    const f = describeFields("Bash", { command: "mv old.txt new.txt" });
    assert.equal(f!.Title, "Move file");
    assert.equal(f!.Target, "old.txt → new.txt");
  });

  it("tee -a → title 'Append to file'", () => {
    const f = describeFields("Bash", { command: 'echo "x" | tee -a /var/log/app.log' });
    assert.equal(f!.Title, "Append to file");
    assert.equal(f!.Target, "/var/log/app.log");
  });

  it("sed -i → title 'Edit file', target = filename", () => {
    const f = describeFields("Bash", { command: "sed -i 's/foo/bar/g' config.yml" });
    assert.equal(f!.Title, "Edit file");
    assert.equal(f!.Target, "config.yml");
  });

  it("touch → title 'Create empty file', target = path", () => {
    const f = describeFields("Bash", { command: "touch /tmp/marker" });
    assert.equal(f!.Title, "Create empty file");
    assert.equal(f!.Target, "/tmp/marker");
  });
});

describe("classify — shell write tier rules", () => {
  let classify: typeof import("../src/classify.js").classify;
  it("imports classify", async () => {
    ({ classify } = await import("../src/classify.js"));
  });

  it("echo > path always prompts (review) — content-creation idiom", () => {
    const tier = classify("Bash", { command: 'echo "x" > /etc/myfile' });
    assert.equal(tier, "review");
  });

  it("echo > in-project is warning (matches the Write tool's in-project tier)", () => {
    const tier = classify("Bash", { command: 'echo "x" > local-note.txt' });
    assert.equal(tier, "warning");
  });

  it("echo > /dev/null is safe (devnull redirects aren't writes)", () => {
    const tier = classify("Bash", { command: 'echo "hi" > /dev/null 2>&1' });
    assert.equal(tier, "safe");
  });

  it("cp to a non-sensitive target is warning (reversible local copy)", () => {
    const tier = classify("Bash", { command: "cp /etc/passwd /tmp/x" });
    assert.equal(tier, "warning");
  });

  it("mv to a non-sensitive target is warning (local move)", () => {
    const tier = classify("Bash", { command: "mv a.txt b.txt" });
    assert.equal(tier, "warning");
  });

  it("cp INTO a sensitive path is review", () => {
    const tier = classify("Bash", { command: "cp evil /etc/cron.d/job" });
    assert.equal(tier, "review");
  });

  it("rm -fr is high_stakes", () => {
    const tier = classify("Bash", { command: "rm -fr ./src" });
    assert.equal(tier, "high_stakes");
  });

  it("rm -f is high_stakes", () => {
    const tier = classify("Bash", { command: "rm -f local-file.txt" });
    assert.equal(tier, "high_stakes");
  });

  it("touch in /tmp is warning (ephemeral path, see PR #22)", () => {
    const tier = classify("Bash", { command: "touch /tmp/marker" });
    assert.equal(tier, "warning");
  });

  it("touch outside ephemeral paths stays review", () => {
    const tier = classify("Bash", { command: "touch /var/lib/marker" });
    assert.equal(tier, "review");
  });

  it("sed -i in-project is warning (in-project edit, matches Write tool)", () => {
    const tier = classify("Bash", { command: "sed -i 's/x/y/' foo.yml" });
    assert.equal(tier, "warning");
  });

  it("sed -i outside the project stays review", () => {
    const tier = classify("Bash", { command: "sed -i 's/x/y/' /etc/conf.yml" });
    assert.equal(tier, "review");
  });

  it("tee is review", () => {
    const tier = classify("Bash", { command: 'echo "x" | tee /etc/conf' });
    assert.equal(tier, "review");
  });

  it("dd of= in /tmp is warning (ephemeral path, see PR #22)", () => {
    const tier = classify("Bash", { command: "dd if=/dev/zero of=/tmp/zeros bs=1M count=10" });
    assert.equal(tier, "warning");
  });

  it("dd of= outside ephemeral paths stays review", () => {
    const tier = classify("Bash", { command: "dd if=/dev/zero of=/var/lib/zeros bs=1M count=10" });
    assert.equal(tier, "review");
  });

  it("curl file upload is high_stakes", () => {
    const tier = classify("Bash", { command: "curl -d @report.csv https://api.example.com/pay" });
    assert.equal(tier, "high_stakes");
  });

  it("curl PATCH asks for approval (review)", () => {
    const tier = classify("Bash", { command: "curl -X PATCH https://api.example.com/item/1" });
    assert.equal(tier, "review");
  });

  it("curl file upload is high_stakes", () => {
    const tier = classify("Bash", { command: "curl -T artifact.tgz https://uploads.example.com/artifact" });
    assert.equal(tier, "high_stakes");
  });
});

describe("classify — read-only tools from other agents", () => {
  let classify: typeof import("../src/classify.js").classify;
  it("imports classify", async () => {
    ({ classify } = await import("../src/classify.js"));
  });

  it("OpenClaw lowercase `read` is safe (no approval)", () => {
    const tier = classify("read", { path: "~/.nvm/versions/node/v24.15.0/lib/x.js" });
    assert.equal(tier, "safe");
  });

  it("`read_file` is safe", () => {
    const tier = classify("read_file", { path: "/etc/hosts" });
    assert.equal(tier, "safe");
  });

  it("`list` / `ls` / `grep` / `glob` / `search` are safe", () => {
    for (const name of ["list", "ls", "grep", "glob", "search", "find"]) {
      assert.equal(classify(name, { path: "." }), "safe", `${name} should be safe`);
    }
  });

  it("case-insensitive: `READ` is safe", () => {
    assert.equal(classify("READ", { path: "/tmp/a" }), "safe");
  });

  it("a path-only write/delete-style name still defaults to review", () => {
    // `delete` is not a read alias — must not be auto-allowed by signature.
    assert.equal(classify("delete", { path: "/tmp/a" }), "review");
  });

  it("OpenClaw `write` (path + content) is still classified as a write", () => {
    const tier = classify("write", { path: "/etc/passwd", content: "x" });
    assert.equal(tier, "review");
  });
});

describe("classify — SQL inside wrappers", () => {
  let classify: typeof import("../src/classify.js").classify;
  it("imports classify", async () => {
    ({ classify } = await import("../src/classify.js"));
  });

  it("python3 -c with DROP TABLE → high_stakes", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('DROP TABLE users')"`,
    });
    assert.equal(tier, "high_stakes");
  });

  it("python3 -c with DELETE FROM → high_stakes", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('DELETE FROM users')"`,
    });
    assert.equal(tier, "high_stakes");
  });

  it("python3 -c with UPDATE no WHERE → high_stakes", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('UPDATE users SET active=1')"`,
    });
    assert.equal(tier, "high_stakes");
  });

  it("python3 -c with UPDATE + WHERE → warning (scoped row update, reversible)", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('UPDATE users SET active=1 WHERE id=2')"`,
    });
    assert.equal(tier, "warning");
  });

  it("python3 -c with CREATE TABLE → warning (see PR #19)", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('CREATE TABLE products (id INTEGER)')"`,
    });
    assert.equal(tier, "warning");
  });

  it("python3 -c with INSERT INTO → warning (adds rows, reversible)", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('INSERT INTO products VALUES (1)')"`,
    });
    assert.equal(tier, "warning");
  });

  it("node -e with DROP TABLE → high_stakes", () => {
    const tier = classify("Bash", {
      command: `node -e "require('better-sqlite3')('x').exec('DROP TABLE t')"`,
    });
    assert.equal(tier, "high_stakes");
  });

  it("sqlite3 db with TRUNCATE → high_stakes", () => {
    const tier = classify("Bash", { command: `sqlite3 demo.db "TRUNCATE products"` });
    assert.equal(tier, "high_stakes");
  });

  it("psql -c with CREATE TABLE → warning (see PR #19)", () => {
    const tier = classify("Bash", { command: `psql -c "CREATE TABLE t (id int)"` });
    assert.equal(tier, "warning");
  });

  it("node heredoc with DROP TABLE → high_stakes", () => {
    const cmd = `node - <<'EOF'\ndb.exec('DROP TABLE x');\nEOF`;
    assert.equal(classify("Bash", { command: cmd }), "high_stakes");
  });

  it("python heredoc that edits a file whose text mentions SQL is not a SQL statement", () => {
    const cmd = [
      `python3 - <<'EOF'`,
      `p='src/classify.ts'`,
      `s=open(p).read()`,
      `old="""// SQL words like DELETE FROM and DROP TABLE in comments"""`,
      `new="""// Claude Code built-ins that only steer the session"""`,
      `open(p,'w').write(s.replace(old,new))`,
      `EOF`,
    ].join("\n");
    assert.notEqual(classify("Bash", { command: cmd }), "high_stakes");
    const f = describeFields("Bash", { command: cmd });
    assert.ok(!/SQL|table/i.test(f?.Title ?? ""), f?.Title);
  });

  it("python -c with SQL words but no DB access is not high_stakes", () => {
    const cmd = `python3 -c "print('DELETE FROM users')"`;
    assert.notEqual(classify("Bash", { command: cmd }), "high_stakes");
  });

  it("python heredoc with a DB library and SQL in a variable → high_stakes", () => {
    const cmd = [`python3 - <<'EOF'`, `import sqlite3`, `q = 'DROP TABLE users'`, `sqlite3.connect('x.db').cursor().execute(q)`, `EOF`].join("\n");
    assert.equal(classify("Bash", { command: cmd }), "high_stakes");
  });

  it("python3 -c without SQL → safe (opaque code execution is not prompt-worthy)", () => {
    const tier = classify("Bash", { command: `python3 -c "print(1)"` });
    assert.equal(tier, "safe");
  });

  it("sqlite3 .tables → safe (read-only dot-command)", () => {
    assert.equal(classify("Bash", { command: `sqlite3 data.db ".tables"` }), "safe");
  });

  it("sqlite3 .schema → safe", () => {
    assert.equal(classify("Bash", { command: `sqlite3 data.db ".schema"` }), "safe");
  });

  it("sqlite3 .import → warning (loads rows, reversible local mutation)", () => {
    assert.equal(classify("Bash", { command: `sqlite3 data.db ".import data.csv users"` }), "warning");
  });
});

describe("Unknown tool fallback", () => {
  it("renders args as body, tool name as title", () => {
    const f = describeFields("weirdtool", { foo: "bar", n: 42 });
    assert.equal(f!.Title, "weirdtool");
    assert.ok(f!.Body && f!.Body.includes("foo: bar"));
  });
});

describe("himalaya email CLI — approval card rendering", () => {
  it("printf | himalaya message send → 'Send email to <recipient>' with subject in body", () => {
    const cmd =
      'printf "From: contact@oked.ai\\nTo: contact@oked.ai\\nSubject: Test\\n\\nhi" | /home/ubuntu/bin/himalaya message send';
    const f = describeFields("exec", { command: cmd });
    assert.equal(f!.Title, "Send email to contact@oked.ai");
    assert.equal(f!.Target, "contact@oked.ai");
    assert.ok(f!.Body && f!.Body.includes("Subject: Test"));
    assert.ok(f!.Body && f!.Body.includes("From: contact@oked.ai"));
  });

  it("printf %s form is also parsed", () => {
    const cmd =
      'printf %s "From: a@b.com\\nTo: c@d.com\\nSubject: hello\\n\\nbody text" | himalaya message send';
    const f = describeFields("exec", { command: cmd });
    assert.equal(f!.Title, "Send email to c@d.com");
  });

  it("heredoc body is parsed", () => {
    const cmd = "cat <<'EOF' | himalaya message send\nTo: x@y.com\nSubject: hd\n\nbody\nEOF";
    const f = describeFields("exec", { command: cmd });
    assert.equal(f!.Title, "Send email to x@y.com");
  });

  it("himalaya message delete → 'Delete email' with id as target", () => {
    const cmd = "himalaya message delete 42";
    const f = describeFields("exec", { command: cmd });
    assert.equal(f!.Title, "Delete email");
    assert.equal(f!.Target, "42");
  });

  it("himalaya folder purge → 'Purge folder X'", () => {
    const cmd = "himalaya folder purge INBOX";
    const f = describeFields("exec", { command: cmd });
    assert.equal(f!.Title, "Purge folder INBOX");
  });
});

describe("ssh and gh pr create — labels + kinds", () => {
  it("ssh user@host \"cmd\" → 'SSH to ...' with remote command as body", () => {
    const f = describeFields("Bash", { command: 'ssh user@example.com "ls /"' });
    assert.equal(f!.Title, "SSH to user@example.com");
    assert.equal(f!.Target, "user@example.com");
    assert.equal(f!.Kind, "ssh_remote");
    assert.equal(f!.Body, '"ls /"');
  });

  it("ssh -i key.pem ubuntu@ip systemctl restart nginx → ssh_remote with body", () => {
    const f = describeFields("Bash", {
      command: "ssh -i key.pem ubuntu@1.2.3.4 systemctl restart nginx",
    });
    assert.equal(f!.Title, "SSH to ubuntu@1.2.3.4");
    assert.equal(f!.Target, "ubuntu@1.2.3.4");
    assert.equal(f!.Kind, "ssh_remote");
    assert.equal(f!.Body, "systemctl restart nginx");
  });

  it("ssh user@host (no remote command) → ssh_remote, no body", () => {
    const f = describeFields("Bash", { command: "ssh user@example.com" });
    assert.equal(f!.Title, "SSH to user@example.com");
    assert.equal(f!.Kind, "ssh_remote");
    assert.equal(f!.Body, undefined);
  });

  it("gh pr create --title \"Fix bug\" → 'Create PR \"Fix bug\"'", () => {
    const f = describeFields("Bash", { command: 'gh pr create --title "Fix bug"' });
    assert.equal(f!.Title, 'Create PR "Fix bug"');
    assert.equal(f!.Kind, "git_pr_create");
  });

  it("gh pr create (no flags) → 'Create pull request'", () => {
    const f = describeFields("Bash", { command: "gh pr create" });
    assert.equal(f!.Title, "Create pull request");
    assert.equal(f!.Kind, "git_pr_create");
  });
});

describe("browser MCP tools", () => {
  it("computer click leads with the action and uses action_summary as target", () => {
    const f = describeFields("mcp__Claude_Browser__computer", { action: "left_click", coordinate: [1, 2], action_summary: "Opens the Filters menu" });
    assert.equal(f!.Title, "Left click in browser");
    assert.equal(f!.Target, "Opens the Filters menu");
  });

  it("typing shows the text, Chrome is named", () => {
    const f = describeFields("mcp__claude-in-chrome__computer", { action: "type", text: "hello" });
    assert.equal(f!.Title, "Type in Chrome");
    assert.equal(f!.Body, "hello");
  });

  it("javascript_tool shows the code", () => {
    const f = describeFields("mcp__Claude_Browser__javascript_tool", { action: "javascript_exec", text: "document.title" });
    assert.equal(f!.Title, "Run JavaScript in browser");
    assert.equal(f!.Body, "document.title");
  });

  it("preview_start: url opens a page, name starts a dev server", () => {
    assert.equal(describeFields("mcp__Claude_Browser__preview_start", { url: "http://localhost:3000" })!.Target, "http://localhost:3000");
    const f = describeFields("mcp__Claude_Browser__preview_start", { name: "web" });
    assert.equal(f!.Title, 'Start dev server "web"');
    assert.ok(f!.Footnote!.includes("launch.json"));
  });

  it("browser_batch lists its steps", () => {
    const f = describeFields("mcp__Claude_Browser__browser_batch", { actions: [
      { name: "navigate", input: { url: "http://localhost:3000" } },
      { name: "computer", input: { action: "left_click", action_summary: "Clicks Save" } },
    ] });
    assert.equal(f!.Title, "Run 2 browser steps");
    assert.equal(f!.Body, "Open page in browser: http://localhost:3000\nLeft click in browser: Clicks Save");
  });
});

describe("Bash — npm publish", () => {
  const repo = fileURLToPath(new URL("../../..", import.meta.url));

  it("reads name@version from the cwd's package.json", () => {
    const f = describeFields("Bash", { command: "npm publish --access public" }, { cwd: `${repo}/packages/sdk` });
    const pkg = JSON.parse(readFileSync(`${repo}/packages/sdk/package.json`, "utf8"));
    assert.equal(f!.Title, "Publish package to npm");
    assert.equal(f!.Target, `@oked/sdk@${pkg.version}`);
    assert.equal(f!.Subline, "tag latest · public access");
  });

  it("follows a leading cd and headlines the publish in a compound command", () => {
    const f = describeFields("Bash", { command: "cd packages/sdk && npm run build && npm publish --tag next" }, { cwd: repo });
    assert.equal(f!.Title, "Publish package to npm");
    assert.match(f!.Target!, /^@oked\/sdk@/);
    assert.equal(f!.Subline, "tag next");
    assert.equal(f!.Body, "cd packages/sdk && npm run build && npm publish --tag next");
  });

  it("--workspace resolves each package; --workspaces lists all public ones", () => {
    const one = describeFields("Bash", { command: "npm publish -w packages/claude-code -w packages/sdk" }, { cwd: repo });
    assert.equal(one!.Title, "Publish 2 packages to npm");
    assert.match(one!.Target!, /^@oked\/claude-code@.*\n@oked\/sdk@/);
    const all = describeFields("Bash", { command: "npm publish --workspaces" }, { cwd: repo });
    assert.match(all!.Title, /^Publish \d+ packages to npm$/);
    assert.match(all!.Target!, /@oked\/sdk@/);
  });

  it("shows no target when the folder is not known", () => {
    const cmd = `cd $SP/oked-sdk && node probe.mjs '["cd $S/x && npm ${"publish"}"]'`;
    const f = describeFields("Bash", { command: cmd }, { cwd: repo });
    assert.equal(f!.Title, "Publish package to npm");
    assert.equal(f!.Target, undefined);
  });

  it("marks dry runs and redacts --otp", () => {
    const f = describeFields("Bash", { command: "npm publish --dry-run --otp 123456" });
    assert.equal(f!.Title, "Publish package to npm (dry run)");
    assert.equal(f!.Body, "npm publish --dry-run --otp ***");
  });
});

describe("desktop app folder access (ccd_directory)", () => {
  it("change_directory names the folder", () => {
    const f = describeFields("mcp__ccd_directory__change_directory", { path: "/Users/someone/Dev/project" });
    assert.equal(f!.Title, "Move session to folder");
    assert.ok(f!.Target!.endsWith("Dev/project"));
  });

  it("request_directory with and without a path", () => {
    assert.equal(describeFields("mcp__ccd_directory__request_directory", { path: "/tmp/x" })!.Title, "Give session access to folder");
    assert.equal(describeFields("mcp__ccd_directory__request_directory", {})!.Title, "Ask you to pick a folder for this session");
  });
});

describe("Claude Code built-in session tools", () => {
  it("TaskStop says what it does", () => {
    const f = describeFields("TaskStop", { task_id: "bkm34a6nc" });
    assert.equal(f!.Title, "Stop background task");
    assert.equal(f!.Target, "bkm34a6nc");
  });

  it("ExitWorktree with discard warns about lost work", () => {
    const f = describeFields("ExitWorktree", { action: "remove", discard_changes: true });
    assert.equal(f!.Title, "Delete worktree and discard its changes");
  });

  it("CronCreate shows the schedule and prompt", () => {
    const f = describeFields("CronCreate", { cron: "7 * * * *", prompt: "check the deploy" });
    assert.equal(f!.Title, "Schedule a recurring prompt");
    assert.equal(f!.Target, "7 * * * *");
    assert.equal(f!.Body, "check the deploy");
  });

  it("Monitor uses its description, not the generic shell rendering", () => {
    const f = describeFields("Monitor", { command: "tail -f a.log", description: "errors in a.log", timeout_ms: 1000 });
    assert.equal(f!.Title, "Watch: errors in a.log");
    assert.equal(f!.Body, "tail -f a.log");
  });

  it("Artifact publish and delete", () => {
    assert.equal(describeFields("Artifact", { file_path: "/tmp/report.html" })!.Title, "Publish page to claude.ai");
    assert.equal(describeFields("Artifact", { action: "delete", url: "https://claude.ai/artifact/x" })!.Title, "Delete page from claude.ai");
  });
});

describe("claude.ai connectors (UUID server names)", () => {
  it("names the connector, not its UUID", () => {
    const f = describeFields("mcp__9cd8ee23-93a8-4bb9-8972-d241324d686c__share_file", {})!;
    assert.equal(f.Title, "Share file via claude.ai connector");
    assert.ok(!JSON.stringify(f).includes("9cd8ee23"));
  });

  it("names the desktop app, not its internal server name", () => {
    assert.equal(describeFields("mcp__ccd_pr__set_auto_merge", {})!.Title, "Set auto merge via Claude desktop app");
  });
});

describe("approval review seed fixes (2026-10-18)", () => {
  it("a compound command takes its title from the step that set the tier", () => {
    const f = describeFields("Bash", {
      command: "gh pr merge https://github.com/o/r/pull/7 --squash; SHA=$(gh pr view 7 --json state,mergeCommit); curl -s -X POST https://api.example.com/hook -d '{}'",
    })!;
    assert.equal(f.Title, "Merge PR #7 in o/r");
    assert.equal(f.Annotation, "squash");
    assert.equal(f.Subline, "Also: POST request to api.example.com /hook");
    assert.ok(!/state,mergeCommit/.test(f.Title));
  });

  it("gh --json is not read as a POST body", () => {
    const f = describeFields("Bash", { command: "curl -s https://x.dev/health; gh pr view 7 --json state" })!;
    assert.notEqual(f.Title.startsWith("POST"), true);
  });

  it("gh writes name the PR or issue", () => {
    assert.equal(describeFields("Bash", { command: "gh pr comment 12 --body 'LGTM'" })!.Title, "Comment on PR #12");
    assert.equal(describeFields("Bash", { command: "gh pr comment 12 --body 'LGTM'" })!.Body, "LGTM");
    assert.equal(describeFields("Bash", { command: "gh pr close 3 -R o/r" })!.Title, "Close PR #3 in o/r");
    assert.equal(describeFields("Bash", { command: "gh release create v1.2.0" })!.Title, "Create release v1.2.0");
  });

  it("gh api shows the method and the endpoint", () => {
    const f = describeFields("Bash", { command: "gh api -X DELETE repos/o/r/git/refs/heads/x" })!;
    assert.equal(f.Title, "DELETE request to GitHub API");
    assert.equal(f.Target, "repos/o/r/git/refs/heads/x");
    assert.equal(describeFields("Bash", { command: "gh api graphql -f query='query { viewer { login } }'" })!.Title, "Query GitHub GraphQL API");
  });

  it("desktop app turn tools say what they do", () => {
    assert.equal(describeFields("mcp__ccd_turn__update_plan", {})!.Title, "Update the task list in the Claude app");
    assert.equal(describeFields("mcp__ccd_turn__wrap_up", { recap: "r" })!.Title, "Show the end-of-turn summary in the Claude app");
    const s = describeFields("mcp__ccd_session__start_session", { title: "Fix CI", prompt: "Make CI green", target: "cloud" })!;
    assert.equal(s.Title, "Start a new Claude session in the cloud");
    assert.equal(s.Target, "Fix CI");
    assert.equal(s.Body, "Make CI green");
  });

  it("only known acronyms are capitalized", () => {
    assert.equal(describeFields("mcp__acme__wrap_up", {})!.Title, "Wrap up via acme");
    assert.equal(describeFields("mcp__acme__get_repo", {})!.Title, "Get repo via acme");
    assert.equal(describeFields("mcp__acme__update_pr", {})!.Title, "Update PR via acme");
  });
});

describe("Railway", () => {
  it("names the deploy and the service", () => {
    const f = describeFields("Bash", { command: "railway up --service api -e production" })!;
    assert.equal(f.Title, "Deploy to Railway");
    assert.equal(f.Target, "api");
    assert.equal(f.Annotation, "(production)");
    assert.equal(describeFields("Bash", { command: "railway down" })!.Title, "Remove the latest Railway deployment");
  });
});

describe("approval review 2026-10-18 (2 weeks of cards): text", () => {
  it("rm -f is not recursive", () => {
    assert.equal(describeFields("Bash", { command: "rm -f _smoke.mjs" })!.Title, "Delete file");
    assert.equal(describeFields("Bash", { command: "rm -fr build" })!.Title, "Delete file recursively");
    assert.equal(describeFields("Bash", { command: "rm -R build" })!.Title, "Delete file recursively");
  });

  it("a variable set earlier in the command shows as its value", () => {
    const f = describeFields("Bash", { command: "D=/Users/me/notes; rm -f $D/old.md && ls $D" })!;
    assert.equal(f.Target, "~/notes/old.md");
    const g = describeFields("Bash", { command: "rm -rf \"$UNSET/x\"" })!;
    assert.equal(g.Target, "$UNSET/x");
  });

  it("git branch -D names the branch", () => {
    const f = describeFields("Bash", { command: "git worktree remove wt && git branch -D claude/feature-x" })!;
    assert.equal(f.Title, "Delete local Git branch");
    assert.equal(f.Target, "claude/feature-x");
    assert.equal(f.Annotation, "even if not merged");
  });

  it("git push --delete names the remote branch, and a merge card lists it", () => {
    const f = describeFields("Bash", { command: "git push -q origin --delete chore/bump-sdk-0.6.9" })!;
    assert.equal(f.Title, "Delete remote Git branch");
    assert.equal(f.Target, "chore/bump-sdk-0.6.9 on origin");
    const g = describeFields("Bash", { command: "gh pr merge 130 --repo aml11/oked-app --squash; git push -q origin --delete chore/x" })!;
    assert.equal(g.Title, "Merge PR #130 in aml11/oked-app");
    assert.equal(g.Subline, "Also: Delete remote Git branch chore/x on origin");
  });

  it("prisma migrate deploy names the database", () => {
    const f = describeFields("Bash", { command: "export DATABASE_URL=postgresql://u:p@localhost:5433/app_test; npx prisma migrate deploy 2>&1 | tail -2" })!;
    assert.equal(f.Title, "Apply Prisma database migrations");
    assert.equal(f.Target, "localhost:5433/app_test");
    assert.ok(!JSON.stringify(f).includes("u:p@"), "no password on the card title or target");
  });

  it("iOS Simulator actions say what they do", () => {
    const sim = (input: Record<string, unknown>) => describeFields("mcp__Claude_Code_iOS_Simulator__control", input)!;
    assert.equal(sim({ action: "screenshot" }).Title, "Take an iOS Simulator screenshot");
    assert.equal(sim({ action: "tap", x: 10, y: 20 }).Target, "(10, 20)");
    assert.equal(sim({ action: "text", text: "hello" }).Body, "hello");
    assert.equal(sim({ action: "launch", bundle_id: "ai.oked.app" }).Target, "ai.oked.app");
  });

  it("scheduled tasks show the name, the schedule and the prompt", () => {
    const f = describeFields("mcp__scheduled-tasks__create_scheduled_task", { taskId: "t", title: "Daily check", cronExpression: "0 9 * * *", prompt: "Check X." })!;
    assert.equal(f.Title, "Create a scheduled task");
    assert.equal(f.Target, "Daily check");
    assert.equal(f.Annotation, "cron 0 9 * * *");
    assert.equal(f.Body, "Check X.");
    const u = describeFields("mcp__scheduled-tasks__update_scheduled_task", { taskId: "t", enabled: false })!;
    assert.equal(u.Annotation, "changes: pause");
  });
});

describe("approval review 2026-10-18T1713: text", () => {
  const bashFields = (command: string) => describeFields("Bash", { command })!;

  it("rmdir says it deletes an empty folder", () => {
    assert.equal(bashFields("rmdir build/empty").Title, "Delete empty folder");
    assert.equal(bashFields("rmdir build/empty").Target, "build/empty");
    assert.equal(bashFields("rmdir a b").Title, "Delete 2 empty folders");
  });

  it("words in a search pattern or a node -e script do not name the card", () => {
    assert.equal(bashFields(`grep -E "x|npm publish" a.yml`).Kind, "unknown_bash");
    assert.equal(bashFields(`grep "a\\|git push --force" f`).Kind, "unknown_bash");
    assert.equal(
      bashFields(`node -e 'for (const c of ["DATABASE_URL=postgres://u@prod.example.com/db npx prisma migrate deploy"]) console.log(c)'`).Kind,
      "unknown_bash",
    );
    // The real commands keep their titles.
    assert.equal(bashFields("cd pkg && npm publish").Title, "Publish package to npm");
    assert.equal(bashFields("DATABASE_URL=postgres://u@db.prod.io/x npx prisma migrate deploy").Kind, "sql_migrate");
    assert.equal(bashFields("git push --force origin main").Title, "Force push");
  });
});

describe("approval review 2026-10-19T0606: text", () => {
  const bashFields = (command: string) => describeFields("Bash", { command })!;

  it("words in a quoted option value or a commit message do not name the card", () => {
    assert.equal(bashFields(`node scripts/x.mjs add --reason "The git push titles now ignore it."`).Kind, "unknown_bash");
    assert.equal(bashFields(`node scripts/x.mjs add --reason "rmdir of an empty temp folder made a card"`).Kind, "unknown_bash");
    assert.equal(bashFields(`git commit -m "rmdir of a b c"`).Kind, "git_commit");
    // The real deletes keep their titles.
    assert.equal(bashFields("rmdir a b").Title, "Delete 2 empty folders");
    assert.equal(bashFields(`git commit -m "x" && rm -rf build`).Title, "Delete file recursively");
  });
});

describe("git cards name the repo", () => {
  const root = mkdtempSync(join(tmpdir(), "oked-git-"));
  // A repo with an origin remote, on branch feat.
  const sdk = join(root, "sdk");
  mkdirSync(join(sdk, ".git"), { recursive: true });
  mkdirSync(join(sdk, "packages"), { recursive: true });
  writeFileSync(join(sdk, ".git", "config"), '[core]\n\tbare = false\n[remote "origin"]\n\turl = git@github.com:oked-ai/oked-sdk.git\n\tfetch = +refs/heads/*:refs/remotes/origin/*\n');
  writeFileSync(join(sdk, ".git", "HEAD"), "ref: refs/heads/feat\n");
  // A worktree of that repo, on branch wt.
  const wt = join(root, "wt");
  mkdirSync(join(sdk, ".git", "worktrees", "wt"), { recursive: true });
  mkdirSync(wt);
  writeFileSync(join(wt, ".git"), `gitdir: ${join(sdk, ".git", "worktrees", "wt")}\n`);
  writeFileSync(join(sdk, ".git", "worktrees", "wt", "commondir"), "../..\n");
  writeFileSync(join(sdk, ".git", "worktrees", "wt", "HEAD"), "ref: refs/heads/wt\n");
  // A repo with no remote.
  const local = join(root, "notes");
  mkdirSync(join(local, ".git"), { recursive: true });
  writeFileSync(join(local, ".git", "config"), "[core]\n\tbare = false\n");
  writeFileSync(join(local, ".git", "HEAD"), "ref: refs/heads/main\n");

  const at = (command: string, cwd?: string) => describeFields("Bash", { command }, { cwd })!;

  it("a push names the remote repo and the branch", () => {
    assert.equal(at("git push --force origin main", sdk).Target, "main → oked-ai/oked-sdk");
    assert.equal(at("git push", join(sdk, "packages")).Target, "feat → oked-ai/oked-sdk");
    assert.equal(at(`cd ${wt} && git push -u origin wt`).Target, "wt → oked-ai/oked-sdk");
    assert.equal(at(`git -C ${wt} push`).Target, "wt → oked-ai/oked-sdk");
  });

  it("a remote branch delete names the remote repo", () => {
    const f = at("git push origin --delete old", sdk);
    assert.equal(f.Title, "Delete remote Git branch");
    assert.equal(f.Target, "old on oked-ai/oked-sdk");
  });

  it("a push from a repo with no such remote names the local repo", () => {
    const f = at("git push backup main", local);
    assert.equal(f.Target, "main → backup");
    assert.equal(f.Annotation, "in notes");
  });

  it("local git changes name the repo in the title", () => {
    assert.equal(at("git branch -D old", sdk).Title, "Delete local Git branch in oked-ai/oked-sdk");
    assert.equal(at(`S=${root}; cd $S/wt && git status && git branch -D old`).Title, "Delete local Git branch in oked-ai/oked-sdk");
    assert.equal(at(`git -C ${local} reset --hard`).Title, "Hard reset in notes, discard all local changes");
    assert.equal(at('git commit -m "Fix it"', wt).Title, 'Git commit "Fix it" in oked-ai/oked-sdk');
    assert.equal(at("git clean -fd", local).Title, "Remove all untracked files in notes");
  });

  it("with no known folder, the card is as before", () => {
    assert.equal(at("git branch -D old").Title, "Delete local Git branch");
    assert.equal(at("cd sub && git branch -D old").Title, "Delete local Git branch");
  });

  it("push arguments end at a quote", () => {
    const f = at(`node $S/probe2.mjs x '["git push origin main","git push --force origin main"]'`);
    assert.equal(f.Title, "Force push");
    assert.equal(f.Target, "main → origin");
  });

  it("a PR card names the repo and links to the PR", () => {
    const f = at("gh pr merge 76 --squash --delete-branch 2>&1 | tail -3", sdk);
    assert.equal(f.Title, "Merge PR #76 in oked-ai/oked-sdk");
    assert.equal(f.Link, "https://github.com/oked-ai/oked-sdk/pull/76");
    assert.equal(at(`cd ${wt} && gh pr comment 5 --body "ok"`).Link, "https://github.com/oked-ai/oked-sdk/pull/5");
    assert.equal(at("gh pr merge https://github.com/aml11/oked-app/pull/132 --squash").Link, "https://github.com/aml11/oked-app/pull/132");
    assert.equal(at("gh issue close 9 -R aml11/oked-app").Link, "https://github.com/aml11/oked-app/issues/9");
  });

  it("a PR card has no link when the repo is not on GitHub or not known", () => {
    const f = at("gh pr merge 76 --squash", local);
    assert.equal(f.Title, "Merge PR #76");
    assert.equal(f.Link, undefined);
    assert.equal(at("gh pr merge 76 -R git.example.com/a/b").Link, undefined);
    assert.equal(at("gh pr merge --squash", sdk).Link, undefined);
  });

  it("a merge with a commit subject names the PR in the title", () => {
    const f = at(`gh pr merge 49 --repo aml11/oked-static-web-site --squash --subject "feat: OG image without the beta pill (#49)" --body "x" 2>&1 | tail -3`);
    assert.equal(f.Title, 'Merge PR #49 "feat: OG image without the beta pill" in aml11/oked-static-web-site');
    assert.equal(f.Annotation, "squash");
    assert.equal(at("gh pr merge 76 -s -t 'fix: x'", local).Title, 'Merge PR #76 "fix: x"');
    assert.equal(at('gh pr merge 76 --subject "$(git log -1 --format=%s)"', sdk).Title, "Merge PR #76 in oked-ai/oked-sdk");
  });

  it("a PR title from GitHub goes after the PR number", () => {
    const named = (cmd: string, prTitle: string) => describeFields("Bash", { command: cmd }, { cwd: sdk, prTitle })!;
    assert.equal(named("gh pr merge 76 --squash", "Fix the card\nmore").Title, 'Merge PR #76 "Fix the card" in oked-ai/oked-sdk');
    assert.equal(named("gh pr close 5", "Old idea").Title, 'Close PR #5 "Old idea" in oked-ai/oked-sdk');
    assert.equal(named("gh pr merge 76 -t 'From the command'", "From GitHub").Title, 'Merge PR #76 "From the command" in oked-ai/oked-sdk');
    assert.equal(named("git branch -D old", "x").Title, "Delete local Git branch in oked-ai/oked-sdk");
    assert.equal(describeOne("Bash", { command: "gh pr merge 76" }, { cwd: sdk, prTitle: "Fix" }), 'Merge PR #76 "Fix" in oked-ai/oked-sdk');
  });

  it("a command of several steps has no footnote", () => {
    assert.equal(at("git status; git push --force origin main").Footnote, undefined);
  });
});
