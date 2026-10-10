// DropBeam configuration — everything here is optional.
window.DROPBEAM_CONFIG = {
  // Signaling server: only used to introduce two browsers to each other.
  // Files never pass through it. Default is the free public PeerJS cloud.
  // To self-host: https://github.com/peers/peerjs-server
  // (If you change the host, also update `connect-src` in the CSP <meta> tag in index.html.)
  peer: {
    // host: '0.peerjs.com',
    // port: 443,
    // path: '/',
    // secure: true,
  },

  // STUN servers help browsers find each other across home routers (NAT).
  // Very strict networks (some corporate/mobile) also need a TURN relay.
  // Note: anything here is public in your repo, so only use throwaway TURN credentials.
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:global.stun.twilio.com:3478' },
    // { urls: 'turn:turn.example.com:3478', username: 'user', credential: 'pass' },
  ],
};
