'use strict'

var debug = require('debug')('bitcoin-net:bridge')
var PeerGroup = require('./peerGroup.js')
var assign = require('object-assign')
var proto = require('bitcoin-protocol')
var through = require('through2').obj
var pkg = require('../package.json')

module.exports =
class Bridge extends PeerGroup {
  constructor (params, opts) {
    opts = assign({ connectWeb: false }, opts)
    super(params, opts)
  }

  _onConnection (err, client) {
    if (err) {
      this.emit('connectError', err, null)
      return
    }
    if (!client.incoming) return
    this.emit('connection', client)
    this._connectPeer((err, bridgePeer) => {
      if (err) {
        this.emit('connectError', err)
        return setImmediate(() => this._onConnection(null, client))
      }
      debug(`connected to TCP peer for bridging: ${bridgePeer.remoteAddress}`)
      var onError = (err) => {
        client.destroy()
        bridgePeer.destroy()
        debug('error', err.message)
        this.emit('peerError', err, client, bridgePeer)
      }
      client.once('error', onError)
      bridgePeer.once('error', onError)
      client.once('close', () => bridgePeer.destroy())
      bridgePeer.once('close', () => client.destroy())

      client.pipe(bridgePeer)
      var transform = through((message, enc, cb) => {
        if (message.command !== 'version') return cb(null, message)
        var version = message.payload
        if (!version.userAgent.endsWith('/')) version.userAgent += '/'
        version.userAgent += `webcoin-bridge:${pkg.version}`
        version.userAgent += `(proxy; host='${bridgePeer.remoteAddress}')/`
        cb(null, message)
        bridgePeer.unpipe()
        bridgePeer.pipe(client)
      })
      var protocolOpts = {
        magic: this._params.magic,
        messages: this._params.messages
      }
      bridgePeer
        .pipe(proto.createDecodeStream(protocolOpts))
        .pipe(transform)
        .pipe(proto.createEncodeStream(protocolOpts))
        .pipe(client)
      this.emit('bridge', client, bridgePeer)
    })
  }

  connect () {
    // don't let consumers try to make outgoing connections
    throw new Error('Do not use "connect()" with Bridge, only incoming connections are allowed')
  }
}
