# Kharcha

A Google-style expense tracker for phone and computer: daily expenses and income, budgets with alerts, bills and subscriptions, savings goals, splitting costs with friends, charts, a calculator, and money calculators (EMI, SIP, FD, GST, fuel, discount, inflation).

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
