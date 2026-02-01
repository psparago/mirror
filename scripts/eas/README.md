# EAS Build Scripts for Reflections

This directory contains scripts for building and distributing the Reflections  and Reflections Companion (Reflections Companion) iOS apps using Expo Application Services (EAS).

## 📱 Apps Overview

- **Reflections **: The primary app for Cole to view reflections sent by family
- **Reflections Companion (Reflections Companion)**: The companion app for family members to create and send reflections

## 🏗️ Build Profiles

### Preview Profile (Recommended for Family Distribution)
- **Purpose**: Optimized production-like builds for internal distribution
- **Distribution**: Internal (shareable URL, no App Store required)
- **Performance**: Full optimization, no development overhead
- **Use Case**: Sending to family devices for real-world testing and use
- **Expiration**: 30 days (just rebuild and share new URL)
- **Device Limit**: Up to 100 devices can install

### Development Profile (For Active Development)
- **Purpose**: Development builds with hot reload and debugging
- **Distribution**: Internal (shareable URL)
- **Performance**: Includes dev client overhead
- **Use Case**: Your own testing and development
- **Features**: Fast Refresh, React DevTools, better error messages

### Production Profile (For App Store)
- **Purpose**: Final builds for App Store submission
- **Distribution**: App Store
- **Use Case**: Public release (not yet configured for submission)

## 🚀 Build Scripts

### Preview Builds (For Family)

#### Build Reflections Only
```bash
./scripts/eas/build-Reflections-preview-ios.sh
```
Builds Reflections  in preview mode for internal distribution.

#### Build Reflections Companion Only
```bash
./scripts/eas/build-Reflections-companion-preview-ios.sh
```
Builds Reflections Companion in preview mode for internal distribution.

#### Build Both Apps
```bash
./scripts/eas/build-all-preview-ios.sh
```
Builds both Reflections and Reflections Companion in preview mode. **Recommended for family distribution.**

### Development Builds (For Testing)

#### Build Reflections Development
```bash
./scripts/eas/build-Reflections-dev-ios.sh
```
Builds Reflections  with development client for hot reload and debugging.

#### Build Reflections Companion Development
```bash
./scripts/eas/build-Reflections-companion-dev-ios.sh
```
Builds Reflections Companion with development client for hot reload and debugging.

### Check Build Status

#### List Recent Builds
```bash
./scripts/eas/list-builds.sh
```
Shows the 5 most recent builds for both apps.

## ⏱️ Build Timeline

### First Build
- **Duration**: ~15-20 minutes
- **Why**: Compiling all native modules from scratch (expo-camera, expo-audio, expo-blur, etc.)
- **One-time**: Subsequent builds are faster

### Subsequent Builds
- **Duration**: ~10-15 minutes
- **Why**: Incremental compilation with cached dependencies

## 📦 What Happens During a Build

1. **Submission**: Script submits build to EAS cloud builders
2. **Compilation**: EAS compiles your React Native code and native modules
3. **Signing**: EAS automatically handles iOS certificates and provisioning profiles
4. **Distribution**: Build is uploaded and made available via URL
5. **Notification**: You'll receive email when build completes

## 🔗 After Build Completes

### Getting the Install URL

1. **Via Email**: EAS sends you an email with the install link
2. **Via Web**: Visit the Expo dashboard:
   - Reflections: https://expo.dev/accounts/psparago/projects/reflections-explorer/builds
   - Reflections Companion: https://expo.dev/accounts/psparago/projects/reflections-companion/builds
3. **Via CLI**: Run `./scripts/eas/list-builds.sh`

### Sharing with Family

1. Copy the install URL from the build details
2. Send the URL via text/email to family members
3. They open the URL on their iOS device
4. They tap "Install" and follow the prompts
5. The app appears on their home screen as "Reflections" or "Reflections Companion"

### Installing on Your Own Device

Same process as above - just open the URL on your iPhone/iPad.

## 🔐 iOS Certificates & Provisioning

EAS automatically manages:
- **Development Certificates**: For development builds
- **Distribution Certificates**: For preview/production builds
- **Provisioning Profiles**: Device registration and app signing
- **Push Notification Certificates**: If/when you add push notifications

You don't need to manually create or manage these in the Apple Developer Portal.

## 📋 App Configuration

### Reflections 
- **Display Name**: Reflections
- **Bundle ID**: com.psparago.lookingglass
- **Expo Slug**: reflections-explorer (internal only)
- **EAS Project ID**: c68c385b-fb1c-4beb-b226-5750b49b20d2
- **Native Plugins**: expo-camera, expo-audio, expo-blur, expo-speech

