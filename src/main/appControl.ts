import { runPs } from './psHost';
import type { Tool } from './toolTypes';
import { captureScreen, imageToScreen } from './vision';
import { assessTargetAmbiguity, desktopVerifyBlock, type ScreenState } from './desktopVerify';

const requireWindows = () => {
  if (process.platform !== 'win32') throw new Error('App control is only supported on Windows.');
};

const PRELUDE_EXTRA = String.raw`
function RClick($x, $y) { [JM]::SetCursorPos([int]$x, [int]$y); Start-Sleep -Milliseconds 60; [JM]::mouse_event(8,0,0,0,[UIntPtr]::Zero); [JM]::mouse_event(16,0,0,0,[UIntPtr]::Zero) }
function Wheel($x, $y, $d) { [JM]::SetCursorPos([int]$x, [int]$y); Start-Sleep -Milliseconds 60; $u = [BitConverter]::ToUInt32([BitConverter]::GetBytes([int]$d), 0); [JM]::mouse_event(2048,0,0,$u,[UIntPtr]::Zero) }
function Drag($x1, $y1, $x2, $y2) {
  [JM]::SetCursorPos([int]$x1, [int]$y1); Start-Sleep -Milliseconds 80; [JM]::mouse_event(2,0,0,0,[UIntPtr]::Zero)
  for ($i = 1; $i -le 10; $i++) { [JM]::SetCursorPos([int]($x1 + ($x2 - $x1) * $i / 10), [int]($y1 + ($y2 - $y1) * $i / 10)); Start-Sleep -Milliseconds 20 }
  [JM]::mouse_event(4,0,0,0,[UIntPtr]::Zero)
}
`;

/** Windows built-in OCR: reads the text on screen in ANY app (Electron, games, canvases) without a vision model. */
const OCR_PS = String.raw`
Add-Type -AssemblyName System.Runtime.WindowsRuntime, System.Drawing
$null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics, ContentType = WindowsRuntime]
$null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Foundation, ContentType = WindowsRuntime]
$opName = 'IAsyncOperation' + [char]96 + '1'
$asTask = ([System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq $opName })[0]
function Await($op, $type) { $t = $asTask.MakeGenericMethod($type).Invoke($null, @($op)); [void]$t.Wait(-1); $t.Result }
function Ocr() {
  $v = [System.Windows.Forms.SystemInformation]::VirtualScreen
  $bmp = New-Object System.Drawing.Bitmap $v.Width, $v.Height
  $g = [System.Drawing.Graphics]::FromImage($bmp); $g.CopyFromScreen($v.X, $v.Y, 0, 0, $bmp.Size); $g.Dispose()
  $path = Join-Path $env:TEMP ('jarvis_ocr_' + [guid]::NewGuid().ToString('N') + '.png')
  $bmp.Save($path, [System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose()
  try {
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($path)) ([Windows.Storage.StorageFile])
    $stream = Await ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    $dec = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
    $sb = Await ($dec.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
    $eng = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $eng) { throw 'No OCR language is installed in Windows (Settings > Time and language > Language).' }
    $res = Await ($eng.RecognizeAsync($sb)) ([Windows.Media.Ocr.OcrResult])
    $stream.Dispose()
    foreach ($l in $res.Lines) { [pscustomobject]@{ Text = $l.Text; Words = @($l.Words); OX = $v.X; OY = $v.Y } }
  } finally { Remove-Item $path -ErrorAction SilentlyContinue }
}
function Box($w) {
  $x1 = ($w | ForEach-Object { $_.BoundingRect.X } | Measure-Object -Minimum).Minimum
  $x2 = ($w | ForEach-Object { $_.BoundingRect.X + $_.BoundingRect.Width } | Measure-Object -Maximum).Maximum
  $y1 = ($w | ForEach-Object { $_.BoundingRect.Y } | Measure-Object -Minimum).Minimum
  $y2 = ($w | ForEach-Object { $_.BoundingRect.Y + $_.BoundingRect.Height } | Measure-Object -Maximum).Maximum
  @(([int](($x1 + $x2) / 2)), ([int](($y1 + $y2) / 2)))
}
`;

