import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.jini.companion',
  appName: 'JINI',
  webDir: 'dist',
  server: {
    // http://localhost is still a secure context (WebCrypto works) and lets the app open the
    // ws:// live channel to the desktop on the LAN. Payloads are end-to-end encrypted by the
    // JINI link protocol regardless of transport.
    androidScheme: 'http',
  },
  plugins: {
    // Native HTTP: requests to the desktop and to the AI provider bypass WebView CORS.
    CapacitorHttp: { enabled: true },
  },
  android: { allowMixedContent: true },
};

export default config;
