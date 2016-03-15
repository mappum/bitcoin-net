var Readable = require('stream').Readable
var util = require('util')
var u = require('bitcoin-util')
var merkleProof = require('bitcoin-merkle-proof')

var BlockStream = module.exports = function (peers, chain, opts) {
  if (!peers) throw new Error('"peers" argument is required for BlockStream')
  if (!chain) throw new Error('"chain" argument is required for BlockStream')
  Readable.call(this, { objectMode: true })

  opts = opts || {}
  this.peers = peers
  this.chain = chain
  // TODO: handle different types for 'from' (e.g. height, timestamp)
  this.from = opts.from || 0
  this.to = opts.to || null
  this.bufferSize = opts.bufferSize || 128
  this.filtered = opts.filtered

  this.requestCursor = this.from
  this.requestQueue = []
  this.requestHeight = null
  this.buffer = []
  this.pause = false
  this.ended = false
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
  if (self.pause) return
  if (this.ended) return
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
    if (self.pause) return
    if (self.requestQueue.length >= self.bufferSize) return
    self._next()
  })
  this.requestCursor = null
}

BlockStream.prototype._getData = function (hash) {
  if (this.ended) return
  this.peers.getBlocks([ hash ], { filtered: this.filtered }, (err, blocks) => {
    if (err) return this._error(err)
    var onBlock = this.filtered ? this._onMerkleBlock : this._onBlock
    onBlock.call(this, blocks[0])
  })
}

BlockStream.prototype._requestIndex = function (hash) {
  for (var i = 0; i < this.requestQueue.length; i++) {
    if (this.requestQueue[i] == null) continue
    if (hash.compare(this.requestQueue[i]) === 0) return i
  }
  return false
}

BlockStream.prototype._onBlock = function (message) {
  if (this.ended) return
  var hash = message.header.getHash()
  var reqIndex = this._requestIndex(hash)
  if (reqIndex === false) return
  this._push(reqIndex, {
    height: this.requestHeight + reqIndex,
    header: message.header,
    transactions: message.transactions
  })
}

BlockStream.prototype._onMerkleBlock = function (message) {
  if (this.ended) return
  var self = this

  var hash = message.merkleBlock.header.getHash()
  if (this._requestIndex(hash) === false) return

  var txids = merkleProof.verify(message.merkleBlock)
  if (!txids.length) return done(null, [])
  this.peers.getTransactions(hash, txids, done)

  function done (err, transactions) {
    if (err) return self._error(err)
    var reqIndex = self._requestIndex(hash)
    var height = self.requestHeight + reqIndex
    self._push(reqIndex, {
      height: height,
      header: message.merkleBlock.header,
      transactions: transactions
    })
  }
}

BlockStream.prototype._push = function (i, data) {
  if (this.ended) return
  this.buffer[i] = data
  while (this.buffer[0]) {
    if (this.ended) return
    // consumers might end the stream after this.push(),
    // so we should watch for that and stop pushing data if it happens
    this.requestHeight++
    this.requestQueue.shift()
    var head = this.buffer.shift()
    var more = this.push(head)
    if (!more) this.pause = true
  }
  if (this.requestQueue[0] === null) this.end()
}

BlockStream.prototype.end = function () {
  this.ended = true
  this.requestCursor = null
  this.push(null)
}
