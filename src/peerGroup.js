'use strict'

var debug = require('debug')('bitcoin-net:peergroup')
var dns = require('dns')
var EventEmitter = require('events')
try { var net = require('net') } catch (err) {}
var exchange = require('peer-exchange')
var getBrowserRTC = require('get-browser-rtc')
var once = require('once')
var parallel = require('run-parallel')
var pumpify = require('pumpify').obj
var assign = require('object-assign')
var {
  BlockStream,
  HeaderStream,
  TransactionStream
} = require('blockchain-download')
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
    this.connecting = false
    this.closed = false
    this.accepting = false

    var wrtc = opts.wrtc || getBrowserRTC()
    var envSeeds = process.env.WEB_SEED
      ? process.env.WEB_SEED.split(',').map((s) => s.trim()) : []
    this._webSeeds = this._params.webSeeds.concat(envSeeds)
    this._exchange = exchange(params.magic.toString(16),
      assign({ wrtc }, opts.exchangeOpts))
    this._exchange.on('error', this._error.bind(this))
    this._exchange.on('peer', (peer) => {
      if (!peer.incoming) return
      this._onConnection(null, peer)
    })

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
          setImmediate(this.connect())
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
      if (typeof seed === 'string') {
        var url = utils.parseAddress(seed)
        var port = url.port || this._params.defaultWebPort || DEFAULT_PXP_PORT
        var secure = url.protocol && url.protocol === 'wss:'
        var opts = { port, secure }
        seed = { transport: 'websocket', address: url.hostname, opts }
      }
      debug(`connecting to web seed: ${JSON.stringify(seed, null, '  ')}`)
      this._exchange.connect(seed.transport, seed.address, seed.opts, (err, socket) => {
        debug(err ? `error connecting to web seed: ${JSON.stringify(seed, null, '  ')} ${err.stack}`
          : `connected to web seed: ${JSON.stringify(seed, null, '  ')}`)
        this.emit('webSeed', socket)
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
      var nSeeds = Math.max(1,
        Math.min(this._webSeeds.length, Math.floor(this._numPeers / 2)))
      var i = 0
      var onWebSeed = () => {
        i++
        if (i < nSeeds) return
        this.removeListener('webSeed', onWebSeed)
        this._fillPeers()
      }
      this.on('webSeed', onWebSeed)
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
    this.unaccept((err) => {
      if (err) return cb(err)
      if (this.peers.length === 0) return cb(null)
      var peers = this.peers.slice(0)
      for (var peer of peers) {
        peer.once('disconnect', () => {
          if (this.peers.length === 0) cb(null)
        })
        peer.disconnect(new Error('PeerGroup closing'))
      }
    })
  }

  // accept incoming connections through websocket and webrtc (if supported)
  accept (wsOpts, cb) {
    if (typeof wsOpts === 'function') {
      cb = wsOpts
      wsOpts = {}
    }
    cb = cb || ((err) => { if (err) this._error(err) })
    parallel([
      (cb) => this._acceptWebsocket(wsOpts, cb),
      (cb) => this._acceptWebRTC(cb)
    ], (err) => {
      if (err) return this.unaccept(() => cb(err))
      this.accepting = true
      cb(null)
    })
  }

  _acceptWebsocket (opts, cb) {
    if (process.browser) return cb(null)
    if (typeof opts === 'number') {
      opts = { port: opts }
    }
    if (!opts.port) opts.port = DEFAULT_PXP_PORT
    this.websocketPort = opts.port
    this._exchange.accept('websocket', opts, cb)
  }

  _acceptWebRTC (cb) {
    this._exchange.accept('webrtc', (err) => {
      // ignore errors about not having a webrtc transport
      if (err && err.message === 'Transport "webrtc" not found') err = null
      cb(err)
    })
  }

  // stop accepting incoming connections
  unaccept (cb) {
    if (!this.accepting) return cb(null)
    this._exchange.unaccept('websocket', (err1) => {
      this._exchange.unaccept('webrtc', (err2) => {
        this.accepting = false
        if (err1 && err1.message === 'Not accepting connections with "websocket" transport') {
          err1 = null
        }
        if (err2 && err2.message === 'Not accepting connections with "webrtc" transport') {
          err2 = null
        }
        if (cb) return cb(err1 || err2)
        if (err1 || err2) return this._error(err1 || err2)
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

  createHeaderStream (opts) {
    return new HeaderStream(this, opts)
  }

  createBlockStream (opts) {
    return new BlockStream(this, opts)
  }

  createTransactionStream (opts) {
    var blocks = new BlockStream(this, opts)
    var txs = pumpify(blocks, TransactionStream())
    txs.blocks = blocks
    return txs
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
