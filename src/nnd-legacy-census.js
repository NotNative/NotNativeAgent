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
$count=0; $legacy=0; $unknown=0
$selectedName=[IO.Path]::GetFileName([string]$request.node)
foreach($p in Get-CimInstance -ClassName Win32_Process) {
 $count++; if($count -gt 4096) { throw 'process bound' }
 if($p.Name -notin @('node.exe','nna.exe','NotNativeAgent.exe',$selectedName)) { continue }
 # Invariant: exited snapshots need native exit proof; live snapshots need native creation identity before classification.
 $created=0
 try { if($null -ne $p.CreationDate) { $created=$p.CreationDate.ToUniversalTime().ToFileTimeUtc() } } catch { $created=0 }
 $state=[NndArgv]::Probe([int]$p.ProcessId,[long]$created)
 if($state -eq 'exited') { continue }
 if($state -ne 'same') { $unknown++; continue }
 if([string]::IsNullOrWhiteSpace($p.CommandLine) -or $p.CommandLine.Length -gt 32768) { $unknown++; continue }
 try { $a=[NndArgv]::Parse($p.CommandLine) } catch { $unknown++; continue }
 $script=-1
 for($i=1;$i -lt $a.Length;$i++) { if($a[$i] -match '(?:^|[\\/])cli\.js$') { $script=$i; break } }
 if($script -lt 0) {
  if($a -contains 'nnd') { $unknown++ }; continue
 }
 $tail=@($a | Select-Object -Skip ($script+1))
 if($tail.Count -eq 0 -or $tail[0] -in @('tui','text','headless','host','integration','opencode')) { continue }
 if($tail[0] -ne 'nnd') { if($tail -contains 'nnd') { $unknown++ }; continue }
 $operands=@($tail | Select-Object -Skip 1 | Where-Object { $_ -notin @('--no-color','--reduced-motion') })
 if($operands.Count -gt 0 -and $operands[0] -eq 'serve') { $legacy++ }
 elseif($operands.Count -eq 0 -or $operands[0] -notin @('service','package')) { $unknown++ }
}
[Console]::Out.WriteLine((@{version='1.0';scanned=$count;legacy=$legacy;unknown=$unknown}|ConvertTo-Json -Compress))
`;

export async function scanNndLegacyOwners(identity, signal) {
  let result;
  try { result = await runPrivateWindowsProgram(PROGRAM, { node: identity.node }, signal); }
  catch (cause) { throw new ContractError('nnd_owner_unverified', 'Legacy NND process census could not establish quiescence', { cause }); }
  if (!result || result.version !== '1.0' || !Number.isSafeInteger(result.scanned) || result.scanned < 1
    || result.scanned > 4096 || result.legacy !== 0 || result.unknown !== 0) {
    throw new ContractError('nnd_owner_unverified', 'A legacy or unverifiable NND process must be closed before adoption. No process was terminated.');
  }
  return Object.freeze({ version: '1.0', scanned: result.scanned, legacy: 0, unknown: 0, checked_at: new Date().toISOString() });
}
