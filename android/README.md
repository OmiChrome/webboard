# Android app (Trusted Web Activity)

The Android app is the same PWA, wrapped as a **Trusted Web Activity**: a thin
APK that opens the site in the user's Chrome without browser UI. Because it is
real Chrome (not a WebView), **WebUSB works**, so the USB-serial drivers in
`web/src/lib/serial/webusb.ts` can talk to the board over an OTG cable.

> A plain WebView / default Capacitor shell would **not** work: Android
> WebView has no WebUSB or Web Serial. If you ever need a WebView shell, add a
> native plugin based on `usb-serial-for-android` and implement the
> `Transport` interface on top of it.

## Build the APK

1. Deploy the app over HTTPS (see the root README) and replace
   `bitbench.example.com` in `twa-manifest.json` with your domain.
2. Install Bubblewrap and build (needs a JDK + Android SDK; Bubblewrap can
   download both):

   ```bash
   npm i -g @bubblewrap/cli
   cd android && bubblewrap build
   ```
3. Publish Digital Asset Links so Chrome trusts the app (removes the URL bar):
   `bubblewrap fingerprint generateAssetLinks` and serve the output at
   `https://<your-domain>/.well-known/assetlinks.json`
   (put it in `web/public/.well-known/`).
4. `adb install app-release-signed.apk`, plug the board in with a USB-OTG
   adapter, choose **USB device (WebUSB driver)** and press Upload.

## Phone checklist
- The phone must support USB host/OTG (most do; some need OTG enabled in settings).
- Use a data-capable cable. Chrome will show its USB permission prompt the first time.
- On Android 17+ with Chrome 148+, the **Web Serial** option may also work on
  devices that expose wired serial ports; WebUSB is the reliable path today.
