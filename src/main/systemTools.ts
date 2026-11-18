import { clipboard, desktopCapturer, screen, shell } from 'electron';
import { promises as fs } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { findCustomApp } from './extraTools';
import { runProcess } from './execution/ProcessRunner';
import { setMini } from './hud';
import type { Tool } from './toolTypes';
import { executionSignal } from './toolResult';
import { FILES_ROOT } from './workspace';

const run = async (
  executable: string,
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {}
): Promise<{ stdout: string; stderr: string }> => {
  const result = await runProcess({
    executable,
    args,
    cwd: process.cwd(),
    timeoutMs: options.timeout ?? 15_000,
    maxOutputBytes: 2 * 1024 * 1024,
    resource: 'system',
    signal: executionSignal(),
    env: options.env,
  });
  if (result.status !== 'success') {
    const message = result.status === 'timed_out'
      ? `Process timed out after ${Math.round((options.timeout ?? 15_000) / 1000)}s`
      : result.status === 'cancelled'
        ? 'Process was cancelled'
        : result.status === 'launch_failed'
          ? `Process could not start (${result.errorCode ?? 'unknown'})`
          : `Process exited with code ${result.exitCode ?? 'unknown'}`;
    throw new Error(`${message}. ${result.stderr.trim().slice(0, 1200)}`.trim());
  }
  return { stdout: result.stdout, stderr: result.stderr };
};
const MAX_CLIPBOARD_CHARS = 4000;
/** Only these programs can be launched. Add entries here to allow more. */
const APPS: Record<string, string> = {
  notepad: 'notepad.exe',
  calculator: 'calc.exe',
  paint: 'mspaint.exe',
  'file explorer': 'explorer.exe',
  'task manager': 'taskmgr.exe',
};
const APP_NAMES = [...Object.keys(APPS), 'settings'];

const ps = (script: string, arg = '', timeoutMs = 15000) =>
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    timeout: timeoutMs,
    env: { JARVIS_ARG: arg },
  });

const requireWindows = () => {
  if (process.platform !== 'win32') throw new Error('This control is only supported on Windows.');
};

const MEDIA_KEYS: Record<string, number> = { play_pause: 179, next: 176, previous: 177, stop: 178 };
const WINDOW_ACTIONS: Record<string, string> = {
  minimize_all: 'MinimizeAll()',
  restore_all: 'UndoMinimizeALL()',
  show_desktop: 'ToggleDesktop()',
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Real Windows Bluetooth discovery: devices sitting in pairing mode right now (headphones,
 * speakers, phones with the pairing dialog open). This is what the Bluetooth settings
 * window shows that Get-PnpDevice cannot — unpaired, never-seen neighbours. Runs the
 * BluetoothFindFirstDevice API directly, no elevation needed; the inquiry takes ~10 s.
 */
const BT_SCAN_PS = String.raw`
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class JBT {
  [StructLayout(LayoutKind.Sequential)]
  public struct BTFP { public uint size; public uint flags; }
  [StructLayout(LayoutKind.Sequential)]
  public struct SEARCH { public uint size; public int fReturnAuthenticated, fReturnRemembered, fReturnUnknown, fReturnConnected, fIssueInquiry; public byte cTimeoutMultiplier; public IntPtr hRadio; }
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct INFO { public uint size; public int fAuthenticated; public long address; public uint ulClassofDevice; public int fConnected, fRemembered; [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 248)] public string name; }
  [DllImport("bthprops.cpl", SetLastError = true)] public static extern IntPtr BluetoothFindFirstRadio(ref BTFP p, out IntPtr hRadio);
  [DllImport("bthprops.cpl")] public static extern bool BluetoothFindRadioClose(IntPtr h);
  [DllImport("bthprops.cpl", SetLastError = true)] public static extern IntPtr BluetoothFindFirstDevice(ref SEARCH p, ref INFO info);
  [DllImport("bthprops.cpl")] public static extern bool BluetoothFindNextDevice(IntPtr h, ref INFO info);
  [DllImport("bthprops.cpl")] public static extern bool BluetoothFindDeviceClose(IntPtr h);
}
'@
$fp = New-Object JBT+BTFP; $fp.size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][JBT+BTFP]); $fp.flags = 0
$radio = [IntPtr]::Zero
$fr = [JBT]::BluetoothFindFirstRadio([ref]$fp, [ref]$radio)
if ($fr -eq [IntPtr]::Zero) { throw 'No Bluetooth radio is available on this computer.' }
try {
  $sp = New-Object JBT+SEARCH
  $sp.size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][JBT+SEARCH])
  $sp.fReturnAuthenticated = 1; $sp.fReturnRemembered = 1; $sp.fReturnUnknown = 1; $sp.fReturnConnected = 1
  $sp.fIssueInquiry = 1; $sp.cTimeoutMultiplier = 8; $sp.hRadio = $radio
  $info = New-Object JBT+INFO; $info.size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][JBT+INFO])
  $found = 0
  $h = [JBT]::BluetoothFindFirstDevice([ref]$sp, [ref]$info)
  if ($h -ne [IntPtr]::Zero) {
    try {
      for (;;) {
        $state = if ($info.fConnected -eq 1) { 'connected' } elseif ($info.fAuthenticated -eq 1) { 'paired' } elseif ($info.fRemembered -eq 1) { 'remembered' } else { 'IN PAIRING MODE — ready to pair' }
        $name = if ([string]::IsNullOrWhiteSpace($info.name)) { '(unnamed device ' + ('{0:X12}' -f $info.address) + ')' } else { $info.name }
        Write-Output ("$name | $state")
        $found++
        $info = New-Object JBT+INFO; $info.size = [System.Runtime.InteropServices.Marshal]::SizeOf([type][JBT+INFO])
        if (-not [JBT]::BluetoothFindNextDevice($h, [ref]$info) -or $found -ge 25) { break }
      }
    } finally { [void][JBT]::BluetoothFindDeviceClose($h) }
  }
  if ($found -eq 0) { Write-Output 'No nearby Bluetooth devices were found. Make sure the device is in pairing mode (its light usually blinks) and try again.' }
} finally { [void][JBT]::BluetoothFindRadioClose($fr) }
`;


function cpuSnapshot() {
  return os.cpus().map((c) => c.times);
}

async function cpuLoadPercent(): Promise<number> {
  const before = cpuSnapshot();
  await sleep(150);
  const after = cpuSnapshot();
  let idle = 0;
  let total = 0;
  after.forEach((t, i) => {
    const b = before[i];
    const sum = (x: typeof t) => x.user + x.nice + x.sys + x.idle + x.irq;
    idle += t.idle - b.idle;
    total += sum(t) - sum(b);
  });
  return total ? Math.round(100 * (1 - idle / total)) : 0;
}

const gb = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);

