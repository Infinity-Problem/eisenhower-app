# Google OAuth Verification — Step-by-step

Eisenhower's Google Calendar sync uses the sensitive `auth/calendar` scope. To distribute the app without the "unverified app — proceed with caution" warning and the 100-test-user cap, the OAuth client must be verified by Google.

## What you'll need before submitting

- A live homepage URL describing the app
- A live privacy policy URL
- A live terms-of-service URL
- A YouTube video (unlisted is fine) demonstrating the OAuth consent flow end-to-end
- An app icon (PNG, 120x120 minimum)
- Domain verification of the homepage's domain in Google Search Console

The `public/` folder in this repo contains drop-in HTML for the first three. Host them publicly and you have your URLs.

## 1. Host the public assets

Recommended free option: **GitHub Pages**.

1. Create a new GitHub repository called `eisenhower-app` (or whatever).
2. Push the contents of this `public/` folder to the repository's `main` branch.
3. In repo Settings → Pages, set Source = Deploy from a branch, Branch = `main`, Folder = `/ (root)`.
4. GitHub assigns you `https://<your-username>.github.io/eisenhower-app/`.
5. Verify the three URLs load:
   - Homepage: `https://<your-username>.github.io/eisenhower-app/`
   - Privacy:  `https://<your-username>.github.io/eisenhower-app/privacy.html`
   - Terms:    `https://<your-username>.github.io/eisenhower-app/terms.html`

If you have a custom domain you'd rather use, configure it on the Pages tab and proceed with that domain instead.

## 2. Verify the domain in Google Search Console

1. Go to https://search.google.com/search-console.
2. Add your homepage URL as a property (URL prefix type).
3. Verify ownership — easiest is the HTML meta tag method (paste the tag into the `<head>` of `public/index.html`, redeploy, click Verify).

Verification of the domain in Search Console is required before Google will accept it on the OAuth consent screen.

## 3. Fill out the OAuth consent screen

In Google Cloud Console → APIs & Services → OAuth consent screen:

- **User type**: External
- **App name**: Eisenhower
- **User support email**: your email
- **App logo**: upload `public/icon.svg` converted to PNG at 120x120 or larger
- **Application home page**: your hosted homepage URL
- **Application privacy policy link**: your hosted privacy URL
- **Application terms of service link**: your hosted terms URL
- **Authorized domains**: add the domain (e.g. `your-username.github.io`)
- **Developer contact information**: your email

On the Scopes step:

- Add the scope `.../auth/calendar` (the full Calendar scope).
- In the justification box, explain: "Eisenhower mirrors tasks from the user's local task list to a calendar of their choice. The calendar scope is required because we create, update, and delete event records on the user's behalf. We never read events the user did not create."

Save.

## 4. Record the demo video

Google requires a YouTube video showing:

- The OAuth consent screen (your unverified-but-being-reviewed version is fine)
- The user clicking through and granting permission
- The application using the granted permission (e.g. clicking Sync now and a task appearing on their calendar)
- The application's name and the Google sign-in account being clearly visible

Upload as Unlisted on YouTube. Paste the URL into the verification submission form.

## 5. Submit for verification

In OAuth consent screen → Publishing status → click **Publish app** → **Prepare for verification**.

Fill in the requested information, attach the video URL, submit.

Google's review typically takes 4–6 weeks for a sensitive scope like Calendar. You may receive follow-up emails asking for clarifications. Respond promptly.

## Until verification completes

The app stays in Testing mode. Add anyone you want to grant pre-verification access via OAuth consent screen → Test users → Add users. Up to 100 testers.
