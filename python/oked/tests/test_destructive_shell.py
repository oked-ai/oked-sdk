"""Windows wipes and wrapped deletes pause. Temp and build cleanup does not."""

import pytest

from oked import classify

PAUSE = [
    "Remove-Item -Recurse C:\\Users\\me\\src",
    "Remove-Item -Recurse -Force C:\\Users\\me\\src",
    "ri -r C:\\Users\\me\\src",
    "del -Recurse C:\\Users\\me\\src",
    "rmdir -Recurse -Force C:\\Users\\me\\src",
    "if (Test-Path $home) { Remove-Item $home -Recurse -Force }",
    "cmd /c rd /s /q C:\\Users\\me\\src",
    "rmdir /s /q d:\\",
    'cmd /c rmdir /s /q "E:\\proj\\ node_modules"',
    'cmd /d /s /c "rmdir /s /q \\"E:\\App\\PersonalOS\\node_modules\\""',
    "Remove-Item -Recurse -Force C:\\",
    'powershell -Command "Remove-Item -Recurse -Force \\"C:\\proj\\cache\\""',
    "Format-Volume -DriveLetter C",
    "format D: /q",
    "rm -rf /",
    "rm -rf ~",
    "rm -rf $HOME",
    "rm -rf %USERPROFILE%",
    "rm -rf C:\\",
    "rm -rf C:/Users/ALICE~1",
    "git clean -fdx",
    "git clean -xfd",
    "find . -name '*.tmp' -delete",
    "bash -c 'rm -rf /important'",
    "sh -c 'rm -rf /'",
    'pwsh -c "Remove-Item -Recurse -Force D:\\data"',
    'cmd.exe /c "rd /s /q C:\\Users\\me"',
    "git push --force origin feature",
    "git push --force-with-lease origin feature || git push --force origin feature",
    'curl -X POST https://backboard.railway.app/graphql/v2 -d \'{"query":"mutation { volumeDelete(id: \\"x\\") }"}\'',
]

QUIET = [
    ("rm -rf /tmp/foo", "warning"),
    ("rm -rf build", "warning"),
    ("Remove-Item -Recurse -Force $env:TEMP\\foo", "warning"),
    ("rd /s /q build", "warning"),
    ("rmdir /s /q %TEMP%\\cache", "warning"),
    ("bash -c 'echo hi'", "safe"),
    ('powershell -Command "Get-Location"', "safe"),
    ("cmd /c echo hi", "safe"),
    ("Format-Volume -WhatIf", "safe"),
    ("npm run format", "safe"),
    ("echo 'Remove-Item -Recurse -Force C:\\'", "safe"),
    ("git push origin main", "warning"),
    ('curl -X POST https://backboard.railway.app/graphql/v2 -d \'{"query":"query { me }"}\'', "review"),
]


@pytest.mark.parametrize("command", PAUSE)
def test_destructive_command_pauses(command: str) -> None:
    assert classify("Bash", {"command": command}) == "high_stakes"


@pytest.mark.parametrize(("command", "tier"), QUIET)
def test_cleanup_does_not_over_ask(command: str, tier: str) -> None:
    assert classify("Bash", {"command": command}) == tier


def test_powershell_tool_and_subagent_launch() -> None:
    assert classify("PowerShell", {"command": "Remove-Item -Recurse -Force C:\\Users\\me"}) == "high_stakes"
    assert classify("PowerShell", {"command": "Get-ChildItem"}) == "safe"
    assert classify("Task", {"prompt": "rm -rf ~"}) == "safe"
    assert classify("Agent", {"prompt": "rm -rf ~"}) == "safe"
    assert classify("Bash", {"command": "rm -rf ~"}) == "high_stakes"