export const systemTools: Record<string, Tool> = {
  bluetooth_scan: {
    description:
      'Scan for nearby Bluetooth devices that are visible RIGHT NOW — anything in pairing mode plus already paired/connected devices. Takes about 12 seconds. Use when the user asks what devices can be paired or what is nearby. Pairing itself is not automated; open ms-settings:bluetooth for the user to click Pair.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      requireWindows();
      const { stdout } = await ps(BT_SCAN_PS, '', 45000);
      return stdout.trim() || 'No nearby Bluetooth devices were found. Make sure the device is in pairing mode and try again.';
    },
  },
  get_system_info: {
    parallelSafe: true,
    description:
      'Get CPU load, memory usage, uptime and basic details about this computer. topic "devices" lists the hardware Windows sees right now — device classes and every paired/connected Bluetooth device with its status (it cannot discover NEW nearby devices that were never paired).',
    parameters: { type: 'object', properties: { topic: { type: 'string', enum: ['overview', 'devices'], description: 'Default overview.' } } },
    run: async (args) => {
      if (args.topic === 'devices') {
        // Windows-only: PnP enumeration through the persistent PowerShell host.
        const { stdout } = await ps(
          '$ErrorActionPreference="SilentlyContinue"; ' +
            '$d = Get-PnpDevice -PresentOnly; ' +
            '"== Connected device classes =="; ' +
            '$d | Group-Object Class | Sort-Object Count -Descending | ForEach-Object { "{0}: {1}" -f $_.Name, $_.Count }; ' +
            '"== Bluetooth devices (paired/connected) =="; ' +
            '$b = $d | Where-Object { $_.Class -eq "Bluetooth" -or $_.InstanceId -like "BTHENUM*" }; ' +
            'if ($b) { $b | ForEach-Object { "{0} [{1}]" -f $_.FriendlyName, $_.Status } } else { "none found" }'
        );
        return stdout || 'Device enumeration returned nothing (PowerShell unavailable on this platform?).';
      }
      const total = os.totalmem();
      const used = total - os.freemem();
      return (
        `CPU: ${os.cpus()[0]?.model.trim()} (${os.cpus().length} threads), load ${await cpuLoadPercent()}%. ` +
        `Memory: ${gb(used)} of ${gb(total)} GB used. ` +
        `Uptime: ${(os.uptime() / 3600).toFixed(1)} hours. ` +
        `${os.type()} ${os.release()} on ${os.hostname()}.`
      );
    },
  },
  clipboard_read: {
    parallelSafe: true,
    description: 'Read the text currently on the clipboard.',
    parameters: { type: 'object', properties: {} },
    run: () => {
      const text = clipboard.readText();
      return text ? text.slice(0, MAX_CLIPBOARD_CHARS) : '(clipboard is empty or holds no text)';
    },
  },
  clipboard_write: {
    description: 'Copy text to the clipboard.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string', description: 'Text to copy.' } },
      required: ['text'],
    },
    run: (args) => {
      clipboard.writeText(String(args.text ?? ''));
      return 'Copied to the clipboard.';
    },
  },
  volume_control: {
    description: 'Change the system volume. Each step is about 2 percent.',
    parameters: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['up', 'down', 'mute_toggle'] },
        steps: { type: 'integer', description: 'Number of steps (1-25). Defaults to 5.' },
      },
      required: ['action'],
    },
    run: async (args) => {
      if (process.platform !== 'win32') throw new Error('Volume control is only supported on Windows.');
      const keys: Record<string, number> = { up: 175, down: 174, mute_toggle: 173 };
      const key = keys[String(args.action)];
      if (!key) throw new Error('Action must be up, down or mute_toggle.');
      const steps = args.action === 'mute_toggle' ? 1 : Math.min(25, Math.max(1, Math.trunc(Number(args.steps) || 5)));

      const script = `$w = New-Object -ComObject WScript.Shell; 1..${steps} | ForEach-Object { $w.SendKeys([char]${key}) }`;
      await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true });
      return args.action === 'mute_toggle' ? 'Toggled mute.' : `Volume ${args.action} by ${steps} steps.`;
    },
  },
  open_app: {
    description: `Launch a built-in app. Available: ${APP_NAMES.join(', ')}.`,
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', enum: APP_NAMES } },
      required: ['name'],
    },
    run: async (args) => {
      const name = String(args.name ?? '').toLowerCase();
      if (name === 'settings') {
        await shell.openExternal('ms-settings:');
        return 'Opened Windows Settings.';
      }
      const exe = APPS[name];
      if (!exe) throw new Error(`I can only open: ${APP_NAMES.join(', ')}.`);
      // cmd start surfaces a missing binary as a real error; the old detached spawn with a
      // swallowed error handler used to report "Opened X." even when nothing opened.
      await run('cmd.exe', ['/c', 'start', '', exe], { windowsHide: true });
      return `Opened ${name}.`;
    },
  },
  take_screenshot: {
    description: 'Capture the main screen and save it as a PNG in the workspace. Returns the file path.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      const display = screen.getPrimaryDisplay();
      const sources = await desktopCapturer.getSources({
        types: ['screen'],
        thumbnailSize: {
          width: Math.round(display.size.width * display.scaleFactor),
          height: Math.round(display.size.height * display.scaleFactor),
        },
      });
      const source = sources.find((s) => s.display_id === String(display.id)) ?? sources[0];
      if (!source) throw new Error('No screen available to capture.');

      const dir = path.join(FILES_ROOT, 'screenshots');
      await fs.mkdir(dir, { recursive: true });
      const file = path.join(dir, `screenshot-${new Date().toISOString().replace(/[:.]/g, '-')}.png`);
      await fs.writeFile(file, source.thumbnail.toPNG());
      return `Saved ${path.relative(FILES_ROOT, file)}`;
    },
  },
  launch_app: {
    description: 'Launch any installed app by name (for example Spotify, Chrome, Word, Discord). Matches the Start Menu.',
    parameters: {
      type: 'object',
      properties: { name: { type: 'string', description: 'App name or part of it.' } },
      required: ['name'],
    },
    run: async (args) => {
      requireWindows();
      const name = String(args.name ?? '').trim();
      if (!name) throw new Error('Which app?');
      const custom = await findCustomApp(name);
      if (custom) {
        const failure = await shell.openPath(custom);
        if (failure) throw new Error(failure);
        return `Launched ${name}.`;
      }
      // NOT_FOUND is written instead of `exit 3`: exit would kill the shared PowerShell host
      // and cost a full prelude recompile on the next app-control call.
      // Round 20 (CHANGE 9): POST-LAUNCH VERIFICATION — "Start-Process returned nothing"
      // used to be reported as "Launched X." without evidence. The script now polls for a
      // real window belonging to a NEW process of the launched app (up to 6 s) and
      // reports the observed state honestly: launched-and-window-visible, launched-but-
      // no-window-yet (with guidance), or not found.
      const script =
        '$a = Get-StartApps | Where-Object { $_.Name -like "*$($env:JARVIS_ARG)*" } | Sort-Object { $_.Name.Length } | Select-Object -First 1; ' +
        'if (-not $a) { "NOT_FOUND" } else { $before = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { $_.Id }); Start-Process explorer.exe "shell:AppsFolder\\$($a.AppID)"; $win = $null; ' +
        'foreach ($i in 1..12) { Start-Sleep -Milliseconds 500; $cand = @(Get-Process | Where-Object { $_.MainWindowHandle -ne 0 -and $before -notcontains $_.Id }); if ($cand.Count) { $win = $cand[0]; break } }; ' +
        'if ($win) { "LAUNCHED_WINDOW: $($a.Name) ($($win.ProcessName)) window: $($win.MainWindowTitle)" } else { "LAUNCHED_NOWINDOW: $($a.Name) - no new window appeared within 6s; check the taskbar/screen_text" } }';
      const { stdout } = await ps(script, name);
      const out = stdout.trim();
      if (out === 'NOT_FOUND') throw new Error(`No installed app matching "${name}".`);
      const m = /^(LAUNCHED_WINDOW|LAUNCHED_NOWINDOW):\s*(.*)$/s.exec(out);
      if (!m) return `Launched ${out || name}.`; // legacy shape — do not invent evidence
      if (m[1] === 'LAUNCHED_WINDOW') return `Launched ${m[2].trim()}. (verified: a window appeared)`;
      return `NOT DONE: ${m[2].trim()}.`;
    },
  },
  media_control: {
    description: 'Control media playback system-wide: play/pause, next track, previous track or stop.',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: Object.keys(MEDIA_KEYS) } },
      required: ['action'],
    },
    run: async (args) => {
      requireWindows();
      const key = MEDIA_KEYS[String(args.action)];
      if (!key) throw new Error(`Action must be one of: ${Object.keys(MEDIA_KEYS).join(', ')}.`);
      await ps(`(New-Object -ComObject WScript.Shell).SendKeys([char]${key})`);
      return `Media: ${args.action}.`;
    },
  },
  list_windows: {
    description: 'List the titles of open application windows.',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      requireWindows();
      const { stdout } = await ps('Get-Process | Where-Object { $_.MainWindowTitle } | ForEach-Object { "$($_.ProcessName): $($_.MainWindowTitle)" }');
      return stdout.trim() || '(no windows)';
    },
  },
  focus_window: {
    description: 'Bring an open window to the front by part of its title or app name.',
    parameters: {
      type: 'object',
      properties: { title: { type: 'string', description: 'Part of the window title.' } },
      required: ['title'],
    },
    run: async (args) => {
      requireWindows();
      const title = String(args.title ?? '').trim();
      if (!title) throw new Error('Which window?');
      try {
        await ps('if (-not (New-Object -ComObject WScript.Shell).AppActivate($env:JARVIS_ARG)) { exit 3 }', title);
        return `Focused ${title}.`;
      } catch {
        throw new Error(`No window matching "${title}".`);
      }
    },
  },
  window_control: {
    description: 'Minimize all windows, restore them, or show the desktop.',
    parameters: {
      type: 'object',
      properties: { action: { type: 'string', enum: Object.keys(WINDOW_ACTIONS) } },
      required: ['action'],
    },
    run: async (args) => {
      requireWindows();
      const call = WINDOW_ACTIONS[String(args.action)];
      if (!call) throw new Error(`Action must be one of: ${Object.keys(WINDOW_ACTIONS).join(', ')}.`);
      await ps(`(New-Object -ComObject Shell.Application).${call}`);
      return `Done: ${args.action}.`;
    },
  },
  set_brightness: {
    description: 'Set the laptop screen brightness from 0 to 100 percent.',
    parameters: {
      type: 'object',
      properties: { percent: { type: 'integer', description: '0-100.' } },
      required: ['percent'],
    },
    run: async (args) => {
      requireWindows();
      const pct = Math.min(100, Math.max(0, Math.round(Number(args.percent))));
      if (Number.isNaN(pct)) throw new Error('Give a brightness between 0 and 100.');
      try {
        await ps('(Get-CimInstance -Namespace root/WMI -ClassName WmiMonitorBrightnessMethods).WmiSetBrightness(1, [int]$env:JARVIS_ARG)', String(pct));
      } catch {
        throw new Error('This display does not support software brightness control.');
      }
      return `Brightness set to ${pct}%.`;
    },
  },
  lock_screen: {
    description: 'Lock the computer (Windows lock screen).',
    parameters: { type: 'object', properties: {} },
    run: async () => {
      requireWindows();
      await run('rundll32.exe', ['user32.dll,LockWorkStation'], { windowsHide: true });
      return 'Locked.';
    },
  },
  set_hud_mode: {
    description: 'Switch the JARVIS window between the full view and a small always-on-top mini HUD.',
    parameters: {
      type: 'object',
      properties: { mode: { type: 'string', enum: ['mini', 'full'] } },
      required: ['mode'],
    },
    run: (args) => {
      setMini(args.mode === 'mini');
      return args.mode === 'mini' ? 'Mini HUD on.' : 'Full view.';
    },
  },
};
