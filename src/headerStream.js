var Readable = require('stream').Readable
var util = require('util')

var HeaderStream = module.exports = function (peers, opts) {
  if (!peers) throw new Error('"peers" option is required for HeaderStream')
  Readable.call(this, { objectMode: true, highWaterMark: 4 })
  opts = opts || {}
  this.peers = peers
  this.locator = opts.locator || []
  this.timeout = opts.timeout
  this.stop = opts.stop
  this.getting = false
  this.done = false

  this._onHeaders = this._onHeaders.bind(this)
}
util.inherits(HeaderStream, Readable)

HeaderStream.prototype._error = function (err) {
  this.emit('error', err)
  this.end()
}

HeaderStream.prototype._read = function () {
  this._getHeaders()
}

HeaderStream.prototype.end = function () {
  this.done = true
  this.push(null)
}

HeaderStream.prototype._getHeaders = function () {
  if (this.getting || this.done) return
  this.getting = true
  this.peers.getHeaders(this.locator, {
    stop: this.stop,
    timeout: this.timeout
  }, this._onHeaders)
}

HeaderStream.prototype._onHeaders = function (err, headers) {
  if (err) return this._error(err)
  this.getting = false
  if (headers.length === 0) return this.end()
  this.locator = [ headers[headers.length - 1].getHash() ]
  var res = this.push(headers)
  if (headers.length < 2000) return this.end()
  if (res) this._getHeaders()
}
