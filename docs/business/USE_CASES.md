# Hearth — Use Cases

End-to-end scenarios showing how real people use Hearth. Each case ties a
business goal to a concrete user flow and references the requirements it
exercises. Format: actor, goal, preconditions, main flow, alternate/exception
flows, and the requirements/tests it touches.

---

## UC-1 — Host stands up a server for the group

**Actor:** The host (one technically-comfortable member).
**Goal:** Get a Hearth server running so the group can connect.
**Preconditions:** A machine that stays on; Node.js 20+; Tailscale installed on
the host.

**Main flow:**
1. Host clones the repo and installs the server (`npm install`, then
   `npm start`; or installs the native service).
2. Server boots, auto-detects its Tailscale address, and prints it.
3. On first run, the server prints an **owner claim code**.
4. Host shares the address with the group (chat, DM, etc.).
5. Host opens the client, connects to the address, and pastes the claim code in
   **Settings → Server** to become owner.

**Alternate flows:**
- *A1 — Public host instead of Tailscale:* host sets `HEARTH_ANNOUNCED_IP`,
  fronts the server with a TLS reverse proxy, and shares the domain. (See
  [`DEPLOY_PUBLIC.md`](../DEPLOY_PUBLIC.md).)
- *A2 — Runs as a service:* host installs the systemd user service so it
  survives reboots and updates itself. (See [`INSTALL_NATIVE.md`](../INSTALL_NATIVE.md).)

**Exceptions:**
- *E1 — Server can't detect the right address:* host sets it explicitly via
  environment variable.

**Requirements:** BR-2, BR-4, BR-6, NBR-2 · **Tests:** connection tests, TC
owner-claim.

---

## UC-2 — Friend joins for the first time

**Actor:** A group member (any OS, non-technical).
**Goal:** Get into the hangout.
**Preconditions:** Has the server address; Tailscale installed (for the private
path).

**Main flow:**
1. Member downloads the installer for their OS from the Releases page.
2. Installs it, clearing the OS "unidentified developer" warning once.
3. Launches Hearth, pastes the address, enters a display name.
4. Lands in the lobby; sees voice and text channels.
5. Clicks a voice channel and starts talking.

**Alternate flows:**
- *A1 — First-ever member claims ownership:* if the host designates them, they
  paste the claim code to become owner.

**Exceptions:**
- *E1 — OS blocks the unsigned app:* member follows the platform-specific
  "open anyway" steps. (See [`INSTALL_GUIDE.md`](../install/INSTALL_GUIDE.md).)
- *E2 — Can't connect:* usually Tailscale isn't running or the address is
  wrong. (See [`CONNECTION_GUIDE.md`](../CONNECTION_GUIDE.md).)

**Requirements:** BR-1, BR-3, BR-5, NBR-3 · **Tests:** install/connect tests.

---

## UC-3 — Group voice hangout with screen share

**Actor:** Several members simultaneously.
**Goal:** Hang out in voice while someone shares gameplay.
**Preconditions:** Everyone connected; in the same voice channel.

**Main flow:**
1. Members join a voice channel; voice activity or push-to-talk gates mics.
2. One member clicks **Share**, picks a screen/window, and goes live.
3. Others see the stream tile; audio and video stay in sync via the SFU.
4. A viewer clicks the stream tile to **focus** it (fills the stage; other
   video tiles pause server-side to save bandwidth).
5. Members adjust the streamer's voice and the stream's game-audio
   independently via right-click volume sliders.

**Alternate flows:**
- *A1 — Multiple simultaneous streams:* several members share at once; each
  viewer focuses whichever they want.
- *A2 — Pop-out theater:* a viewer double-clicks a stream to pop it into a
  draggable, resizable, fullscreen-capable window.

**Exceptions:**
- *E1 — Wayland screen share:* the OS portal is the picker; member chooses
  there. (See Wayland notes in the install guide.)
- *E2 — Choppy stream on NVIDIA/Linux:* software encoding limitation; member
  drops to VP8/1080p or the host uses a lower preset. (See
  [`STREAMING_INTERNALS.md`](../engineering/STREAMING_INTERNALS.md).)

**Requirements:** BR-3, NBR-1 · **Tests:** TC-50 (smooth streams), TC-51
(focus mode), TC-57 (stream audio volume).

---

## UC-4 — Persistent text chat between sessions

