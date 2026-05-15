import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { describeFields, describe as describeOne } from "../src/describe.js";

describe("Bash - SQL via host language", () => {
  it("node heredoc with CREATE TABLE -> title 'Create table', target 'users'", () => {
    const cmd = `node - <<'EOF'
const db = require('better-sqlite3')('demo.db');
db.exec(\`CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY)\`);
EOF`;
    const f = describeFields("Bash", { command: cmd });
    assert.equal(f!.Title, "Create table");
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

  it("node heredoc INSERT only -> 'Insert rows into' + target", () => {
    const cmd = `node - <<'EOF'
db.exec(\`INSERT INTO users (name) VALUES ('Alice')\`);
EOF`;
    const f = describeFields("Bash", { command: cmd });
    assert.equal(f!.Title, "Insert rows into");
    assert.equal(f!.Target, "users");
  });

  it("python -c DELETE no WHERE -> 'Delete ALL rows from' + target", () => {
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
    assert.equal(f!.Title, "Create table");
    assert.equal(f!.Target, "t");
  });

  it("node -e DROP TABLE with arrow function in body is not misread as shell redirect", () => {
    const cmd = `cd /home/ubuntu/.openclaw/workspace && node -e "const Database = require('better-sqlite3'); const db = new Database('random_db.sqlite'); db.exec('DROP TABLE IF EXISTS space_missions;'); console.log('Table dropped.'); const tables = db.prepare(\\"SELECT name FROM sqlite_master WHERE type='table'\\").all(); console.log('Remaining tables:', tables.length ? tables.map(t => t.name) : 'none'); db.close();"`;
    const f = describeFields("Bash", { command: cmd });
    assert.equal(f!.Title, "Drop table");
    assert.equal(f!.Target, "space_missions");
  });
});

describe("Bash - semantic rerendering", () => {
  it("rm -rf path -> title 'Delete file recursively', target = path", () => {
    const f = describeFields("Bash", { command: "rm -rf node_modules" });
    assert.equal(f!.Title, "Delete file recursively");
    assert.equal(f!.Target, "node_modules");
    assert.equal(f!.Body, undefined);
  });

  it("trash <path> -> title 'Delete file', target = path", () => {
    const f = describeFields("Bash", { command: "trash /home/ubuntu/.openclaw/workspace/note.txt" });
    assert.equal(f!.Title, "Delete file");
    assert.match(f!.Target, /note\.txt/);
  });

  it("rm <path>.sql -> 'Delete SQL file', not generic 'Delete file'", () => {
    const f = describeFields("Bash", { command: "rm /home/ubuntu/.openclaw/workspace/employees_table.sql" });
    assert.equal(f!.Title, "Delete SQL file");
    assert.equal(f!.Kind, "file_delete");
    assert.match(f!.Target!, /employees_table\.sql/);
  });

  it("rm -rf <path>.sql -> still 'Delete file recursively' (recursive flag wins)", () => {
    const f = describeFields("Bash", { command: "rm -rf /tmp/schema.sql" });
    assert.equal(f!.Title, "Delete file recursively");
  });

  it("DROP TABLE -> title 'Drop table', target = table name", () => {
    const f = describeFields("Bash", { command: 'psql -c "DROP TABLE sessions"' });
    assert.equal(f!.Title, "Drop table");
    assert.equal(f!.Target, "sessions");
  });

  it("DELETE FROM with WHERE -> title 'Delete rows from', target = table", () => {
    const f = describeFields("Bash", {
      command: `psql -c "DELETE FROM users WHERE created_at < '2024-01-01'"`,
    });
    assert.equal(f!.Title, "Delete rows from");
    assert.equal(f!.Target, "users");
    assert.ok(f!.Body && f!.Body.includes("WHERE"));
  });

  it("DELETE without WHERE -> 'Delete ALL rows from'", () => {
    const f = describeFields("Bash", { command: 'psql -c "DELETE FROM users"' });
    assert.equal(f!.Title, "Delete ALL rows from");
    assert.equal(f!.Target, "users");
  });

  it("UPDATE with WHERE -> 'Update rows in'", () => {
    const f = describeFields("Bash", {
      command: `psql -c "UPDATE users SET role='admin' WHERE id=1"`,
    });
    assert.equal(f!.Title, "Update rows in");
    assert.equal(f!.Target, "users");
  });

  it("UPDATE without WHERE -> flag 'EVERY row'", () => {
    const f = describeFields("Bash", { command: `psql -c "UPDATE users SET role='admin'"` });
    assert.equal(f!.Title, "Update EVERY row in");
    assert.equal(f!.Target, "users");
  });

  it("git push --force -> title 'Force push', target = 'branch -> remote'", () => {
    const f = describeFields("Bash", { command: "git push --force origin main" });
    assert.equal(f!.Title, "Force push");
    assert.equal(f!.Target, "main -> origin");
  });

  it("git push -> title 'Push', target = 'branch -> remote'", () => {
    const f = describeFields("Bash", { command: "git push origin main" });
    assert.equal(f!.Title, "Push");
    assert.equal(f!.Target, "main -> origin");
  });

  it("curl POST -> 'POST request to <host>'", () => {
    const f = describeFields("Bash", { command: "curl -X POST https://api.stripe.com/v1/charges -d foo=bar" });
    assert.equal(f!.Title, "POST request to api.stripe.com");
  });

  it("multi-step pipeline -> 'Run command' + body has full pipeline", () => {
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

describe("Edit - diff preview", () => {
  it("emits title 'Edit file', target = path, annotation = +/- counts, body = diff", () => {
    const f = describeFields("Edit", {
      file_path: "/Users/oren/src/foo.ts",
      old_string: "  return token(user);",
      new_string: "  if (await bcrypt.compare(user.password, stored)) {\n    return token(user);\n  }",
    });
    assert.equal(f!.Title, "Edit file");
    assert.equal(f!.Target, "~/src/foo.ts");
    assert.match(f!.Annotation, /\+3 -1/);
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

describe("classify - project path handling", () => {
  it("treats relative and absolute in-project edits as warning", async () => {
    const { classify } = await import("../src/classify.js");
    assert.equal(classify("Edit", { file_path: "README.md" }, process.cwd()), "warning");
    assert.equal(classify("Edit", { file_path: `${process.cwd()}/README.md` }, process.cwd()), "warning");
  });

  it("treats outside-project writes as review", async () => {
    const { classify } = await import("../src/classify.js");
    assert.equal(classify("Write", { file_path: "../outside.txt" }, process.cwd()), "review");
  });

  it("reads NotebookEdit notebook_path", () => {
    const f = describeFields("NotebookEdit", { notebook_path: "notebooks/demo.ipynb" });
    assert.equal(f!.Title, "Edit notebook");
    assert.equal(f!.Target, "notebooks/demo.ipynb");
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

describe("Email - sentence-style", () => {
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
    assert.ok(f!.Subline && f!.Subline.includes("attachment: contract.pdf (412 KB)"));
  });

  it("no Key:value Path/Cc/Subject keys in output", () => {
    const f = describeFields("mcp__gmail__send_email", { to: "a@b.com", subject: "s", body: "b" });
    assert.equal(f!.To, undefined);
    assert.equal(f!.Cc, undefined);
    assert.equal(f!.Subject, undefined);
    assert.equal(f!.From, undefined);
  });
});

describe("Payment - sentence-style", () => {
  it("charge_card -> 'Charge $X to card ending Y' + merchant subline", () => {
    const f = describeFields("mcp__stripe__charge_card", {
      amount: 4200,
      currency: "usd",
      last4: "4242",
      merchant: "Acme Inc",
    });
    assert.match(f!.Title, /^Charge \$42\.00 to card ending 4242/);
    assert.match(f!.Subline!, /merchant Acme Inc/);
  });

  it("create_payment with merchant -> 'Send $X to <merchant>'", () => {
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

describe("Send message - sentence-style", () => {
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
    assert.equal(describeOne("Bash", { command: "git push origin main" }), "Push main -> origin");
  });
});

describe("Bash - shell file writes", () => {
  it("echo > path -> title 'Create file', target = path, body = content", () => {
    const f = describeFields("Bash", { command: 'echo "hello world" > /home/u/note.txt' });
    assert.equal(f!.Title, "Create file");
    assert.equal(f!.Target, "~/note.txt");
    assert.equal(f!.Body, "hello world");
  });

  it("echo >> path -> title 'Append to file', target = path", () => {
    const f = describeFields("Bash", { command: 'echo "hello" >> /tmp/log.txt' });
    assert.equal(f!.Title, "Append to file");
    assert.equal(f!.Target, "/tmp/log.txt");
    assert.equal(f!.Body, "hello");
  });

  it("/dev/null redirect is not a file write", () => {
    const f = describeFields("Bash", { command: 'echo "hi" > /dev/null' });
    assert.notEqual(f!.Title, "Create file");
  });

  it("cp -> title 'Copy file', target = 'src -> dest'", () => {
    const f = describeFields("Bash", { command: "cp /etc/passwd /tmp/backup" });
    assert.equal(f!.Title, "Copy file");
    assert.equal(f!.Target, "/etc/passwd -> /tmp/backup");
  });

  it("mv -> title 'Move file', target = 'src -> dest'", () => {
    const f = describeFields("Bash", { command: "mv old.txt new.txt" });
    assert.equal(f!.Title, "Move file");
    assert.equal(f!.Target, "old.txt -> new.txt");
  });

  it("tee -a -> title 'Append to file'", () => {
    const f = describeFields("Bash", { command: 'echo "x" | tee -a /var/log/app.log' });
    assert.equal(f!.Title, "Append to file");
    assert.equal(f!.Target, "/var/log/app.log");
  });

  it("sed -i -> title 'Edit file', target = filename", () => {
    const f = describeFields("Bash", { command: "sed -i 's/foo/bar/g' config.yml" });
    assert.equal(f!.Title, "Edit file");
    assert.equal(f!.Target, "config.yml");
  });

  it("touch -> title 'Create empty file', target = path", () => {
    const f = describeFields("Bash", { command: "touch /tmp/marker" });
    assert.equal(f!.Title, "Create empty file");
    assert.equal(f!.Target, "/tmp/marker");
  });
});

describe("classify - shell write tier rules", () => {
  let classify: typeof import("../src/classify.js").classify;
  it("imports classify", async () => {
    ({ classify } = await import("../src/classify.js"));
  });

  it("echo > path always prompts (review) - content-creation idiom", () => {
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

  it("cp is safe (just moves existing bytes)", () => {
    const tier = classify("Bash", { command: "cp /etc/passwd /tmp/x" });
    assert.equal(tier, "safe");
  });

  it("mv is safe", () => {
    const tier = classify("Bash", { command: "mv a.txt b.txt" });
    assert.equal(tier, "safe");
  });

  it("touch is review (creates new file)", () => {
    const tier = classify("Bash", { command: "touch /tmp/marker" });
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

  it("dd of= is review", () => {
    const tier = classify("Bash", { command: "dd if=/dev/zero of=/tmp/zeros bs=1M count=10" });
    assert.equal(tier, "review");
  });
});

describe("classify - SQL inside wrappers", () => {
  let classify: typeof import("../src/classify.js").classify;
  it("imports classify", async () => {
    ({ classify } = await import("../src/classify.js"));
  });

  it("python3 -c with DROP TABLE -> high_stakes", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('DROP TABLE users')"`,
    });
    assert.equal(tier, "high_stakes");
  });

  it("python3 -c with DELETE FROM -> high_stakes", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('DELETE FROM users')"`,
    });
    assert.equal(tier, "high_stakes");
  });

  it("python3 -c with UPDATE no WHERE -> high_stakes", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('UPDATE users SET active=1')"`,
    });
    assert.equal(tier, "high_stakes");
  });

  it("python3 -c with UPDATE + WHERE -> review", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('UPDATE users SET active=1 WHERE id=2')"`,
    });
    assert.equal(tier, "review");
  });

  it("python3 -c with CREATE TABLE -> review (reported case)", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('CREATE TABLE products (id INTEGER)')"`,
    });
    assert.equal(tier, "review");
  });

  it("python3 -c with INSERT INTO -> review", () => {
    const tier = classify("Bash", {
      command: `python3 -c "import sqlite3; sqlite3.connect('demo.db').execute('INSERT INTO products VALUES (1)')"`,
    });
    assert.equal(tier, "review");
  });

  it("node -e with DROP TABLE -> high_stakes", () => {
    const tier = classify("Bash", {
      command: `node -e "require('better-sqlite3')('x').exec('DROP TABLE t')"`,
    });
    assert.equal(tier, "high_stakes");
  });

  it("sqlite3 db with TRUNCATE -> high_stakes", () => {
    const tier = classify("Bash", { command: `sqlite3 demo.db "TRUNCATE products"` });
    assert.equal(tier, "high_stakes");
  });

  it("psql -c with CREATE TABLE -> review", () => {
    const tier = classify("Bash", { command: `psql -c "CREATE TABLE t (id int)"` });
    assert.equal(tier, "review");
  });

  it("node heredoc with DROP TABLE -> high_stakes", () => {
    const cmd = `node - <<'EOF'\ndb.exec('DROP TABLE x');\nEOF`;
    assert.equal(classify("Bash", { command: cmd }), "high_stakes");
  });

  it("python3 -c without SQL -> review (default unchanged)", () => {
    const tier = classify("Bash", { command: `python3 -c "print(1)"` });
    assert.equal(tier, "review");
  });
});

describe("Unknown tool fallback", () => {
  it("renders args as body, tool name as title", () => {
    const f = describeFields("weirdtool", { foo: "bar", n: 42 });
    assert.equal(f!.Title, "weirdtool");
    assert.ok(f!.Body && f!.Body.includes("foo: bar"));
  });
});