const SCREEN_TEXT_PS = String.raw`
if ($env:JB) { Focus $env:JB }
$out = @()
foreach ($l in @(Ocr)) {
  if (-not $l.Words.Count) { continue }
  $c = Box $l.Words
  $out += ('' + ($l.OX + $c[0]) + ',' + ($l.OY + $c[1]) + '  ' + $l.Text)
}
if ($out.Count -eq 0) { 'No text found on screen.' } else { ($out | Select-Object -First 120) -join [Environment]::NewLine }
`;

const CLICK_TEXT_PS = String.raw`
if ($env:JB) { Focus $env:JB }
$needle = $env:JA.ToLower()
$found = @()
foreach ($l in @(Ocr)) {
  $words = $l.Words; $acc = ''; $starts = @()
  for ($i = 0; $i -lt $words.Count; $i++) { $starts += $acc.Length; $acc += $words[$i].Text + ' ' }
  $low = $acc.ToLower(); $idx = 0
  while (($idx = $low.IndexOf($needle, $idx)) -ge 0) {
    $end = $idx + $needle.Length
    $sel = @(); for ($i = 0; $i -lt $words.Count; $i++) { $st = $starts[$i]; $en = $st + $words[$i].Text.Length; if ($en -gt $idx -and $st -lt $end) { $sel += $words[$i] } }
    if ($sel.Count) { $c = Box $sel; $found += [pscustomobject]@{ X = $l.OX + $c[0]; Y = $l.OY + $c[1]; Line = $acc.Trim() } }
    $idx = $end
  }
}
$n = [int]$env:JC; if ($n -lt 1) { $n = 1 }
if ($found.Count -eq 0) { throw ('Text "' + $env:JA + '" was not found on screen. Use screen_text to see what is visible.') }
if ($n -gt $found.Count) { throw ('Only ' + $found.Count + ' match(es) for "' + $env:JA + '" on screen.') }
$m = $found[$n - 1]
switch ($env:JD) { 'right' { RClick $m.X $m.Y } 'double' { Click $m.X $m.Y 2 } default { Click $m.X $m.Y 1 } }
$ln = $m.Line; if ($ln.Length -gt 80) { $ln = $ln.Substring(0, 80) }
'Clicked "' + $env:JA + '" at ' + $m.X + ',' + $m.Y + ' (match ' + $n + ' of ' + $found.Count + '; line: ' + $ln + ')'
# Round 19 (CHANGE 7) — OBSERVE after acting: re-read the screen and report whether the
# clicked text is still visible, plus which window is in the foreground now. A successful
# click API call is not proof the UI responded; this is the verify step.
Start-Sleep -Milliseconds 500
$still = @(Ocr) | Where-Object { $_.Text -like ('*' + $env:JA + '*') }
if ($still.Count) { 'After: the text "' + $env:JA + '" is STILL visible on screen - if you expected it to disappear (menu closed, dialog dismissed), verify the intended state.' }
else { 'After: the clicked text is no longer visible on screen (the UI responded).' }
'After: foreground window is now "' + (Fore) + '"'
DialogLine
`;

