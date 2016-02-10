'use strict'

var EventEmitter = require('events')
var BlockStream = require('./blockStream.js')
var HeaderStream = require('./headerStream.js')
var Peer = require('./peer.js')

function assertParams (params) {
  if (!params || !params.getSeeds || params.magic == null ||
    !params.defaultPort) {
    throw new Error('Invalid network parameters')
  }
}

module.exports =
class PeerGroup extends EventEmitter {
  constructor (params, opts) {
    assertParams(params)
    super()
    this._params = params
    this._seeds = params.getSeeds({ wrtc: opts.wrtc })
    this._seeds = this._seeds.concat(opts.seeds || [])
    this._numPeers = opts.numPeers || 8
    this._getTip = opts.getTip
    this._peers = []
  }

  _error (err) {
    this.emit('error', err)
  }

  _connect () {
    var getPeer = this._seeds[Math.floor(Math.random() * this._seeds.length)]
    getPeer((err, socket) => {
      if (err) {
        this.emit('connectError', err, getPeer, null)
        return this._connect()
      }
      var peer = new Peer({
        magic: this._params.magic,
        protocolVersion: this._params.protocolVersion,
        getTip: this._getTip,
        socket
      })
      var onError = (err) => {
        err = err || new Error('Socket closed')
        this.emit('connectError', err, getPeer, peer)
        this._connect()
      }
      peer.once('error', onError)
      peer.once('disconnect', onError)
      peer.once('ready', () => {
        peer.removeListener('error', onError)
        peer.removeListener('disconnect', onError)
        this.addPeer(peer)
        this.emit('peer', peer)
      })
    })
  }

  _assertPeers () {
    if (this._peers.length === 0) {
      throw new Error('Not connected to any peers')
    }
  }

  send (command, payload) {
    this._assertPeers()
    for (var peer of this.peers) {
      peer.send(command, payload)
    }
  }

  connect (next) {
    // TODO: smarter seed logic (ensure we don't have too many peers from the
    // same seed, or the same IP block)
    var n = this._numPeers - this._peers.length
    for (var i = 0; i < n; i++) this._connect()
  }

  addPeer (peer) {
    this._peers.push(peer)
    if (this._peers.length > this._numPeers) {
      var disconnectPeer = this._peers.shift()
      disconnectPeer.disconnect()
    }

    peer.once('disconnect', () => {
      var index = this._peers.indexOf(peer)
      this._peers.splice(index, 1)
      this.emit('disconnect', peer)
    })
    peer.on('error', this._error.bind(this))
  }

  randomPeer () {
    this._assertPeers()
    return this._peers[Math.floor(Math.random() * this._peers.length)]
  }

  createHeaderStream (opts) {
    return new HeaderStream(this.randomPeer(), opts)
  }

