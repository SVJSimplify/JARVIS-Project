/**
 * ROUND 23 — UI WINDOW-SIZE VALIDATION HARNESS (run with xvfb + electron, Linux).
 *
 * Loads the BUILT renderer once in a real BrowserWindow, RESIZES it through the three
 * desktop sizes (a real live resize, no reload — task state must survive it), drives the
 * REAL UI paths (header summary button, popover, Settings → Activity), and saves a
 * screenshot at each state. No app source is modified; the harness only observes.
 */
import { app, BrowserWindow } from 'electron';
import * as path from 'path';
import * as fs from 'fs';
import { fileURLToPath } from 'url';

const here = path.dirname(fileURLToPath(import.meta.url));
const OUT = '/tmp/r23-ui-shots';
const SIZES = [
  { name: 'min-1000x700', width: 1000, height: 700 },
  { name: 'mid-1180x800', width: 1180, height: 800 },
  { name: 'full-1400x900', width: 1400, height: 900 },
];

const shot = async (win, name) => {
  const img = await win.webContents.capturePage();
  fs.mkdirSync(OUT, { recursive: true });
  fs.writeFileSync(path.join(OUT, `${name}.png`), img.toPNG());
};

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({
      width: SIZES[0].width,
      height: SIZES[0].height,
      show: true,
      backgroundColor: '#02060b',
      webPreferences: {
        preload: path.join(here, '../dist/preload/index.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    await win.loadFile(path.join(here, '../dist/renderer/index.html'));
    await new Promise((r) => setTimeout(r, 3000));

    for (const s of SIZES) {
      await win.setSize ? null : null;
      win.setBounds({ width: s.width, height: s.height });
      await new Promise((r) => setTimeout(r, 800));
      const probe = await win.webContents.executeJavaScript(
        `(() => {
           const btns = [...document.querySelectorAll('button')];
           const b = btns.find((x) => (x.getAttribute('aria-label') || '').startsWith('Tool activity'));
           const header = document.querySelector('header');
           return {
             width: window.innerWidth,
             buttons: btns.length,
             summary: !!b,
             summaryText: b ? b.textContent.trim() : null,
             headerText: header ? header.innerText.slice(0, 120) : null,
           };
         })()`
      );
      console.log(`[probe] ${s.name}: ${JSON.stringify(probe)}`);
      await shot(win, `header-${s.name}`);
      if (probe.summary) {
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('Tool activity')).click()`
        );
        await new Promise((r) => setTimeout(r, 700));
        await shot(win, `popover-${s.name}`);
        await win.webContents.executeJavaScript(
          `[...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '').startsWith('Tool activity')).click()`
        );
        await new Promise((r) => setTimeout(r, 300));
      }
    }

    // Settings → Activity at full size, through the real gear + nav buttons.
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].find((x) => (x.getAttribute('aria-label') || '') === 'Provider settings').click()`
    );
    await new Promise((r) => setTimeout(r, 600));
    const nav = await win.webContents.executeJavaScript(
      `(() => {
         const btns = [...document.querySelectorAll('button')];
         const act = btns.find((x) => x.textContent.trim() === 'Activity');
         const tra = btns.find((x) => x.textContent.trim() === 'Transcript');
         if (act) act.click();
         return { activity: !!act, transcript: !!tra };
       })()`
    );
    await new Promise((r) => setTimeout(r, 900));
    await shot(win, 'settings-activity-1400x900');
    // Switch to the Transcript section (real nav button) and screenshot.
    await win.webContents.executeJavaScript(
      `[...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'Transcript').click()`
    );
    await new Promise((r) => setTimeout(r, 600));
    await shot(win, 'settings-transcript-1400x900');
    console.log(`[probe] settings nav: ${JSON.stringify(nav)}`);
    console.log('[ui-shots] DONE');
    process.exit(0);
  } catch (e) {
    console.error('[ui-shots] FAILED:', e);
    process.exit(1);
  }
});
