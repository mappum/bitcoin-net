var Transform = require('stream').Transform
var util = require('util')
var async = require('async')
var INV = require('bitcoin-protocol').constants.inventory

var HeaderStream = module.exports = function (peers, opts) {
  if (!peers) throw new Error('"peers" argument is required')
  Transform.call(this, { objectMode: true })
  opts = opts || {}
  this.peers = peers
  this.timeout = opts.timeout
  this.stop = opts.stop
  this.getting = false
  this.done = false
  this.reachedTip = false
  this.lastLocator = null
  if (opts.endOnTip) {
    this.once('tip', () => this.end())
  }
}
util.inherits(HeaderStream, Transform)

HeaderStream.prototype._error = function (err) {
  this.emit('error', err)
  this.end()
}

HeaderStream.prototype._transform = function (locator, enc, cb) {
  console.log('headerstream locator: ' + locator[locator.length-1].toString('hex'))
  this.lastLocator = locator
  if (this.reachedTip) return cb(null)
  this._getHeaders(locator, cb)
}

HeaderStream.prototype._getHeaders = function (locator, peer, cb) {
  if (this.getting || this.done) return
  if (typeof peer === 'function') {
    cb = peer
    peer = this.peers
  }
  this.getting = true
  peer.getHeaders(locator, {
    stop: this.stop,
    timeout: this.timeout
  }, (err, headers, peer) => {
    if (this.done) return
    if (err) return this._error(err)
    this.getting = false
    if (headers.length === 0) return this._onTip(locator, peer)
    headers.peer = peer
    this.push(headers)
    if (headers.length < 2000) {
      var lastHash = headers[headers.length - 1].getHash()
      return this._onTip([ lastHash ], peer)
    }
    if (this.stop &&
    headers[headers.length - 1].getHash().compare(this.stop) === 0) {
      return this.end()
    }
    if (cb) cb(null)
  })
}

HeaderStream.prototype.end = function () {
  if (this.done) return
  this.done = true
  this.push(null)
}

HeaderStream.prototype._onTip = function (locator, peer) {
  if (this.reachedTip) return

  // first, verify we are actually at the tip by repeating the request to
  // other peers. this is so peers can't DoS our sync by sending an empty
  // 'headers' message
  var otherPeers = this.peers.peers.filter((peer2) => peer2 !== peer)
  if (otherPeers.length === 0) return
  otherPeers = otherPeers.slice(0, Math.max(1, otherPeers.length / 2))
  async.each(otherPeers, (peer, cb) => {
    peer.getHeaders(locator, { timeout: this.timeout }, (err, headers) => {
      if (err) return cb(null) // ignore errors
      if (headers.length > 0) {
        return cb(new Error('Got a non-empty headers response'))
      }
      cb(null)
    })
  }, (err) => {
    if (err) return
    this.reachedTip = true
    this.emit('tip')
    if (!this.done) this._subscribeToInvs()
  })
}

HeaderStream.prototype._subscribeToInvs = function () {
  var lastInv = null
  this.peers.on('inv', (inv, peer) => {
    for (let item of inv) {
      if (item.type !== INV.MSG_BLOCK) continue
      if (lastInv && item.hash.compare(lastInv) === 0) continue
      lastInv = item.hash
      this._getHeaders(this.lastLocator, peer)
    }
  })
}
