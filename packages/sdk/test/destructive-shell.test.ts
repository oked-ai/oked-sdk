import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { classify } from "../src/classify.js";
import { describeFields } from "../src/describe.js";

const bash = (command: string) => classify("Bash", { command });
const pauses = (tier: string) => tier === "review" || tier === "high_stakes";

// Commands that must wait for a person. Temp and build-output cleanup stays
// a warning (logged, no prompt). Quoted text stays data.
const PAUSE: Array<[string, string]> = [
  // PowerShell Remove-Item -Recurse, including -Force and aliases with -r.
  ["Remove-Item -Recurse C:\\Users\\me\\src", "high_stakes"],
  ["Remove-Item -Recurse -Force C:\\Users\\me\\src", "high_stakes"],
  ["Remove-Item -Force -Recurse -Path D:\\data", "high_stakes"],
  ["ri -r C:\\Users\\me\\src", "high_stakes"],
  ["del -Recurse C:\\Users\\me\\src", "high_stakes"],
  ["rmdir -Recurse -Force C:\\Users\\me\\src", "high_stakes"],
  // Codex #32684: $home is the profile. The assignment to a temp path does not stick.
  ["if (Test-Path $home) { Remove-Item $home -Recurse -Force }", "high_stakes"],
  ["Remove-Item -LiteralPath $HOME -Recurse -Force", "high_stakes"],
  // cmd recursive deletes.
  ["cmd /c rd /s /q C:\\Users\\me\\src", "high_stakes"],
  ["cmd /c rmdir /s C:\\Users\\me\\src", "high_stakes"],
  ["rmdir /s C:\\Users\\me\\src", "high_stakes"],
  ["rd /s /q C:\\Users\\me\\src", "high_stakes"],
  ["del /s /q C:\\Users\\me\\src", "high_stakes"],
  ["erase /s /q C:\\Users\\me\\src", "high_stakes"],
  // Antigravity: rmdir /s /q of a drive root.
  ["rmdir /s /q d:\\", "high_stakes"],
  ["rd /s /q D:\\", "high_stakes"],
  ["del /s /q C:\\", "high_stakes"],
  // Codex #57530 style: a quoted path with a space is not one node_modules folder.
  ["cmd /c rmdir /s /q \"E:\\proj\\ node_modules\"", "high_stakes"],
  // Codex #57530, the logged command. `\"` is the PowerShell-to-cmd collapse
  // onto the current drive root, even though the text names node_modules.
  ["cmd /d /s /c \"rmdir /s /q \\\"E:\\App\\PersonalOS\\node_modules\\\"\"", "high_stakes"],
  // Cursor: Remove-Item -Recurse -Force whose quotes collapse toward C:\.
  ["Remove-Item -Recurse -Force C:\\", "high_stakes"],
  ["powershell -Command \"Remove-Item -Recurse -Force \\\"C:\\proj\\cache\\\"\"", "high_stakes"],
  ["powershell.exe -NoProfile -Command \"Remove-Item -Recurse -Force C:\\Users\\me\"", "high_stakes"],
  // Disk format.
  ["Format-Volume -DriveLetter C", "high_stakes"],
  ["Format-Volume -DriveLetter D -FileSystem NTFS", "high_stakes"],
  ["format C:", "high_stakes"],
  ["format D: /fs:NTFS /q /y", "high_stakes"],
  ["sudo format E:", "high_stakes"],
  // Drive roots and the home directory, including the 8.3 profile alias.
  ["rm -rf /", "high_stakes"],
  ["rm -rf ~", "high_stakes"],
  ["rm -rf $HOME", "high_stakes"],
  ["rm -rf %USERPROFILE%", "high_stakes"],
  ["rm -rf C:\\", "high_stakes"],
  ["rm -rf D:/", "high_stakes"],
  ["rm -rf C:/Users/ALICE~1", "high_stakes"],
  ["rm -rf $env:USERPROFILE", "high_stakes"],
  // git clean -fdx outside temp and build output. Flag order does not matter.
  ["git clean -fdx", "high_stakes"],
  ["git clean -xfd", "high_stakes"],
  ["git clean --force -d -x", "high_stakes"],
  ["git -C /r clean -fdx", "high_stakes"],
  ["git clean -fdx src", "high_stakes"],
  // find -delete outside temp and build output.
  ["find . -name '*.tmp' -delete", "high_stakes"],
  ["find /home/me -delete", "high_stakes"],
  ["find / -delete", "high_stakes"],
  // Wrappers. The body is the command.
  ["bash -c 'rm -rf /important'", "high_stakes"],
  ["sh -c 'rm -rf /'", "high_stakes"],
  ["bash -lc 'rm -rf ~'", "high_stakes"],
  ["pwsh -c \"Remove-Item -Recurse -Force D:\\data\"", "high_stakes"],
  ["cmd.exe /c \"rd /s /q C:\\Users\\me\"", "high_stakes"],
  ["sh -c 'rmdir /s /q d:\\'", "high_stakes"],
  // claude-code#70378: --force after a failed --force-with-lease.
  ["git push --force origin feature", "high_stakes"],
  ["git push --force-with-lease origin feature || git push --force origin feature", "high_stakes"],
  // PocketOS / Railway: GraphQL volumeDelete.
  [
    "curl -X POST https://backboard.railway.app/graphql/v2 -H \"Authorization: Bearer tok\" -d '{\"query\":\"mutation { volumeDelete(volumeId: \\\"3d2c42fb-1111-2222-3333-444444444444\\\") }\"}'",
    "high_stakes",
  ],
];

