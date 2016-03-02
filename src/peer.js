'use strict'

var Debug = require('debug')
var debug = Debug('bitcoin-net:peer')
debug.rx = Debug('bitcoin-net:messages:rx')
debug.tx = Debug('bitcoin-net:messages:tx')
var through = require('through2').obj
var crypto = require('crypto')
var EventEmitter = require('events')
var proto = require('bitcoin-protocol')
var INV = proto.constants.inventory
var pkg = require('../package.json')
var HeaderStream = require('./headerStream.js')
var BlockStream = require('./blockStream.js')
var transforms = require('./protocolTransforms.js')

var SERVICES_SPV = new Buffer('0000000000000000', 'hex')
var SERVICES_FULL = new Buffer('0100000000000000', 'hex')
var BLOOMSERVICE_VERSION = 70011
var SENDHEADERS_VERSION = 70012

var serviceBits = {
  'NODE_NETWORK': 1,
  'NODE_BLOOM': 1 << 2
}
function getServices (buf) {
  var services = {}
  var lower = buf.readUInt32LE(0)
  for (var name in serviceBits) {
    var bit = serviceBits[name]
    if (lower & bit) services[name] = true
  }
  return services
}

var debugStream = (f) => through(function (message, enc, cb) {
  f(message)
  this.push(message)
  cb(null)
})

module.exports =
class Peer extends EventEmitter {
  constructor (opts) {
    if (!opts || opts.magic == null) {
      throw new Error('Must specify network magic')
    }

    super()

    this.magic = opts.magic
    this.protocolVersion = opts.protocolVersion || 70012
    this.minimumVersion = opts.minimumVersion || 70001
    this.requireBloom = opts.requireBloom && true
    this.userAgent = opts.userAgent || `/${pkg.name}:${pkg.version}/`
    if (process.browser) opts.userAgent += navigator.userAgent + '/'
    this.handshakeTimeout = opts.handshakeTimeout || 10 * 1000
    this.getTip = opts.getTip
    this.relay = opts.relay || false
    this.version = null
    this.services = null
    this.socket = null
    this.ready = false
    this.sendHeaders = false
    this._handshakeTimeout = null
    this.disconnected = false

    this.setMaxListeners(200)

    if (opts.socket) this.connect(opts.socket)
  }

  send (command, payload) {
    // TODO?: maybe this should error if we try to write after close?
    if (!this.socket.writable) return
    this._encoder.write({ command, payload })
  }

  connect (socket) {
    if (!socket || !socket.readable || !socket.writable) {
      throw new Error('Must specify socket duplex stream')
    }
    this.socket = socket
    socket.once('close', this.disconnect.bind(this))
    socket.on('error', this._error.bind(this))

    this._decoder = transforms.decode()
    var protoDecoder = proto.createDecodeStream({ magic: this.magic })
    var decodeDebug = debugStream(debug.rx)
    socket.pipe(protoDecoder).pipe(this._decoder).pipe(decodeDebug)

    this._encoder = transforms.encode()
    var protoEncoder = proto.createEncodeStream({ magic: this.magic })
    var encodeDebug = debugStream(debug.tx)
    this._encoder.pipe(encodeDebug).pipe(protoEncoder).pipe(socket)

    // timeout if handshake doesn't finish fast enough
    if (this.handshakeTimeout) {
      this._handshakeTimeout = setTimeout(() => {
        this._handshakeTimeout = null
        this._error(new Error('Peer handshake timed out'))
      }, this.handshakeTimeout)
      this.once('ready', () => {
        clearTimeout(this._handshakeTimeout)
        this._handshakeTimeout = null
      })
    }

    this._registerListeners()
    this._sendVersion()
  }

  disconnect () {
    if (this.disconnected) return
    this.disconnected = true
    if (this._handshakeTimeout) clearTimeout(this._handshakeTimeout)
    this.socket.destroy()
    this.emit('disconnect')
  }

  _error (err) {
    this.emit('error', err)
    this.disconnect()
  }

