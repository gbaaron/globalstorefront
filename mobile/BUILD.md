# Global Storefront Mobile App — Build & Deploy Guide

## Overview

This is a Capacitor-wrapped native app (iOS + Android) that loads the Global Storefront admin dashboard from `https://globalstorefront.netlify.app/app-login.html`. It adds native features (push notifications, haptics, badge count) that make it a legitimate App Store / Play Store app rather than a thin webview wrapper.

---

## Prerequisites

- **Node.js** 18+
- **Xcode** 15+ (for iOS builds)
- **Android Studio** (for Android builds)
- **CocoaPods** (`brew install cocoapods`)
- **Firebase project** set up with Cloud Messaging enabled

---

## First-Time Setup

```bash
cd mobile/

# 1. Install dependencies
npm install

# 2. Add native platforms (if not already present)
npx cap add ios
npx cap add android

# 3. Fix CocoaPods UTF-8 issue (if pod install fails)
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
cd ios/App && pod install && cd ../..

# 4. Place Firebase config files
# Copy GoogleService-Info.plist → ios/App/App/
# Copy google-services.json → android/app/
```

---

## Firebase Setup (One-Time)

1. Go to https://console.firebase.google.com/
2. Create project "Global Storefront"
3. Enable Cloud Messaging
4. **iOS app**: Bundle ID = `com.globalstorefront.app`
   - Download `GoogleService-Info.plist`
   - Place in `ios/App/App/GoogleService-Info.plist`
5. **Android app**: Package = `com.globalstorefront.app`
   - Download `google-services.json`
   - Place in `android/app/google-services.json`
6. **Server key** (for sending push from Netlify):
   - Project Settings → Cloud Messaging → Server Key
   - Add as `FIREBASE_SERVER_KEY` in Netlify env vars

---

## App Icon & Splash Screen

Place source images in `resources/`:
- `icon.png` — 1024x1024px (Gold "G" on dark navy `#0f0f1a`)
- `splash.png` — 2732x2732px (Centered logo on `#0f0f1a`)

Then generate all sizes:
```bash
npx capacitor-assets generate
```

This creates all required icon/splash variants for both platforms.

---

## Development Workflow

### Making changes to the web app

The native app loads from the live Netlify URL. To test changes:

1. Make edits to `app.html`, `app-login.html`, or Netlify functions in the main project
2. Push to GitHub → Netlify auto-deploys
3. Reopen the native app — it loads the updated version

### Testing locally (optional)

To test against a local dev server instead of production:

1. Edit `capacitor.config.ts`:
   ```ts
   server: {
     url: 'http://YOUR_LOCAL_IP:8888/app-login.html',
     cleartext: true  // required for HTTP
   }
   ```
2. Run `npx cap sync`
3. Build and run on device/simulator

**Remember to revert to the production URL before building for release.**

---

## Building for iOS

### Debug (Simulator)
```bash
npx cap open ios
# Xcode opens → select simulator → Run (Cmd+R)
```

### Debug (Physical Device)
```bash
npx cap run ios --target=YOUR_DEVICE_UDID
# Or: open Xcode, select your device, Run
```

### Release (App Store)
1. In Xcode: Product → Archive
2. Organizer → Distribute App → App Store Connect
3. Upload, then manage in App Store Connect

### iOS Signing Requirements
- Apple Developer account ($99/year)
- Provisioning profile with Push Notification entitlement
- Enable "Push Notifications" capability in Xcode project settings

---

## Building for Android

### Debug (Emulator)
```bash
npx cap open android
# Android Studio opens → select emulator → Run (Shift+F10)
```

### Debug (Physical Device)
```bash
npx cap run android
# Ensure USB debugging enabled on device
```

### Release (Play Store)
1. Android Studio → Build → Generate Signed Bundle / APK
2. Choose Android App Bundle (.aab)
3. Create/select keystore
4. Upload to Google Play Console

### Android Signing Requirements
- Google Play Developer account ($25 one-time)
- Upload keystore (keep this safe — cannot be regenerated)
- `google-services.json` must be present for FCM

---

## Syncing After Changes

When you change `capacitor.config.ts` or update plugins:
```bash
npx cap sync
```

When you add/remove Capacitor plugins:
```bash
npm install
npx cap sync
```

---

## Project Structure

