# SpeedReader: App Store Deployment Roadmap

The app is fully client-side with no backend dependencies. This document covers what remains to ship to the Google Play Store and Apple App Store via Capacitor.

---

## 1. Capacitor Setup

**Status: Not started**

- [ ] Install Capacitor core: `npm install @capacitor/core @capacitor/cli`
- [ ] Install platform packages: `npm install @capacitor/android @capacitor/ios`
- [ ] Create `capacitor.config.ts` with `appId: 'com.speedreader.app'`, `webDir: 'dist'`, `androidScheme: 'https'`
- [ ] Run `npx cap init SpeedReader com.speedreader.app --web-dir dist`
- [ ] Run `npx cap add android` and `npx cap add ios`
- [ ] Add npm scripts: `"cap:sync": "cap sync"`, `"build:native": "npm run build && cap sync"`
- [ ] Configure live reload for dev: set `server.url` to LAN IP of Vite dev server in capacitor config

---

## 2. Native Plugin Replacements

Several Web APIs work inconsistently in native WebViews. These need Capacitor plugin replacements.

### Haptics
**Status: Using `navigator.vibrate()` — works on Android, does nothing on iOS**

- [ ] Install `@capacitor/haptics`
- [ ] Update `src/hooks/useHaptics.ts` to use `Haptics.impact()` when `Capacitor.isNativePlatform()` is true, fall back to `navigator.vibrate()` for web

### Wake Lock
**Status: Using Web Wake Lock API — not supported in iOS WKWebView**

- [ ] Install `@capacitor-community/keep-awake`
- [ ] Update `src/hooks/useWakeLock.ts` to use `KeepAwake.keepAwake()` / `KeepAwake.allowSleep()` on native, keep existing Web Wake Lock for browser

### Status Bar
**Status: Only meta tags — no native control**

- [ ] Install `@capacitor/status-bar`
- [ ] Integrate with `src/hooks/useTheme.ts` to call `StatusBar.setBackgroundColor()` and `StatusBar.setStyle()` on theme changes

### Splash Screen
- [ ] Install `@capacitor/splash-screen`
- [ ] Configure auto-hide in `capacitor.config.ts`

### File Picker (for "Open With" support)
- [ ] Install `@capawesome/capacitor-file-picker` for native file selection
- [ ] Install `@capacitor/app` for handling "Open With" intents from other apps
- [ ] Add intent filters in `AndroidManifest.xml` for epub/pdf MIME types
- [ ] Add `CFBundleDocumentTypes` in iOS `Info.plist` for epub/pdf UTIs
- [ ] Wire `App.addListener('appUrlOpen')` to import the received file

---

## 3. Service Worker Handling

**Status: Workbox SW precaches all assets — redundant in native context since Capacitor serves from local filesystem**

