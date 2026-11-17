/**
 * Shared electron stub for tests that import electron-coupled modules. Import-time usage
 * across the graph is limited to destructuring; a catch-all Proxy keeps every runtime call
 * harmless while explicit values (safeStorage off, tmp paths) keep branching deterministic.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
export const electronStub = (): any => {
  const flexible = (): any =>
    new Proxy(function () {}, {
      get: (_t, prop) => {
        if (prop === 'then') return undefined; // never a thenable
        if (prop === 'isDestroyed') return () => true;
        return flexible();
      },
      construct: () => flexible(),
      apply: () => flexible(),
    });
  return {
    app: { getPath: () => '/tmp', getVersion: () => '32.0.0', isReady: true, whenReady: async () => undefined, name: 'JARVIS', isPackaged: false, on: () => undefined, once: () => undefined, off: () => undefined },
    safeStorage: { isEncryptionAvailable: () => false, encryptString: (s: string) => Buffer.from(s), decryptString: (b: Buffer) => b.toString() },
    BrowserWindow: flexible(),
    WebContentsView: flexible(),
    ipcMain: flexible(),
    ipcRenderer: flexible(),
    screen: flexible(),
    session: flexible(),
    desktopCapturer: flexible(),
    Notification: flexible(),
    globalShortcut: flexible(),
    dialog: flexible(),
    Menu: flexible(),
    nativeTheme: flexible(),
    powerMonitor: flexible(),
    systemPreferences: flexible(),
    shell: { openExternal: async () => undefined, openPath: async () => '', beep: () => undefined },
    clipboard: { readText: () => '', writeText: () => undefined, readImage: () => ({}) },
  };
};
