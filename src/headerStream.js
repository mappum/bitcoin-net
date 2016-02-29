var Readable = require('stream').Readable
var util = require('util')
var u = require('bitcoin-util')

var HeaderStream = module.exports = function (peer, opts) {
  if (!peer) throw new Error('"peer" option is required for HeaderStream')
  Readable.call(this, { objectMode: true, highWaterMark: 4 })
  opts = opts || {}
  this.peer = peer
  this.locator = opts.locator || []
  this.disconnected = false
  this.getting = false
  this.done = false

  var self = this
  this.peer.on('disconnect', function () {
    self.disconnected = true
    self._error(new Error('Disconnected from peer'))
  })

  this._onHeaders = this._onHeaders.bind(this)
  this.peer.on('headers', this._onHeaders)
}
util.inherits(HeaderStream, Readable)

HeaderStream.prototype._error = function (err) {
  this.emit('error', err)
}

HeaderStream.prototype._read = function () {
  this._getHeaders()
}

HeaderStream.prototype._end = function () {
  this.done = true
  this.peer.removeListener('headers', this._onHeaders)
  this.push(null)
}

HeaderStream.prototype._getHeaders = function () {
  if (this.disconnected || this.getting || this.done) return
  this.getting = true
  this.peer.send('getheaders', {
    version: this.peer.protocolVersion,
    locator: this.locator,
    hashStop: this.stop || u.nullHash
  })
  // TODO: timeout if we don't get a response
}

HeaderStream.prototype._onHeaders = function (message) {
  this.getting = false
  if (message.length === 0) return this._end()
  this.locator = message.slice(-6).map((header) => {
    return header.getHash()
  })
  var res = this.push(message)
  if (message.length < 2000) return this._end()
  if (res) this._getHeaders()
}
