'use strict'

var debug = require('debug')('bitcoin-net:peergroup')
var dns = require('dns')
var EventEmitter = require('events')
try { var net = require('net') } catch (err) {}
var exchange = require('peer-exchange')
var getBrowserRTC = require('get-browser-rtc')
var BlockStream = require('./blockStream.js')
var HeaderStream = require('./headerStream.js')
var Peer = require('./peer.js')
var utils = require('./utils.js')

var DEFAULT_PXP_PORT = 8192 // default port for peer-exchange nodes

module.exports =
class PeerGroup extends EventEmitter {
  constructor (params, opts) {
    utils.assertParams(params)
    super()
    this._params = params
    opts = opts || {}
    this._numPeers = opts.numPeers || 8
    this._getTip = opts.getTip
    this.peers = []
    this._hardLimit = opts.hardLimit || false
    this.websocketPort = null
    this._connectWeb = opts.connectWeb != null
      ? opts.connectWeb : process.browser
    this.connectTimeout = opts.connectTimeout != null
      ? opts.connectTimeout : 8 * 1000
    this.peerOpts = opts.peerOpts != null
      ? opts.peerOpts : {}
    this.connecting = false
    this.closed = false

    var wrtc = opts.wrtc || getBrowserRTC()
    this._exchange = exchange(params.id, { wrtc })
    this._exchange.on('error', this._error.bind(this))
    this._exchange.on('peer', (peer) => {
      if (!peer.incoming) return
      this._onConnection(null, peer)
    })

    this._onMessage = this._onMessage.bind(this)
  }

  _error (err) {
    this.emit('error', err)
  }

  // callback for peer discovery methods
  _onConnection (err, socket) {
    if (err) {
      if (socket) socket.destroy()
      debug(`discovery connection error: ${err.message}`)
      this.emit('connectError', err, null)
      if (this.connecting) this._connectPeer()
      return
    }
    if (this.closed) return socket.destroy()
    var peer = new Peer(this._params, {
      getTip: this._getTip,
      socket
    })
    var onError = (err) => {
      err = err || new Error('Connection error')
      debug(`peer connection error: ${err.message}`)
      peer.removeListener('disconnect', onError)
      this.emit('connectError', err, peer)
      if (this.connecting) this._connectPeer()
    }
    peer.once('error', onError)
    peer.once('disconnect', onError)
    peer.once('ready', () => {
      if (this.closed) return socket.destroy()
      peer.removeListener('error', onError)
      peer.removeListener('disconnect', onError)
      this.addPeer(peer)
    })
  }

  // connects to a new peer, via a randomly selected peer discovery method
  _connectPeer () {
    if (this.closed) return
    var getPeerArray = []
    if (!process.browser) {
      if (this._params.dnsSeeds && this._params.dnsSeeds.length > 0) {
        getPeerArray.push(this._connectDNSPeer.bind(this))
      }
      if (this._params.staticPeers && this._params.staticPeers.length > 0) {
        getPeerArray.push(this._connectStaticPeer.bind(this))
      }
    }
    if (this._connectWeb && this._exchange.peers.length > 0) {
      getPeerArray.push(this._exchange.getNewPeer.bind(this._exchange))
    }
    if (this._params.getNewPeer) {
      getPeerArray.push(this._params.getNewPeer.bind(this._params))
    }
    if (getPeerArray.length === 0) {
      return this._onConnection(
        new Error('No methods available to get new peers'))
    }
    var getPeer = utils.getRandom(getPeerArray)
    debug(`_connectPeer: getPeer = ${getPeer.name}`)
    getPeer(this._onConnection.bind(this))
  }

  // connects to a random TCP peer via a random DNS seed
  // (selected from `dnsSeeds` in the params)
  _connectDNSPeer (cb) {
    var seeds = this._params.dnsSeeds
    var seed = utils.getRandom(seeds)
    dns.resolve(seed, (err, addresses) => {
      if (err) return cb(err)
      var address = utils.getRandom(addresses)
      this._connectTCP(address, this._params.defaultPort, cb)
    })
  }

  // connects to a random TCP peer from `staticPeers` in the params
  _connectStaticPeer (cb) {
    var peers = this._params.staticPeers
    var address = utils.getRandom(peers)
    var peer = utils.parseAddress(address)
    this._connectTCP(peer.hostname, peer.port, cb)
  }

  // connects to a standard protocol TCP peer
  _connectTCP (host, port, cb) {
    debug(`_connectTCP: tcp://${host}:${port}`)
    var socket = net.connect(port, host)
    if (this.connectTimeout) {
      var timeout = setTimeout(() => {
        socket.destroy()
        cb(new Error('Connection timed out'))
      }, this.connectTimeout)
    }
    socket.once('error', cb)
    socket.once('connect', () => {
      socket.ref()
      socket.removeListener('error', cb)
      clearTimeout(timeout)
      cb(null, socket)
    })
    socket.unref()
  }

  // connects to the peer-exchange peers provided by the params
  _connectWebSeeds () {
    for (var seed of this._params.webSeeds) {
      if (typeof seed === 'string') {
        var url = utils.parseAddress(seed)
        var port = url.port || this._params.defaultWebPort || DEFAULT_PXP_PORT
        seed = { transport: 'websocket', address: url.hostname, opts: { port } }
      }
      this._exchange.connect(seed.transport, seed.address, seed.opts, this._onConnection.bind(this))
    }
  }

