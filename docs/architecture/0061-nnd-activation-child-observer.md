# Architecture decision 0061: Recorded NND child process observation

Status: private barred recovery prerequisite. This observer is not connected to
native admission, activation cleanup, or a process stop.

Activation evidence records the GUI child's Windows PID and process start time
as UTC ticks. A PID alone cannot identify that child after Windows reuses it.
The observer accepts only the exact recorded identity shape and returns one of
three states: `same_process`, `old_process_gone`, or `unknown`.

A successful `Get-CimInstance Win32_Process` query that finds no PID proves the
old child is gone. When a PID exists, `Get-Process` supplies start-time ticks.
Equal ticks retain the child; different ticks prove PID reuse. A failed
`Get-Process` call triggers a second CIM query. If the PID vanished, the old
child is gone. If it still exists, the observer makes one bounded fresh attempt.
Query failure, malformed output, cancellation, or a second race is `unknown`.
An error from `Get-Process` alone never proves exit.

This result is only evidence for a later, separately authorized recovery
protocol. That protocol must preserve the pending activation barrier until it
also resolves the controller, pointer, selected registration, and terminal
retirement evidence. The observer never terminates the target process.
