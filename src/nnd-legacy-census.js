// SPDX-License-Identifier: Apache-2.0
import { ContractError } from './ids.js';
import { runPrivateWindowsProgram } from './nnd-service-private-windows.js';

export const NND_CENSUS_NATIVE_TYPES = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class NndArgv {
 [DllImport("shell32.dll", SetLastError=true)] static extern IntPtr CommandLineToArgvW([MarshalAs(UnmanagedType.LPWStr)] string text,out int count);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle,uint timeout);
 [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr handle,out long created,out long exited,out long kernel,out long user);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 public static string Probe(int pid,long snapshotCreated) {
  if(pid<1) return "unknown";
  var handle=OpenProcess(0x00101000,false,pid);
  if(handle==IntPtr.Zero) return Marshal.GetLastWin32Error()==87 ? "exited" : "unknown";
  try {
   var wait=WaitForSingleObject(handle,0);
   if(wait==0) return "exited";
   if(wait!=258 || snapshotCreated<=0) return "unknown";
   long created,exited,kernel,user;
   if(!GetProcessTimes(handle,out created,out exited,out kernel,out user)) return "unknown";
   // Invariant: CIM timestamps have microsecond precision; a reused live PID cannot inherit stale command-line evidence.
   return created/10==snapshotCreated/10 ? "same" : "unknown";
  } finally { CloseHandle(handle); }
 }
 public static string[] Parse(string text) {
  int count; var pointer=CommandLineToArgvW(text,out count);
  if(pointer==IntPtr.Zero) throw new Exception("argv");
  try { if(count>256) throw new Exception("bound"); var values=new string[count];
   for(int i=0;i<count;i++) values[i]=Marshal.PtrToStringUni(Marshal.ReadIntPtr(pointer,i*IntPtr.Size));
   return values;
  } finally { LocalFree(pointer); }
 }
}
'@
`;
const PROGRAM = String.raw`$ErrorActionPreference='Stop'
$request=[Console]::In.ReadToEnd()|ConvertFrom-Json
` + NND_CENSUS_NATIVE_TYPES + String.raw`
$count=0; $legacy=0; $unknown=0; $legacyPids=@(); $unknownPids=@()
$selectedName=[IO.Path]::GetFileName([string]$request.node)
foreach($p in Get-CimInstance -ClassName Win32_Process) {
 $count++; if($count -gt 4096) { throw 'process bound' }
 $knownRuntime=$p.Name -in @('node.exe','nna.exe','NotNativeAgent.exe',$selectedName)
 # Security: historical descriptors can name a renamed Node executable. Readable exact CLI argv identifies that owner independently of its current executable name.
 if(-not $knownRuntime) {
  if([string]::IsNullOrWhiteSpace($p.CommandLine) -or $p.CommandLine.Length -gt 32768) { continue }
  try { $candidate=[NndArgv]::Parse($p.CommandLine) } catch { continue }
  $candidateScript=-1
  for($i=1;$i -lt $candidate.Length;$i++) { if($candidate[$i] -match '(?:^|[\\/])cli\.js$') { $candidateScript=$i; break } }
  if($candidateScript -lt 0 -or $candidateScript+1 -ge $candidate.Length -or $candidate[$candidateScript+1] -ne 'nnd') { continue }
 }
 # Invariant: exited snapshots need native exit proof; live snapshots need native creation identity before classification.
 $created=0
 try { if($null -ne $p.CreationDate) { $created=$p.CreationDate.ToUniversalTime().ToFileTimeUtc() } } catch { $created=0 }
 $state=[NndArgv]::Probe([int]$p.ProcessId,[long]$created)
 if($state -eq 'exited') { continue }
 if($state -ne 'same') { $unknown++; $unknownPids += [int64]$p.ProcessId; continue }
 if([string]::IsNullOrWhiteSpace($p.CommandLine) -or $p.CommandLine.Length -gt 32768) { $unknown++; $unknownPids += [int64]$p.ProcessId; continue }
 try { $a=[NndArgv]::Parse($p.CommandLine) } catch { $unknown++; $unknownPids += [int64]$p.ProcessId; continue }
 $script=-1
 for($i=1;$i -lt $a.Length;$i++) { if($a[$i] -match '(?:^|[\\/])cli\.js$') { $script=$i; break } }
 if($script -lt 0) {
  if($a -contains 'nnd') { $unknown++; $unknownPids += [int64]$p.ProcessId }; continue
 }
 $tail=@($a | Select-Object -Skip ($script+1))
 if($tail.Count -eq 0 -or $tail[0] -in @('tui','text','headless','host','integration','opencode')) { continue }
 if($tail[0] -ne 'nnd') { if($tail -contains 'nnd') { $unknown++; $unknownPids += [int64]$p.ProcessId }; continue }
 $operands=@($tail | Select-Object -Skip 1 | Where-Object { $_ -notin @('--no-color','--reduced-motion') })
 if($operands.Count -gt 0 -and $operands[0] -eq 'serve') { $legacy++; $legacyPids += [int64]$p.ProcessId }
 elseif($operands.Count -eq 0 -or $operands[0] -notin @('service','package')) { $unknown++; $unknownPids += [int64]$p.ProcessId }
}
$legacyString=($legacyPids|ForEach-Object{[int64]$_}) -join ','
$unknownString=($unknownPids|ForEach-Object{[int64]$_}) -join ','
[Console]::Out.WriteLine((@{version='1.0';scanned=$count;legacy=$legacy;unknown=$unknown;legacyPids=$legacyString;unknownPids=$unknownString}|ConvertTo-Json -Compress))
`;

function parsePids(value) {
  if (typeof value !== 'string') return [];
  if (!value.length) return [];
  const pids = value.split(',').map((part) => Number(part));
  if (!pids.every((pid) => Number.isSafeInteger(pid) && pid > 0 && pid < 4294967295)) return [-1];
  return pids;
}
// Raw census: verified counters plus named ownership evidence. Never throws
// for live owners; only for an unverifiable scan, which is not quiescence.
export async function probeNndLegacyOwners(identity, signal) {
  let result;
  try { result = await runPrivateWindowsProgram(PROGRAM, { node: identity.node }, signal); }
  catch (cause) { throw new ContractError('nnd_owner_unverified', 'Legacy NND process census could not establish quiescence', { cause }); }
  const legacyPids = parsePids(result?.legacyPids), unknownPids = parsePids(result?.unknownPids);
  if (!result || result.version !== '1.0' || !Number.isSafeInteger(result.scanned) || result.scanned < 1
    || result.scanned > 4096 || !Number.isSafeInteger(result.legacy) || !Number.isSafeInteger(result.unknown)
    || result.legacy < 0 || result.unknown < 0
    || result.legacy !== legacyPids.length || result.unknown !== unknownPids.length
    || legacyPids.includes(-1) || unknownPids.includes(-1)) {
    throw new ContractError('nnd_owner_unverified', 'Legacy NND process census could not establish quiescence');
  }
  return Object.freeze({ scanned: result.scanned, legacy: result.legacy, unknown: result.unknown,
    legacy_pids: Object.freeze(legacyPids), unknown_pids: Object.freeze(unknownPids) });
}
export async function scanNndLegacyOwners(identity, signal) {
  const probe = await probeNndLegacyOwners(identity, signal);
  if (probe.legacy !== 0 || probe.unknown !== 0) {
    throw new ContractError('nnd_owner_unverified', 'A legacy or unverifiable NND process must be closed before adoption. No process was terminated.');
  }
  return Object.freeze({ version: '1.0', scanned: probe.scanned, legacy: 0, unknown: 0, checked_at: new Date().toISOString() });
}
