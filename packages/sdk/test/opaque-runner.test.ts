import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/classify.js";
import { describe as describeAction, describeFields, OPAQUE_RUNNER_FOOTNOTE } from "../src/describe.js";

const off = (command: string) => classify("Bash", { command }, { sandboxEnforced: false });
const on = (command: string) => classify("Bash", { command }, { sandboxEnforced: true });
const plain = (command: string) => classify("Bash", { command });

// Runners the hook cannot see inside. Child processes (the cargo test incident)
// never arrive as their own tool call.
const RUNNERS = [
  "cargo test",
  "cargo test --lib",
  "cargo test foo::bar",
  "cargo +nightly test foo",
  "cargo --manifest-path Cargo.toml test",
  "npm test",
  "npm t",
  "npm run build",
  "npm run test -- --coverage",
  "npm start",
  "pnpm test",
  "pnpm run lint",
  "pnpm build",
  "yarn test",
  "yarn run test",
  "yarn build",
  "bun test",
  "pytest",
  "pytest -q tests",
  "py.test -q",
  "python -m pytest",
  "python3 -m pytest tests/",
  "python3 -m unittest",
  "python scripts/check.py",
  "go test",
  "go test ./...",
  "go -C . test ./...",
  "make test",
  "make",
  "make -C pkg test",
  "./script.sh",
  "./scripts/foo.sh --flag",
  "../bin/run",
  "bash script.sh",
  "bash ./script.sh",
  "sh scripts/run.sh",
  "source scripts/env.sh",
  "node scripts/x.mjs",
  "node server.js",
  "node --experimental-strip-types scripts/x.ts",
  "node --test",
  "tsx scripts/x.ts",
  "npx vitest",
  "npx --yes tsx --test file.test.ts",
  "npx tsx --test packages/sdk/test/classify.test.ts",
  "bunx vitest",
  "pnpm dlx vitest",
  "npm exec vitest",
  "FOO=bar cargo test",
  "FOO=bar npm test",
  "command npm test",
  'HOME="$EMPTYHOME" env -u OKED_API_KEY npm test',
  "env -u CI npm test",
  "cd packages/sdk && npm test",
  "cd packages/sdk && cargo test",
  "npm test 2>&1 | tail -20",
  "cd packages/sdk && npm test 2>&1 | tail -20",
  "true && pytest -q",
  "bash -c 'cargo test'",
  "bash -lc 'npm test'",
  "git status && cargo test",
];

describe("opaque runners ask when the sandbox is not enforcing", () => {
  for (const command of RUNNERS) {
    it(`${command} → review off, safe on, safe when unset`, () => {
      assert.equal(off(command), "review", "sandbox off");
      assert.equal(on(command), "safe", "sandbox on");
      assert.equal(plain(command), "safe", "sandbox unset");
    });
  }
});

describe("opaque runners do not change other commands", () => {
  const cases: Array<[string, "safe" | "warning" | "review" | "high_stakes"]> = [
    ["ls", "safe"],
    ["git status", "safe"],
    ["cat README.md", "safe"],
    ["grep -n pytest packages/sdk/src/classify.ts", "safe"],
    ["echo cargo test", "safe"],
    ["echo 'npm test && rm -rf ~'", "safe"],
    ["git status && ls", "safe"],
    ["node -e 'console.log(1)'", "safe"],
    ["node -v", "safe"],
    ["python3 -c 'print(1)'", "safe"],
    ["cargo build", "safe"],
    ["cargo check", "safe"],
    ["go build ./...", "safe"],
    ["make -n", "safe"],
    ["make --dry-run test", "safe"],
    ["make --version", "safe"],
    ["npx --version", "safe"],
    ["npm --version", "safe"],
    ["npm run", "safe"],
    ["bash -c 'ls'", "safe"],
    ["bash -n script.sh", "safe"],
    ["npm install left-pad", "warning"],
    ["yarn install", "warning"],
    ['git commit -m "npm test"', "warning"],
    ["git push origin main", "warning"],
    ["npm test && git commit -m wip", "warning"],
    ["rm -rf ~", "high_stakes"],
    ["cargo test && rm -rf ~", "high_stakes"],
    ["npm test && git push --force", "high_stakes"],
    ["npx wrangler deploy", "high_stakes"],
  ];

  for (const [command, tier] of cases) {
    it(`${command} stays ${tier}`, () => {
      assert.equal(plain(command), tier);
      assert.equal(on(command), tier);
      // A compound whose other step is only a warning stays a warning when the
      // runner is contained, and rises to review when it is not.
      if (command === "npm test && git commit -m wip") {
        assert.equal(off(command), "review");
        return;
      }
      assert.equal(off(command), tier);
    });
  }
});

describe("opaque runner cards", () => {
  it("names the sandbox setting when the runner needs approval", () => {
    const fields = describeFields("Bash", { command: "npm test" }, { sandboxEnforced: false });
    assert.equal(fields?.Title, "Run npm tests");
    assert.equal(fields?.Footnote, OPAQUE_RUNNER_FOOTNOTE);
    assert.equal(describeAction("Bash", { command: "npm test" }, { sandboxEnforced: false }), "Run npm tests");
    assert.equal(OPAQUE_RUNNER_FOOTNOTE.includes("\u2014"), false);
    assert.match(OPAQUE_RUNNER_FOOTNOTE, /allowUnsandboxedCommands/);
  });

  it("omits the footnote when the sandbox is on or the command is not a runner", () => {
    assert.equal(describeFields("Bash", { command: "npm test" }, { sandboxEnforced: true })?.Footnote, undefined);
    assert.equal(describeFields("Bash", { command: "npm test" })?.Footnote, undefined);
    assert.equal(describeFields("Bash", { command: "ls" }, { sandboxEnforced: false })?.Footnote, undefined);
    assert.equal(describeFields("Bash", { command: "rm -rf ~" }, { sandboxEnforced: false })?.Footnote, undefined);
    assert.equal(
      describeFields("Bash", { command: "cargo test && rm -rf ~" }, { sandboxEnforced: false })?.Footnote,
      undefined,
    );
  });

  it("a compound runner uses the runner step as the title", () => {
    const fields = describeFields("Bash", { command: "cd packages/sdk && npm test" }, { sandboxEnforced: false });
    assert.equal(fields?.Title, "Run npm tests");
    assert.equal(fields?.Footnote, OPAQUE_RUNNER_FOOTNOTE);
  });

  it("Monitor and other shell tools use the same flag", () => {
    assert.equal(classify("Monitor", { command: "cargo test" }), "safe");
    assert.equal(classify("Monitor", { command: "cargo test" }, { sandboxEnforced: false }), "review");
    assert.equal(classify("Monitor", { command: "cargo test" }, { sandboxEnforced: true }), "safe");
    assert.equal(classify("exec", { command: "pytest -q" }, { sandboxEnforced: false }), "review");
    assert.equal(classify("exec", { cmd: "ls" }, { sandboxEnforced: false }), "safe");
  });
});
