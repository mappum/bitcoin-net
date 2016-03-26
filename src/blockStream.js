var Transform = require('stream').Transform
var util = require('util')
var merkleProof = require('bitcoin-merkle-proof')

var BlockStream = module.exports = function (peers, opts) {
  if (!(this instanceof BlockStream)) return new BlockStream(peers, opts)
  if (!peers) throw new Error('"peers" argument is required for BlockStream')
  Transform.call(this, { objectMode: true })

  opts = opts || {}
  this.peers = peers
  this.batchSize = opts.batchSize || 64
  this.filtered = opts.filtered

  this.batch = []
  this.requestQueue = []
  this.height = null
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

  // buffer block hashes until we have `batchSize`, then make a `getdata`
  // request with all of them
  // TODO: make request with unfilled batch if block is at end of chain
  this.batch.push(block.header.getHash())
  if (this.batch.length >= this.batchSize) {
    self._getData(this.batch, (err) => cb(err))
    this.batch = []
  } else {
    return cb(null)
  }
}

BlockStream.prototype._getData = function (hashes, cb) {
  if (this.ended) return
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

  var block = {
    height: this.height++,
    header: message.header
  }

  var hash = message.header.getHash()
  var txids = merkleProof.verify({
    flags: message.flags,
    hashes: message.hashes,
    numTransactions: message.numTransactions,
    merkleRoot: message.header.merkleRoot
  })
  if (!txids.length) return done(null, [])
  this.peers.getTransactions(hash, txids, done)

  function done (err, transactions) {
    if (err) return self._error(err)
    block.transactions = transactions
    self.push(block)
  }
}

BlockStream.prototype.end = function () {
  this.ended = true
  this.push(null)
}
