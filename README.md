# Kharcha

A Google-style expense tracker for phone and computer: daily expenses and income, budgets with alerts, bills and subscriptions, savings goals, a running tab with each friend (with WhatsApp payment reminders), charts, a calculator, and money calculators (EMI, SIP, FD, GST, fuel, discount, inflation).

With Google sign-in turned on, everyone gets a **private book**. You can also create **shared books** (for example "Home expenses") and invite family by email. Everyone in a shared book sees the same entries live, and each entry shows who added it.

## How it runs

| Where | Sign-in | Where data is saved |
|---|---|---|
| Website (GitHub Pages) with `firebase-config.js` filled in | Google account | Firebase Firestore, synced across devices |
| Website without `firebase-config.js` filled in, or "Use on this device without signing in" | None | This browser only |
| The Claude artifact link | Claude account | Claude's artifact storage |

It's plain HTML, CSS and JavaScript with no build step.

## One-time setup: Firebase (about 10 minutes)

Firebase is Google's free service for sign-in and databases. The free Spark plan covers a family easily (50,000 reads and 20,000 writes a day).

1. Open <https://console.firebase.google.com>, choose **Create a project**, name it `kharcha`, and finish. You can turn Google Analytics off.
2. **Turn on Google sign-in:** in the left menu choose **Build → Authentication → Get started**. On the **Sign-in method** tab, choose **Google**, switch it on, pick your support email, and **Save**.
3. **Create the database:** choose **Build → Firestore Database → Create database**. Pick a location close to you (`asia-south1 (Mumbai)` for India), choose **Start in production mode**, and create it.
4. **Add the security rules:** in Firestore, open the **Rules** tab, replace everything with the contents of [`firestore.rules`](firestore.rules), and **Publish**. These rules make sure only you can read your private book and only members can read a shared book.
5. **Register the website:**
   - Click the gear icon, then **Project settings**.
   - Under **Your apps**, click the web icon `</>`, name it `Kharcha web`, and register it. You don't need Firebase Hosting.
   - Copy the `firebaseConfig` values into [`firebase-config.js`](firebase-config.js), like this:
     ```js
     window.KHARCHA_FIREBASE = {
       apiKey: '…',
       authDomain: 'kharcha-xxxx.firebaseapp.com',
       projectId: 'kharcha-xxxx',
       storageBucket: 'kharcha-xxxx.firebasestorage.app',
       messagingSenderId: '…',
       appId: '…',
     };
     ```
     These values are designed to be public. Your data is protected by the rules from step 4, not by keeping this key secret.
6. **Allow your website address:** go to **Authentication → Settings → Authorized domains → Add domain** and add your GitHub Pages domain, for example `saivineet300.github.io`.

## Put it online: GitHub Pages

1. Create a new repository on GitHub, for example `kharcha`. Free GitHub Pages needs it to be **public**. Only the app's code is public; your expense data lives in Firebase.
2. Push this folder to it:
   ```bash
   git remote add origin https://github.com/YOUR-USERNAME/kharcha.git
   git push -u origin main
   ```
3. In the repository, go to **Settings → Pages**. Set **Source: Deploy from a branch**, **Branch: `main`**, folder **`/ (root)`**, and save.
4. After a minute the site is live at `https://YOUR-USERNAME.github.io/kharcha/`. Open it in Chrome and choose **Continue with Google**.

On a phone, open the same address and choose **Add to Home Screen** (Safari) or **Install app** (Chrome). It then opens like a normal app and works offline.

## Android app (APK)

The `mobile/` folder packages the same app as an Android APK with [Capacitor](https://capacitorjs.com). It works fully offline.

- **Install:** on your phone, open the [latest release](https://github.com/saivineet300/kharcha/releases/latest), tap the `.apk` file under **Assets** to download it, then open it. Android asks you to allow installing from that app (Files, Drive or Chrome) the first time.
- **Where data lives:** your book is saved as files inside the app's private storage on the phone. After every change, a full backup is also written to **Documents/Kharcha** on the phone: the latest copy plus one per day for the past week. If you uninstall the app or move to a new phone, install Kharcha again, then go to **Settings → Restore from backup** and pick that file.
- **Export and Back up** save to Documents/Kharcha and open Android's share menu, so you can send the file to Drive, WhatsApp or email.
- **Updates keep your data,** as long as the new APK is signed with the same key. The key is stored on the computer that built the app at `~/.kharcha/` and isn't in this repository. Back that folder up: without it, a new version can't install over the old one.
- **Moving from 1.0 to 1.1:** version 1.0 was signed with a key that has since been lost, so 1.1 can't install over it. In 1.0, open **Settings → Back up data** first. Then uninstall 1.0, install 1.1, and use **Settings → Restore from backup** to pick that file from Documents/Kharcha. Later versions install over 1.1 normally.
- Google sign-in and syncing inside the Android app come next, after the Firebase project is set up. Until then, the app keeps everything on the phone.

To rebuild the APK after changing the web app (needs Node.js, JDK 21 and the Android SDK):

```bash
cd mobile
npm install
npm run apk
```

The signed APK is written to `mobile/android/app/build/outputs/apk/release/app-release.apk`.

## Friends: paying for each other

- **You paid for you and a friend:** tap **Add expense**, enter the full amount, and pick the friend under **Split with friends**. With **Split equally**, your half is added to your spending and the other half goes on the friend's tab.
- **You paid only for them** (their ticket, their shopping): pick the friend and choose **Paid for them**. Nothing is added to your spending, and they owe you all of it.
- **A friend paid:** go to **Plan → Friends**, open the friend and tap **[name] paid**. For bills with several people or uneven shares, use **Split a bill**.
- **See the total:** **Plan → Friends** lists everyone with what they owe you. What they owe and what you owe them cancel out.
- **Ask for the money:** open a friend and tap **Request on WhatsApp**. Your phone opens WhatsApp with a message listing each item and the total. Save their number once, or choose the chat in WhatsApp. Add your UPI ID in **Settings → Money** and it's included in the message.
- **When they pay you back:** tap **Record payment**. The full amount settles everything. A smaller amount pays off their oldest items first.

## Using shared books

1. Tap your book name or picture at the top, then choose **New shared book**.
2. Invite people by their Google account email.
3. Send them the website link. When they sign in with that email, they see the invitation on Home and tap **Join**.

The owner can rename the book, remove people, or delete it. Anyone else can leave at any time.

## Moving data in

- If you used the website without signing in first, it offers to copy those entries into your account the first time you sign in.
- From the Claude artifact or another browser: use **Settings → Back up data** there, then **Settings → Restore from backup** here.

## Run it on your computer

```bash
python3 -m http.server 8080
```

Then open <http://localhost:8080>. `localhost` is already an authorized domain in Firebase, so Google sign-in works locally too.

## Files

| File | What it does |
|---|---|
| `index.html` | Page shell |
| `app.js` | All app logic: screens, storage, sign-in, shared books, charts, calculators |
| `app.css` | Material You styles, light and dark, phone and desktop layouts |
| `firebase-config.js` | Your Firebase project settings (you fill this in) |
| `firestore.rules` | Database security rules (paste into Firebase) |
| `firebase.json` | Lets the Firebase CLI deploy the rules or run local emulators |
| `sw.js`, `manifest.webmanifest`, `icons/` | Offline support and the installable app |

## Optional: deploy rules from the command line

If you have the Firebase CLI (`npm i -g firebase-tools`), run this instead of pasting the rules in step 4:

```bash
firebase deploy --only firestore:rules --project YOUR-PROJECT-ID
```
