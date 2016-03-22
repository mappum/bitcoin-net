var Transform = require('stream').Transform
var util = require('util')
var merkleProof = require('bitcoin-merkle-proof')

var BlockStream = module.exports = function (peers, opts) {
  if (!peers) throw new Error('"peers" argument is required for BlockStream')
  Transform.call(this, { objectMode: true })

  opts = opts || {}
  this.peers = peers
  this.bufferSize = opts.bufferSize || 100
  this.filtered = opts.filtered

  this.requestQueue = []
  this.height = null
  this.buffer = []
  this.ended = false
}
util.inherits(BlockStream, Transform)

BlockStream.prototype._error = function (err) {
  this.emit('error', err)
}

BlockStream.prototype._transform = function (block, enc, cb) {
  var self = this
  if (this.ended) return

  if (this.height == null) this.height = block.height
  this.buffer.push(block)
  if (this.buffer.length >= this.bufferSize) {
    self._getData(this.buffer, (err) => cb(err))
    this.buffer = []
  } else {
    return cb(null)
  }
}

BlockStream.prototype._getData = function (blocks, cb) {
  if (this.ended) return
  var hashes = blocks.map((block) => block.header.getHash())
  this.peers.getBlocks(hashes, { filtered: this.filtered }, (err, blocks) => {
    if (err) return (cb ? cb : this._error)(err)
    var onBlock = this.filtered ? this._onMerkleBlock : this._onBlock
    for (var block of blocks) onBlock.call(this, block)
    if (cb) cb(null, blocks)
  })
}

BlockStream.prototype._onBlock = function (message) {
  if (this.ended) return
  this.push({
    height: this.height++,
    header: message.header,
    transactions: message.transactions
  })
}

BlockStream.prototype._onMerkleBlock = function (message) {
  if (this.ended) return
  var self = this

  var hash = message.merkleBlock.header.getHash()
  var txids = merkleProof.verify(message.merkleBlock)
  if (!txids.length) return done(null, [])
  this.peers.getTransactions(hash, txids, done)

  function done (err, transactions) {
    if (err) return self._error(err)
    self.push({
      height: this.height++,
      header: message.merkleBlock.header,
      transactions: transactions
    })
  }
}

BlockStream.prototype.end = function () {
  this.ended = true
  this.push(null)
}
