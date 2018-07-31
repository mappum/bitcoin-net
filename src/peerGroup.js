'use strict'

var debug = require('debug')('bitcoin-net:peergroup')
var dns = require('dns')
var EventEmitter = require('events')
try { var net = require('net') } catch (err) {}
var ws = require('websocket-stream')
var http = require('http')
var Exchange = require('peer-exchange')
var getBrowserRTC = require('get-browser-rtc')
var once = require('once')
var pumpify = require('pumpify').obj
var assign = require('object-assign')
var old = require('old')
var Peer = require('./peer.js')
var utils = require('./utils.js')
require('setimmediate')

var DEFAULT_PXP_PORT = 8192 // default port for peer-exchange nodes

class PeerGroup extends EventEmitter {
  constructor (params, opts) {
    utils.assertParams(params)
    super()
    this._params = params
    opts = opts || {}
    this._numPeers = opts.numPeers || 8
    this.peers = []
    this._hardLimit = opts.hardLimit || false
    this.websocketPort = null
    this._connectWeb = opts.connectWeb != null
      ? opts.connectWeb : process.browser
    this.connectTimeout = opts.connectTimeout != null
      ? opts.connectTimeout : 8 * 1000
    this.peerOpts = opts.peerOpts != null
      ? opts.peerOpts : {}
    this.acceptIncoming = opts.acceptIncoming
    var acceptIncoming = this.acceptIncoming
    this.connecting = false
    this.closed = false
    this.accepting = false

    if (this._connectWeb) {
      var wrtc = opts.wrtc || getBrowserRTC()
      var envSeeds = process.env.WEB_SEED
        ? process.env.WEB_SEED.split(',').map((s) => s.trim()) : []
      this._webSeeds = this._params.webSeeds.concat(envSeeds)
      try {
        this._exchange = Exchange(params.magic.toString(16),
          assign({ wrtc, acceptIncoming }, opts.exchangeOpts))
      } catch (err) {
        return this._error(err)
      }
      this._exchange.on('error', this._error.bind(this))
      this._exchange.on('connect', (stream) => {
        this._onConnection(null, stream)
      })
      if (!process.browser && acceptIncoming) {
        this._acceptWebsocket()
      }
    }

    this.on('block', (block) => {
      this.emit(`block:${block.header.getHash().toString('base64')}`, block)
    })
    this.on('merkleblock', (block) => {
      this.emit(`merkleblock:${block.header.getHash().toString('base64')}`, block)
    })
    this.on('tx', (tx) => {
      this.emit(`tx:${tx.getHash().toString('base64')}`, tx)
    })
    this.once('peer', () => this.emit('connect'))
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
      if (this.connecting) {
        setImmediate(this._connectPeer.bind(this))
      }
      return
    }
    if (this.closed) return socket.destroy()
    var opts = assign({ socket }, this.peerOpts)
    var peer = new Peer(this._params, opts)
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
      if (this.closed) return peer.disconnect()
      peer.removeListener('error', onError)
      peer.removeListener('disconnect', onError)
      this.addPeer(peer)
    })
  }

  // connects to a new peer, via a randomly selected peer discovery method
  _connectPeer (cb) {
    cb = cb || this._onConnection.bind(this)
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
      this.connecting = false
      if (this.connectTimeout) {
        setTimeout(() => {
          this.connecting = true
          setImmediate(this.connect.bind(this))
        }, this.connectTimeout)
      }
      return this._onConnection(
        new Error('No methods available to get new peers'))
    }
    var getPeer = utils.getRandom(getPeerArray)
    debug(`_connectPeer: getPeer = ${getPeer.name}`)
    getPeer(cb)
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
    this._connectTCP(peer.hostname, peer.port || this._params.defaultPort, cb)
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
    this._webSeeds.forEach((seed) => {
      debug(`connecting to web seed: ${JSON.stringify(seed, null, '  ')}`)
      var socket = ws(seed)
      socket.on('error', (err) => this._error(err))
      this._exchange.connect(socket, (err, peer) => {
        if (err) {
          debug(`error connecting to web seed (pxp): ${JSON.stringify(seed, null, '  ')} ${err.stack}`)
          return
        }
        debug(`connected to web seed: ${JSON.stringify(seed, null, '  ')}`)
        this.emit('webSeed', peer)
      })
    })
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

  // sends a message to all peers
  send (command, payload, assert) {
    assert = assert != null ? assert : true
    if (assert) this._assertPeers()
    for (var peer of this.peers) {
      peer.send(command, payload)
    }
  }

  // initializes the PeerGroup by creating peer connections
  connect (onConnect) {
    debug('connect called')
    this.connecting = true
    if (onConnect) this.once('connect', onConnect)

    // first, try to connect to web seeds so we can get web peers
    // once we have a few, start filling peers via any random
    // peer discovery method
    if (this._connectWeb && this._params.webSeeds && this._webSeeds.length) {
      this.once('webSeed', () => this._fillPeers())
      return this._connectWebSeeds()
    }

    // if we aren't using web seeds, start filling with other methods
    this._fillPeers()
  }

  // disconnect from all peers and stop accepting connections
  close (cb) {
    if (cb) cb = once(cb)
    else cb = (err) => { if (err) this._error(err) }

    debug(`close called: peers.length = ${this.peers.length}`)
    this.closed = true
    if (this.peers.length === 0) return cb(null)
    var peers = this.peers.slice(0)
    for (var peer of peers) {
      peer.once('disconnect', () => {
        if (this.peers.length === 0) cb(null)
      })
      peer.disconnect(new Error('PeerGroup closing'))
    }
  }

  _acceptWebsocket (port, cb) {
    if (process.browser) return cb(null)
    if (!port) port = DEFAULT_PXP_PORT
    this.websocketPort = port
    var server = http.createServer()
    ws.createServer({ server }, (stream) => {
      this._exchange.accept(stream)
    })
    http.listen(port)
    cb(null)
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

    var onMessage = (message) => {
      this.emit('message', message, peer)
      this.emit(message.command, message.payload, peer)
    }
    peer.on('message', onMessage)

    peer.once('disconnect', (err) => {
      var index = this.peers.indexOf(peer)
      this.peers.splice(index, 1)
      peer.removeListener('message', onMessage)
      debug(`peer disconnect, peer.length = ${this.peers.length}, reason=${err}\n${err.stack}`)
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

  getBlocks (hashes, opts, cb) {
    this._request('getBlocks', hashes, opts, cb)
  }

  getTransactions (blockHash, txids, opts, cb) {
    this._request('getTransactions', blockHash, txids, opts, cb)
  }

  getHeaders (locator, opts, cb) {
    this._request('getHeaders', locator, opts, cb)
  }

  // calls a method on a random peer,
  // and retries on another peer if it times out
  _request (method, ...args) {
    var cb = args.pop()
    while (!cb) cb = args.pop()
    var peer = this.randomPeer()
    args.push((err, res) => {
      if (this.closed) return
      if (err && err.timeout) {
        // if request times out, disconnect peer and retry with another random peer
        debug(`peer request "${method}" timed out, disconnecting`)
        peer.disconnect(err)
        this.emit('requestError', err)
        return this._request(...arguments)
      }
      cb(err, res, peer)
    })
    peer[method](...args)
  }
}

module.exports = old(PeerGroup)