### Reflections Companion (Reflections Companion)
- **Display Name**: Reflections Companion
- **Bundle ID**: com.psparago.lookingglass.companion
- **Expo Slug**: reflections-companion (internal only)
- **EAS Project ID**: a21eb601-52c9-4d66-97d9-0891967bedee
- **Native Plugins**: expo-camera, expo-image-picker, expo-audio, expo-blur

## 🛠️ Troubleshooting

### Build Fails
1. Check the build logs in the Expo dashboard
2. Common issues:
   - Missing dependencies (run `npm install` in the app directory)
   - Invalid app.json configuration
   - iOS certificate issues (EAS usually auto-resolves)

### Can't Install on Device
1. **Device not registered**: First build registers your device automatically
2. **Build expired**: Builds expire after 30 days - create a new build
3. **iOS version**: Ensure device is running iOS 13.4 or later

### Build Takes Too Long
- First builds are always slower (~15-20 min)
- Subsequent builds cache dependencies (~10-15 min)
- If stuck > 30 min, check Expo dashboard for errors

## 🔄 Updating Builds

### When to Rebuild
- Code changes in the app
- Dependency updates
- Configuration changes in app.json or eas.json
- Build expired (30 days)

### How to Update
1. Make your code changes
2. Commit to git (recommended but not required)
3. Run the appropriate build script
4. Share the new URL with family

### Development Builds with Hot Reload
If using development builds, you can:
- Make code changes without rebuilding
- Use Fast Refresh for instant updates
- Only rebuild when native dependencies change

## 📱 Device Requirements

### iOS
- **Minimum Version**: iOS 13.4
- **Supported Devices**: iPhone 6s and later, iPad Air 2 and later
- **Installation**: Via Safari (not Chrome or other browsers)

### Android (Future)
- Not yet configured
- Will use APK format for easy installation
- No Google Play Store required for internal distribution

## 🔑 EAS Account

- **Owner**: psparago
- **Organization**: Personal account
- **Projects**:
  - reflections-cole (Reflections / Reflections)
  - reflections-companion (Reflections Companion / Reflections Companion)

## 📚 Additional Resources

- [EAS Build Documentation](https://docs.expo.dev/build/introduction/)
- [Internal Distribution Guide](https://docs.expo.dev/build/internal-distribution/)
- [EAS Dashboard](https://expo.dev/accounts/psparago/projects)
- [Expo Forums](https://forums.expo.dev/) - For troubleshooting help

## 🎯 Quick Start Guide

### First Time Building

1. **Ensure you're logged into EAS**:
   ```bash
   npx eas login
   ```

2. **Build both apps for family distribution**:
   ```bash
   ./scripts/eas/build-all-preview-ios.sh
   ```

3. **Wait for builds to complete** (~15-20 minutes first time)

4. **Check build status**:
   ```bash
   ./scripts/eas/list-builds.sh
   ```

5. **Get install URLs** from:
   - Email notification from EAS
   - Expo dashboard
   - Build list output

6. **Share URLs with family** via text/email

7. **Family installs** by opening URL in Safari on their iOS device

### Regular Updates

1. **Make code changes**
2. **Rebuild**:
   ```bash
   ./scripts/eas/build-all-preview-ios.sh
   ```
3. **Share new URLs** with family

## 💡 Tips & Best Practices

### For Development
- Use development builds for your own testing
- Use preview builds when sharing with family
- Keep development and preview builds separate

### For Distribution
- Always test preview builds yourself before sharing
- Keep track of which build version family members have
- Notify family when you share a new build
- Builds expire after 30 days - plan accordingly

### For Debugging
- Check build logs in Expo dashboard for errors
- Use `./scripts/eas/list-builds.sh` to see recent build status
- Development builds provide better error messages

### For Performance
- Preview builds are fully optimized
- Development builds are slower due to dev client
- Production builds (future) will be identical to preview for performance

## 🔒 Security Notes

- Bundle IDs are unique identifiers (cannot be changed after App Store submission)
- Internal distribution builds are signed with your Apple Developer account
- Only devices you authorize can install internal distribution builds
- Builds expire after 30 days for security

## 📝 Version Management

### App Versions
Update version in `app.json`:
```json
{
  "expo": {
    "version": "1.0.0"
  }
}
```

### Build Numbers
EAS automatically increments build numbers for each build.

### Tracking Versions
- Check Expo dashboard for build history
- Use `./scripts/eas/list-builds.sh` to see recent versions
- Recommended: Tag git commits with version numbers

---

**Last Updated**: January 2026  
**Maintainer**: psparago  
**Apps**: Reflections & Reflections Companion (Reflections Companion)