const PRELUDE = [
  '$ErrorActionPreference = "Stop"',
  'Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes,System.Windows.Forms',
  'Add-Type -TypeDefinition @"',
  'using System; using System.Runtime.InteropServices; using System.Text;',
  'public class JM { [DllImport("user32.dll")] public static extern bool SetCursorPos(int x,int y);',
  '[DllImport("user32.dll")] public static extern void mouse_event(uint f,uint dx,uint dy,uint d,UIntPtr e);',
  '[DllImport("user32.dll")] public static extern bool SetProcessDPIAware();',
  // Round 19 (CHANGE 7): post-action evidence — WHICH window is in the foreground after
  // the action. A successful mouse_event/SendKeys call is not proof the intended window
  // received it; the foreground title is the cheapest observable check.
  '[DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();',
  '[DllImport("user32.dll")] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n); }',
  '"@',
  '[void][JM]::SetProcessDPIAware()',
  '$AE = [Windows.Automation.AutomationElement]; $TS = [Windows.Automation.TreeScope]; $TC = [Windows.Automation.Condition]::TrueCondition',
  'function Win($t) { foreach ($e in $AE::RootElement.FindAll($TS::Children, $TC)) { if ($e.Current.Name -like "*$t*") { return $e } }; throw "No window matching $t" }',
  'function El($w, $n) { foreach ($e in $w.FindAll($TS::Descendants, $TC)) { if ($e.Current.Name -like "*$n*" -and -not $e.Current.IsOffscreen) { return $e } }; throw "No control matching $n" }',
  'function Focus($t) { if ($t) { if (-not (New-Object -ComObject WScript.Shell).AppActivate($t)) { throw "No window matching $t" }; Start-Sleep -Milliseconds 350 } }',
  'function Fore() { $sb = New-Object System.Text.StringBuilder 512; [void][JM]::GetWindowText([JM]::GetForegroundWindow(), $sb, 512); return $sb.ToString() }',
  // Round 20 (CHANGE 9): DIALOG DETECTION — standard Windows modal dialogs live in the
  // '#32770' window class (MessageBox, file pickers, confirmations). After every acting
  // step the tools report whether one appeared: an unnoticed modal used to swallow
  // clicks invisibly and stall desktop flows. Read the dialog (screen_text/inspect_app)
  // and respond deliberately — never click through it blindly.
  'function Dialogs() { $out = @(); foreach ($w in $AE::RootElement.FindAll($TS::Children, $TC)) { try { if ($w.Current.ClassName -eq "#32770") { $out += $w.Current.Name } } catch {} }; return ,$out }',
  'function DialogLine() { $ds = Dialogs; if ($ds.Count) { return ("After: DIALOG window(s) detected: " + (($ds | Select-Object -First 3) -join " | ") + " - observe them (screen_text / inspect_app) and respond deliberately before further actions.") } return "After: no modal dialog windows detected." }',
  'function Click($x, $y, $n) { [JM]::SetCursorPos([int]$x, [int]$y); Start-Sleep -Milliseconds 60; for ($i = 0; $i -lt $n; $i++) { [JM]::mouse_event(2,0,0,0,[UIntPtr]::Zero); [JM]::mouse_event(4,0,0,0,[UIntPtr]::Zero); Start-Sleep -Milliseconds 60 } }',
  PRELUDE_EXTRA,
].join('\n');

const ps = async (body: string, a = '', b = '', c = '', d = '', timeoutMs = 20000) => {
  requireWindows();
  return runPs(PRELUDE, body, { JA: a, JB: b, JC: c, JD: d }, timeoutMs);
};

