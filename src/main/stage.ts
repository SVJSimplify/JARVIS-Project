import { execFile } from 'child_process';
import { screen } from 'electron';
import { isMini, setMini } from './hud';
import type { Tool } from './toolTypes';

const HUD_W = 412;
const GAP = 16;

const SCRIPT = `
Add-Type @'
using System;using System.Runtime.InteropServices;
public class W{
[DllImport("user32.dll")]public static extern bool MoveWindow(IntPtr h,int x,int y,int w,int ht,bool r);
[DllImport("user32.dll")]public static extern bool ShowWindow(IntPtr h,int c);
[DllImport("user32.dll")]public static extern bool SetForegroundWindow(IntPtr h);
[DllImport("dwmapi.dll")]public static extern int DwmSetWindowAttribute(IntPtr h,int a,ref int v,int s);
[DllImport("dwmapi.dll")]public static extern int DwmGetWindowAttribute(IntPtr h,int a,out R v,int s);
[DllImport("user32.dll")]public static extern bool GetWindowRect(IntPtr h,out R r);
[StructLayout(LayoutKind.Sequential)]public struct R{public int l,t,r,b;}
}
'@
$n=$env:J_NAME;$p=$null
for($i=0;$i -lt 24 -and -not $p;$i++){
  $p=Get-Process|?{$_.MainWindowHandle -ne 0 -and $_.Id -ne [int]$env:J_SELF -and ($_.MainWindowTitle -like "*$n*" -or $_.ProcessName -like "*$n*")}|Select -First 1
  if(-not $p){Start-Sleep -Milliseconds 500}
}
if(-not $p){exit 3}
$h=$p.MainWindowHandle
[W]::ShowWindow($h,9)|Out-Null
$c=2;[W]::DwmSetWindowAttribute($h,33,[ref]$c,4)|Out-Null
$x=[int]$env:J_X;$y=[int]$env:J_Y;$w=[int]$env:J_W;$H2=[int]$env:J_H
[W]::MoveWindow($h,$x,$y,$w,$H2,$true)|Out-Null
$a=New-Object W+R;$e=New-Object W+R
if([W]::GetWindowRect($h,[ref]$a) -and [W]::DwmGetWindowAttribute($h,9,[ref]$e,16) -eq 0){
  [W]::MoveWindow($h,$x-($e.l-$a.l),$y-($e.t-$a.t),$w+($e.l-$a.l)+($a.r-$e.r),$H2+($e.t-$a.t)+($a.b-$e.b),$true)|Out-Null
}
[W]::SetForegroundWindow($h)|Out-Null
# VERIFY, never assume: read the rect back after the move; a window that refused (or a
# shell that silently ignored the move) must not be reported as placed.
Start-Sleep -Milliseconds 120
$v=New-Object W+R
if(-not [W]::GetWindowRect($h,[ref]$v)){exit 4}
if(([Math]::Abs($v.l-$x) -gt 80) -or ([Math]::Abs($v.t-$y) -gt 80)){exit 4}
"PLACED $($v.l),$($v.t) $($v.r-$v.l)x$($v.b-$v.t)"
`;

const SIDE_LABEL: Record<string, string> = {
  stage: 'beside the JARVIS HUD',
  left: 'on the LEFT half of the screen',
  right: 'on the RIGHT half of the screen',
  top: 'on the TOP half of the screen',
  bottom: 'on the BOTTOM half of the screen',
  full: 'across almost the whole work area',
};

/** Snap an app window to a clean, rounded, margined stage; JARVIS shrinks to its corner HUD.
 *  `side` selects the layout: 'stage' (default, leaves room for the HUD), or half/full of the
 *  work area: 'left' | 'right' | 'top' | 'bottom' | 'full'. The window rect is read back after
 *  the move, so the returned text describes what REALLY happened. */
export async function placeApp(name: string, side?: string): Promise<string> {
  if (process.platform !== 'win32') return '';
  const wasMini = isMini();
  setMini(true);
  const a = screen.getPrimaryDisplay().workArea;
  const half = (n: number): number => Math.floor(n / 2) - GAP;
  let x = a.x + GAP;
  let y = a.y + GAP;
  let w = a.width - HUD_W - GAP; // 'stage': everything beside the HUD
  let h = a.height - 2 * GAP;
  const kind = SIDE_LABEL[side ?? ''] ? side : undefined;
  switch (side) {
    case 'left':
      w = half(a.width);
      break;
    case 'right':
      w = half(a.width);
      x = a.x + a.width - w - GAP;
      break;
    case 'top':
      w = a.width - 2 * GAP;
      h = half(a.height);
      break;
    case 'bottom':
      w = a.width - 2 * GAP;
      h = half(a.height);
      y = a.y + a.height - h - GAP;
      break;
    case 'full':
      w = a.width - 2 * GAP;
      break;
  }
  const env = {
    ...process.env,
    J_NAME: name,
    J_SELF: String(process.pid),
    J_X: String(x),
    J_Y: String(y),
    J_W: String(w),
    J_H: String(h),
  };
  const enc = Buffer.from(SCRIPT, 'utf16le').toString('base64');
  return new Promise((resolve) =>
    execFile('powershell.exe', ['-NoProfile', '-EncodedCommand', enc], { env, timeout: 20000 }, (err, stdout) => {
      if (!err && /PLACED/.test(String(stdout))) {
        const where = SIDE_LABEL[kind ?? 'stage'] ?? 'beside the JARVIS HUD';
        return resolve(`Placed ${where}.`);
      }
      // Nothing was staged: undo the shrink so a failed placement does not leave the HUD mini.
      if (!wasMini) setMini(false);
      // Distinguish "no such window" from "window refused the move" — both honest, neither fake.
      const code = (err as { code?: number })?.code;
      resolve(
        code === 3
          ? `The window for "${name}" was not found, so it was not placed.`
          : 'The window opened but could not be placed automatically; it is where Windows put it.'
      );
    })
  );
}

export const stageTools: Record<string, Tool> = {
  place_window: {
    description:
      "Snap an open app window to a clean rounded layout. Default: the stage beside JARVIS's HUD. side: 'left', 'right', 'top', 'bottom' (that half of the screen) or 'full' (almost the whole work area). Name is part of its title or process.",
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        side: { type: 'string', enum: ['stage', 'left', 'right', 'top', 'bottom', 'full'], description: 'Where to place the window. Default stage.' },
      },
      required: ['name'],
    },
    run: (args) => placeApp(String(args.name ?? ''), typeof args.side === 'string' ? args.side : undefined),
  },
};