- [ ] Detect `Capacitor.isNativePlatform()` in `src/main.tsx` and skip SW registration when native
- [ ] Alternatively, keep the SW for consistency (it won't cause problems, just unnecessary)

---

## 4. MediaPipe WASM (Eye/Head Tracking)

**Status: Loads WASM + model from CDN at runtime — works but requires network on first use**

- [ ] Copy MediaPipe WASM files (~2MB) to `public/mediapipe/wasm/`
- [ ] Copy face landmarker model (~4MB) to `public/models/`
- [ ] Update `src/hooks/useGazeTracker.ts` to load from local paths instead of CDN
- [ ] This eliminates the network dependency and adds ~6MB to the app binary
- [ ] Test WASM SIMD support: requires iOS 16.4+ (WKWebView) and Android WebView 91+
- [ ] Add graceful fallback message for older devices where WASM SIMD fails

---

## 5. Install Prompt Suppression

**Status: `useInstallPrompt.ts` shows PWA install banners — irrelevant in a native app**

- [ ] Check `Capacitor.isNativePlatform()` and skip install prompt rendering entirely
- [ ] Hide any "Add to Home Screen" UI when running as a native app

---

## 6. App Icons and Splash Screens

- [ ] Create a 1024x1024 source icon (the existing `public/pwa-512x512.png` can be upscaled or redesigned)
- [ ] Install `@capacitor/assets`: `npm install -D @capacitor/assets`
- [ ] Run `npx capacitor-assets generate --iconBackgroundColor '#1a1a2e' --splashBackgroundColor '#1a1a2e'`
- [ ] This generates all required sizes for both platforms

---

## 7. Platform-Specific Configuration

### iOS
- [ ] Set minimum deployment target to iOS 16.4 (for WASM SIMD support)
- [ ] Add `NSCameraUsageDescription` in `Info.plist`: "SpeedReader uses the camera for eye-tracking to auto-scroll text as you read"
- [ ] Configure App Transport Security if loading any HTTP resources
- [ ] Set up code signing: Apple Developer account ($99/year), certificates, provisioning profiles

### Android
- [ ] Set `minSdkVersion` to 26 (Android 8.0) or higher
- [ ] Add camera permission in `AndroidManifest.xml` with rationale for gaze tracking
- [ ] Generate a release keystore for signing: `keytool -genkey -v -keystore speedreader.jks -keyalg RSA -keysize 2048 -validity 10000`
- [ ] Store keystore credentials securely (never commit to git)

---

## 8. Build Pipeline

### Local builds
```
npm run build          # Vite production build → dist/
npx cap sync           # Copy dist/ to native projects + sync plugins
npx cap open ios       # Open in Xcode
npx cap open android   # Open in Android Studio
```

### CI/CD (GitHub Actions)
- [ ] Add workflow for web build + `cap sync`
- [ ] iOS job (runs on `macos-latest`): `xcodebuild archive` → `xcodebuild -exportArchive`
- [ ] Android job: `cd android && ./gradlew assembleRelease` (or `bundleRelease` for AAB)
- [ ] Store signing credentials as GitHub Actions secrets

---

## 9. App Store Submission

### Apple App Store (TestFlight first)
- [ ] Apple Developer Program enrollment ($99/year)
- [ ] Create App ID in App Store Connect
- [ ] Upload build via Xcode Organizer or `xcrun altool`
- [ ] Fill in App Store listing: description, screenshots (6.7" and 5.5" iPhone, iPad)
- [ ] Privacy policy URL (required) — document that data stays on-device
- [ ] Submit for TestFlight review (usually <48 hours)
- [ ] After testing, submit for App Store review

### Google Play Store
- [ ] Google Play Developer account ($25 one-time)
- [ ] Create app listing in Play Console
- [ ] Upload signed AAB (Android App Bundle)
- [ ] Fill in store listing: description, screenshots (phone + 7" and 10" tablet)
- [ ] Complete data safety form — declare that no data leaves the device
- [ ] Content rating questionnaire
- [ ] Roll out to internal testing track first, then production

---

## 10. Store Listing Assets Needed

- [ ] App name: "SpeedReader"
- [ ] Short description (80 chars): "Speed read any ebook with phrase display, eye tracking, and offline support"
- [ ] Full description (4000 chars)
- [ ] Feature graphic (1024x500 for Play Store)
- [ ] Screenshots: at least 2 per form factor
  - Phone reading view (phrase mode)
  - Library view
  - Settings/theme options
  - Eye tracking in action (optional, differentiator)
- [ ] Privacy policy page (can be a simple GitHub Pages site)
- [ ] App icon (already have SVG source)

---

## Estimated Effort

| Task | Effort |
|------|--------|
| Capacitor setup + platform add | 1 hour |
| Native plugin replacements | 2-3 hours |
| MediaPipe local bundling | 1 hour |
| Icons and splash screens | 30 min |
| Platform config (Info.plist, manifest) | 1-2 hours |
| Build pipeline / CI | 2-3 hours |
| Store listing + screenshots | 2-3 hours |
| TestFlight + Play Store submission | 1-2 hours |
| **Total** | **~12-16 hours** |

---

## 11. CFBundleVersion / versionCode Auto-Increment

**Status: Manual — not automated in CI**

Store submissions require a monotonically increasing build number every upload. Right now `CFBundleVersion` (iOS, `$(CURRENT_PROJECT_VERSION)` in `ios/App/App.xcodeproj/project.pbxproj`) and `versionCode` (Android, `android/app/build.gradle`) must be bumped by hand.

Recommended approaches (document-only; do not implement until CI is wired up):

- **iOS / Xcode build phase** — add a "Run Script" build phase before the "Compile Sources" phase that runs:
  ```sh
  cd "$SRCROOT"
  agvtool next-version -all
  ```
  This requires `VERSIONING_SYSTEM = "apple-generic"` and `CURRENT_PROJECT_VERSION` to be set in the target's build settings (they already are). Caveat: the change gets written back into `project.pbxproj`, so local builds will produce dirty working trees. Gate the script on `CONFIGURATION = Release` to avoid churn during development.
- **fastlane** — run `fastlane run increment_build_number` (iOS) and `fastlane run increment_version_code` (Android) as an early lane step before `gym` / `gradle`. Cleaner than Xcode build phases because the bump happens in CI, not in every developer's local archive.
- **CI-driven** — derive `CFBundleVersion` from `GITHUB_RUN_NUMBER` (or a commit count: `git rev-list --count HEAD`) and inject via `xcodebuild CURRENT_PROJECT_VERSION=...` / Gradle `-PversionCode=...`. This keeps the repo clean (no generated bumps committed) but requires the build command to always set the flag.

No Xcode project changes have been made for this — revisit once GitHub Actions (Section 8) lands.

---

## What's Already Done

- Fully offline, client-side app (no backend)
- IndexedDB storage via Dexie.js with OPFS backup
- 10 format parsers running in a Web Worker (EPUB, PDF, TXT, HTML, MD, FB2, RTF, DOCX, CBZ)
- PWA with service worker, manifest, and icons
- Viewport and status bar meta tags configured
- Platform detection in `useInstallPrompt.ts`
- `viewport-fit=cover` for safe area handling
