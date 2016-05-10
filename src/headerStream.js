var Transform = require('stream').Transform
var util = require('util')

var HeaderStream = module.exports = function (peers, opts) {
  if (!peers) throw new Error('"peers" argument is required')
  Transform.call(this, { objectMode: true })
  opts = opts || {}
  this.peers = peers
  this.timeout = opts.timeout
  this.stop = opts.stop
  this.getting = false
  this.done = false
}
util.inherits(HeaderStream, Transform)

HeaderStream.prototype._error = function (err) {
  this.emit('error', err)
  this.end()
}

HeaderStream.prototype._transform = function (locator, enc, cb) {
  if (this.getting || this.done) return
  this.getting = true
  this.peers.getHeaders(locator, {
    stop: this.stop,
    timeout: this.timeout
  }, (err, headers, peer) => {
    if (this.done) return
    if (err) return this._error(err)
    if (headers.length === 0) return this.end()
    headers.peer = peer
    this.push(headers)
    if (headers.length < 2000) return this.end()
    if (this.stop &&
    headers[headers.length - 1].getHash().compare(this.stop) === 0) {
      return this.end()
    }
    this.getting = false
    cb(null)
  })
}

HeaderStream.prototype.end = function () {
  if (this.done) return
  this.done = true
  this.push(null)
}
