// Redaction and the script-excerpt opt-out. No test runner.

import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { redactScriptExcerpt, resolveSendScriptContent, tryReadScriptFile, MAX_SCRIPT_READ } =
  await import("../dist/script-excerpt.js");

assert.equal(
  redactScriptExcerpt("print('hello')\nAPI_KEY=supersecretvalue\nprint('still')"),
  "print('hello')\nAPI_KEY=[REDACTED]\nprint('still')",
);
assert.equal(redactScriptExcerpt('password = "hunter2hunter2"'), "password = [REDACTED]");
assert.equal(redactScriptExcerpt("token: 'abcd1234token'"), "token: [REDACTED]");
assert.equal(redactScriptExcerpt('const apiKey = "sk-live-secret"'), "const apiKey = [REDACTED]");
assert.equal(redactScriptExcerpt("export SECRET=abcdef"), "export SECRET=[REDACTED]");
assert.equal(
  redactScriptExcerpt('export const API_KEY = "from-export"'),
  "export const API_KEY = [REDACTED]",
);
assert.equal(
  redactScriptExcerpt('aws_secret_access_key = "wJalrXUtnFEMI"'),
  "aws_secret_access_key = [REDACTED]",
);
assert.equal(redactScriptExcerpt('DB_PASSWORD=hunter2'), "DB_PASSWORD=[REDACTED]");
assert.equal(redactScriptExcerpt('  "api_key": "json-secret"'), '  "api_key": [REDACTED]');
assert.equal(redactScriptExcerpt("# API_KEY=commentsecret"), "# API_KEY=[REDACTED]");
assert.equal(
  redactScriptExcerpt('keyboard = "qwerty"\nmonkey = 1'),
  'keyboard = "qwerty"\nmonkey = 1',
);
assert.equal(redactScriptExcerpt("id = 'AKIAIOSFODNN7EXAMPLE'"), "id = '[REDACTED]'");
assert.equal(
  redactScriptExcerpt("id = 'ASIAIOSFODNN7EXAMPLE'"),
  "id = '[REDACTED]'",
);
assert.equal(
  redactScriptExcerpt("Authorization: Bearer abcdefghijklmnopqrstuvwxyz"),
  "Authorization: Bearer [REDACTED]",
);
assert.equal(
  redactScriptExcerpt("-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----\nprint(1)"),
  "[REDACTED]\nprint(1)",
);
assert.equal(
  redactScriptExcerpt("-----BEGIN RSA PRIVATE KEY-----\ntruncated-no-end"),
  "[REDACTED]",
);
assert.equal(redactScriptExcerpt("print('hello')"), "print('hello')");
console.log("OK redactScriptExcerpt");

const prev = process.env.OKED_SEND_SCRIPT_CONTENT;
try {
  delete process.env.OKED_SEND_SCRIPT_CONTENT;
  assert.equal(resolveSendScriptContent(undefined), true);
  process.env.OKED_SEND_SCRIPT_CONTENT = "0";
  assert.equal(resolveSendScriptContent(undefined), false);
  process.env.OKED_SEND_SCRIPT_CONTENT = "false";
  assert.equal(resolveSendScriptContent(undefined), false);
  process.env.OKED_SEND_SCRIPT_CONTENT = "1";
  assert.equal(resolveSendScriptContent(undefined), true);
  process.env.OKED_SEND_SCRIPT_CONTENT = "true";
  assert.equal(resolveSendScriptContent(undefined), true);
  process.env.OKED_SEND_SCRIPT_CONTENT = "maybe";
  assert.equal(resolveSendScriptContent(undefined), true);
  process.env.OKED_SEND_SCRIPT_CONTENT = "0";
  assert.equal(resolveSendScriptContent(true), true, "plugin config true wins over env 0");
  process.env.OKED_SEND_SCRIPT_CONTENT = "1";
  assert.equal(resolveSendScriptContent(false), false, "plugin config false wins over env 1");
} finally {
  if (prev === undefined) delete process.env.OKED_SEND_SCRIPT_CONTENT;
  else process.env.OKED_SEND_SCRIPT_CONTENT = prev;
}
console.log("OK resolveSendScriptContent");

{
  const dir = mkdtempSync(join(tmpdir(), "oked-script-"));
  const script = join(dir, "deploy.py");
  const marker = "TAIL_MARKER_SHOULD_NOT_APPEAR";
  writeFileSync(script, `print('x')\n${"A".repeat(5000)}\n${marker}\n`);
  const excerpt = tryReadScriptFile(`python ${script}`);
  assert.ok(excerpt, "recognized python script is read");
  assert.equal(excerpt.length, MAX_SCRIPT_READ);
  assert.equal(excerpt.includes(marker), false);
  assert.equal(tryReadScriptFile(`bash ${join(dir, "foo.sh")}`), undefined);
  writeFileSync(join(dir, "foo.sh"), "SECRET=should-not-be-read\n");
  assert.equal(tryReadScriptFile(`bash ${join(dir, "foo.sh")} && git push --force`), undefined);
  console.log("OK tryReadScriptFile cap and shell-script skip");
}