  createBlockStream (opts) {
    return new BlockStream(this, opts)
  }
}
/*
var PeerGroup = module.exports = function (opts) {
  opts = opts || {}
  this.network = Networks.get(opts.network) || Networks.defaultNetwork
  this.acceptTcp = opts.acceptTcp || false
  this.acceptWeb = opts.acceptWeb || false
  this.tcpCount = opts.tcpCount != null ? opts.tcpCount : 5
  this.webCount = opts.webCount != null ? opts.webCount : 5
  this.autoConnect = opts.autoConnect != null ? opts.autoConnect : true
  this.getTip = opts.getTip
  this.webSeedUris = opts.webSeeds
  this.wrtc = opts.wrtc || getBrowserRTC()

  this.connecting = false
  this.connected = false
  this.disconnecting = false
  this.connectedTCP = false
  this.connectedWeb = false

  this.peers = []
  this.peers.tcp = []
  this.peers.web = []
  this.messages = null
  this.webSeeds = []

  this.filter = opts.filter || null
  this.inventory = {}

  this.pool = new p2p.Pool({ maxSize: this.tcpCount, network: this.network })
  this.pool.on('peerconnect', this._onTCPPeerConnect.bind(this))

  this.setMaxListeners(100)
}
util.inherits(PeerGroup, EventEmitter)

PeerGroup.prototype._error = function (err) {
  this.emit('error', err)
}

PeerGroup.prototype._onPeerConnect = function (peer) {
  var self = this

  if (!(peer instanceof Peer)) {
    peer = new Peer(peer)
  }

  peer.on('ready', function () {
    self._onPeerReady(peer)
    self.emit('peer', peer)
  })
  peer.on('error', function (err) {
    self._error(err)
  })
  peer.on('disconnect', function () {
    self._onPeerDisconnect(peer)
    self.emit('peerdisconnect', peer)
  })
  this.emit('peerconnect', peer)
}

PeerGroup.prototype._onPeerReady = function (peer) {
  var self = this
  this.peers.push(peer)
  if (peer instanceof WebPeer) this.peers.web.push(peer)
  else this.peers.tcp.push(peer)

  if (this.filter) peer.setFilter(this.filter)

  if (!this.messages) this.messages = peer.messages
  commands.forEach(function (key) {
    peer.on(key, function (message) {
      self.emit(key, message, peer)
    })
  })

  peer.on('getdata', function (message) {
    message.inventory.forEach(function (inv) {
      var hash = inv.hash.toString('base64')
      var item = self.inventory[hash]
      if (!item) return
      // TODO: handle types other than transactions
      var txMessage = peer.messages.Transaction(item.value)
      peer.sendMessage(txMessage)
    })
  })

  var invMessage = peer.messages.Inventory(this.getInventory())
  peer.sendMessage(invMessage)
}

PeerGroup.prototype._onPeerDisconnect = function (peer) {
  var isWeb = peer instanceof WebPeer

  remove(this.peers, peer)
  remove(isWeb ? this.peers.web : this.peers.tcp, peer)

  if (this.autoConnect && isWeb) {
    // TODO (we don't yet have a way of ensuring peers are unique)
  }
}

PeerGroup.prototype.numberConnected = function () {
  return this.peers.length
}

PeerGroup.prototype.randomPeer = function () {
  // prefers TCP peers to WebRTC peers
  var peers = this.peers
  if (peers.tcp.length) peers = peers.tcp
  return peers[Math.floor(Math.random() * peers.length)]
}

PeerGroup.prototype._connectToLocalhost = function (cb) {
  var self = this
  if (process.browser) return cb(new Error('Not supported in the browser'))

  var localPeer = new Peer({
    host: 'localhost',
    port: this.network.port,
    getTip: this.getTip
  })

  var couldNotConnect = function () {
    if (cb) return cb(new Error('Could not connect'))
  }
  localPeer.on('error', couldNotConnect)
  localPeer.on('connect', function () {
    self._onPeerConnect(localPeer)
  })
  localPeer.on('ready', function () {
    localPeer.removeListener('error', couldNotConnect)
    if (cb) return cb(null, localPeer)
  })

  localPeer.connect()
}

PeerGroup.prototype._connectToTCPPeers = function (cb) {
  if (process.browser) throw new Error('Not supported in the browser')
  if (!cb) cb = function () {}

  var self = this
  if (this.tcpCount <= 0) return cb(null)
  // FIXME: temporary hack to fix intermittent connection problems:
  // (reconnect pool every 5 seconds if no peers connect)
  var interval = setInterval(function () {
    self.pool.connect()
  }, 5000)
  function onPeerConnect () {
    self.pool.removeListener('peerconnect', onPeerConnect)
    clearInterval(interval)
    cb(null)
  }
  if (!this.connected) this.pool.on('peerconnect', onPeerConnect)
  this.pool.connect()
  if (this.acceptTcp) this.pool.listen()
}

PeerGroup.prototype._onTCPPeerConnect = function (peer) {
  if (this.disconnecting) return
  peer.getTip = this.getTip
  this._onPeerConnect(new Peer(peer))
}

PeerGroup.prototype._connectToWebPeers = function () {
  var self = this
  var client = this.webSeeds[Math.floor(Math.random() * this.webSeeds.length)]
  client.discover(function (err, peerIds) {
    if (err) return console.error(err)

    peerIds = peerIds.slice(0, self.webCount - self.numberConnected())
    peerIds.forEach(function (id) {
      client.connect(id, function (err, peer) {
        if (err) return self._error(err)
        self._onWebPeerConnect(peer)
      })
    })
  })
}

PeerGroup.prototype._onWebPeerConnect = function (conn, incoming) {
  if (this.disconnecting) return
  var peer = new WebPeer(conn, { incoming: !!incoming, getTip: this.getTip })
  peer.connect()
  this._onPeerConnect(peer)
  this.emit('webpeer', peer)
}

PeerGroup.prototype.acceptWebPeers = function () {
  if (!this.wrtc) throw new Error('WebRTC is not supported')
  this.webSeeds.forEach(this._acceptFromPeerhub.bind(this))
  this.acceptWeb = true
}

PeerGroup.prototype._acceptFromPeerhub = function (client) {
  var self = this
  client.accept(function (id, peer) { self._onWebPeerConnect(peer, true) })
}

PeerGroup.prototype.disconnect = function (cb) {
  var self = this

  this.disconnecting = true

  if (this.connecting) {
    return this.on('ready', function () {
      self.disconnect(cb)
    })
  }

  self.peers.forEach(function (peer) {
    peer.disconnect()
  })
  self.webSeeds.forEach(function (client) {
    client.disconnect()
  })

  if (this.pool) this.pool.disconnect()
  self.emit('disconnect')
  if (cb) cb(null)
}

PeerGroup.prototype.setFilter = function (filter) {
  this.peers.forEach(function (peer) {
    peer.setFilter(filter)
  })
  this.filter = filter
}

PeerGroup.prototype.addToFilter = function (data) {
  this.filter.insert(data)
  this.peers.forEach(function (peer) {
    peer.addToFilter(data)
  })
}

PeerGroup.prototype.sendMessage = PeerGroup.prototype.broadcast = function (message) {
  this.peers.forEach(function (peer) {
    peer.sendMessage(message)
  })
}

PeerGroup.prototype.addToInventory = function (item, data) {
  // TODO: support inventory types other than transactions
  if (!(item instanceof Transaction)) {
    throw new Error('Argument must be an instance of bitcore.Transaction')
  }
  var hash = u.toHash(item.hash).toString('base64')
  var inv = new Inventory({
    type: Inventory.TYPE.TX,
    hash: u.toHash(item.hash)
  })
  this.inventory[hash] = {
    inv: inv,
    value: item
  }
  this.sendInventory(inv)
}

PeerGroup.prototype.getInventory = function () {
  var output = []
  for (var k in this.inventory) {
    output.push(this.inventory[k].inv)
  }
  return output
}

PeerGroup.prototype.sendInventory = function (item) {
  if (this.peers.length === 0) return
  var inventory = item ? [item] : this.getInventory()
  var message = this.messages.Inventory(inventory)
  this.sendMessage(message)
}

PeerGroup.prototype.broadcastTransaction = function (tx, cb) {
  this.addToInventory(tx)
  // TODO: remove tx from inventory after it has been confirmed
  // TODO: send relevant 'reject' message back as error to cb
  if (cb) cb(null)
}

PeerGroup.prototype.createHeaderStream = function (opts) {
  // TODO: handle peer disconnect
  return this.randomPeer().createHeaderStream(opts)
}

PeerGroup.prototype.getTransactions = function (txids, cb) {
  return this.randomPeer().getTransactions(txids, cb)
}

PeerGroup.prototype.createBlockStream = function (chain, opts) {
  opts = Object.assign({
    chain: chain,
    peers: this
  }, opts)
  return new BlockStream(opts)
}

function remove (array, item) {
  var i = array.indexOf(item)
  if (i !== -1) return array.splice(i, 1)
} for (var i = 0; i < this._numPeers; i++) {
  var cb = next.parallel()
  var getPeer = this._seeds[Math.floor(Math.random() * this._seeds.length)]

}
var peers = yield next.sync()
*/
