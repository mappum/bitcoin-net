'use strict'

var Debug = require('debug')
var debug = Debug('bitcoin-net:peer')
debug.rx = Debug('bitcoin-net:messages:rx')
debug.tx = Debug('bitcoin-net:messages:tx')
var through = require('through2').obj
var crypto = require('crypto')
var EventEmitter = require('events')
var proto = require('bitcoin-protocol')
var u = require('bitcoin-util')
var pkg = require('../package.json')
var HeaderStream = require('./headerStream.js')
var BlockStream = require('./blockStream.js')
var transforms = require('./protocolTransforms.js')

var SERVICES_SPV = new Buffer('0000000000000000', 'hex')
var SERVICES_FULL = new Buffer('0100000000000000', 'hex')

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
    this.protocolVersion = opts.protocolVersion || 70002
    this.userAgent = opts.userAgent || `/${pkg.name}:${pkg.version}/`
    if (process.browser) opts.userAgent += navigator.userAgent + '/'
    this.verackTimeout = opts.verackTimeout || 10 * 1000
    this.getTip = opts.getTip
    this.relay = opts.relay || false
    this.version = null
    this.services = null
    this.socket = null

    if (opts.socket) this.connect(opts.socket)
  }

  send (command, payload) {
    this._encoder.write({ command, payload })
  }

  connect (socket) {
    if (!socket || !socket.readable || !socket.writable) {
      throw new Error('Must specify socket duplex stream')
    }
    this.socket = socket

    this._decoder = transforms.decode()
    var protoDecoder = proto.createDecodeStream({ magic: this.magic })
    var decodeDebug = debugStream(debug.rx)
    socket.pipe(protoDecoder).pipe(this._decoder).pipe(decodeDebug)

    this._encoder = transforms.encode()
    var protoEncoder = proto.createEncodeStream({ magic: this.magic })
    var encodeDebug = debugStream(debug.tx)
    this._encoder.pipe(encodeDebug).pipe(protoEncoder).pipe(socket)

    this._registerListeners()
    this._sendVersion()
  }

  disconnect () {
    this.socket.destroy()
  }

  _error (err) {
    this.disconnect()
    this.emit('error', err)
  }

  _registerListeners () {
    this.socket.on('close', () => this.emit('disconnect'))
    this.socket.on('error', this._error.bind(this))

    this._decoder.on('data', message => {
      this.emit('message', message)
      this.emit(message.command, message.payload)
    })

    this.on('version', this._onVersion)
    this.on('verack', () => {
      if (this.ready) return this._error(new Error('Got duplicate verack'))
      this.verack = true
      this._maybeReady()
    })

    this.on('ping', message => this.send('pong', message))
  }

  _onVersion (message) {
    this.services = getServices(message.services)
    if (!this.services.NODE_NETWORK) {
      throw new Error('Node does not provide NODE_NETWORK service')
    }
    // TODO: if version >= 70011, handle NODE_BLOOM service bit (dc if not set)
    // TODO: if version >= 70012, send sendheaders message
    this.version = message
    this.send('verack')
    this._maybeReady()
  }

  _maybeReady () {
    if (this.verack && this.version) {
      this.ready = true
      this.emit('ready')
    }
  }

  _sendVersion () {
    if (this.verackTimeout) {
      var timeout = setTimeout(() => {
        this._error(new Error('Peer did not send verack'))
      }, this.verackTimeout)
      this.once('verack', () => clearTimeout(timeout))
    }

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
  getTransactions (txids, cb) {
    var inventory = txids.map(txid => ({
      type: 1, // MSG_TX
      hash: u.toHash(txid)
    }))
    var txidIndex = {}
    txids.forEach((txid, i) => txidIndex[txid] = i)
    var remaining = txids.length
    var output = new Array(txids.length)
    var onTx = (transaction) => {
      var i = txidIndex[transaction.getId()]
      if (i == null) return
      output[i] = transaction
      remaining--
      if (remaining === 0) {
        this.removeListener('tx', onTx)
        cb(null, output)
      }
    }
    this.on('tx', onTx)
    this.send('getData', inventory)
  }
}
