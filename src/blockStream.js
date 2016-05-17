var Transform = require('stream').Transform
var util = require('util')
var merkleProof = require('bitcoin-merkle-proof')
var debug = require('debug')('bitcoin-net:blockstream')

var BlockStream = module.exports = function (peers, opts) {
  if (!(this instanceof BlockStream)) return new BlockStream(peers, opts)
  if (!peers) throw new Error('"peers" argument is required for BlockStream')
  Transform.call(this, { objectMode: true })

  debug(`created BlockStream: ${opts}`)

  opts = opts || {}
  this.peers = peers
  this.batchSize = opts.batchSize || 64
  this.filtered = opts.filtered
  this.timeout = opts.timeout || 2 * 1000

  this.batch = []
  this.buffer = []
  this.height = null
  this.ended = false

  this.batchTimeout = null
}
util.inherits(BlockStream, Transform)

BlockStream.prototype._error = function (err) {
  this.emit('error', err)
}

BlockStream.prototype._transform = function (block, enc, cb) {
  if (this.ended) return

  if (this.height == null) {
    this.height = block.height
  }

  // buffer block hashes until we have `batchSize`, then make a `getdata`
  // request with all of them once the batch fills up, or if we don't receive
  // any headers for a certain amount of time (`timeout` option)
  this.batch.push(block)
  if (this.batchTimeout) clearTimeout(this.batchTimeout)
  if (this.batch.length >= this.batchSize) {
    this._sendBatch(cb)
  } else {
    this.batchTimeout = setTimeout(() => {
      this._sendBatch((err) => {
        if (err) this._error(err)
      })
    }, this.timeout)
    cb(null)
  }
}

BlockStream.prototype._sendBatch = function (cb) {
  if (this.ended) return
  var batch = this.batch
  this.batch = []
  var hashes = batch.map((block) => block.header.getHash())
  this.peers.getBlocks(hashes, { filtered: this.filtered }, (err, blocks) => {
    if (err) return cb(err)
    var onBlock = this.filtered ? this._onMerkleBlock : this._onBlock
    blocks.forEach((block, i) => {
      block = Object.assign({}, batch[i], block)
      if (batch[i].operation) block.operation = batch[i].operation
      onBlock.call(this, block)
    })
    cb(null)
  })
}

BlockStream.prototype._onBlock = function (block) {
  if (this.ended) return
  this._push(block)
}

BlockStream.prototype._onMerkleBlock = function (block) {
  if (this.ended) return
  var self = this

  var txids = merkleProof.verify({
    flags: block.flags,
    hashes: block.hashes,
    numTransactions: block.numTransactions,
    merkleRoot: block.header.merkleRoot
  })
  if (!txids.length) return done([])

  var transactions = []
  for (var txid of txids) {
    var hash = txid.toString('base64')
    var tx = this.peers._txPoolMap[hash]
    if (tx) {
      maybeDone(tx)
      continue
    }
    this.peers.once(`tx:${hash}`, maybeDone)
  }

  function maybeDone (tx) {
    transactions.push(tx)
    if (transactions.length === txids.length) {
      done(transactions)
    }
  }

  function done (transactions) {
    block.transactions = transactions
    self._push(block)
  }
}

BlockStream.prototype._push = function (block) {
  var offset = block.height - this.height
  this.buffer[offset] = block
  if (!this.buffer[0]) debug(`buffering block, height=${block.height}, buffer.length=${this.buffer.length}`)
  while (this.buffer[0]) {
    this.push(this.buffer.shift())
    this.height++
  }
}

BlockStream.prototype.end = function () {
  this.ended = true
  this.push(null)
}
