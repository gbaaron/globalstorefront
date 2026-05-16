# Firebase Configuration

## Setup Steps

1. Go to https://console.firebase.google.com/
2. Create a new project named "Global Storefront"
3. Enable Cloud Messaging (FCM)
4. Add an iOS app (bundle ID: `com.globalstorefront.app`)
5. Add an Android app (package: `com.globalstorefront.app`)
6. Download the config files:

### iOS
- Download `GoogleService-Info.plist`
- Place it in this directory
- It will be copied to `ios/App/App/` during build

### Android
- Download `google-services.json`
- Place it in this directory
- It will be copied to `android/app/` during build

## Server Key (for sending push notifications from Netlify functions)

1. In Firebase Console → Project Settings → Cloud Messaging
2. Enable "Cloud Messaging API (Legacy)" if not already enabled
3. Copy the Server Key
4. Add as `FIREBASE_SERVER_KEY` environment variable in Netlify dashboard

## Alternatively: Firebase Admin SDK (recommended for production)

Instead of the legacy server key, use a service account:
1. Firebase Console → Project Settings → Service Accounts
2. Generate New Private Key
3. Add `FIREBASE_SERVICE_ACCOUNT` env var (JSON string) in Netlify

The `escalate.js` function supports both methods.
