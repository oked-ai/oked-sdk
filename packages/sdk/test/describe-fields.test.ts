import { describe, it } from "node:test";
import assert from "node:assert/strict";
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
      from: "agent@orendor.com",
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

  it("echo > in-project also prompts (content-creation is always review)", () => {
    const tier = classify("Bash", { command: 'echo "x" > local-note.txt' });
    assert.equal(tier, "review");
  });

  it("echo > /dev/null is safe (devnull redirects aren't writes)", () => {
    const tier = classify("Bash", { command: 'echo "hi" > /dev/null 2>&1' });
    assert.equal(tier, "safe");
  });

  it("cp is review (can overwrite a target)", () => {
    const tier = classify("Bash", { command: "cp /etc/passwd /tmp/x" });
    assert.equal(tier, "review");
  });

  it("mv is review (moves/removes the source path)", () => {
    const tier = classify("Bash", { command: "mv a.txt b.txt" });
    assert.equal(tier, "review");
  });

  it("rm -fr is high_stakes", () => {
    const tier = classify("Bash", { command: "rm -fr ./dist" });
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

  it("sed -i is review (mutates existing file)", () => {
    const tier = classify("Bash", { command: "sed -i 's/x/y/' foo.yml" });
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

  it("curl data upload is high_stakes", () => {
    const tier = classify("Bash", { command: "curl -d a=1 https://api.example.com/pay" });
    assert.equal(tier, "high_stakes");
  });

  it("curl PATCH is high_stakes", () => {
    const tier = classify("Bash", { command: "curl -X PATCH https://api.example.com/item/1" });
    assert.equal(tier, "high_stakes");
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

  it("python3 -c with UPDATE + WHERE → review", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('UPDATE users SET active=1 WHERE id=2')"`,
    });
    assert.equal(tier, "review");
  });

  it("python3 -c with CREATE TABLE → warning (see PR #19)", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('CREATE TABLE products (id INTEGER)')"`,
    });
    assert.equal(tier, "warning");
  });

  it("python3 -c with INSERT INTO → review", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('INSERT INTO products VALUES (1)')"`,
    });
    assert.equal(tier, "review");
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

  it("python3 -c without SQL → review (default unchanged)", () => {
    const tier = classify("Bash", { command: `python3 -c "print(1)"` });
    assert.equal(tier, "review");
  });

  it("sqlite3 .tables → safe (read-only dot-command)", () => {
    assert.equal(classify("Bash", { command: `sqlite3 data.db ".tables"` }), "safe");
  });

  it("sqlite3 .schema → safe", () => {
    assert.equal(classify("Bash", { command: `sqlite3 data.db ".schema"` }), "safe");
  });

  it("sqlite3 .import → review (mutating dot-command)", () => {
    assert.equal(classify("Bash", { command: `sqlite3 data.db ".import data.csv users"` }), "review");
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
      'printf "From: okedtester@gmail.com\\nTo: orendor@gmail.com\\nSubject: Test\\n\\nhi" | /home/ubuntu/bin/himalaya message send';
    const f = describeFields("exec", { command: cmd });
    assert.equal(f!.Title, "Send email to orendor@gmail.com");
    assert.equal(f!.Target, "orendor@gmail.com");
    assert.ok(f!.Body && f!.Body.includes("Subject: Test"));
    assert.ok(f!.Body && f!.Body.includes("From: okedtester@gmail.com"));
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
