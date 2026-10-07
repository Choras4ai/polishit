# Execute the production apply branch with an in-memory Word range substitute.
# This tests PowerShell syntax/string/range logic, not Windows or COM automation.
$ErrorActionPreference = 'Stop'
$sourcePath = Join-Path $PSScriptRoot 'windows_review.ps1'
$tokens=$null; $errors=$null
[void][System.Management.Automation.Language.Parser]::ParseFile($sourcePath,[ref]$tokens,[ref]$errors)
if ($errors.Count) { throw ($errors | Out-String) }
$source=[IO.File]::ReadAllText($sourcePath)
$first=$source.IndexOf('[int]$targetStart=$request.targetRange.location')
$last=$source.IndexOf("`n        }",$first)
$apply=[scriptblock]::Create($source.Substring($first,$last-$first))
function Reject([string] $reason) { throw $reason }
function Assert-SimpleRange($range) {
    if ($range.Start -lt 0 -or $range.End -gt $range.Doc.Body.Length) { Reject 'invalid-range' }
}
function Assert-Foreground($handle,$ownerPid) {
    if ($doc.Writes.Count -ge $script:failAfter) { Reject 'source-window-changed' }
}
function Document-Identity($document,$ownerPid) { return $document.Body }
function Check($condition,[string] $message) { if (-not $condition) { throw $message } }
function New-Document([string] $text) {
    $document=[pscustomobject]@{Body=$text; TrackRevisions=$false; Writes=(New-Object System.Collections.Generic.List[object])}
    $document | Add-Member ScriptProperty Content { [pscustomobject]@{Text=$this.Body;Start=0;End=$this.Body.Length} }
    $document | Add-Member ScriptMethod Range {
        param([int]$first,[int]$last)
        $range=[pscustomobject]@{Doc=$this;Start=$first;End=$last}
        $range | Add-Member ScriptProperty Text { $this.Doc.Body.Substring($this.Start,$this.End-$this.Start) } {
            param($value)
            $old=$this.Doc.Body.Substring($this.Start,$this.End-$this.Start)
            $this.Doc.Writes.Add(@{start=$this.Start;old=$old;replacement=$value})
            $this.Doc.Body=$this.Doc.Body.Substring(0,$this.Start)+$value+$this.Doc.Body.Substring($this.End)
        }
        return $range
    }
    return $document
}
$checks=New-Object System.Collections.Generic.List[string]
foreach ($case in @(
    @{old="第一段。`r第二段。`r";new="第一段修改。`r第二段修改。`r"},
    @{old="`r第二段。`r`r";new="首段补充。`r`r末段补充。`r"},
    @{old="甲`r乙";new="`r乙乙乙"},
    @{old='普通单句';new='修订后的单句'}
)) {
    $script:failAfter=[int]::MaxValue
    $doc=New-Document ("前缀。"+$case.old+"后缀。`r")
    $start=3;$length=$case.old.Length;$range=$doc.Range($start,$start+$length)
    $handle=123;$ownerPid=456;$identity=$doc.Body;$script:writeStarted=$false
    $request=[pscustomobject]@{expectedText=$case.old;targetRange=@{location=$start;length=$length};replacement=$case.new}
    . $apply
    Check ($result.ok -and $result.verified) 'success was not verified'
    Check ($doc.Body -ceq ("前缀。"+$case.new+"后缀。`r")) 'body mismatch'
    Check ($result.text -ceq $case.new) 'selection mismatch'
    foreach ($write in $doc.Writes) { Check ($write.old -notmatch '[\r\n]' -and $write.replacement -notmatch '[\r\n]') 'paragraph marker was written' }
    $request.expectedText=$case.new;$request.replacement=$case.old;$request.targetRange.length=$case.new.Length
    $length=$case.new.Length;$range=$doc.Range($start,$start+$length);$identity=$doc.Body
    . $apply
    Check ($doc.Body -ceq ("前缀。"+$case.old+"后缀。`r")) 'undo mismatch'
    $checks.Add('multi-paragraph replace and undo, boundaries and empty paragraphs preserved')
}
foreach ($replacement in @("甲乙", "甲`r乙`r丙", "甲`n乙", "甲`t乙", "甲$([char]7)乙")) {
    $script:failAfter=[int]::MaxValue;$doc=New-Document "甲`r乙`r"
    $start=0;$length=3;$range=$doc.Range(0,3);$identity=$doc.Body;$script:writeStarted=$false
    $request=[pscustomobject]@{expectedText="甲`r乙";targetRange=@{location=0;length=3};replacement=$replacement}
    try { . $apply; throw 'structural edit incorrectly allowed' }
    catch { Check ($_.Exception.Message -eq 'structural-edit-unsupported') 'unexpected structural rejection' }
    Check ($doc.Writes.Count -eq 0 -and -not $script:writeStarted) 'rejected edit wrote text'
}
$checks.Add('paragraph changes and control characters rejected before writes')
$script:failAfter=1;$doc=New-Document "甲`r乙`r"
$start=0;$length=3;$range=$doc.Range(0,3);$identity=$doc.Body;$script:writeStarted=$false
$request=[pscustomobject]@{expectedText="甲`r乙";targetRange=@{location=0;length=3};replacement="甲甲`r乙乙"}
try { . $apply; throw 'foreground switch incorrectly allowed' }
catch { Check ($_.Exception.Message -eq 'source-window-changed') 'unexpected foreground failure' }
Check ($doc.Writes.Count -eq 1 -and $script:writeStarted) 'partial write must remain uncertain'
$checks.Add('foreground changes between segments stop further writing and retain uncertainty')
@{ok=$true;runtime=$PSVersionTable.PSVersion.ToString();platform=$PSVersionTable.Platform;checks=@($checks.ToArray());scope='production PowerShell apply branch with Word range substitute; not Windows/COM acceptance'} | ConvertTo-Json -Depth 5
