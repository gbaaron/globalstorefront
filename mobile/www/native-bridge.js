/**
 * Native Bridge — Capacitor Plugin Interface
 *
 * This script is injected into the webview alongside the web app.
 * It provides a global `NativeBridge` object that the web app (app.html)
 * can call to access native features (push, haptics, badge).
 *
 * Usage from app.html:
 *   if (window.NativeBridge) {
 *     NativeBridge.registerPush(token => sendToServer(token));
 *     NativeBridge.hapticTap();
 *     NativeBridge.setBadge(3);
 *   }
 */

(function() {
  'use strict';

  // Only activate inside Capacitor native shell
  const isNative = window.Capacitor && window.Capacitor.isNativePlatform();

  if (!isNative) {
    // Provide no-op stubs so web app code doesn't need to check everywhere
    window.NativeBridge = {
      isNative: false,
      registerPush: () => Promise.resolve(null),
      hapticTap: () => {},
      hapticSuccess: () => {},
      hapticWarning: () => {},
      setBadge: () => Promise.resolve(),
      clearBadge: () => Promise.resolve(),
      getPlatform: () => 'web',
      onPushReceived: () => {},
      onPushTapped: () => {}
    };
    return;
  }

  // Import Capacitor plugins
  const { PushNotifications } = window.Capacitor.Plugins;
  const { Haptics } = window.Capacitor.Plugins;
  const { Badge } = window.Capacitor.Plugins; // @capawesome/capacitor-badge
  const { StatusBar } = window.Capacitor.Plugins;
  const { App } = window.Capacitor.Plugins;

  // Push notification callbacks (set by the web app)
  let _onPushReceived = null;
  let _onPushTapped = null;

  // Initialize push notifications
  async function initPush() {
    try {
      // Request permission
      const permResult = await PushNotifications.requestPermissions();
      if (permResult.receive !== 'granted') {
        console.warn('[NativeBridge] Push permission denied');
        return null;
      }

      // Register with FCM/APNs
      await PushNotifications.register();

      // Listen for token
      return new Promise((resolve) => {
        PushNotifications.addListener('registration', (token) => {
          console.log('[NativeBridge] FCM Token:', token.value);
          resolve(token.value);
        });

        PushNotifications.addListener('registrationError', (err) => {
          console.error('[NativeBridge] Push registration error:', err);
          resolve(null);
        });
      });
    } catch (err) {
      console.error('[NativeBridge] initPush error:', err);
      return null;
    }
  }

  // Set up push notification listeners
  function setupPushListeners() {
    // Notification received while app is in foreground
    PushNotifications.addListener('pushNotificationReceived', (notification) => {
      console.log('[NativeBridge] Push received:', notification);
      if (_onPushReceived) _onPushReceived(notification);
    });

    // User tapped on a notification
    PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
      console.log('[NativeBridge] Push tapped:', action);
      if (_onPushTapped) _onPushTapped(action.notification);
    });
  }

  // Initialize status bar
  async function initStatusBar() {
    try {
      await StatusBar.setStyle({ style: 'DARK' });
      await StatusBar.setBackgroundColor({ color: '#0f0f1a' });
    } catch (err) {
      // Status bar may not be available on all platforms
    }
  }

  // Handle app state changes (for badge clearing)
  function initAppListeners() {
    App.addListener('appStateChange', ({ isActive }) => {
      if (isActive) {
        // Clear badge when app comes to foreground
        Badge.clear().catch(() => {});
      }
    });
  }

  // Initialize everything
  setupPushListeners();
  initStatusBar();
  initAppListeners();

  // Expose the NativeBridge API
  window.NativeBridge = {
    isNative: true,

    /**
     * Register for push notifications.
     * Returns the FCM device token (or null if denied/failed).
     */
    registerPush: initPush,

    /**
     * Light haptic tap (for button presses, selections)
     */
    hapticTap: () => {
      Haptics.impact({ style: 'LIGHT' }).catch(() => {});
    },

    /**
     * Success haptic (for completed actions)
     */
    hapticSuccess: () => {
      Haptics.notification({ type: 'SUCCESS' }).catch(() => {});
    },

    /**
     * Warning haptic (for new message arrival)
     */
    hapticWarning: () => {
      Haptics.notification({ type: 'WARNING' }).catch(() => {});
    },

    /**
     * Set the app icon badge count
     */
    setBadge: (count) => {
      return Badge.set({ count }).catch(() => {});
    },

    /**
     * Clear the app icon badge
     */
    clearBadge: () => {
      return Badge.clear().catch(() => {});
    },

    /**
     * Get the current platform ('ios' | 'android')
     */
    getPlatform: () => {
      return window.Capacitor.getPlatform();
    },

    /**
     * Set callback for when push notification arrives (foreground)
     */
    onPushReceived: (callback) => {
      _onPushReceived = callback;
    },

    /**
     * Set callback for when user taps a push notification
     */
    onPushTapped: (callback) => {
      _onPushTapped = callback;
    }
  };

  console.log('[NativeBridge] Initialized on', window.Capacitor.getPlatform());
})();