  _assertPeers () {
    if (this.peers.length === 0) {
      throw new Error('Not connected to any peers')
    }
  }

  _fillPeers () {
    if (this.closed) return

    // TODO: smarter peer logic (ensure we don't have too many peers from the
    // same seed, or the same IP block)
    var n = this._numPeers - this.peers.length
    debug(`_fillPeers: n = ${n}, numPeers = ${this._numPeers}, peers.length = ${this.peers.length}`)
    for (var i = 0; i < n; i++) this._connectPeer()
  }

  _onMessage (message) {
    this.emit('message', message)
    this.emit(message.command, message.payload)
  }

  // sends a message to all peers
  send (command, payload) {
    this._assertPeers()
    for (var peer of this.peers) {
      peer.send(command, payload)
    }
  }

  // initializes the PeerGroup by creating peer connections
  connect () {
    debug('connect called')
    this.connecting = true

    // first, try to connect to web seeds so we can get web peers
    // once we have a few, start filling peers via any random
    // peer discovery method
    if (this._connectWeb && this._params.webSeeds && this._params.webSeeds.length) {
      var nSeeds = Math.min(
        this._params.webSeeds.length,
        Math.floor(this._numPeers / 2),
        1)
      var i = 0
      var onPeer = () => {
        i++
        if (i < nSeeds) return
        this.removeListener('peer', onPeer)
        this._fillPeers()
      }
      this.on('peer', onPeer)
      return this._connectWebSeeds()
    }

    // if we aren't using web seeds, start filling with other methods
    this._fillPeers()
  }

  // disconnect from all peers and stop accepting connections
  close () {
    debug(`close called: peers.length = ${this.peers.length}`)
    this.closed = true
    var peers = this.peers.slice(0)
    for (var peer of peers) {
      peer.disconnect(new Error('PeerGroup closing'))
    }
    // TODO: unaccept all
  }

  // accept incoming connections through websocket and webrtc (if supported)
  accept (port, cb) {
    if (typeof port === 'function') {
      cb = port
      port = null
    }
    port = this.websocketPort = port || DEFAULT_PXP_PORT
    this._exchange.accept('websocket', { port }, (err1) => {
      if (!err1) this.acceptingWebsocket = true
      this._exchange.accept('webrtc', (err2) => {
        // ignore errors about not having a webrtc transport
        if (err2 && err2.message === 'Transport "webrtc" not found') err2 = null
        if (!err2) this.acceptingWebRTC = true
        if (cb) return cb(err1 || err2)
        if (err1 && err2) return this._error(err1)
      })
    })
  }

  // stop accepting incoming connections
  unaccept (cb) {
    this._exchange.unaccept('websocket', (err1) => {
      this._exchange.unaccept('webrtc', (err2) => {
        if (cb) return cb(err1 || err2)
        if (err1 && err2) return this._error(err1)
      })
    })
  }

  // manually adds a Peer
  addPeer (peer) {
    if (this.closed) throw new Error('Cannot add peers, PeerGroup is closed')

    this.peers.push(peer)
    debug(`add peer: peers.length = ${this.peers.length}`)

    if (this._hardLimit && this.peers.length > this._numPeers) {
      var disconnectPeer = this.peers.shift()
      disconnectPeer.disconnect(new Error('PeerGroup over limit'))
    }

    peer.on('message', this._onMessage)

    peer.once('disconnect', (err) => {
      var index = this.peers.indexOf(peer)
      this.peers.splice(index, 1)
      peer.removeListener('message', this._onMessage)
      debug(`peer disconnect, peer.length = ${this.peers.length}, reason = ${err}`)
      if (this.connecting) this._fillPeers()
      this.emit('disconnect', peer, err)
    })
    peer.on('error', (err) => {
      this.emit('peerError', err)
      peer.disconnect(err)
    })

    this.emit('peer', peer)
  }

  randomPeer () {
    this._assertPeers()
    return utils.getRandom(this.peers)
  }

  createHeaderStream (opts) {
    return new HeaderStream(this, opts)
  }

  createBlockStream (chain, opts) {
    return new BlockStream(this, chain, opts)
  }

  getBlocks (hashes, opts, cb) {
    this._request('getBlocks', hashes, opts, cb)
  }

  getTransactions (blockHash, txids, cb) {
    this._request('getTransactions', blockHash, txids, cb)
  }

  getHeaders (locator, opts, cb) {
    this._request('getHeaders', locator, opts, cb)
  }

  // calls a method on a random peer,
  // and retries on another peer if it times out
  _request (method) {
    var cb
    var args
    for (var i = 1; i < arguments.length - 1; i++) {
      cb = arguments[arguments.length - i]
      if (!cb) continue
      args = Array.prototype.slice.call(arguments, 1, arguments.length - i)
      break
    }
    var peer = this.randomPeer()
    args.push((err, res) => {
      if (this.closed) return
      if (err && err.timeout) {
        // if request times out, disconnect peer and retry with another random peer
        debug(`peer request "${method}" timed out, disconnecting`)
        peer.disconnect(err)
        this.emit('requestError', err)
        var allArgs = Array.prototype.slice.call(arguments, 0)
        return this._request.apply(this, allArgs)
      }
      cb(err, res, peer)
    })
    peer[method].apply(peer, args)
  }
}

/*
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
*/