const str = (v: unknown) => String(v ?? '').trim();
const browserKey = (v: unknown) => {
  const b = str(v).toLowerCase().replace(/^(google|microsoft)\s+/, '');
  return b === 'edge' ? 'msedge' : b === 'any' ? '' : b;
};
const CLOSE_MY_TAB_PS = String.raw`
$names = @('chrome','msedge','firefox','brave','opera','vivaldi')
$want = $env:JB
$q = [WildcardPattern]::Escape($env:JA)
$tabCond = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
$hits = @()
foreach ($w in $AE::RootElement.FindAll($TS::Children, $TC)) {
  $wp = $w.Current.ProcessId
  $pr = Get-Process -Id $wp -ErrorAction SilentlyContinue
  if (-not $pr) { continue }
  $pn = $pr.ProcessName.ToLower()
  if ($names -notcontains $pn) { continue }
  if ($want -and $pn -notlike "*$want*") { continue }
  foreach ($t in $w.FindAll($TS::Descendants, $tabCond)) {
    if ($t.Current.Name -like "*$q*") { $hits += [pscustomobject]@{ P = $pn; WP = $wp; T = $t } }
  }
}

if ($hits.Count -eq 0) { throw "No open tab matching '$($env:JA)' in the user's own browser. Nothing was closed." }
if ($hits.Count -gt 1 -and $env:JC -ne '1') { throw ("Several tabs match: " + (($hits | ForEach-Object { $_.P + ': ' + $_.T.Current.Name }) -join ' | ') + ". Ask the user which one.") }
$btnCond = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Button)
$closed = @()
foreach ($h in $hits) {
  $t = $h.T; $nm = $t.Current.Name; $btn = $null; $p = $null
  foreach ($b in $t.FindAll($TS::Descendants, $btnCond)) { if ($b.Current.Name -like '*Close*') { $btn = $b; break } }
  if ($btn -and $btn.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke() }
  else {
    if ($t.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select() }
    if (-not (New-Object -ComObject WScript.Shell).AppActivate([int]$h.WP)) { throw 'Could not focus the browser, so nothing more was closed.' }
    Start-Sleep -Milliseconds 300
    [System.Windows.Forms.SendKeys]::SendWait('^w')
  }
  $closed += ($h.P + ': ' + $nm)
  Start-Sleep -Milliseconds 250
}
'Closed ' + ($closed -join ' | ')
`;
const LIST_MY_TABS_PS = String.raw`
$names = @('chrome','msedge','firefox','brave','opera','vivaldi')
$want = $env:JB
$q = [WildcardPattern]::Escape($env:JA)
$tabCond = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::TabItem)
$hits = @()
foreach ($w in $AE::RootElement.FindAll($TS::Children, $TC)) {
  $wp = $w.Current.ProcessId
  $pr = Get-Process -Id $wp -ErrorAction SilentlyContinue
  if (-not $pr) { continue }
  $pn = $pr.ProcessName.ToLower()
  if ($names -notcontains $pn) { continue }
  if ($want -and $pn -notlike "*$want*") { continue }
  foreach ($t in $w.FindAll($TS::Descendants, $tabCond)) {
    if ($t.Current.Name -like "*$q*") { $hits += [pscustomobject]@{ P = $pn; WP = $wp; T = $t } }
  }
}

if ($hits.Count -eq 0) { 'No matching tabs found in the user''s own browser.' } else { ($hits | Select-Object -First 40 | ForEach-Object { $_.P + ': ' + $_.T.Current.Name }) -join [Environment]::NewLine }
`;
const escapeKeys = (s: string) => s.replace(/[+^%~(){}[\]]/g, '{$&}');

/** Coordinates from see_screen's image are mapped to physical pixels (DPI-correct); 'screen' passes raw. */
const toPhys = (x: number, y: number, space: unknown): { x: number; y: number; note: string } => {
  if (space !== 'screen') {
    const m = imageToScreen(x, y);
    if (m) return { ...m, note: ` (image ${x},${y} → screen ${m.x},${m.y})` };
  }
  return { x, y, note: '' };
};

/** Screenshot → act → SEE: every pointer/keyboard action is followed by a fresh look (default on). */
const observeAfter = async (args: Record<string, unknown>, out: unknown): Promise<string> => {
  if (args.observe === false) return String(out);
  try {
    await new Promise((r) => setTimeout(r, 450)); // let the app re-render
    const { note } = await captureScreen();
    return `${String(out)}\n[AFTER] ${note} Check the image: did the intended change actually happen? If not, adjust and retry — never report success unseen.`;
  } catch {
    return String(out);
  }
};

