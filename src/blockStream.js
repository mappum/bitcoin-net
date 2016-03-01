var Readable = require('stream').Readable
var util = require('util')
var u = require('bitcoin-util')
var merkleProof = require('bitcoin-merkle-proof')
var Peer = require('./peer.js')

var BlockStream = module.exports = function (peers, chain, opts) {
  if (!peers) throw new Error('"peers" argument is required for BlockStream')
  if (!chain) throw new Error('"chain" argument is required for BlockStream')
  Readable.call(this, { objectMode: true })

  opts = opts || {}
  this.peers = peers
  this.chain = chain
  this.from = opts.from || 0
  this.to = opts.to || null
  this.bufferSize = opts.bufferSize || 128

  this.requestCursor = this.from
  this.requestQueue = []
  this.requestHeight = null
  this.buffer = []
  this.pause = false

  this.filtered = !!this.peers.filter
  if (!this.filtered) {
    this.peers.on('block', this._onBlock.bind(this))
  } else {
    this.peers.on('merkleblock', this._onMerkleBlock.bind(this))
  }
}
util.inherits(BlockStream, Readable)

BlockStream.prototype._error = function (err) {
  this.emit('error', err)
}

BlockStream.prototype._read = function () {
  this.pause = false
  this._next()
}

// FIXME: maybe this should happen outside of BlockStream?
BlockStream.prototype._next = function () {
  var self = this
  if (this.requestCursor == null) return
  // TODO: handle different types of requestCursors? (e.g. height, timestamp)
  this.chain.getBlock(this.requestCursor, function (err, block) {
    if (err) return self._error(err)
    if (!self._from) self._from = block
    var hash = block.header.getHash()
    if (block.height > self._from.height) {
      if (self.requestHeight == null) {
        self.requestHeight = block.height
      }
      self.requestQueue.push(hash)
      self._getData(hash)
    }
    if (!block.next) {
      return self.requestQueue.push(null)
    }
    self.requestCursor = u.toHash(block.next)
    if (self.pause || self.requestQueue.length >= self.bufferSize) return
    self._next()
  })
  this.requestCursor = null
}

BlockStream.prototype._getPeer = function () {
  if (this.peers instanceof Peer) return this.peers
  return this.peers.randomPeer()
}

// TODO: use a callback, rather than going through the on*Block methods
// TODO: add a timeout
BlockStream.prototype._getData = function (hash) {
  var inv = {
    type: this.filtered ? 3 : 2, // MSG_FILTERED_BLOCK, MSG_BLOCK
    hash
  }
  this._getPeer().send('getdata', [ inv ])
}

BlockStream.prototype._requestIndex = function (hash) {
  for (var i = 0; i < this.requestQueue.length; i++) {
    if (this.requestQueue[i] == null) continue
    if (hash.compare(this.requestQueue[i]) === 0) return i
  }
  return false
}

BlockStream.prototype._onBlock = function (message) {
  var hash = message.header.getHash()
  var reqIndex = this._requestIndex(hash)
  if (reqIndex === false) return
  this._push(reqIndex, {
    height: this.requestHeight + reqIndex,
    header: message.header,
    block: message
  })
}

BlockStream.prototype._onMerkleBlock = function (message) {
  var self = this

  var hash = message.merkleBlock.header.getHash()
  if (this._requestIndex(hash) === false) return

  var txids = merkleProof.verify(message.merkleBlock)
  if (!txids.length) return done(null, [])
  this.peers.getTransactions(txids, done)

  function done (err, transactions) {
    if (err) return self._error(err)
    var reqIndex = self._requestIndex(hash)
    var height = self.requestHeight + reqIndex
    self._push(reqIndex, {
      height: height,
      header: message.merkleBlock.header,
      txids: txids,
      transactions: transactions
    })
  }
}

BlockStream.prototype._push = function (i, data) {
  this.buffer[i] = data
  while (this.buffer[0]) {
    this.requestHeight++
    this.requestQueue.shift()
    var head = this.buffer.shift()
    var more = this.push(head)
    if (!more) this.pause = true
  }
  if (this.requestQueue[0] === null) this.push(null)
}