```
mobile/
├── capacitor.config.ts          # Capacitor configuration (URL, plugins, native settings)
├── package.json                 # Dependencies (Capacitor + plugins)
├── tsconfig.json                # TypeScript config for capacitor.config.ts
├── BUILD.md                     # This file
├── .gitignore                   # Ignores node_modules, ios/, android/, firebase configs
├── www/                         # Fallback web assets (shown when offline)
│   ├── index.html               # Offline fallback page
│   └── native-bridge.js         # JS bridge for native plugins (push, haptics, badge)
├── firebase/                    # Firebase config templates
│   ├── README.md                # Setup instructions
│   ├── GoogleService-Info.plist.example
│   └── google-services.json.example
├── resources/                   # Source images for icon/splash generation
│   └── README.md                # Image specs
├── ios/                         # Generated Xcode project
│   └── App/
│       └── App/
│           ├── AppDelegate.swift    # Push notification delegate methods
│           └── Info.plist           # Background modes, orientation lock
└── android/                     # Generated Android Studio project
    └── app/
        ├── build.gradle             # google-services plugin (conditional)
        └── src/main/
            └── AndroidManifest.xml  # Permissions (notifications, vibrate)
```

---

## How Push Notifications Work

```
1. User logs into app → Capacitor requests FCM token
2. native-bridge.js calls NativeBridge.registerPush()
3. Token sent to /api/register-device (stored in DeviceTokens table)
4. Customer asks question on website → bot can't answer → escalate.js fires
5. escalate.js fetches DeviceTokens for tenant → sends FCM push
6. Phone shows notification → user taps → app opens to conversation
```

### Integrating with app.html

Add this to `app.html`'s login success handler:

```javascript
// After successful login, register for push
if (window.NativeBridge && window.NativeBridge.isNative) {
  const token = await window.NativeBridge.registerPush();
  if (token) {
    await fetch('/api/register-device', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + localStorage.getItem('gs_token')
      },
      body: JSON.stringify({
        token: token,
        platform: window.NativeBridge.getPlatform()
      })
    });
  }

  // Handle notification taps — navigate to the conversation
  window.NativeBridge.onPushTapped((notification) => {
    const convId = notification.data?.conversationId;
    if (convId) {
      go('chat', convId);
    }
  });

  // Handle foreground notifications — show in-app alert + haptic
  window.NativeBridge.onPushReceived((notification) => {
    window.NativeBridge.hapticWarning();
    showToast(notification.body || 'New message from a customer');
    loadConversations(); // refresh inbox
  });
}
```

---

## App Store Submission Checklist

### Apple App Store
- [ ] App icon (1024x1024) — no transparency, no rounded corners (iOS rounds them)
- [ ] Screenshots (6.7" and 6.5" iPhone, 12.9" iPad)
- [ ] Privacy Policy URL (host at globalstorefront.netlify.app/privacy.html)
- [ ] App description + keywords
- [ ] Push Notification entitlement enabled in developer portal
- [ ] Tested on physical device (not just simulator)
- [ ] No placeholder content visible

### Google Play Store
- [ ] App icon (512x512)
- [ ] Feature graphic (1024x500)
- [ ] Screenshots (phone + tablet)
- [ ] Privacy Policy URL
- [ ] Content rating questionnaire completed
- [ ] google-services.json present in build
- [ ] Signed AAB with production keystore
- [ ] Tested on physical device

---

## Environment Variables (Netlify)

These must be set in the Netlify dashboard for push to work:

```
FIREBASE_SERVER_KEY=<from Firebase Console>
FIREBASE_PROJECT_ID=global-storefront
```

(All other env vars — AIRTABLE_API_KEY, JWT_SECRET, OPENAI_API_KEY — are already set from Phase 1.)

---

## Troubleshooting

### CocoaPods UTF-8 error
```bash
export LANG=en_US.UTF-8
export LC_ALL=en_US.UTF-8
cd ios/App && pod install
```

### Push notifications not arriving
1. Check `google-services.json` / `GoogleService-Info.plist` are in the right directories
2. Verify `FIREBASE_SERVER_KEY` is set in Netlify env vars
3. Check DeviceTokens table has a valid token for the user
4. On iOS: ensure Push Notification capability is enabled in Xcode signing
5. On Android: ensure `POST_NOTIFICATIONS` permission is granted (Android 13+)

### App shows offline fallback
- Check internet connection
- Verify `globalstorefront.netlify.app` is accessible
- Check `capacitor.config.ts` has the correct URL

### Changes not appearing in app
The app loads from the live URL — changes deploy when you push to GitHub.
Clear the webview cache if needed:
- iOS: uninstall + reinstall
- Android: App Info → Storage → Clear Cache
