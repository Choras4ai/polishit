# Word COM bridge. Never selects/activates text or windows and never uses paste.
# GetPoint requires a visible range: https://learn.microsoft.com/office/vba/api/word.window.getpoint
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding($false)
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$script:writeStarted = $false

function Reject([string] $reason) { throw $reason }
function Hash-Text([string] $text) {
    $sha = [Security.Cryptography.SHA256]::Create()
    try { return [Convert]::ToBase64String($sha.ComputeHash([Text.Encoding]::Unicode.GetBytes($text))) }
    finally { $sha.Dispose() }
}
function Document-Identity($doc, [uint32] $ownerPid) {
    $started = (Get-Process -Id $ownerPid).StartTime.ToUniversalTime().Ticks
    return "$ownerPid|$started|$($doc.FullName)|$(Hash-Text ([string]$doc.Content.Text))"
}
function Assert-Foreground([long] $handle, [uint32] $ownerPid) {
    if ([RunshiWordNative]::GetForegroundWindow().ToInt64() -ne $handle) { Reject 'source-window-changed' }
    [uint32]$actualPid = 0
    [void][RunshiWordNative]::GetWindowThreadProcessId([IntPtr]$handle, [ref]$actualPid)
    if ($actualPid -ne $ownerPid) { Reject 'source-process-changed' }
}
function Assert-SimpleRange($range) {
    if ([int]$range.StoryType -ne 1) { Reject 'unsupported-story' }
    if ([int]$range.Fields.Count -gt 0 -or [int]$range.Tables.Count -gt 0 -or
        [int]$range.ContentControls.Count -gt 0 -or [int]$range.InlineShapes.Count -gt 0) { Reject 'structured-text-unsupported' }
    if ([int]$range.End - [int]$range.Start -ne ([string]$range.Text).Length) { Reject 'range-offset-ambiguous' }
}
function View-State($window) {
    $pane=$window.ActivePane
    return "$($window.Left)|$($window.Top)|$($window.Width)|$($window.Height)|$($pane.VerticalPercentScrolled)|$($pane.HorizontalPercentScrolled)|$($pane.View.Zoom.Percentage)"
}

