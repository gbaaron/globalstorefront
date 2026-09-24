import { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.globalstorefront.app',
  appName: 'Global Storefront',
  webDir: 'www',
  server: {
    // Points to the live Netlify-deployed app.
    // ?native=1 is a permanent marker so the web app reliably knows it's
    // running inside the native shell (Capacitor's JS bridge isn't reliably
    // injected on remote-hosted pages, so we can't depend on window.Capacitor).
    url: 'https://globalstorefront.netlify.app/app-login.html?native=1',
    cleartext: false
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert']
    },
    StatusBar: {
      style: 'Dark',
      backgroundColor: '#0f0f1a'
    },
    SplashScreen: {
      launchShowDuration: 2000,
      launchAutoHide: true,
      backgroundColor: '#0f0f1a',
      showSpinner: false,
      androidScaleType: 'CENTER_CROP',
      splashFullScreen: true,
      splashImmersive: true
    },
    LocalNotifications: {
      smallIcon: 'ic_stat_notify',
      iconColor: '#d4af37'
    }
  },
  ios: {
    contentInset: 'always',
    allowsLinkPreview: false,
    scrollEnabled: true
  },
  android: {
    allowMixedContent: false,
    backgroundColor: '#0f0f1a'
  }
};

export default config;
