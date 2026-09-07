# Switch-day regulation research, run LOCALLY.
#
#   powershell -ExecutionPolicy Bypass -File scripts\regulation-research.ps1
#
# WHY LOCAL. The obvious home for this was a scheduled cloud agent, and one was
# built (routine trig_01UfqkR9Luyi365bwcfDACVq). It cannot work: the cloud
# sandbox's egress proxy blocks every source we rely on — serebii.net,
# pokemon.com, x.com, bulbapedia, victoryroad.pro, metavgc.com, rotomlabs.net,
# game8.co, pokeos.com and pikalytics.com all return EGRESS_BLOCKED / curl 000,
# as organization policy. WebSearch still works there, but it returns only
# titles and snippets, and snippets are exactly what the sourcing rules forbid
# acting on — the first search of that dry run once again asserted "Mega
# Golisopod: Shell Armor", the Mega Scolipede conflation, with no primary
# source. So the routine is disabled and the job runs here, where web access is
# unrestricted. Verified 2026-09-07.
#
# READ-ONLY BY CONSTRUCTION. The run gets Read/Grep/Glob/WebSearch/WebFetch and
# nothing else — no Edit, no Write, no Bash — so it physically cannot touch the
# repo. It reports; a human (with a normal session) does the wiring. That split
# is deliberate: the failure mode we care about is a confidently wrong ability
# pin poisoning every damage calc, and an unattended run should never be the
# thing that makes it.
#
# The prompt is the fenced block in docs/notes/regulation-switch-research-prompt.md,
# kept in one place so the next rotation edits one file.
[CmdletBinding()]
param(
    # Where reports land. Gitignored. Resolved in the BODY, not here:
    # $PSScriptRoot is not populated while param() defaults are evaluated.
    [string]$OutDir,
    [string]$Model = 'opus'
)

$ErrorActionPreference = 'Stop'
$here = if ($PSScriptRoot) { $PSScriptRoot } else { Split-Path -Parent $MyInvocation.MyCommand.Path }
$repo = Resolve-Path (Join-Path $here '..')
if (-not $OutDir) { $OutDir = Join-Path $repo 'research' }
$promptDoc = Join-Path $repo 'docs\notes\regulation-switch-research-prompt.md'
if (-not (Test-Path $promptDoc)) { throw "prompt doc missing: $promptDoc" }

# Pull the fenced block out of the note (everything between the first ``` pair).
$lines = Get-Content $promptDoc
$fences = @()
for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].TrimEnd() -eq '```') { $fences += $i } }
if ($fences.Count -lt 2) { throw "could not find a fenced prompt block in $promptDoc" }
$prompt = ($lines[($fences[0] + 1)..($fences[1] - 1)]) -join "`n"

# Override the prompt's hand-off section: this run reports, it does not write.
$prompt += @"


=== OVERRIDE FOR THIS RUN - REPORT ONLY ===
You are running unattended with READ-ONLY tools (Read, Grep, Glob, WebSearch,
WebFetch). You have no Edit, no Write and no Bash. Therefore:
- Do NOT attempt to change any file, run any command, commit, or open a PR.
  Ignore every instruction above that tells you to. A human does the wiring.
- Instead, END your reply with the findings themselves, structured task by task.
- For each of the four tasks state one of: CONFIRMED (with the exact source URLs
  and the exact values), STILL UNREVEALED, or BLOCKED (say what stopped you).
- Lead with a single line: "HEADLINE: <the one thing worth waking someone for>",
  or "HEADLINE: nothing new" if that is the truth. Nothing new is a fine answer
  and is much better than a guess.
- Where the instructions above tell you to edit a file, say precisely what the
  edit WOULD be (file, symbol, old value, new value) so it can be applied by
  hand and checked.
"@

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$stamp  = Get-Date -Format 'yyyy-MM-dd_HHmm'
$report = Join-Path $OutDir "regulation-research_$stamp.md"

Write-Output "repo:   $repo"
Write-Output "model:  $Model"
Write-Output "report: $report"
Write-Output "running (read-only tools; this takes a few minutes)..."

Push-Location $repo
try {
    $header = @(
        "# Regulation research - $(Get-Date -Format 'yyyy-MM-dd HH:mm K')",
        '',
        "Run by ``scripts/regulation-research.ps1`` (read-only, model=$Model).",
        ''
    ) -join "`n"
    Set-Content -Path $report -Value $header -Encoding utf8

    # NO `2>&1` here. Windows PowerShell 5.1 wraps a native exe's stderr in an
    # ErrorRecord (NativeCommandError) and fails the script even when the exe
    # returned 0 — and `claude` writes advisory warnings to stderr, so
    # redirecting turns every warning into a spurious failure.
    $out  = $prompt | & claude -p --model $Model --allowed-tools Read Grep Glob WebSearch WebFetch
    $exit = $LASTEXITCODE
    Add-Content -Path $report -Value ($out -join "`n") -Encoding utf8

    if ($exit -ne 0) {
        Add-Content -Path $report -Value "`n`n**claude exited $exit**" -Encoding utf8
        Write-Output "claude exited $exit - see the report"
    }
} finally {
    Pop-Location
}

Write-Output ''
Write-Output "=== HEADLINE ==="
Select-String -Path $report -Pattern 'HEADLINE:' | Select-Object -First 1 |
    ForEach-Object { $_.Line } | Write-Output
Write-Output ''
Write-Output "full report: $report"