  _registerListeners () {
    this._decoder.on('error', (err) => console.log('DECODER ERROR: ', err))
    this._decoder.on('error', this._error.bind(this))
    this._decoder.on('data', (message) => {
      this.emit('message', message)
      this.emit(message.command, message.payload)
    })

    this._encoder.on('error', this._error.bind(this))

    this.on('version', this._onVersion)
    this.on('verack', () => {
      if (this.ready) return this._error(new Error('Got duplicate verack'))
      this.verack = true
      this._maybeReady()
    })

    this.on('sendheaders', () => this.sendHeaders = true)

    this.on('ping', (message) => this.send('pong', message))
  }

  _onVersion (message) {
    this.services = getServices(message.services)
    if (!this.services.NODE_NETWORK) {
      return this._error(new Error('Node does not provide NODE_NETWORK service'))
    }
    this.version = message
    if (message.version < this.minimumVersion) {
      return this._error(new Error(`Peer is using an incompatible protocol version: ` +
        `required: >= ${this.minimumVersion}, actual: ${message.version}`))
    }
    if (this.requireBloom &&
    message.version >= BLOOMSERVICE_VERSION &&
    !this.services.NODE_BLOOM) {
      return this._error(new Error('Node does not provide NODE_BLOOM service'))
    }
    this.send('verack')
    this._maybeReady()
  }

  _maybeReady () {
    if (!this.verack || !this.version) return
    this.ready = true
    if (this.version.version >= SENDHEADERS_VERSION) {
      this.send('sendheaders')
    }
    this.emit('ready')
  }

  _onceReady (cb) {
    if (this.ready) return cb()
    this.once('ready', cb)
  }

  _sendVersion () {
    this.send('version', {
      version: this.protocolVersion,
      services: SERVICES_SPV,
      timestamp: Math.round(Date.now() / 1000),
      receiverAddress: {
        services: SERVICES_FULL,
        address: this.socket.remoteAddress || '0.0.0.0',
        port: this.socket.remotePort || 0
      },
      senderAddress: {
        services: SERVICES_SPV,
        address: '0.0.0.0',
        port: this.socket.localPort || 0
      },
      nonce: crypto.pseudoRandomBytes(8),
      userAgent: this.userAgent,
      startHeight: this.getTip ? this.getTip().height : 0,
      relay: this.relay
    })
  }

  createHeaderStream (opts) {
    return new HeaderStream(this, opts)
  }

  createBlockStream (opts) {
    return new BlockStream(this, opts)
  }

  // TODO: add a timeout
  getBlocks (hashes, filtered, cb) {
    if (typeof filtered === 'function') {
      cb = filtered
      filtered = false
    }
    var inventory = hashes.map((hash) => ({
      type: filtered ? INV.MSG_FILTERED_BLOCK : INV.MSG_BLOCK,
      hash
    }))

    var blockIndex = {}
    hashes.forEach((block, i) => blockIndex[block] = i)
    var remaining = hashes.length
    var output = new Array(hashes.length)

    // TODO: listen for blocks by hash
    var onBlock = (block) => {
      var blockId = block.header.getId()
      var i = blockIndex[blockId]
      if (i == null) return
      delete blockIndex[blockId]
      output[i] = block
      remaining--
      if (remaining === 0) {
        this.removeListener('block', onBlock)
        cb(null, output)
      }
    }
    this.on('block', onBlock)
    this.send('getdata', inventory)
  }

  getTransactions (blockHash, txids, cb) {
    var txIndex = {}
    txids.forEach((txid, i) => txIndex[txid] = i)
    var output = new Array(txids.length)

    this.getBlocks([ blockHash ], (err, blocks) => {
      if (err) return cb(err)
      for (var tx of blocks[0].transactions) {
        var id = tx.getId()
        var i = txIndex[id]
        if (i == null) return
        delete txIndex[id]
        output[i] = tx
        cb(null, output)
      }
    })
  }
}
