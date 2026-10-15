# Deadline

Deadline is a student planner that keeps every due date in one place: schoolwork from Canvas, programs worth applying to, and your own reminders. It's a single web page (`app/index.html`) that runs in three places:

1. **Website / iPhone app**: published on GitHub Pages at `https://johnha749-creator.github.io/Deadlines/`. On an iPhone, open it in Safari, tap **Share → Add to Home Screen**, and it opens full screen like an app, offline too.
2. **Laptop app**: Windows, macOS and Linux builds made with Electron (`desktop/`).
3. **claude.ai artifact**: the same `index.html`, with accounts switched off.

With accounts switched on (see `config.js` below), you sign in with a username and password and your deadlines sync between your phone and laptop through Supabase.

## What's in the repo

| Folder | What it is |
|---|---|
| `app/` | The web app: `index.html`, `config.js`, `programs.json` (the weekly programs list), `assets/` (paintings), `src/` (scripts) |
| `web/` | The website build: `build-site.mjs`, the service worker template `sw.js`, and the home-screen icons in `icons/` |
| `desktop/` | The laptop app (Electron) and its build. See `desktop/README.md` |
| `.github/workflows/pages.yml` | Builds and publishes the website on every push to `main` |

## The website

Every push to `main` runs `.github/workflows/pages.yml`, which runs `node web/build-site.mjs` on Node 22 and publishes the `site/` folder it makes. One-time setup: in the repo on GitHub, open **Settings → Pages** and set **Source** to **GitHub Actions**. You can also start a deploy by hand from the **Actions** tab (**Deploy website → Run workflow**).

To build it on your own computer (needs Node 22, nothing to install):

```bash
node web/build-site.mjs                       # app/ -> site/
node web/build-site.mjs --src app --out /tmp/site --config my-test-config.js
```

The build turns `app/index.html` into a full page with what an iPhone home-screen app needs: the icon, the app name, full-screen mode, padding for the notch and home bar, a web app manifest, and a Content-Security-Policy that only allows the app's own files, Google Fonts and your Supabase project. It also adds a service worker, so the app opens offline. A new version is picked up the next time the app is opened after a deploy. `programs.json` and `config.js` are always fetched fresh when there's a connection.

The icons in `web/icons/` are rendered from `desktop/icon.svg`. If the icon changes, render them again (this needs `@resvg/resvg-js`, which the laptop build installs in its tooling folder) and commit the PNGs:

```bash
node web/build-site.mjs --render-icons --tooling <folder whose node_modules has @resvg/resvg-js>
```

## config.js (accounts)

`app/config.js` holds the Supabase settings:

```js
window.DEADLINE_CONFIG = { supabaseUrl: "", supabaseKey: "", usernameDomain: "users.deadline.invalid" };
```

Empty values mean no accounts: the app keeps everything on the device, exactly like before. To switch accounts on, put in your project URL (`https://<project>.supabase.co`) and its **publishable** key (`sb_publishable_...`), then push. The publishable key is meant to be public, so it's fine on the website. Never put the secret (`service_role`) key here. The build stops if it finds one. If `config.js` is missing, the build writes an empty one.

## Setting up Supabase (one time, before you fill in config.js)

1. In the Supabase dashboard, open **SQL Editor** and run:

   ```sql
   create table public.deadline_state (
     user_id uuid primary key references auth.users(id) on delete cascade,
     data jsonb not null default '{}'::jsonb,
     updated_at timestamptz not null default now(),
     -- one student's list is a few KB; this stops anyone from filling your free 500 MB database
     constraint deadline_state_size check (pg_column_size(data) < 1048576)
   );
   grant select, insert, update, delete on public.deadline_state to authenticated;
   alter table public.deadline_state enable row level security;
   create policy "own row" on public.deadline_state for all
     using (auth.uid() = user_id) with check (auth.uid() = user_id);
   ```

   If you already made the table without the size limit, add it with
   `alter table public.deadline_state add constraint deadline_state_size check (pg_column_size(data) < 1048576);`.
   A list that hits the limit doesn't sync, and the app tells the student to delete old deadlines.
2. **Authentication → Sign In / Providers → Email**: turn **Confirm email** off (usernames don't have a real email address behind them), and set **Minimum password length** to 8, the same as the app asks for. The app also refuses passwords that are only spaces, but anyone can call Supabase directly with your public key, so the server's own minimum is the one that counts.

Things to know as the owner:

- **You can see every student's list.** Row level security keeps students out of each other's lists, but anyone with your Supabase dashboard (or the secret key) can read every row: deadlines, display names, and the Canvas calendar feed link if a student pasted one (the app tells students that link is saved with their account). Keep the dashboard to yourself.
- **Deleting an account.** Students can't delete their own account in the app. "Clear all my data" empties their list everywhere, but the username stays. If someone asks, delete them in **Authentication → Users** (their saved list goes with them, because of `on delete cascade`).
- **Keep the site on its own.** Every GitHub Pages project of yours shares one web address (`https://johnha749-creator.github.io`), and pages there can read each other's saved data, including a signed-in student's session. Don't publish other pages or projects from this GitHub account, or give Deadline its own address (a custom domain, in **Settings → Pages**).

## The laptop app

```bash
bash desktop/build.sh                        # every platform, then the tests
bash desktop/build.sh --platforms=linux      # just one
```

It needs Node 22.12 or newer, `curl` and `zip`, and writes the zips to `dist/`. The laptop app ships `app/config.js` too, so accounts work there the same way: rebuild after you fill in `config.js`, and its Content-Security-Policy lets the app reach your Supabase project (and nothing else). `--config=<file>` builds with a different `config.js`. `desktop/README.md` has the details and the install steps for students.
