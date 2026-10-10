# DropBeam

Minimal, fast, private file transfer between two browsers. No uploads, no accounts, no backend.

Files travel **directly** from one device to the other over an encrypted WebRTC connection. This repo is a plain static site — host it anywhere (GitHub Pages works out of the box).

## How it works

1. **Sender** drops files → gets an 8-character code (and a share link).
2. **Receiver** opens the link (or types the code) and connects.
3. Sender sees a prompt and clicks **Allow**.
4. Files stream device-to-device, chunk by chunk, with backpressure so memory stays flat.

## Deploy to GitHub Pages

1. Create a repo and push these files to the root of the `main` branch.
2. In the repo go to **Settings → Pages → Build and deployment**, choose **Deploy from a branch**, branch `main`, folder `/ (root)`.
3. Your site will be live at `https://<user>.github.io/<repo>/`.

No build step. To try it locally: `python3 -m http.server 8000` and open `http://localhost:8000`.

## Security model

- **Encryption:** WebRTC data channels are encrypted end-to-end with DTLS. No server can read the file contents.
- **Nothing stored:** there is no upload endpoint. Closing the tab ends the transfer.
- **Unguessable codes:** 8 characters from a 32-character alphabet (40 bits), generated with `crypto.getRandomValues`.
- **Sender approval:** the sender must click **Allow** before any receiver can see or request files; only one receiver at a time.
- **Receiver consent:** the receiver accepts each file (files under 100 MB can be auto-accepted; they are held in memory until you click **Save**).
- **Hardened page:** strict Content-Security-Policy (no inline scripts, no third-party scripts, no external fonts), `no-referrer`, filenames sanitized, all remote text rendered with `textContent`, and the PeerJS library is vendored (no CDN).
- **Link hash:** the code in a share link lives after `#`, which browsers never send to servers; it's removed from the address bar once used.

### What the signaling server sees
To introduce two browsers, DropBeam uses the free public [PeerJS cloud](https://peerjs.com/) for signaling. It sees connection metadata (IP addresses, the random peer ids) but **never** file data. For full control, self-host [peerjs-server](https://github.com/peers/peerjs-server) and set it in `config.js` (and update `connect-src` in the CSP `<meta>` tag in `index.html`).

## Configuration

Edit `config.js` to change the signaling server or add ICE servers. Most home networks work with the default STUN servers. Very strict networks (some corporate/mobile) need a **TURN** relay; add one under `iceServers`. TURN relays traffic (still encrypted), so use one you trust. Credentials in a public repo are public — use throwaway ones.

## Notes & limits

- Works in current Chrome, Edge, Firefox and Safari.
- Files ≥ 100 MB stream straight to disk in Chrome/Edge (File System Access API). In other browsers they are buffered in memory, so very large files may be limited by available RAM.
- Folders aren't supported yet; zip them first.
- Both devices must keep the page open (and the sender's screen awake) until the transfer finishes. A wake lock is requested automatically where supported.
- Third-party code: [PeerJS](https://github.com/peers/peerjs) 1.5.4 (MIT license), vendored in `vendor/peerjs.min.js`.

## Files

```
index.html   page + CSP
style.css    styles
app.js       transfer logic (no dependencies besides PeerJS)
config.js    optional settings
favicon.svg
vendor/peerjs.min.js
```