**Actor:** Group members over time.
**Goal:** Keep a running conversation, share links, react, search history.
**Preconditions:** Connected; text channels exist.

**Main flow:**
1. Members post messages with markdown and code blocks.
2. They reply (threading), edit, pin, and react with emojis (including custom
   ones).
3. Link posts render preview cards.
4. @mentions ping the mentioned member; unread badges track what's new.
5. Anyone searches full history to find an old message.

**Alternate flows:**
- *A1 — Storage cap reached:* oldest messages prune automatically; the group
  never fills the host's disk.

**Requirements:** BR-3, BR-9 · **Tests:** chat/search/storage tests.

---

## UC-5 — Music jukebox in voice

**Actor:** Any member with speak permission.
**Goal:** Play music everyone hears in sync.
**Preconditions:** In a voice channel.

**Main flow:**
1. Member pastes a YouTube link into the jukebox.
2. The host streams the audio into the voice channel as a participant.
3. Everyone hears it in sync; members queue, skip, pause, and set per-listener
   volume.

**Alternate flows:**
- *A1 — Spotify/Pandora link:* resolves by title and plays the YouTube match
  (their streams are DRM'd).

**Requirements:** BR-3 · **Tests:** jukebox queue/sync tests.

---

## UC-6 — Owner moderates membership

**Actor:** The owner/admin.
**Goal:** Manage who's in and their roles.
**Preconditions:** Is the owner; in **Settings → Server**.

**Main flow:**
1. Owner assigns roles with per-channel allow/deny overwrites.
2. Owner server-mutes or kicks a disruptive member.
3. Owner removes a stale/duplicate member entirely (messages preserved).
4. Owner can transfer ownership to another member.

**Alternate flows:**
- *A1 — Owner lockout recovery:* if the owner's device identity changed, the
  host runs `hearth-reclaim-owner` to mint a fresh claim code and re-take
  ownership. (See ownership section in the install guide.)

**Requirements:** BR-4, NBR-6 · **Tests:** TC-53 (one identity), TC-54 (member
removal), TC-56 (owner reclaim).

---

## UC-7 — Host keeps the server healthy and current

**Actor:** The host/owner.
**Goal:** Monitor the server and apply updates.
**Preconditions:** Is the owner; server running.

**Main flow:**
1. Owner opens **Settings → Server** and sees CPU, memory, disk, network, and
   live participant/stream counts.
2. The monitor reports when a newer server release exists.
3. Owner applies the update (re-run install + restart); data is preserved.
4. Clients auto-update themselves from the Releases page.

**Requirements:** BR-8, BR-10, NBR-2 · **Tests:** TC-58 (update detection),
server-monitor tests.

---

## UC-8 — DevOps runs Hearth in the cloud (future/commercial)

**Actor:** An operator deploying for a larger or hosted context.
**Goal:** Run the server on cloud infrastructure with TLS and monitoring.
**Preconditions:** Cloud account; domain; container or VM.

**Main flow:**
1. Operator provisions a VM (or container) per the deployment guide.
2. Configures `HEARTH_ANNOUNCED_IP`, opens the required ports, and fronts
   signaling with TLS.
3. Sets up process supervision, backups of the data directory, and monitoring.
4. Points clients at the public domain.

**Alternate flows:**
- *A1 — Containerized:* deploys via the container recipe with host networking
  for media ports.
- *A2 — Behind a cloud load balancer:* signaling (TCP 4443) behind the LB;
  media (UDP/TCP 44444) direct to the instance.

**Requirements:** BR-11, NBR-1, NBR-4 · **Reference:**
[`DEPLOYMENT_GUIDE.md`](../deployment/DEPLOYMENT_GUIDE.md).

---

## Traceability summary

| Use case | Business reqs | Key tests |
|----------|---------------|-----------|
| UC-1 Host setup | BR-2, BR-4, BR-6 | connection, owner-claim |
| UC-2 First join | BR-1, BR-3, BR-5 | install/connect |
| UC-3 Voice + share | BR-3, NBR-1 | TC-50/51/57 |
| UC-4 Text chat | BR-3, BR-9 | chat/search/storage |
| UC-5 Jukebox | BR-3 | jukebox sync |
| UC-6 Moderation | BR-4, NBR-6 | TC-53/54/56 |
| UC-7 Health/updates | BR-8, BR-10 | TC-58, monitor |
| UC-8 Cloud deploy | BR-11, NBR-4 | deployment guide |