try {
    $request = [Console]::In.ReadToEnd() | ConvertFrom-Json
    if ($request.action -notin @('probe', 'geometry', 'apply')) { Reject 'invalid-action' }
    Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RunshiWordNative {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
}
'@
    # Word GetPoint reports screen pixels; opt out of helper-side DPI virtualization.
    try {
        if ([RunshiWordNative]::SetThreadDpiAwarenessContext([IntPtr](-4)) -eq [IntPtr]::Zero) { Reject 'dpi-context-unavailable' }
    } catch { Reject 'dpi-context-unavailable' }
    $word = [Runtime.InteropServices.Marshal]::GetActiveObject('Word.Application')
    $window = $word.ActiveWindow
    $doc = $word.ActiveDocument
    [long]$handle = $window.Hwnd
    [uint32]$ownerPid = 0
    [void][RunshiWordNative]::GetWindowThreadProcessId([IntPtr]$handle, [ref]$ownerPid)
    Assert-Foreground $handle $ownerPid
    if ($doc.ReadOnly -or [int]$doc.ProtectionType -ne -1) { Reject 'document-not-editable' }
    # Tracked deletions make COM character offsets differ from the visible text.
    # Keep the user's setting intact; use native Word/add-in review in this mode.
    if ($doc.TrackRevisions -or [int]$doc.Revisions.Count -gt 0) { Reject 'tracked-revisions-unsupported' }
    $identity = Document-Identity $doc $ownerPid
    if ($request.action -eq 'probe') {
        $range = $window.Selection.Range.Duplicate
        Assert-SimpleRange $range
        $text = [string]$range.Text
        if ($text.Length -eq 0 -or $text.Length -gt 20000) { Reject 'selection-unavailable' }
        Assert-Foreground $handle $ownerPid
        $result = @{ ok=$true; text=$text; selectionRange=@{location=[int]$range.Start; length=[int]$range.End-[int]$range.Start}; frontmostPid=$ownerPid; windowHandle=$handle; documentId=$identity; bundleIdentifier='win32.word'; supportsRangeEditing=$true }
    } else {
        if ($handle -ne [long]$request.windowHandle -or $ownerPid -ne [uint32]$request.frontmostPid -or
            $identity -cne [string]$request.documentId -or $request.bundleIdentifier -ne 'win32.word') { Reject 'source-document-changed' }
        [int]$start = $request.selectionRange.location
        [int]$length = $request.selectionRange.length
        if ($start -lt 0 -or $length -lt 1 -or $length -gt 20000 -or $start + $length -gt $doc.Content.End) { Reject 'invalid-range' }
        $range = $doc.Range($start, $start + $length)
        Assert-SimpleRange $range
        if ([string]$range.Text -cne [string]$request.expectedText -or $length -ne ([string]$request.expectedText).Length) { Reject 'source-text-changed' }
        if ($request.action -eq 'geometry') {
            $view=View-State $window
            $rects = New-Object System.Collections.Generic.List[object]
            if (@($request.ranges).Count -gt 80) { Reject 'too-many-ranges' }
            $glyphCount=0
            foreach ($item in $request.ranges) {
                [int]$first = $item.location
                [int]$last = $first + [int]$item.length
                if ($first -lt $start -or $last -gt $start + $length -or $last -lt $first) { Reject 'invalid-range' }
                $glyphCount+=$last-$first
                if ($glyphCount -gt 2000) { Reject 'too-many-glyphs' }
                # One character at a time avoids a bounding box spanning several lines.
                # Consecutive glyph rectangles on the same line are merged below.
                $line = $null
                for ($pos = $first; $pos -lt [Math]::Max($last, $first + 1); $pos++) {
                    $glyph = $doc.Range($pos, [Math]::Min($pos + 1, $last))
                    [int]$x=0; [int]$y=0; [int]$w=0; [int]$h=0
                    try { $window.GetPoint([ref]$x, [ref]$y, [ref]$w, [ref]$h, $glyph) }
                    catch { if ($null -ne $line) { $rects.Add($line); $line=$null }; continue }
                    if ($last -eq $first -and $h -gt 0) { $w=2 }
                    if ($w -le 0 -or $h -le 0) { continue }
                    if ($null -ne $line -and [Math]::Abs($line.y - $y) -le 2 -and [Math]::Abs($line.height - $h) -le 2 -and $x -le $line.x + $line.width + 3 -and $x + $w -ge $line.x - 3) {
                        $right=[Math]::Max($line.x+$line.width, $x+$w)
                        $line.x=[Math]::Min($line.x,$x); $line.width=$right-$line.x
                    } else {
                        if ($null -ne $line) { $rects.Add($line) }
                        $line=@{id=[int]$item.id; x=$x; y=$y; width=$w; height=$h}
                    }
                }
                if ($null -ne $line) { $rects.Add($line) }
            }
            Assert-Foreground $handle $ownerPid
            if ((Document-Identity $doc $ownerPid) -cne $identity) { Reject 'source-document-changed' }
            if ((View-State $window) -cne $view) { Reject 'source-view-changed' }
            $result=@{ok=$true; rects=@($rects.ToArray()); coordinateSpace='physical'}
        } else {
            [int]$targetStart=$request.targetRange.location
            [int]$targetLength=$request.targetRange.length
            if ($targetStart -lt $start -or $targetLength -lt 0 -or $targetStart+$targetLength -gt $start+$length) { Reject 'invalid-range' }
            $replacement=[string]$request.replacement
            # Keep paragraph markers intact. Full-selection replace/undo may
            # span several paragraphs even when the paragraph structure did
            # not change; update prose segments from right to left instead.
            $old=([string]$range.Text).Substring($targetStart-$start,$targetLength)
            if ($old -match '[\x00-\x0C\x0E-\x1F]' -or $replacement -match '[\x00-\x0C\x0E-\x1F]') { Reject 'structural-edit-unsupported' }
            $oldParts=$old.Split([char]13)
            $newParts=$replacement.Split([char]13)
            if ($oldParts.Count -ne $newParts.Count) { Reject 'structural-edit-unsupported' }
            $before=[string]$doc.Content.Text
            $bodyStart=[int]$doc.Content.Start
            $wanted=$before.Substring(0,$targetStart-$bodyStart)+$replacement+$before.Substring($targetStart-$bodyStart+$targetLength)
            $expected=[string]$request.expectedText
            $newText=$expected.Substring(0,$targetStart-$start)+$replacement+$expected.Substring($targetStart-$start+$targetLength)
            $target=$doc.Range($targetStart,$targetStart+$targetLength)
            Assert-SimpleRange $target
            Assert-Foreground $handle $ownerPid
            if ((Document-Identity $doc $ownerPid) -cne $identity -or $doc.TrackRevisions) { Reject 'source-document-changed' }
            $offsets=New-Object System.Collections.Generic.List[int]
            $offset=$targetStart
            foreach ($part in $oldParts) { $offsets.Add($offset); $offset+=$part.Length+1 }
            for ($i=$oldParts.Count-1; $i -ge 0; $i--) {
                if ($oldParts[$i] -ceq $newParts[$i]) { continue }
                Assert-Foreground $handle $ownerPid
                if ([string]$doc.Content.Text -cne $before -or $doc.TrackRevisions) { Reject 'source-document-changed' }
                $piece=$doc.Range($offsets[$i],$offsets[$i]+$oldParts[$i].Length)
                Assert-SimpleRange $piece
                $script:writeStarted=$true
                $piece.Text=$newParts[$i]
                $before=$before.Substring(0,$offsets[$i]-$bodyStart)+$newParts[$i]+$before.Substring($offsets[$i]-$bodyStart+$oldParts[$i].Length)
                if ([string]$doc.Content.Text -cne $before) { Reject 'write-verification-failed' }
            }
            if ([string]$doc.Content.Text -cne $wanted) { Reject 'write-verification-failed' }
            $updated=$doc.Range($start,$start+$newText.Length)
            if ([string]$updated.Text -cne $newText) { Reject 'write-verification-failed' }
            $result=@{ok=$true; verified=$true; text=$newText; expectedText=$newText; selectionRange=@{location=$start;length=$newText.Length}; documentId=(Document-Identity $doc $ownerPid); frontmostPid=$ownerPid;windowHandle=$handle;bundleIdentifier='win32.word';supportsRangeEditing=$true;sourceMayHaveChanged=$false}
        }
    }
    [Console]::Out.WriteLine(($result | ConvertTo-Json -Depth 8 -Compress))
} catch {
    $reason=[string]$_.Exception.Message
    if ($reason -notmatch '^[a-z]+(?:-[a-z]+)*$') { $reason='word-unavailable' }
    [Console]::Out.WriteLine((@{ok=$false;reason=$reason;sourceMayHaveChanged=$script:writeStarted} | ConvertTo-Json -Compress))
}