const QUIET: Array<[string, string]> = [
  // Temp and build output. Logged or silent, not a prompt.
  ["rm -rf /tmp/foo", "warning"],
  ["rm -rf build dist", "warning"],
  ["rm -rf .next", "warning"],
  ["Remove-Item -Recurse -Force $env:TEMP\\foo", "warning"],
  ["Remove-Item -Recurse -Force C:\\Users\\me\\AppData\\Local\\Temp\\cache", "warning"],
  ["Remove-Item -Recurse -Force .\\build", "warning"],
  ["rd /s /q build", "warning"],
  ["rmdir /s /q %TEMP%\\cache", "warning"],
  ["del %TEMP%\\a.txt", "warning"],
  ["rmdir build/empty", "warning"],
  ["cmd /c rmdir /s /q C:\\Users\\me\\AppData\\Local\\Temp\\cache", "warning"],
  ["git clean -n", "safe"],
  ["git clean -fdxn", "safe"],
  ["git clean --dry-run -fdx", "safe"],
  ["git clean -fdx build dist", "warning"],
  ["git -C /tmp/repo clean -fdx", "warning"],
  ["cd /tmp/repo && git clean -fdx", "warning"],
  ["find /tmp/obj -delete", "warning"],
  ["find build -name '*.o' -delete", "warning"],
  ["bash -c 'echo hi'", "safe"],
  ["bash -c 'rm -rf /tmp/foo'", "warning"],
  ["powershell -Command \"Get-Location\"", "safe"],
  ["pwsh -c \"Get-ChildItem\"", "safe"],
  ["cmd /c echo hi", "safe"],
  ["Format-Volume -WhatIf", "safe"],
  ["npm run format", "safe"],
  ["cargo fmt", "safe"],
  ["format", "safe"],
  [`echo 'Remove-Item -Recurse -Force C:\\'`, "safe"],
  [`echo 'rmdir /s /q d:\\'`, "safe"],
  [`git commit -m 'rmdir /s /q d:\\'`, "warning"],
  ["git commit -m \"git clean -fdx\"", "warning"],
  ["grep -n format src/app.ts", "safe"],
  ["grep -c pattern file.ts", "safe"],
  ["git push origin main", "warning"],
  ["find . -name '*.tmp' -print", "safe"],
  // A GraphQL POST that does not delete a volume still asks, at review.
  ["curl -X POST https://backboard.railway.app/graphql/v2 -d '{\"query\":\"query { me }\"}'", "review"],
  ["curl -s https://example.com/health", "safe"],
];

describe("destructive shell rules", () => {
  for (const [command, tier] of PAUSE) {
    it(`pauses: ${command}`, () => {
      const got = bash(command);
      assert.equal(got, tier, command);
      assert.ok(pauses(got), command);
    });
  }

  for (const [command, tier] of QUIET) {
    it(`does not over-ask: ${command}`, () => {
      assert.equal(bash(command), tier, command);
    });
  }

  it("PowerShell tool calls use the same rules as Bash", () => {
    assert.equal(
      classify("PowerShell", { command: "Remove-Item -Recurse -Force C:\\Users\\me" }),
      "high_stakes",
    );
    assert.equal(classify("PowerShell", { command: "Get-ChildItem ." }), "safe");
    assert.equal(
      classify("PowerShell", { command: "Remove-Item -Recurse -Force $env:TEMP\\foo" }),
      "warning",
    );
  });

  it("a subagent launch stays safe; the tool call it makes is classified on its own", () => {
    // Claude Code names the tool Agent. Cursor and older sessions send Task.
    // The prompt is not a shell command. claude-code#105342 ran `rm -rf ~`
    // inside `cargo test`, so the tool call was the runner, not the rm.
    assert.equal(classify("Agent", { prompt: "rm -rf ~" }), "safe");
    assert.equal(classify("Task", { prompt: "rm -rf ~" }), "safe");
    assert.equal(bash("rm -rf ~"), "high_stakes");
    assert.equal(classify("Bash", { command: "cargo test" }, { sandboxEnforced: false }), "review");
    assert.equal(classify("Bash", { command: "cargo test" }), "safe");
  });

  it("rmdir /s is a recursive delete, not an empty folder", () => {
    const fields = describeFields("Bash", { command: "rmdir /s /q d:\\" });
    assert.equal(fields?.Title, "Delete file recursively");
    assert.equal(fields?.Target, "d:\\");
    assert.equal(describeFields("Bash", { command: "rmdir build/empty" })?.Title, "Delete empty folder");
  });
});
