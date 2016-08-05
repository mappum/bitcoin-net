'use strict'

var debug = require('debug')('bitcoin-net:bridge')
var PeerGroup = require('./peerGroup.js')
var assign = require('object-assign')
var proto = require('bitcoin-protocol')
var through = require('through2').obj
var pumpify = require('pumpify')
var pkg = require('../package.json')

module.exports =
class Bridge extends PeerGroup {
  constructor (params, opts) {
    var selectPeer = (...args) => this._selectPeer(...args)
    opts = assign({
      connectWeb: false,
      exchangeOpts: { selectPeer }
    }, opts)
    super(params, opts)
  }

  _selectPeer (cb) {
    this._connectPeer((err, bridgePeer) => {
      if (err) return cb(err)
      debug(`connected to TCP peer for bridging: ${bridgePeer.remoteAddress}`)

      var transform = through((message, enc, cb) => {
        if (message.command !== 'version') return cb(null, message)
        var version = message.payload
        if (!version.userAgent.endsWith('/')) version.userAgent += '/'
        version.userAgent += `webcoin-bridge:${pkg.version} (proxy; ` +
          `${bridgePeer.remoteAddress}:${bridgePeer.remotePort})/`
        cb(null, message)
      })

      var protocolOpts = {
        magic: this._params.magic,
        messages: this._params.messages
      }
      var stream = pumpify(
        bridgePeer,
        proto.createDecodeStream(protocolOpts),
        transform,
        proto.createEncodeStream(protocolOpts)
      )
      cb(null, stream)
    })
  }

  _onConnection (err, socket) {
    if (err) return this.emit('error', err)
    this.emit('connection', socket)
  }

  connect () {
    // don't let consumers try to make outgoing connections
    throw new Error('Do not use "connect()" with Bridge, only incoming connections are allowed')
  }
}
