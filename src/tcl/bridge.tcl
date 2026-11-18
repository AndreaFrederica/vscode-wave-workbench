# SPDX-License-Identifier: MPL-2.0
# This Source Code Form is subject to the terms of the Mozilla Public
# License, v. 2.0. If a copy of the MPL was not distributed with this
# file, You can obtain one at https://mozilla.org/MPL/2.0/.

# A real Tcl interpreter with a safe child for user nWave scripts.
fconfigure stdout -buffering line -encoding utf-8
fconfigure stdin -buffering line -encoding utf-8
interp create -safe wave
proc encode {text} { binary encode base64 -maxlen 0 [encoding convertto utf-8 $text] }
proc decode {text} { encoding convertfrom utf-8 [binary decode base64 $text] }
proc quoteJson {text} {
    set result {"}
    foreach ch [split $text {}] {
        scan $ch %c code
        if {$ch eq "\\"} {append result {\\}} elseif {$ch eq {"}} {append result {\"}} elseif {$code < 32} {append result [format {\u%04x} $code]} else {append result $ch}
    }
    append result {"}
    return $result
}
proc nodeJson {value depth} {
    set result "\{\"value\":[quoteJson $value]"
    if {$depth > 0 && ![catch {llength $value}]} {
        set children {}
        foreach child $value {lappend children [nodeJson $child [expr {$depth-1}]]}
        append result ",\"items\":\[[join $children ,]\]"
    }
    append result "\}"
    return $result
}
proc rpc {name args} {
    set nodes {}
    foreach arg $args {lappend nodes [nodeJson $arg 2]}
    puts "CALL\t[encode $name]\t[encode "\[[join $nodes ,]\]"]\t[encode $::scriptDir]"
    if {[gets stdin response] < 0} {error {Wave host disconnected}}
    set fields [split $response \t]
    set value [decode [lindex $fields 1]]
    if {[lindex $fields 0] eq "ERROR"} {return -code error $value}
    return $value
}
proc scriptSource {filename} {
    set absolute [file normalize [file join $::scriptDir $filename]]
    if {[file size $absolute] > 1048576} {error {Script size exceeds 1 MiB}}
    set channel [open $absolute r];fconfigure $channel -encoding utf-8
    set content [read $channel];close $channel
    set old $::scriptDir;set ::scriptDir [file dirname $absolute]
    try {interp eval wave $content} finally {set ::scriptDir $old}
}
proc restore {args} {
    set filename [rpc __restore {*}$args]
    return [scriptSource $filename]
}
proc safeFile {operation args} {
    if {$operation ni {join dirname tail rootname extension normalize isfile isdirectory exists}} {error "Unsupported file subcommand: $operation"}
    return [file $operation {*}$args]
}
proc logPuts {args} {puts "LOG\t[encode [join $args { }]]"}
proc unknownWave {name args} {error "Unsupported Verdi/nWave command: $name. Use waveHelp to list supported commands."}
set names {waveFindSignals waveGetEvents waveDecode waveDecodeEvents waveAnnotate waveView waveGroup waveTooltip waveLayout waveBusLabels waveRestoreView wvCreateWindow wvGetCurrentWindow wvOpenFile wvAddSignal wvDeleteSignal wvSelectSignal wvSetCursor wvSetMarker wvZoom wvZoomAll wvZoomIn wvZoomOut wvZoomCursorMarker wvSetRadix wvGetSigValueByTime wvIsSignalExistInWaveform wvSetWindowTimeUnit wvGetWindowTimeUnit wvSearchNext wvSearchPrev wvSaveSignal srcGetFileName srcSetScope waveHelp}
foreach name $names {interp alias wave $name {} rpc $name}
interp alias wave wvRestoreSignal {} restore
interp alias wave source {} scriptSource
interp alias wave file {} safeFile
interp alias wave puts {} logPuts
interp alias wave unknown {} unknownWave
set commandBudget 0
while {[gets stdin line] >= 0} {
    set fields [split $line \t]
    set ::scriptDir [decode [lindex $fields 1]]
    incr commandBudget 200000
    interp limit wave command -value $commandBudget
    # Match the host's 120-second deadline, including time spent in SDK RPCs.
    interp limit wave time -seconds [expr {[clock seconds]+120}]
    set code [catch {interp eval wave [decode [lindex $fields 0]]} result]
    puts "DONE\t[expr {$code ? {ERROR} : {OK}}]\t[encode $result]"
}
