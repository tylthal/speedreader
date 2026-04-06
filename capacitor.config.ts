import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.speedreader.app',
  appName: 'SpeedReader',
  webDir: 'dist',
  android: {
    // https scheme is critical: enables service workers, IndexedDB, WASM in Android WebView
    scheme: 'https',
  },
  plugins: {
    SplashScreen: {
      launchAutoHide: true,
      launchShowDuration: 1500,
      backgroundColor: '#1C1C1E',
    },
  },
  // Uncomment for live reload during development:
  // server: {
  //   url: 'http://YOUR_LAN_IP:5173',
  //   cleartext: true,
  // },
};

export default config;