const COORD_PROPS = {
  space: { type: 'string', enum: ['image', 'screen'], description: 'image (default): coordinates read off the latest see_screen image. screen: raw physical pixels.' },
  observe: { type: 'boolean', description: 'Take a screenshot after acting so you can verify (default true).' },
} as const;

export const appControlTools: Record<string, Tool> = {
  screen_text: {
    description:
      'Read ALL visible text on screen with x,y centre coordinates (OCR). Works on any app regardless of tech stack (Electron, Chrome-based, games, canvases) and needs no vision model. Use it to find what to click and to verify results. Optional window focuses that window first.',
    parameters: { type: 'object', properties: { window: { type: 'string', description: 'Part of the window title to focus first. Optional.' } } },
    run: (args) => ps(OCR_PS + SCREEN_TEXT_PS, '', str(args.window), '', '', 30000),
  },
  click_text: {
    description:
      'Click visible on-screen text (button label, menu item, link, file name) found by OCR, in any app. text matches part of a line, case-insensitive; nth picks the match (default 1, top to bottom). mode: click, double or right. ROUND 28: the click is verified — the screen is OCR-read before and after, and an evidence-based [ACTION VERIFY] line is appended (a click is never its own proof; consequential labels require strong evidence).',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string' },
        window: { type: 'string', description: 'Part of the window title to focus first. Optional.' },
        nth: { type: 'number' },
        mode: { type: 'string', enum: ['click', 'double', 'right'] },
        expect: { type: 'string', description: 'The expected result that proves the intended outcome, e.g. "the Save dialog closes and the title bar shows saved".' },
      },
      required: ['text'],
    },
    run: async (args) => {
      if (!str(args.text)) throw new Error('text is required.');
      const nth = String(Math.max(1, Math.round(Number(args.nth) || 1)));
      const mode = str(args.mode) || 'click';
      // ROUND 28 (Phase 4 §4.2): OBSERVE → CHECK AMBIGUITY → ACT → RE-OBSERVE → VERIFY.
      // The observation passes reuse the EXISTING unmodified OCR scripts; the judgment is
      // the pure, unit-tested desktopVerify layer (one verification vocabulary with the browser).
      const observe = async (): Promise<ScreenState> => {
        const raw = await ps(OCR_PS + SCREEN_TEXT_PS, '', str(args.window), '', '', 30000);
        const lines = String(raw).split(/\r?\n/).filter((l) => l.trim());
        const textOf = lines.map((l) => l.replace(/^\s*-?\d+,\s*-?\d+\s\s/, ''));
        let title = '';
        try {
          title = String(await ps('(Fore)', '', '', '', '', 8000)).trim();
        } catch {
          title = '';
        }
        return { windowTitle: title, heading: textOf[0] ?? '', text: textOf.join('\n').slice(0, 3000) };
      };
      const before = await observe();
      // AMBIGUITY GATE: several DIFFERENT matching texts means the click would guess —
      // refuse and re-observe instead (the driver picks a better window or target text).
      const ocrLines = before.text.split('\n').filter(Boolean);
      const ambiguity = assessTargetAmbiguity(ocrLines, str(args.text));
      if (ambiguity.ambiguous && ambiguity.candidates.length > 1 && Number(nth) === 1)
        return `NOT DONE: ${ambiguity.reason}. Re-observe and retry with a more specific target (or nth).\n${ambiguity.candidates.map((c) => `  · ${c}`).join('\n')}`;
      const clickResult = await ps(OCR_PS + CLICK_TEXT_PS, str(args.text), str(args.window), nth, mode, 30000);
      let after: ScreenState | null = null;
      let verifyNote = '';
      try {
        // ROUND 29 (Phase 4): a bounded settle pause before re-observation — many apps
        // re-render (or open dialogs) a few hundred ms after a click; verifying against
        // an un-re-rendered screen used to read as "nothing changed".
        await new Promise((r) => setTimeout(r, 350));
        after = await observe();
        verifyNote = desktopVerifyBlock({
          before,
          after,
          intent: `click "${str(args.text)}"`,
          expected: str(args.expect) || undefined,
          windowChanged: !!after && before.windowTitle !== after.windowTitle && !!before.windowTitle && !!after.windowTitle,
        });
      } catch (e) {
        verifyNote = `[ACTION VERIFY: UNOBSERVED — the post-action screen could not be read (${String(e instanceof Error ? e.message : e).slice(0, 80)}); the click result above is the action's own report, not an observed outcome]`;
      }
      return `${clickResult}\n${verifyNote}`;
    },
  },
  scroll_at: {
    description: 'Scroll the mouse wheel at screen coordinates (default: screen centre) in any app. direction up or down; amount in notches (default 3).',
    parameters: {
      type: 'object',
      properties: { direction: { type: 'string', enum: ['up', 'down'] }, amount: { type: 'number' }, x: { type: 'integer' }, y: { type: 'integer' }, ...COORD_PROPS },
      required: ['direction'],
    },
    run: async (args) => {
      const n = Math.min(30, Math.max(1, Math.round(Number(args.amount) || 3))) * (args.direction === 'up' ? 1 : -1);
      const p = args.x === undefined || args.y === undefined ? null : toPhys(Math.round(Number(args.x)), Math.round(Number(args.y)), args.space);
      return observeAfter(args, await ps(
        'if ($env:JA -and $env:JB) { $x = $env:JA; $y = $env:JB } else { $b = [System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $x = $b.X + $b.Width / 2; $y = $b.Y + $b.Height / 2 }; Wheel $x $y ([int]$env:JC * 120); "Scrolled. After: foreground window is now " + (Fore) + ""; DialogLine',
        p ? String(p.x) : '',
        p ? String(p.y) : '',
        String(n)
      ));
    },
  },
  drag_at: {
    description: 'Drag with the left mouse button from one screen point to another in any app (sliders, canvases, moving windows or items).',
    parameters: {
      type: 'object',
      properties: { x1: { type: 'integer' }, y1: { type: 'integer' }, x2: { type: 'integer' }, y2: { type: 'integer' }, ...COORD_PROPS },
      required: ['x1', 'y1', 'x2', 'y2'],
    },
    run: async (args) => {
      const v = ['x1', 'y1', 'x2', 'y2'].map((k) => Math.round(Number(args[k])));
      if (v.some((n) => !Number.isFinite(n) || n < 0)) throw new Error('Invalid coordinates.');
      const a = toPhys(v[0], v[1], args.space);
      const b = toPhys(v[2], v[3], args.space);
      return observeAfter(args, await ps('Drag $env:JA $env:JB $env:JC $env:JD; "Dragged. After: foreground window is now " + (Fore) + ""; DialogLine', String(a.x), String(a.y), String(b.x), String(b.y)));
    },
  },
  list_my_browser_tabs: {
    parallelSafe: true,
    description:
      "List open tabs in the USER'S OWN browser (Chrome, Edge, Firefox, Brave...), not JARVIS's in-app browser. Optional text filters by tab title; optional browser limits to one.",
    parameters: {
      type: 'object',
      properties: { tab: { type: 'string', description: 'Part of the tab title. Optional.' }, browser: { type: 'string', description: 'chrome, edge, firefox, brave... Optional.' } },
    },
    run: (args) => ps(LIST_MY_TABS_PS, str(args.tab), browserKey(args.browser)),
  },
  close_my_browser_tab: {
    description:
      "Close a tab (matched by title text) in the USER'S OWN browser only, never the in-app browser. Set browser when the user named one (chrome, edge, firefox, brave); otherwise every supported browser is searched. Fails with the list of matches if several tabs match, unless all is true.",
    parameters: {
      type: 'object',
      properties: {
        tab: { type: 'string', description: 'Part of the tab title, e.g. youtube.' },
        browser: { type: 'string', description: 'chrome, edge, firefox, brave... Optional.' },
        all: { type: 'boolean', description: 'Close every matching tab. Only if the user said all/every.' },
      },
      required: ['tab'],
    },
    run: (args) => {
      if (!str(args.tab)) throw new Error('tab is required.');
      return ps(CLOSE_MY_TAB_PS, str(args.tab), browserKey(args.browser), args.all === true ? '1' : '0');
    },
  },
  inspect_app: {
    description:
      'List the visible controls (buttons, menus, text fields, tabs, items) of an open app window so you can see what can be clicked. Call this before click_control when unsure of control names.',
    parameters: {
      type: 'object',
      properties: { window: { type: 'string', description: 'Part of the window title.' } },
      required: ['window'],
    },
    run: async (args) =>
      (await ps(
        '$w = Win $env:JA; $i = 0; foreach ($e in $w.FindAll($TS::Descendants, $TC)) { $n = $e.Current.Name; if ($n -and -not $e.Current.IsOffscreen) { "$($e.Current.ControlType.ProgrammaticName -replace "ControlType\\.",""): $n"; if (++$i -ge 60) { break } } }',
        str(args.window)
      )) || '(no visible controls found)',
  },
  click_control: {
    description: 'Click, toggle, select or expand a named control (button, menu item, tab, checkbox, list item) in an open app window.',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string', description: 'Part of the window title.' },
        control: { type: 'string', description: 'Part of the control name, from inspect_app.' },
      },
      required: ['window', 'control'],
    },
    run: async (args) =>
      ps(
        '$w = Win $env:JA; $e = El $w $env:JB; $p = $null; ' +
          'if ($e.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$p)) { $p.Invoke(); "Clicked." } ' +
          'elseif ($e.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$p)) { $p.Select(); "Selected." } ' +
          'elseif ($e.TryGetCurrentPattern([Windows.Automation.TogglePattern]::Pattern, [ref]$p)) { $p.Toggle(); "Toggled." } ' +
          'elseif ($e.TryGetCurrentPattern([Windows.Automation.ExpandCollapsePattern]::Pattern, [ref]$p)) { $p.Expand(); "Expanded." } ' +
          'else { $r = $e.Current.BoundingRectangle; Click ($r.X + $r.Width / 2) ($r.Y + $r.Height / 2) 1; "Clicked." }; ' +
          // Round 19 (CHANGE 7): the acting process is gone from the PS session by now —
          // the foreground window is the observable evidence that the UI received the action.
          'Start-Sleep -Milliseconds 400; \'After: foreground window is now "\' + (Fore) + \'"\'; DialogLine',
        str(args.window),
        str(args.control)
      ),
  },
  set_control_text: {
    description: 'Put text into a named text field of an open app window (search boxes, address bars, forms). Leave control empty for the first text field. The field value is read back after writing, so success means the text is really in the field.',
    parameters: {
      type: 'object',
      properties: {
        window: { type: 'string' },
        text: { type: 'string' },
        control: { type: 'string', description: 'Part of the field name. Optional.' },
      },
      required: ['window', 'text'],
    },
    run: async (args) =>
      ps(
        '$w = Win $env:JA; $e = $null; ' +
          'if ($env:JC) { $e = El $w $env:JC } else { $c = [Windows.Automation.PropertyCondition]::new([Windows.Automation.AutomationElement]::ControlTypeProperty, [Windows.Automation.ControlType]::Edit); $e = $w.FindFirst($TS::Descendants, $c); if (-not $e) { throw "No text field found" } }; ' +
          // Round 19 (CHANGE 7) — VERIFY: read the value back through UIA. A SetValue
          // that silently no-ops is reported as the failure it is, never as success.
          '$p = $e.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern); $p.SetValue($env:JB); Start-Sleep -Milliseconds 200; $back = $p.Current.Value; ' +
          'if ($back -ne $env:JB) { throw ("Verification failed: the field now holds \u0027" + $back + "\u0027 instead of the requested text.") } ' +
          '"Text entered and verified by reading the field back."',
        str(args.window),
        String(args.text ?? ''),
        str(args.control)
      ),
  },
  type_text: {
    description: 'Type text into whatever is focused, optionally focusing a window first. Use when set_control_text does not work.',
    parameters: {
      type: 'object',
      properties: { text: { type: 'string' }, window: { type: 'string', description: 'Window to focus first. Optional.' }, observe: COORD_PROPS.observe },
      required: ['text'],
    },
    run: async (args) =>
      observeAfter(args, await ps('Focus $env:JA; [System.Windows.Forms.SendKeys]::SendWait($env:JB); Start-Sleep -Milliseconds 300; \'Typed. After: foreground window is now "\' + (Fore) + \'"\'; DialogLine', str(args.window), escapeKeys(String(args.text ?? '')).slice(0, 2000))),
  },
  press_keys: {
    description:
      'Press a key or shortcut in the focused app, optionally focusing a window first. SendKeys syntax: ^ is Ctrl, % is Alt, + is Shift, and {ENTER} {TAB} {ESC} {F5} {DOWN} are special keys. Example: ^t for Ctrl+T, %{F4} to close.',
    parameters: {
      type: 'object',
      properties: { keys: { type: 'string' }, window: { type: 'string', description: 'Window to focus first. Optional.' }, observe: COORD_PROPS.observe },
      required: ['keys'],
    },
    run: async (args) =>
      observeAfter(args, await ps('Focus $env:JA; [System.Windows.Forms.SendKeys]::SendWait($env:JB); Start-Sleep -Milliseconds 300; \'Pressed. After: foreground window is now "\' + (Fore) + \'"\'; DialogLine', str(args.window), String(args.keys ?? '').slice(0, 200))),
  },
  click_at: {
    description:
      'Click at a point you SAW: read x,y off the latest see_screen image (mapped to real pixels automatically, DPI included). Prefer click_control / click_text when the target has a name or visible text. A fresh screenshot follows so you can verify.',
    parameters: {
      type: 'object',
      properties: {
        x: { type: 'integer' },
        y: { type: 'integer' },
        ...COORD_PROPS,
        double: { type: 'boolean', description: 'Double click. Default false.' },
        button: { type: 'string', enum: ['left', 'right'], description: 'Default left.' },
      },
      required: ['x', 'y'],
    },
    run: async (args) => {
      const x = Math.round(Number(args.x));
      const y = Math.round(Number(args.y));
      if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) throw new Error('Invalid coordinates.');
      const p = toPhys(x, y, args.space);
      if (args.button === 'right') return observeAfter(args, `${await ps('RClick $env:JA $env:JB; "Right-clicked."', String(p.x), String(p.y))}${p.note}`);
      return observeAfter(args, `${await ps('Click $env:JA $env:JB $env:JC; Start-Sleep -Milliseconds 400; \'Clicked. After: foreground window is now "\' + (Fore) + \'"\'; DialogLine', String(p.x), String(p.y), args.double ? '2' : '1')}${p.note}`);
    },
  },
  close_app: {
    description: 'Gracefully close an open app window by part of its title (like clicking the X). Unsaved work may prompt the user.',
    parameters: {
      type: 'object',
      properties: { window: { type: 'string' } },
      required: ['window'],
    },
    run: async (args) =>
      ps(
        '$p = Get-Process | Where-Object { $_.MainWindowTitle -like "*$($env:JA)*" } | Select-Object -First 1; if (-not $p) { throw "No window matching $($env:JA)" }; if ($p.CloseMainWindow()) { "Closed $($p.ProcessName)." } else { "Could not close $($p.ProcessName): the window refused the close request (it may be minimised or waiting for a confirmation)." }',
        str(args.window)
      ),
  },
};
