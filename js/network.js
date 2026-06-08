// P2P mesh network layer using PeerJS
// Host claims a deterministic Peer ID from the room key.
// All others get random Peer IDs and connect through the host, then mesh out.

const ROOM_PREFIX = 'war-room-';
const PEERJS_CDN = 'https://unpkg.com/peerjs@1.5.4/dist/peerjs.min.js';

export class Network extends EventTarget {
  constructor(roomKey) {
    super();
    this.roomKey = roomKey;
    this.hostPeerId = ROOM_PREFIX + roomKey;
    this.peer = null;
    this.myPeerId = null;
    this.isHost = false;
    this.connections = new Map(); // networkPeerId → DataConnection
  }

  async init() {
    await this._loadPeerJS();
    await this._tryBecomeHost();
  }

  _loadPeerJS() {
    return new Promise((resolve, reject) => {
      if (window.Peer) { resolve(); return; }
      const s = document.createElement('script');
      s.src = PEERJS_CDN;
      s.onload = resolve;
      s.onerror = () => reject(new Error('Failed to load PeerJS'));
      document.head.appendChild(s);
    });
  }

  // Opens a PeerJS peer with the given ID. Pass null for a random ID.
  _openPeer(id) {
    return new Promise((resolve, reject) => {
      const peer = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 });
      const onOpen = (peerId) => {
        cleanup();
        this.peer = peer;
        this.myPeerId = peerId;
        peer.on('connection', conn => this._onIncoming(conn));
        peer.on('disconnected', () => {
          this._emit('disconnected', {});
        });
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        peer.off('open', onOpen);
        peer.off('error', onError);
      };
      peer.once('open', onOpen);
      peer.once('error', onError);
    });
  }

  async _tryBecomeHost() {
    try {
      await this._openPeer(this.hostPeerId);
      this.isHost = true;
      this._emit('ready', { isHost: true });
    } catch (err) {
      if (err.type === 'unavailable-id') {
        // Room exists — join as a regular peer with a random ID
        await this._openPeer(null);
        this.isHost = false;
        this._emit('ready', { isHost: false });
        await this._connectToPeer(this.hostPeerId);
      } else {
        this._emit('error', { error: err });
      }
    }
  }

  _onIncoming(conn) {
    this._setupConn(conn);
  }

  _connectToPeer(peerId) {
    if (this.connections.has(peerId) || peerId === this.myPeerId) return Promise.resolve();
    const conn = this.peer.connect(peerId, { reliable: true });
    return this._setupConn(conn);
  }

  _setupConn(conn) {
    return new Promise(resolve => {
      const onOpen = () => {
        this.connections.set(conn.peer, conn);
        conn.on('data', data => this._onData(conn.peer, data));
        conn.on('close', () => {
          this.connections.delete(conn.peer);
          this._emit('peer-left', { networkPeerId: conn.peer });
          if (this.isHost) this._sendPeerListTo(null); // broadcast updated list
        });
        conn.on('error', () => this.connections.delete(conn.peer));

        this._emit('peer-joined', { networkPeerId: conn.peer });

        // Host tells the new peer about all OTHER peers so they can mesh up
        if (this.isHost) {
          const others = [...this.connections.keys()].filter(k => k !== conn.peer);
          conn.send({ type: 'PEER_LIST', peers: others });
        }

        resolve(conn);
      };
      if (conn.open) onOpen();
      else conn.once('open', onOpen);
    });
  }

  _onData(fromPeerId, msg) {
    if (msg.type === 'PEER_LIST') {
      // Connect to any peers we don't know about yet
      for (const peerId of msg.peers) {
        if (!this.connections.has(peerId) && peerId !== this.myPeerId) {
          this._connectToPeer(peerId);
        }
      }
      return; // PEER_LIST is network-layer only; don't bubble up
    }
    this._emit('message', { from: fromPeerId, msg });
  }

  // Send updated peer list to all connections (used after a disconnect)
  _sendPeerListTo(_targetPeerId) {
    const allPeers = [...this.connections.keys()];
    for (const [peerId, conn] of this.connections) {
      const others = allPeers.filter(k => k !== peerId);
      conn.send({ type: 'PEER_LIST', peers: others });
    }
  }

  // Send to all connected peers
  broadcast(msg) {
    for (const conn of this.connections.values()) {
      if (conn.open) conn.send(msg);
    }
  }

  // Send to a single peer by their network peer ID
  sendTo(networkPeerId, msg) {
    const conn = this.connections.get(networkPeerId);
    if (conn?.open) conn.send(msg);
  }

  _emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}
