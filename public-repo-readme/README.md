# Hearth — Downloads

**Your own private voice, video, screen-share, and chat hangout.** Like Discord,
but you host it and you own it. No accounts, no ads, no company reading your
messages.

This page is where you **download** Hearth. (The source code lives elsewhere and
is private — but the apps are free for anyone to use.)

---

## 1️⃣ Before you download — two things

**One:** get the **server address** from whoever hosts your group's Hearth.

**Two:** look at how it starts. If it starts with **`http://100.`** your group
uses **Tailscale** (a free private network) and Hearth **cannot connect
without it**: ask your host for the Tailscale invite, install it from
[tailscale.com/download](https://tailscale.com/download), accept the invite,
and check it shows **Connected**. (Address starts with `https://`? Skip this.)

## 2️⃣ Download the app (everyone)

Grab the latest from **[Releases](../../releases/latest)** and pick your system:

| Your computer | Download the file ending in |
|---|---|
| 🪟 **Windows** | `.exe` |
| 🍎 **Mac** | `.dmg` |
| 🐧 **Linux** | `.AppImage` (works everywhere) or `.deb` (Ubuntu/Debian) |

**First time opening it,** your computer may warn "unknown developer" — that's
normal for a small private app:
- **Windows:** More info → Run anyway
- **Mac:** right-click the app → Open → Open
- **Linux:** right-click → Properties → allow executing → double-click

Then paste in the server address your host gave you, pick a name, and you're in.

**🐧 Linux shortcut:** download `install-linux.sh` from the same release and run
`bash install-linux.sh` — it grabs the latest Hearth, adds it to your app menu,
and removes any old copies. Hearth then keeps itself up to date in place.

**Staying current matters:** Hearth checks for updates when it starts and offers
to install them. If you skip updates for a long time you may not be able to join
your host — the app and server need to speak the same language.

> If your host's address starts with `http://100.`, first install the free
> **[Tailscale](https://tailscale.com/download)** app and accept your host's
> invite — that's the private tunnel the group uses.

---

## 3️⃣ Host your own server (one person)

One person in the group runs the server on a computer that stays on. Download
**`hearth-server-<version>.tar.gz`** from
[Releases](../../releases/latest), unzip it, and follow the simple guide inside.
The short version:

- **At home:** install [Node.js](https://nodejs.org), then run `bash install.sh`
  (Mac/Linux) or the PowerShell installer (Windows). Use
  [Tailscale](https://tailscale.com) so friends can reach you with no router
  fuss.
- **On a cheap online server (VPS):** same, plus set your public IP and open
  ports 4443 (TCP) and 44444 (UDP+TCP).
- **With Docker:** `docker compose up -d`.

Full step-by-step for a total beginner is included in the download.

---

## ✨ What you get after installing

🎤 Voice rooms · 📹 Camera · 🖥️ Screen share (up to 4K, pop-out or
picture-in-picture) · 💬 Chat with reactions, emojis, GIFs, and video ·
🎵 Shared music jukebox · 👑 Roles and permissions · 🔒 Private and yours

---

*Hearth is made by Mages of the Beaches LLC. Installers here are free to use.*
