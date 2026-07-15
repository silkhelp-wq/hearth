# Hearth — Super Simple Setup

> **Who this is for:** anyone. No computer skills needed for the app. A little
> copy-and-paste needed for the server. If you can download a file and type
> your name, you can do the app part.

Hearth is your own private voice-and-video hangout — like Discord, but **you**
own it. There are **two parts**:

1. **The app** — everyone in your group installs this. Super easy.
2. **The server** — just **one** person sets this up. A little harder, but this
   guide holds your hand the whole way.

---

## 😀 Part 1: Install the app (everyone does this)

### Step 1 — Join your group's private network

Ask the person who set up the server: **"What's the address?"** They'll send you
something. Look at how it starts:

- If it starts with **`http://100.`** → you need a free app called **Tailscale**
  first (it's the private tunnel your group uses). Do this:
  1. Ask your host to send you a **Tailscale invite**.
  2. Go to **[tailscale.com/download](https://tailscale.com/download)** and
     install it (just like any app).
  3. Click the invite link, sign in with Google/Microsoft/Apple, and say yes.
  4. Make sure it shows a little **"Connected"** — then leave it alone.
- If it starts with **`https://`** → skip this step! You don't need Tailscale.

### Step 2 — Download Hearth

Go to the download page your host gives you (it looks like
`github.com/…/hearth-releases/releases/latest`) and grab the file for your
computer:

| Your computer | Click this file |
|---|---|
| 🪟 Windows | the one ending in **`.exe`** |
| 🍎 Mac | the one ending in **`.dmg`** |
| 🐧 Linux | the one ending in **`.AppImage`** |

### Step 3 — Open it

Your computer might say **"this app is from an unknown developer"** or
**"are you sure?"**. That's normal — it just means we're a small group, not a
big company. Here's how to say "yes, I'm sure":

- **Windows:** click **"More info"**, then **"Run anyway"**.
- **Mac:** **right-click** the Hearth app, choose **"Open"**, then **"Open"**
  again.
- **Linux:** right-click the file → **Properties** → tick **"Allow executing
  file as program"** → then double-click it.

> **Linux tip — want Hearth in your app menu, always up to date?** Download
> `install-linux.sh` from the downloads page and run:
> ```
> bash install-linux.sh
> ```
> It fetches the latest Hearth, puts it in your menu, and cleans up any old
> copies. Run it again any time to repair things.

### Step 4 — Get in!

1. Hearth opens and asks for the **server address**. Paste the one your host
   gave you.
2. Type the **name** you want your friends to see.
3. Click connect. 🎉 **You're in!** Click a voice room on the left to start
   talking.

> **It won't connect?** 99% of the time, Tailscale isn't turned on. Check that
> Tailscale says "Connected" and try again.

---

## 🛠️ Part 2: Set up the server (just one person does this)

**Only one person** in the group needs to do this. Pick whoever's most
comfortable with computers. You need a computer (or a cheap online one) that can
**stay turned on** while people hang out.

**First, install Node.js** (the engine Hearth's server runs on) — go to
**[nodejs.org](https://nodejs.org)** and install the big green "LTS" button.
Do this no matter which option you pick below.

Then pick **one** of these three ways:

---

### 🏠 Option A: On your own computer at home (easiest)

Best if you have a spare computer, or don't mind leaving yours on.

1. **Install Tailscale** (the free private tunnel) from
   [tailscale.com/download](https://tailscale.com/download) and sign in. This
   is how your friends reach your server without any complicated router stuff.
2. Download **`hearth-server-<version>.tar.gz`** from the downloads page.
3. Unzip it (double-click it, or right-click → Extract).
4. Open the unzipped folder, then open a **terminal** there:
   - **Windows:** hold **Shift**, right-click inside the folder, choose
     **"Open PowerShell window here"**, then type:
     ```
     powershell -ExecutionPolicy Bypass -File install-windows.ps1
     ```
   - **Mac/Linux:** right-click the folder → "Open Terminal here" (or open
     Terminal and `cd` into the folder), then type:
     ```
     bash install.sh
     ```
5. Wait a minute while it sets up. At the end it prints an **owner claim
   code** — a short code like `A1B2-C3D4`. **Copy it.**
6. Open the **Hearth app**, go to **Settings → Server**, and paste the code.
   You're now the **owner** (the admin). 👑
7. Tell your friends your **Tailscale address** (it starts with
   `http://100.` — Tailscale shows it, or the installer prints it). That's what
   they type into the app.

**To find your claim code again later:** in the same folder's terminal, type
`node src/index.js --reclaim-owner`.

---

### ☁️ Option B: On a cheap online computer (a "VPS")

Best if you don't want to leave your own computer on. A small server from
DigitalOcean, Hetzner, Linode, etc. costs a few dollars a month and stays on
24/7.

1. Rent a small Linux server (Ubuntu is a great pick). The provider gives you a
   **public IP address** (like `203.0.113.10`) and a way to log in.
2. Log into it and install Node.js:
   ```
   curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
   sudo apt install -y nodejs
   ```
3. Download and unzip the server:
   ```
   curl -L -o hearth-server.tar.gz https://github.com/silkhelp-wq/hearth-releases/releases/latest/download/hearth-server-<version>.tar.gz
   tar -xzf hearth-server.tar.gz
   cd hearth-server-*
   ```
   (Replace `<version>` with the real number from the downloads page.)
4. Tell Hearth your public IP, then run the installer:
   ```
   echo "HEARTH_ANNOUNCED_IP=203.0.113.10" >> ~/.config/hearth/hearth.env
   bash install.sh
   ```
   (Use **your** IP, not the example.)
5. **Open the doors** (firewall) so friends can reach it. In your provider's
   control panel, allow these:
   - **4443** (TCP)
   - **44444** (UDP **and** TCP)
6. Copy the **claim code** it prints, paste it into the app (Settings → Server).
7. Your friends connect using **`http://YOUR.PUBLIC.IP:4443`**.

> Want a nice web address like `hearth.myname.com` with a padlock instead of a
> bare IP? That's a little more setup — see the
> [deployment guide](deployment/DEPLOYMENT_GUIDE.md), section on TLS.

---

### 🐳 Option C: With Docker (if you already know Docker)

If "Docker" means nothing to you, use Option A or B instead.

1. Download and unzip the server tarball.
2. Edit `docker-compose.yml`: set `HEARTH_ANNOUNCED_IP` to your public IP (or
   delete that line if you're using Tailscale/home).
3. Run:
   ```
   docker compose up -d
   ```
4. Get your claim code:
   ```
   docker compose logs | grep -i "claim code"
   ```
5. Paste it into the app (Settings → Server).

---

## 🆘 If something goes wrong

| Problem | Try this |
|---|---|
| App won't connect | Turn on Tailscale (check it says "Connected") |
| "Unknown developer" warning | That's normal — see Part 1, Step 3 |
| Server won't start | Make sure Node.js is installed (nodejs.org) |
| Friends on a VPS can't connect | Open ports 4443 (TCP) and 44444 (UDP+TCP) in your provider's firewall |
| Lost your owner/admin powers | In the server folder: `node src/index.js --reclaim-owner`, paste the new code in the app |
| Need more help | The [full install guide](install/INSTALL_GUIDE.md) has every detail |

---

## 🎉 That's it!

Once you're in, you can:
- 🎤 Talk in voice rooms
- 📹 Turn on your camera
- 🖥️ Share your screen (others can pop it out or shrink it while they read chat)
- 💬 Chat, react with emojis, drop GIFs and videos
- 🎵 Play music everyone hears together (paste a YouTube link)

Have fun in your own private hangout! 🔥
