var util = require('util')
var PeerGroup = require('bitcoin-net').PeerGroup
var debug = require('debug')('webcoin-bridge')

var Bridge = module.exports = function (params, opts) {
  opts = Object.assign({ connectWeb: false }, opts)
  PeerGroup.call(this, params, opts)
}
util.inherits(Bridge, PeerGroup)

Bridge.prototype._onConnection = function (err, client) {
  if (err) {
    this.emit('connectError', err, null)
  }
  this._connectPeer((err, bridgePeer) => {
    if (err) {
      this.emit('connectError', err)
      return this._onConnection(null, client)
    }
    client.pipe(bridgePeer).pipe(client)
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
  })
}

Bridge.prototype.connect = function () {
  // don't let consumers try to make outgoing connectionsBridge.prototype.connect = function () {
  throw new Error('Do not use "connect()" with Bridge, only incoming connections are allowed')
}
